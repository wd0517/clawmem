#!/usr/bin/env python3
"""Judge generated answers in batches using the local Codex CLI login."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_answers import attach_judge, read_jsonl, unique_strings  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--answers", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument("--timeout-sec", type=float, default=float(os.environ.get("CODEX_EVAL_JUDGE_TIMEOUT_SEC", "600")))
    parser.add_argument("--model", default=os.environ.get("CODEX_EVAL_JUDGE_MODEL", os.environ.get("CODEX_EVAL_MODEL", "gpt-5.4-mini")))
    parser.add_argument("--reasoning-effort", default=os.environ.get("CODEX_EVAL_JUDGE_REASONING_EFFORT", os.environ.get("CODEX_EVAL_REASONING_EFFORT", "low")))
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise ValueError("--batch-size must be positive")

    cases = {case["case_id"]: case for case in read_jsonl(Path(args.cases))}
    answers = read_jsonl(Path(args.answers))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    completed = read_completed_ids(output) if args.resume else set()
    mode = "a" if args.resume and output.exists() else "w"

    pending = []
    for answer in answers:
        case_id = answer.get("case_id")
        if not case_id or case_id in completed:
            continue
        case = cases.get(case_id)
        if not case:
            if not args.keep_going:
                raise ValueError(f"unknown case_id {case_id!r}")
            pending.append({"answer": answer, "error": f"unknown case_id {case_id!r}"})
            continue
        pending.append(build_item(case, answer))
        if args.limit and len(pending) >= args.limit:
            break

    written = 0
    with output.open(mode, encoding="utf-8") as sink:
        for batch_index, batch in enumerate(chunks(pending, args.batch_size), 1):
            rows = judge_batch(batch, batch_index, args)
            for row in rows:
                sink.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                written += 1
            sink.flush()
            print(f"wrote judge batch {batch_index} ({len(rows)} answers), total={written}", flush=True)
    print(f"wrote {written} Codex batch judged answer(s) to {output}")


def build_item(case: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
    return {
        "case": case,
        "answer": answer,
        "request": {
            "case_id": case["case_id"],
            "question": case.get("question") or "",
            "references": unique_strings(case.get("answers")),
            "answer": str(answer.get("answer") or answer.get("predicted_answer") or answer.get("model_answer") or "").strip(),
        },
    }


def judge_batch(batch: list[dict[str, Any]], batch_index: int, args: argparse.Namespace) -> list[dict[str, Any]]:
    started = time.perf_counter()
    try:
        judgments, tokens = call_codex([item["request"] for item in batch], args)
        by_id = {str(item.get("case_id")): item for item in judgments if isinstance(item, dict) and item.get("case_id")}
        latency_ms = int((time.perf_counter() - started) * 1000)
        out = []
        for item in batch:
            prediction = item["answer"]
            raw = by_id.get(prediction.get("case_id"), {})
            judge = {
                "correct": raw.get("correct") if isinstance(raw.get("correct"), bool) else None,
                "score": float(raw["score"]) if isinstance(raw.get("score"), (int, float)) else None,
                "rationale": str(raw.get("rationale") or "").strip(),
                "model": args.model,
            }
            usage = {"total_tokens": tokens / len(batch)} if tokens is not None and batch else {}
            judged = attach_judge(prediction, judge, usage, latency_ms)
            metadata = judged.get("metadata") if isinstance(judged.get("metadata"), dict) else {}
            judged["metadata"] = {
                **metadata,
                "judge": "codex_exec_batch",
                "judge_batch_index": batch_index,
                "judge_batch_size": len(batch),
                "judge_batch_total_tokens": tokens,
            }
            out.append(judged)
        return out
    except Exception as error:
        if not args.keep_going:
            raise
        return [
            attach_judge(item["answer"], {"score": 0.0, "correct": False, "rationale": str(error), "error": str(error)}, {}, 0)
            for item in batch
        ]


def call_codex(requests: list[dict[str, Any]], args: argparse.Namespace) -> tuple[list[dict[str, Any]], int | None]:
    prompt = (
        "You are a strict but fair benchmark answer judge.\n"
        "For each item, grade whether answer correctly answers question compared with references.\n"
        "Allow paraphrases, equivalent dates, aliases, and concise partial phrasing when the meaning is the same.\n"
        "Do not penalize extra text unless it contradicts the reference.\n"
        "Return JSON only: an array of objects with exactly keys case_id, correct, score, rationale.\n\n"
        f"Items:\n{json.dumps(requests, ensure_ascii=False)}"
    )
    with tempfile.NamedTemporaryFile("r+", encoding="utf-8", delete=False) as tmp:
        output_path = tmp.name
    try:
        command = [
            "codex", "exec", "--ephemeral", "--skip-git-repo-check",
            "--sandbox", "read-only",
            "-m", args.model,
            "-c", f'model_reasoning_effort="{args.reasoning_effort}"',
            "-o", output_path,
            "-",
        ]
        completed = subprocess.run(command, input=prompt, text=True, capture_output=True, timeout=args.timeout_sec, check=False)
        last_message = Path(output_path).read_text(encoding="utf-8").strip()
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or f"codex exited with code {completed.returncode}")
        value = parse_json(last_message)
        if isinstance(value, dict) and isinstance(value.get("judgments"), list):
            value = value["judgments"]
        if not isinstance(value, list):
            raise RuntimeError("Codex judge output must be a JSON array")
        log = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
        return value, parse_tokens_used(log)
    finally:
        try:
            Path(output_path).unlink()
        except FileNotFoundError:
            pass


def parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"(\[[\s\S]*\]|\{[\s\S]*\})", text)
        if not match:
            raise
        return json.loads(match.group(1))


def parse_tokens_used(log: str) -> int | None:
    matches = list(re.finditer(r"tokens used\s+([0-9,]+)", log, flags=re.IGNORECASE))
    if not matches:
        return None
    return int(matches[-1].group(1).replace(",", ""))


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


def chunks(values: list[dict[str, Any]], size: int):
    for index in range(0, len(values), size):
        yield values[index:index + size]


if __name__ == "__main__":
    main()
