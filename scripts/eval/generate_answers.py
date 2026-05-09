#!/usr/bin/env python3
"""Generate benchmark answers from normalized cases plus retrieval predictions."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, help="Normalized cases JSONL.")
    parser.add_argument("--predictions", required=True, help="Retrieval predictions JSONL.")
    parser.add_argument("--output", required=True, help="Answer predictions JSONL.")
    parser.add_argument("--level", choices=["session", "turn"], default="session")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max-context-chars", type=int, default=16000)
    parser.add_argument("--command", help="Optional answerer command. It reads one input JSON on stdin.")
    parser.add_argument("--timeout-sec", type=float, default=120.0)
    parser.add_argument("--keep-going", action="store_true", help="Write generation errors instead of stopping.")
    parser.add_argument("--resume", action="store_true", help="Append to --output and skip already answered case ids.")
    parser.add_argument("--base-url", default=os.environ.get("EVAL_LLM_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--api-key", default=os.environ.get("EVAL_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY", ""))
    parser.add_argument("--model", default=os.environ.get("EVAL_LLM_MODEL", ""))
    parser.add_argument("--temperature", type=float, default=float(os.environ.get("EVAL_LLM_TEMPERATURE", "0")))
    parser.add_argument("--max-output-tokens", type=int, default=int(os.environ.get("EVAL_LLM_MAX_OUTPUT_TOKENS", "128")))
    args = parser.parse_args()

    if args.top_k <= 0:
        raise ValueError("--top-k must be positive")
    if args.max_context_chars <= 0:
        raise ValueError("--max-context-chars must be positive")

    command = shlex.split(args.command) if args.command else None
    if command is None and not args.model:
        raise ValueError("provide --command or set --model/EVAL_LLM_MODEL")

    cases = {case["case_id"]: case for case in read_jsonl(Path(args.cases))}
    predictions = read_jsonl(Path(args.predictions))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    completed = read_completed_ids(output) if args.resume else set()
    count = 0
    mode = "a" if args.resume and output.exists() else "w"
    with output.open(mode, encoding="utf-8") as sink:
        for prediction in predictions:
            case_id = prediction.get("case_id")
            if case_id in completed:
                continue
            case = cases.get(case_id)
            if case is None:
                if not args.keep_going:
                    raise ValueError(f"prediction references unknown case_id {case_id!r}")
                answer = error_answer(prediction, f"unknown case_id {case_id!r}")
            else:
                try:
                    answer = generate_one(case, prediction, args, command)
                except Exception as error:
                    if not args.keep_going:
                        raise RuntimeError(f"answer generation failed for {case_id}") from error
                    answer = error_answer(prediction, str(error))
            sink.write(json.dumps(answer, ensure_ascii=False, sort_keys=True) + "\n")
            sink.flush()
            count += 1
            if args.limit and count >= args.limit:
                break
    print(f"wrote {count} answer prediction(s) to {output}")


def generate_one(case: dict[str, Any], prediction: dict[str, Any], args: argparse.Namespace, command: list[str] | None) -> dict[str, Any]:
    context_items = build_context_items(case, prediction, args.level, args.top_k, args.max_context_chars)
    context = "\n\n".join(item["text"] for item in context_items)
    answer_input = {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark"),
        "source_id": case.get("source_id"),
        "question": case.get("question") or "",
        "question_type": case.get("question_type"),
        "question_date": case.get("question_date"),
        "retrieved_ids": [item["id"] for item in context_items],
        "context": context,
    }

    started = time.perf_counter()
    if command is not None:
        answer, usage, provider_metadata = run_command(command, answer_input, args.timeout_sec)
        generator = "command"
    else:
        answer, usage, provider_metadata = run_openai_compatible(args, answer_input)
        generator = "openai_compatible_chat"
    latency_ms = int((time.perf_counter() - started) * 1000)

    retrieved_session_ids = unique_strings(prediction.get("retrieved_session_ids"))
    retrieved_turn_ids = unique_strings(prediction.get("retrieved_turn_ids"))
    return {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark"),
        "source_id": case.get("source_id"),
        "question_type": case.get("question_type"),
        "answer": answer,
        "retrieved_session_ids": retrieved_session_ids,
        "retrieved_turn_ids": retrieved_turn_ids,
        "usage": usage,
        "metadata": {
            "generator": generator,
            "model": args.model if command is None else None,
            "level": args.level,
            "top_k": args.top_k,
            "context_item_count": len(context_items),
            "context_chars": len(context),
            "latency_ms": latency_ms,
            "retrieval_metadata": prediction.get("metadata"),
            **provider_metadata,
        },
    }


def run_command(command: list[str], payload: dict[str, Any], timeout_sec: float) -> tuple[str, dict[str, Any], dict[str, Any]]:
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
        raise RuntimeError(stderr or stdout or f"answerer exited with code {completed.returncode}")
    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError("answerer wrote no stdout")
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError:
        return stdout, {}, {}
    if not isinstance(value, dict):
        return str(value), {}, {}
    answer = str(value.get("answer") or value.get("predicted_answer") or "").strip()
    usage = value.get("usage") if isinstance(value.get("usage"), dict) else {}
    metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
    return answer, usage, metadata


def run_openai_compatible(args: argparse.Namespace, payload: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any]]:
    endpoint = args.base_url.rstrip("/") + "/chat/completions"
    question_date = str(payload.get("question_date") or "").strip()
    question_date_block = f"Question date:\n{question_date}\n\n" if question_date else ""
    body = {
        "model": args.model,
        "temperature": args.temperature,
        "max_tokens": args.max_output_tokens,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Answer benchmark questions using only the provided memory context. "
                    "If the context is insufficient, answer \"I don't know.\" "
                    "Keep the answer concise and do not cite memory ids."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"{question_date_block}"
                    f"Question:\n{payload['question']}\n\n"
                    f"Memory context:\n{payload['context'] or '(no retrieved memory)'}\n\n"
                    "Answer:"
                ),
            },
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
        raise RuntimeError(f"LLM request failed with HTTP {error.code}: {message}") from error
    data = json.loads(raw)
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        raise RuntimeError("LLM response has no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else {}
    answer = str(message.get("content") or "").strip()
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    return answer, usage, {"provider": args.base_url.rstrip("/")}


def build_context_items(
    case: dict[str, Any],
    prediction: dict[str, Any],
    level: str,
    top_k: int,
    max_context_chars: int,
) -> list[dict[str, str]]:
    raw_recall = raw_recall_text(prediction)
    metadata = prediction.get("metadata") if isinstance(prediction.get("metadata"), dict) else {}
    if raw_recall and metadata.get("index_mode") == "plugin-finalize":
        return trim_context([{"id": "clawmem_recall", "text": "ClawMem recall text:\n" + raw_recall}], max_context_chars)
    ids = predicted_ids(prediction, level)[:top_k]
    items = session_context(case, ids) if level == "session" else turn_context(case, ids)
    if not items and raw_recall:
        items = [{"id": "raw_recall_text", "text": "Raw recall text:\n" + raw_recall}]
    return trim_context(items, max_context_chars)


def raw_recall_text(prediction: dict[str, Any]) -> str:
    direct = str(prediction.get("raw_recall_text") or "").strip()
    if direct:
        return direct
    metadata = prediction.get("metadata") if isinstance(prediction.get("metadata"), dict) else {}
    return str(metadata.get("raw_recall") or "").strip()


def session_context(case: dict[str, Any], ids: list[str]) -> list[dict[str, str]]:
    sessions = {
        str(session.get("session_id")): session
        for session in case.get("sessions", [])
        if isinstance(session, dict) and session.get("session_id")
    }
    out = []
    for session_id in ids:
        session = sessions.get(session_id)
        if not session:
            continue
        transcript = "\n".join(render_message(message) for message in session.get("messages", []) if isinstance(message, dict))
        text = "\n".join(
            [
                f"Memory session id: {session_id}",
                f"Source session id: {session.get('source_session_id') or ''}",
                f"Timestamp: {session.get('timestamp') or ''}",
                "Transcript:",
                transcript,
            ]
        ).strip()
        out.append({"id": session_id, "text": text})
    return out


def turn_context(case: dict[str, Any], ids: list[str]) -> list[dict[str, str]]:
    by_turn: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for session in case.get("sessions", []):
        if not isinstance(session, dict):
            continue
        for message in session.get("messages", []):
            if isinstance(message, dict) and message.get("turn_id"):
                by_turn[str(message["turn_id"])] = (session, message)
    out = []
    for turn_id in ids:
        pair = by_turn.get(turn_id)
        if not pair:
            continue
        session, message = pair
        text = "\n".join(
            [
                f"Memory turn id: {turn_id}",
                f"Session id: {session.get('session_id') or ''}",
                f"Timestamp: {session.get('timestamp') or ''}",
                render_message(message),
            ]
        ).strip()
        out.append({"id": turn_id, "text": text})
    return out


def trim_context(items: list[dict[str, str]], max_chars: int) -> list[dict[str, str]]:
    out = []
    used = 0
    for item in items:
        remaining = max_chars - used
        if remaining <= 0:
            break
        text = item["text"]
        if len(text) > remaining:
            text = text[: max(0, remaining - 20)].rstrip() + "\n[truncated]"
        out.append({"id": item["id"], "text": text})
        used += len(text) + 2
    return out


def render_message(message: dict[str, Any]) -> str:
    turn_id = str(message.get("turn_id") or "").strip()
    speaker = str(message.get("speaker") or message.get("role") or "speaker").strip()
    content = str(message.get("content") or "").strip()
    prefix = f"[{turn_id}] " if turn_id else ""
    return f"{prefix}{speaker}: {content}".strip()


def predicted_ids(prediction: dict[str, Any], level: str) -> list[str]:
    field = "retrieved_session_ids" if level == "session" else "retrieved_turn_ids"
    values = unique_strings(prediction.get(field))
    if values:
        return values
    for fallback in ("retrieval_results", "retrieved"):
        if fallback in prediction:
            return ids_from_objects(prediction.get(fallback), level)
    return []


def ids_from_objects(value: Any, level: str) -> list[str]:
    if not isinstance(value, list):
        return []
    keys = ["session_id", "id"] if level == "session" else ["turn_id", "id"]
    out = []
    for item in value:
        if isinstance(item, str):
            out.append(item)
            continue
        if isinstance(item, dict):
            for key in keys:
                if item.get(key):
                    out.append(str(item[key]))
                    break
    return unique_strings(out)


def error_answer(prediction: dict[str, Any], error: str) -> dict[str, Any]:
    return {
        "case_id": prediction.get("case_id"),
        "answer": "",
        "retrieved_session_ids": unique_strings(prediction.get("retrieved_session_ids")),
        "retrieved_turn_ids": unique_strings(prediction.get("retrieved_turn_ids")),
        "error": error,
    }


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
    values = value if isinstance(value, list) else []
    seen = set()
    out = []
    for item in values:
        text = str(item).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


if __name__ == "__main__":
    main()
