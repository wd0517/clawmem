#!/usr/bin/env python3
"""Judge one benchmark answer by calling `codex exec`.

This adapter reuses the local Codex CLI login. It is best for runs where an
OpenAI-compatible API key is unavailable and the higher per-call Codex CLI
overhead is acceptable.
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
    model = os.environ.get("CODEX_EVAL_JUDGE_MODEL", os.environ.get("CODEX_EVAL_MODEL", "gpt-5.4-mini"))
    reasoning_effort = os.environ.get("CODEX_EVAL_JUDGE_REASONING_EFFORT", os.environ.get("CODEX_EVAL_REASONING_EFFORT", "low"))
    timeout = float(os.environ.get("CODEX_EVAL_JUDGE_TIMEOUT_SEC", os.environ.get("CODEX_EVAL_TIMEOUT_SEC", "180")))
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
        judge = parse_judge(last_message)
        log = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
        tokens = parse_tokens_used(log)
        judge["model"] = model
        return {
            "judge": judge,
            "usage": {"total_tokens": tokens} if tokens is not None else {},
            "metadata": {
                "judge": "codex_exec",
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
    return (
        "You are a strict but fair benchmark answer judge.\n"
        "Grade whether the predicted answer correctly answers the question compared with the reference answer(s).\n"
        "Allow paraphrases, equivalent dates, aliases, and concise partial phrasing when the meaning is the same.\n"
        "Do not penalize extra text unless it contradicts the reference.\n"
        "Return JSON only with exactly these keys: correct (boolean), score (number 0 to 1), rationale (short string).\n\n"
        f"Question:\n{payload.get('question') or ''}\n\n"
        f"Reference answer(s):\n{json.dumps(payload.get('references') or [], ensure_ascii=False)}\n\n"
        f"Predicted answer:\n{payload.get('answer') or ''}\n"
    )


def parse_judge(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise RuntimeError(f"codex judge did not return JSON: {text[:200]}")
        value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise RuntimeError("codex judge JSON must be an object")
    score = value.get("score")
    return {
        "correct": value.get("correct") if isinstance(value.get("correct"), bool) else None,
        "score": float(score) if isinstance(score, (int, float)) else None,
        "rationale": str(value.get("rationale") or "").strip(),
    }


def parse_tokens_used(log: str) -> int | None:
    matches = list(re.finditer(r"tokens used\s+([0-9,]+)", log, flags=re.IGNORECASE))
    if not matches:
        return None
    return int(matches[-1].group(1).replace(",", ""))


if __name__ == "__main__":
    main()
