#!/usr/bin/env python3
"""Normalize LoCoMo and LongMemEval inputs into a shared JSONL case format."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", choices=["locomo", "longmemeval"], required=True)
    parser.add_argument("--input", required=True, help="Path to the source benchmark JSON file.")
    parser.add_argument("--output", required=True, help="Path to write normalized JSONL cases.")
    parser.add_argument("--limit", type=int, default=0, help="Optional max number of cases to write.")
    args = parser.parse_args()

    data = load_json(Path(args.input))
    if args.benchmark == "locomo":
        cases = iter_locomo_cases(data)
    else:
        cases = iter_longmemeval_cases(data)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with output.open("w", encoding="utf-8") as handle:
        for case in cases:
            handle.write(json.dumps(case, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
            if args.limit and count >= args.limit:
                break
    print(f"wrote {count} normalized {args.benchmark} case(s) to {output}")


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def iter_locomo_cases(data: Any):
    if not isinstance(data, list):
        raise ValueError("LoCoMo input must be a JSON array.")
    for sample_index, sample in enumerate(data):
        if not isinstance(sample, dict):
            continue
        sample_id = clean_id(sample.get("sample_id"), f"sample_{sample_index:04d}")
        conversation = sample.get("conversation") if isinstance(sample.get("conversation"), dict) else {}
        sessions, turn_to_session = normalize_locomo_sessions(sample_id, conversation)
        qa_items = sample.get("qa") if isinstance(sample.get("qa"), list) else []
        for question_index, qa in enumerate(qa_items):
            if not isinstance(qa, dict):
                continue
            evidence = [str(item).strip() for item in as_list(qa.get("evidence")) if str(item).strip()]
            gold_sessions = sorted({turn_to_session[item] for item in evidence if item in turn_to_session})
            yield {
                "case_id": f"locomo:{sample_id}:q{question_index:04d}",
                "benchmark": "locomo",
                "source_id": sample_id,
                "question": str(qa.get("question") or "").strip(),
                "answers": as_string_list(qa.get("answer")),
                "question_type": f"category:{qa.get('category')}",
                "question_date": None,
                "sessions": sessions,
                "gold_session_ids": gold_sessions,
                "gold_turn_ids": evidence,
                "metadata": {
                    "qa_index": question_index,
                    "category": qa.get("category"),
                },
            }


def normalize_locomo_sessions(sample_id: str, conversation: dict[str, Any]):
    session_keys = sorted(
        [
            key
            for key, value in conversation.items()
            if re.fullmatch(r"session_\d+", key) and isinstance(value, list)
        ],
        key=lambda key: int(key.split("_")[1]),
    )
    sessions = []
    turn_to_session: dict[str, str] = {}
    for key in session_keys:
        session_id = f"{sample_id}:{key}"
        messages = []
        for turn_index, turn in enumerate(conversation.get(key) or []):
            if not isinstance(turn, dict):
                continue
            turn_id = str(turn.get("dia_id") or f"{key}:turn_{turn_index:04d}").strip()
            if turn_id:
                turn_to_session[turn_id] = session_id
            messages.append(
                {
                    "turn_id": turn_id,
                    "role": "speaker",
                    "speaker": str(turn.get("speaker") or "").strip(),
                    "content": str(turn.get("text") or "").strip(),
                    "has_answer": False,
                    "metadata": {
                        key: turn[key]
                        for key in ("img_url", "blip_caption", "search_query")
                        if key in turn
                    },
                }
            )
        sessions.append(
            {
                "session_id": session_id,
                "source_session_id": key,
                "timestamp": conversation.get(f"{key}_date_time"),
                "messages": messages,
            }
        )
    return sessions, turn_to_session


def iter_longmemeval_cases(data: Any):
    if not isinstance(data, list):
        raise ValueError("LongMemEval input must be a JSON array.")
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        question_id = clean_id(item.get("question_id"), f"question_{index:04d}")
        sessions, gold_turn_ids = normalize_longmemeval_sessions(item)
        answer_session_ids = [str(value) for value in as_list(item.get("answer_session_ids"))]
        yield {
            "case_id": f"longmemeval:{question_id}",
            "benchmark": "longmemeval",
            "source_id": question_id,
            "question": str(item.get("question") or "").strip(),
            "answers": as_string_list(item.get("answer")),
            "question_type": str(item.get("question_type") or "").strip(),
            "question_date": item.get("question_date"),
            "sessions": sessions,
            "gold_session_ids": answer_session_ids,
            "gold_turn_ids": gold_turn_ids,
            "metadata": {
                "is_abstention": str(question_id).endswith("_abs"),
            },
        }


def normalize_longmemeval_sessions(item: dict[str, Any]):
    session_ids = [str(value) for value in as_list(item.get("haystack_session_ids"))]
    dates = as_list(item.get("haystack_dates"))
    raw_sessions = item.get("haystack_sessions") if isinstance(item.get("haystack_sessions"), list) else []
    sessions = []
    gold_turn_ids: list[str] = []
    for session_index, raw_session in enumerate(raw_sessions):
        session_id = session_ids[session_index] if session_index < len(session_ids) else f"session_{session_index:04d}"
        timestamp = dates[session_index] if session_index < len(dates) else None
        messages = []
        turns = raw_session if isinstance(raw_session, list) else []
        for turn_index, turn in enumerate(turns):
            if not isinstance(turn, dict):
                continue
            turn_id = f"{session_id}:turn_{turn_index:04d}"
            has_answer = bool(turn.get("has_answer"))
            if has_answer:
                gold_turn_ids.append(turn_id)
            messages.append(
                {
                    "turn_id": turn_id,
                    "role": str(turn.get("role") or "").strip(),
                    "speaker": str(turn.get("role") or "").strip(),
                    "content": str(turn.get("content") or "").strip(),
                    "has_answer": has_answer,
                    "metadata": {},
                }
            )
        sessions.append(
            {
                "session_id": session_id,
                "source_session_id": session_id,
                "timestamp": timestamp,
                "messages": messages,
            }
        )
    return sessions, gold_turn_ids


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else ([] if value is None else [value])


def as_string_list(value: Any) -> list[str]:
    out = []
    for item in as_list(value):
        if item is None:
            continue
        if isinstance(item, (dict, list)):
            out.append(json.dumps(item, ensure_ascii=False, sort_keys=True))
        else:
            out.append(str(item))
    return out


def clean_id(value: Any, fallback: str) -> str:
    text = str(value if value is not None else fallback).strip()
    text = re.sub(r"\s+", "_", text)
    return text or fallback


if __name__ == "__main__":
    main()
