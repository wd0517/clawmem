#!/usr/bin/env python3
"""Add LLM-as-judge scores to generated benchmark answers."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shlex
import string
import subprocess
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, help="Normalized cases JSONL.")
    parser.add_argument("--answers", required=True, help="Generated answers JSONL.")
    parser.add_argument("--output", required=True, help="Judged answers JSONL.")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--keep-going", action="store_true", help="Write judge errors instead of stopping.")
    parser.add_argument("--heuristic", action="store_true", help="Use local token F1 as a non-comparable smoke-test judge.")
    parser.add_argument("--command", help="Optional judge command. It reads one judge input JSON on stdin.")
    parser.add_argument("--resume", action="store_true", help="Append to --output and skip already judged case ids.")
    parser.add_argument("--threshold", type=float, default=0.5, help="Correctness threshold for heuristic or numeric judge scores.")
    parser.add_argument("--base-url", default=os.environ.get("EVAL_JUDGE_BASE_URL") or os.environ.get("EVAL_LLM_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--api-key", default=os.environ.get("EVAL_JUDGE_API_KEY") or os.environ.get("EVAL_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY", ""))
    parser.add_argument("--model", default=os.environ.get("EVAL_JUDGE_MODEL") or os.environ.get("EVAL_LLM_MODEL", ""))
    parser.add_argument("--temperature", type=float, default=float(os.environ.get("EVAL_JUDGE_TEMPERATURE", "0")))
    parser.add_argument("--max-output-tokens", type=int, default=int(os.environ.get("EVAL_JUDGE_MAX_OUTPUT_TOKENS", "256")))
    parser.add_argument("--timeout-sec", type=float, default=120.0)
    args = parser.parse_args()

    command = shlex.split(args.command) if args.command else None
    if not args.heuristic and command is None and not args.model:
        raise ValueError("set --model/EVAL_JUDGE_MODEL, provide --command, or use --heuristic for a smoke test")
    args.command_argv = command

    cases = {case["case_id"]: case for case in read_jsonl(Path(args.cases))}
    answers = read_jsonl(Path(args.answers))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    completed = read_completed_ids(output) if args.resume else set()
    count = 0
    mode = "a" if args.resume and output.exists() else "w"
    with output.open(mode, encoding="utf-8") as sink:
        for prediction in answers:
            case_id = prediction.get("case_id")
            if case_id in completed:
                continue
            case = cases.get(case_id)
            try:
                if case is None:
                    raise ValueError(f"unknown case_id {case_id!r}")
                judged = judge_one(case, prediction, args)
            except Exception as error:
                if not args.keep_going:
                    raise RuntimeError(f"judge failed for {case_id}") from error
                judged = attach_judge(prediction, {
                    "score": 0.0,
                    "correct": False,
                    "rationale": str(error),
                    "error": str(error),
                }, {}, 0)
            sink.write(json.dumps(judged, ensure_ascii=False, sort_keys=True) + "\n")
            sink.flush()
            count += 1
            if args.limit and count >= args.limit:
                break
    print(f"wrote {count} judged answer(s) to {output}")


def judge_one(case: dict[str, Any], prediction: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    references = unique_strings(case.get("answers"))
    answer = str(prediction.get("answer") or prediction.get("predicted_answer") or prediction.get("model_answer") or "").strip()
    started = time.perf_counter()
    if args.heuristic:
        score = max((token_f1(answer, reference) for reference in references), default=0.0)
        judge = {
            "score": score,
            "correct": score >= args.threshold,
            "rationale": "heuristic token F1 smoke-test judge",
        }
        usage = {}
    elif args.command_argv:
        judge, usage = run_command_judge(args.command_argv, case, answer, references, args.timeout_sec)
        score = number(judge.get("score"))
        if score is not None:
            judge["score"] = max(0.0, min(1.0, score))
        if not isinstance(judge.get("correct"), bool):
            judge["correct"] = bool(judge.get("score", 0.0) >= args.threshold)
    else:
        judge, usage = call_judge_model(case, answer, references, args)
        score = number(judge.get("score"))
        if score is not None:
            judge["score"] = max(0.0, min(1.0, score))
        if not isinstance(judge.get("correct"), bool):
            judge["correct"] = bool(judge.get("score", 0.0) >= args.threshold)
    latency_ms = int((time.perf_counter() - started) * 1000)
    return attach_judge(prediction, judge, usage, latency_ms)


def run_command_judge(command: list[str], case: dict[str, Any], answer: str, references: list[str], timeout_sec: float) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark"),
        "source_id": case.get("source_id"),
        "question": case.get("question") or "",
        "question_type": case.get("question_type"),
        "references": references,
        "answer": answer,
    }
    completed = subprocess.run(
        command,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        timeout=timeout_sec,
        check=False,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        raise RuntimeError(stderr or stdout or f"judge command exited with code {completed.returncode}")
    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError("judge command wrote no stdout")
    value = json.loads(stdout)
    if not isinstance(value, dict):
        raise RuntimeError("judge command stdout must be a JSON object")
    judge = value.get("judge") if isinstance(value.get("judge"), dict) else value
    usage = value.get("usage") if isinstance(value.get("usage"), dict) else {}
    return {
        "correct": judge.get("correct") if isinstance(judge.get("correct"), bool) else None,
        "score": number(judge.get("score")),
        "rationale": str(judge.get("rationale") or "").strip(),
        **({"model": str(judge.get("model")).strip()} if judge.get("model") else {}),
    }, usage


def call_judge_model(case: dict[str, Any], answer: str, references: list[str], args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    endpoint = args.base_url.rstrip("/") + "/chat/completions"
    prompt = (
        "Grade whether the predicted answer correctly answers the question compared with the reference answer(s).\n"
        "Allow paraphrases, equivalent dates, aliases, and concise partial phrasing when the meaning is the same.\n"
        "Do not penalize extra text unless it contradicts the reference.\n"
        "Return JSON only with keys: correct (boolean), score (number from 0 to 1), rationale (short string).\n\n"
        f"Question:\n{case.get('question') or ''}\n\n"
        f"Reference answer(s):\n{json.dumps(references, ensure_ascii=False)}\n\n"
        f"Predicted answer:\n{answer}\n"
    )
    body = {
        "model": args.model,
        "temperature": args.temperature,
        "max_tokens": args.max_output_tokens,
        "messages": [
            {"role": "system", "content": "You are a strict but fair benchmark answer judge."},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if args.api_key:
        headers["Authorization"] = f"Bearer {args.api_key}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=args.timeout_sec) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        message = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"judge request failed with HTTP {error.code}: {message}") from error
    data = json.loads(raw)
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        raise RuntimeError("judge response has no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else {}
    content = str(message.get("content") or "")
    judge = parse_judge_json(content)
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    judge["model"] = args.model
    return judge, usage


def parse_judge_json(content: str) -> dict[str, Any]:
    stripped = content.strip()
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", stripped)
        if not match:
            raise RuntimeError(f"judge did not return JSON: {stripped[:200]}")
        value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise RuntimeError("judge JSON must be an object")
    score = number(value.get("score"))
    return {
        "correct": value.get("correct") if isinstance(value.get("correct"), bool) else None,
        "score": score if score is not None else None,
        "rationale": str(value.get("rationale") or "").strip(),
    }


def attach_judge(prediction: dict[str, Any], judge: dict[str, Any], usage: dict[str, Any], latency_ms: int) -> dict[str, Any]:
    metadata = prediction.get("metadata") if isinstance(prediction.get("metadata"), dict) else {}
    return {
        **prediction,
        "judge": judge,
        "metadata": {
            **metadata,
            "judge_latency_ms": latency_ms,
            "judge_usage": usage,
        },
    }


def token_f1(prediction: str, reference: str) -> float:
    pred_tokens = normalize_answer(prediction).split()
    ref_tokens = normalize_answer(reference).split()
    if not pred_tokens and not ref_tokens:
        return 1.0
    if not pred_tokens or not ref_tokens:
        return 0.0
    common = Counter(pred_tokens) & Counter(ref_tokens)
    overlap = sum(common.values())
    if overlap == 0:
        return 0.0
    precision = overlap / len(pred_tokens)
    recall = overlap / len(ref_tokens)
    return 2 * precision * recall / (precision + recall)


def normalize_answer(text: Any) -> str:
    value = str(text or "").lower()
    value = value.translate(str.maketrans("", "", string.punctuation))
    value = re.sub(r"\b(a|an|the)\b", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: expected a JSON object")
            rows.append(value)
    return rows


def read_completed_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    out = set()
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("case_id"):
                out.add(str(value["case_id"]))
    return out


def unique_strings(value: Any) -> list[str]:
    values = value if isinstance(value, list) else ([] if value is None else [value])
    seen = set()
    out = []
    for item in values:
        text = str(item).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


if __name__ == "__main__":
    main()
