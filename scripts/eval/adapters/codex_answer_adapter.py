#!/usr/bin/env python3
"""Answer one normalized eval payload by calling `codex exec`.

This adapter is intentionally for small pilots. It reuses the local Codex CLI
login, but each call starts a fresh Codex agent session and has meaningful
startup overhead.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


def main() -> None:
    payload = json.loads(sys.stdin.read())
    model = os.environ.get("CODEX_EVAL_MODEL", "gpt-5.4-mini")
    reasoning_effort = os.environ.get("CODEX_EVAL_REASONING_EFFORT", "low")
    timeout = float(os.environ.get("CODEX_EVAL_TIMEOUT_SEC", "180"))
    output = run_codex(payload, model, reasoning_effort, timeout)
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))


def run_codex(payload: dict[str, Any], model: str, reasoning_effort: str, timeout: float) -> dict[str, Any]:
    prompt = build_prompt(payload)
    with tempfile.NamedTemporaryFile("r+", encoding="utf-8", delete=False) as tmp:
        output_path = tmp.name
    try:
        command = [
            "codex",
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-m",
            model,
            "-c",
            f'model_reasoning_effort="{reasoning_effort}"',
            "-o",
            output_path,
            "-",
        ]
        completed = subprocess.run(
            command,
            input=prompt,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        last_message = Path(output_path).read_text(encoding="utf-8").strip()
        if completed.returncode != 0:
            message = completed.stderr.strip() or completed.stdout.strip() or f"codex exited with code {completed.returncode}"
            raise RuntimeError(message)
        parsed = parse_answer(last_message)
        log = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
        tokens = parse_tokens_used(log)
        return {
            "answer": parsed["answer"],
            "usage": {"total_tokens": tokens} if tokens is not None else {},
            "metadata": {
                "answerer": "codex_exec",
                "model": model,
                "reasoning_effort": reasoning_effort,
                "codex_tokens_used": tokens,
            },
        }
    finally:
        try:
            Path(output_path).unlink()
        except FileNotFoundError:
            pass


def build_prompt(payload: dict[str, Any]) -> str:
    question = str(payload.get("question") or "").strip()
    context = str(payload.get("context") or "").strip()
    return (
        "You are an answer-generation function for a memory benchmark.\n"
        "Use only the provided memory context. If the context is insufficient, answer \"I don't know.\"\n"
        "Return JSON only, with exactly this shape: {\"answer\":\"...\"}.\n\n"
        f"Question:\n{question}\n\n"
        f"Memory context:\n{context or '(no retrieved memory)'}\n"
    )


def parse_answer(text: str) -> dict[str, str]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return {"answer": text.strip()}
        value = json.loads(match.group(0))
    if isinstance(value, dict):
        return {"answer": str(value.get("answer") or value.get("predicted_answer") or "").strip()}
    return {"answer": str(value).strip()}


def parse_tokens_used(log: str) -> int | None:
    matches = list(re.finditer(r"tokens used\s+([0-9,]+)", log, flags=re.IGNORECASE))
    if not matches:
        return None
    return int(matches[-1].group(1).replace(",", ""))


if __name__ == "__main__":
    main()
