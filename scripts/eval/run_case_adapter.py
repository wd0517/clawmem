#!/usr/bin/env python3
"""Run a per-case retrieval adapter over normalized benchmark cases."""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, help="Normalized cases JSONL.")
    parser.add_argument("--command", required=True, help="Adapter command. It reads one case JSON on stdin and writes one prediction JSON.")
    parser.add_argument("--output", required=True, help="Predictions JSONL path.")
    parser.add_argument("--timeout-sec", type=float, default=120.0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--keep-going", action="store_true", help="Write adapter errors as failed predictions instead of stopping.")
    args = parser.parse_args()

    command = shlex.split(args.command)
    if not command:
        raise ValueError("--command is empty")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with Path(args.cases).open("r", encoding="utf-8") as source, output.open("w", encoding="utf-8") as sink:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            case = json.loads(line)
            try:
                prediction = run_adapter(command, case, args.timeout_sec)
            except Exception as error:
                if not args.keep_going:
                    raise RuntimeError(f"adapter failed for {case.get('case_id')} at {args.cases}:{line_number}") from error
                prediction = {
                    "case_id": case.get("case_id"),
                    "retrieved_session_ids": [],
                    "retrieved_turn_ids": [],
                    "error": str(error),
                }
            if not prediction.get("case_id"):
                prediction["case_id"] = case.get("case_id")
            sink.write(json.dumps(prediction, ensure_ascii=False, sort_keys=True) + "\n")
            sink.flush()
            count += 1
            if args.limit and count >= args.limit:
                break
    print(f"wrote {count} adapter prediction(s) to {output}")


def run_adapter(command: list[str], case: dict[str, Any], timeout_sec: float) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        input=json.dumps(case, ensure_ascii=False),
        text=True,
        capture_output=True,
        timeout=timeout_sec,
        check=False,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        message = stderr or stdout or f"adapter exited with code {completed.returncode}"
        raise RuntimeError(message)
    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError("adapter wrote no stdout")
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        sys.stderr.write(stdout + "\n")
        raise RuntimeError("adapter stdout is not valid JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError("adapter stdout must be a JSON object")
    return value


if __name__ == "__main__":
    main()
