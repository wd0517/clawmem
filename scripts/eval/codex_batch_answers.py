#!/usr/bin/env python3
"""Generate answers in batches using the local Codex CLI login."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_answers import build_context_items, read_jsonl, unique_strings  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--level", choices=["session", "turn"], default="session")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--max-context-chars", type=int, default=16000)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument("--timeout-sec", type=float, default=float(os.environ.get("CODEX_EVAL_TIMEOUT_SEC", "600")))
    parser.add_argument("--model", default=os.environ.get("CODEX_EVAL_MODEL", "gpt-5.4-mini"))
    parser.add_argument("--reasoning-effort", default=os.environ.get("CODEX_EVAL_REASONING_EFFORT", "low"))
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise ValueError("--batch-size must be positive")

    cases = {case["case_id"]: case for case in read_jsonl(Path(args.cases))}
    predictions = read_jsonl(Path(args.predictions))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    completed = read_completed_ids(output) if args.resume else set()
    mode = "a" if args.resume and output.exists() else "w"

    pending = []
    for prediction in predictions:
        case_id = prediction.get("case_id")
        if not case_id or case_id in completed:
            continue
        case = cases.get(case_id)
        if not case:
            if not args.keep_going:
                raise ValueError(f"unknown case_id {case_id!r}")
            pending.append(error_row(prediction, f"unknown case_id {case_id!r}"))
            continue
        pending.append(build_item(case, prediction, args))
        if args.limit and len(pending) >= args.limit:
            break

    written = 0
    with output.open(mode, encoding="utf-8") as sink:
        for batch_index, batch in enumerate(chunks(pending, args.batch_size), 1):
            rows = answer_batch(batch, batch_index, args)
            for row in rows:
                sink.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                written += 1
            sink.flush()
            print(f"wrote batch {batch_index} ({len(rows)} answers), total={written}", flush=True)
    print(f"wrote {written} Codex batch answer(s) to {output}")


def build_item(case: dict[str, Any], prediction: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    context_items = build_context_items(case, prediction, args.level, args.top_k, args.max_context_chars)
    context = "\n\n".join(item["text"] for item in context_items)
    return {
        "case": case,
        "prediction": prediction,
        "request": {
            "case_id": case["case_id"],
            "question_date": case.get("question_date"),
            "question": case.get("question") or "",
            "memory_context": context,
        },
        "context_chars": len(context),
        "context_item_count": len(context_items),
    }


def answer_batch(batch: list[dict[str, Any]], batch_index: int, args: argparse.Namespace) -> list[dict[str, Any]]:
    started = time.perf_counter()
    try:
        answers, tokens = call_codex([item["request"] for item in batch], args, answer_prompt)
        by_id = {str(item.get("case_id")): item for item in answers if isinstance(item, dict) and item.get("case_id")}
        latency_ms = int((time.perf_counter() - started) * 1000)
        out = []
        for item in batch:
            case = item["case"]
            prediction = item["prediction"]
            answer = str(by_id.get(case["case_id"], {}).get("answer") or "").strip()
            out.append(answer_row(case, prediction, answer, item, batch_index, len(batch), tokens, latency_ms, args))
        return out
    except Exception as error:
        if not args.keep_going:
            raise
        return [error_row(item["prediction"], str(error)) for item in batch]


def answer_prompt(requests: list[dict[str, Any]]) -> str:
    return (
        "You are an answer-generation function for a memory benchmark.\n"
        "For each item, use only that item's memory_context. If the context is insufficient, answer \"I don't know.\"\n"
        "Return JSON only: an array of objects with exactly keys case_id and answer.\n\n"
        f"Items:\n{json.dumps(requests, ensure_ascii=False)}"
    )


def answer_row(
    case: dict[str, Any],
    prediction: dict[str, Any],
    answer: str,
    item: dict[str, Any],
    batch_index: int,
    batch_size: int,
    tokens: int | None,
    latency_ms: int,
    args: argparse.Namespace,
) -> dict[str, Any]:
    amortized_tokens = (tokens / batch_size) if tokens is not None and batch_size else None
    return {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark"),
        "source_id": case.get("source_id"),
        "question_type": case.get("question_type"),
        "answer": answer,
        "retrieved_session_ids": unique_strings(prediction.get("retrieved_session_ids")),
        "retrieved_turn_ids": unique_strings(prediction.get("retrieved_turn_ids")),
        "usage": {"total_tokens": amortized_tokens} if amortized_tokens is not None else {},
        "metadata": {
            "answerer": "codex_exec_batch",
            "model": args.model,
            "reasoning_effort": args.reasoning_effort,
            "level": args.level,
            "top_k": args.top_k,
            "context_item_count": item["context_item_count"],
            "context_chars": item["context_chars"],
            "batch_index": batch_index,
            "batch_size": batch_size,
            "batch_total_tokens": tokens,
            "latency_ms": latency_ms,
            "retrieval_metadata": prediction.get("metadata"),
        },
    }


def call_codex(requests: list[dict[str, Any]], args: argparse.Namespace, prompt_builder) -> tuple[list[dict[str, Any]], int | None]:
    prompt = prompt_builder(requests)
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
        if isinstance(value, dict) and isinstance(value.get("answers"), list):
            value = value["answers"]
        if not isinstance(value, list):
            raise RuntimeError("Codex answer output must be a JSON array")
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


def error_row(prediction: dict[str, Any], error: str) -> dict[str, Any]:
    return {
        "case_id": prediction.get("case_id"),
        "answer": "",
        "retrieved_session_ids": unique_strings(prediction.get("retrieved_session_ids")),
        "retrieved_turn_ids": unique_strings(prediction.get("retrieved_turn_ids")),
        "error": error,
    }


if __name__ == "__main__":
    main()
