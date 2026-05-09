#!/usr/bin/env python3
"""Estimate token usage for full-context and memory-based benchmark runs."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any


ANSWER_SYSTEM = (
    "Answer benchmark questions using only the provided memory context. "
    "If the context is insufficient, answer \"I don't know.\" "
    "Keep the answer concise and do not cite memory ids."
)

FULL_CONTEXT_SYSTEM = (
    "Answer benchmark questions using only the provided conversation history. "
    "If the conversation history is insufficient, answer \"I don't know.\" "
    "Keep the answer concise."
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, help="Normalized cases JSONL.")
    parser.add_argument("--predictions", help="Retrieval predictions JSONL for memory-based context.")
    parser.add_argument("--answers", help="Memory-based answer predictions JSONL with optional provider usage.")
    parser.add_argument("--no-memory-answers", help="Optional full-context answer predictions JSONL with provider usage.")
    parser.add_argument("--output", help="Optional summary JSON path.")
    parser.add_argument("--per-case-output", help="Optional per-case token accounting JSONL path.")
    parser.add_argument("--level", choices=["session", "turn"], default="session")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--index-granularity", choices=["session", "turn"], default="session")
    parser.add_argument("--max-context-chars", type=int, default=16000)
    parser.add_argument("--completion-estimate", choices=["gold", "answers", "none"], default="gold")
    parser.add_argument("--model", default="", help="Optional model name for tiktoken when available.")
    parser.add_argument("--tokenizer", choices=["auto", "approx"], default="auto")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    if args.top_k <= 0:
        raise ValueError("--top-k must be positive")
    if args.max_context_chars <= 0:
        raise ValueError("--max-context-chars must be positive")

    counter = TokenCounter(args.tokenizer, args.model)
    predictions = read_jsonl_map(Path(args.predictions)) if args.predictions else {}
    answers = read_jsonl_map(Path(args.answers)) if args.answers else {}
    no_memory_answers = read_jsonl_map(Path(args.no_memory_answers)) if args.no_memory_answers else {}

    source_index: dict[str, dict[str, Any]] = {}
    source_case_counts: dict[str, int] = {}
    totals = empty_totals()
    per_case_sink = None
    if args.per_case_output:
        per_case_path = Path(args.per_case_output)
        per_case_path.parent.mkdir(parents=True, exist_ok=True)
        per_case_sink = per_case_path.open("w", encoding="utf-8")

    try:
        evaluated = 0
        with Path(args.cases).open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                case = json.loads(line)
                if not isinstance(case, dict):
                    raise ValueError(f"{args.cases}:{line_number}: expected a JSON object")
                case_id = str(case.get("case_id") or "")
                if not case_id:
                    raise ValueError(f"{args.cases}:{line_number}: case_id is required")
                source_id = str(case.get("source_id") or case_id)
                source_case_counts[source_id] = source_case_counts.get(source_id, 0) + 1
                if source_id not in source_index:
                    source_index[source_id] = index_source_tokens(case, source_id, args.index_granularity, counter)
                row = score_case(
                    case=case,
                    prediction=predictions.get(case_id, {}),
                    answer=answers.get(case_id, {}),
                    no_memory_answer=no_memory_answers.get(case_id, {}),
                    args=args,
                    counter=counter,
                )
                add_row(totals, row)
                if per_case_sink:
                    per_case_sink.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                evaluated += 1
                if args.limit and evaluated >= args.limit:
                    break
    finally:
        if per_case_sink:
            per_case_sink.close()

    for source_id, count in source_case_counts.items():
        source_index[source_id]["case_count"] = count
        tokens = source_index[source_id]["tokens"]
        source_index[source_id]["amortized_tokens_per_case"] = tokens / count if count else 0

    metadata_index_tokens = plugin_finalize_index_tokens(predictions)
    index_write_tokens = metadata_index_tokens if metadata_index_tokens is not None else sum(item["tokens"] for item in source_index.values())
    memory_answer_tokens = totals["memory"]["answer_total_tokens"]
    memory_total = index_write_tokens + totals["memory"]["recall_query_tokens"] + memory_answer_tokens
    no_memory_total = totals["no_memory"]["total_tokens"]

    summary = {
        "num_cases": evaluated,
        "token_counter": counter.name,
        "level": args.level,
        "top_k": args.top_k,
        "index_granularity": args.index_granularity,
        "completion_estimate": args.completion_estimate,
        "no_memory": {
            "prompt_tokens": totals["no_memory"]["prompt_tokens"],
            "completion_tokens": totals["no_memory"]["completion_tokens"],
            "total_tokens": no_memory_total,
            "actual_answer_usage_cases": totals["no_memory"]["actual_usage_cases"],
        },
        "memory": {
            "index_write_tokens": index_write_tokens,
            "index_write_token_source": "plugin_finalize_metadata" if metadata_index_tokens is not None else "payload_estimate",
            "index_item_count": sum(item["item_count"] for item in source_index.values()),
            "recall_query_tokens": totals["memory"]["recall_query_tokens"],
            "answer_prompt_tokens": totals["memory"]["answer_prompt_tokens"],
            "answer_completion_tokens": totals["memory"]["answer_completion_tokens"],
            "answer_total_tokens": memory_answer_tokens,
            "total_tokens": memory_total,
            "actual_answer_usage_cases": totals["memory"]["actual_usage_cases"],
        },
        "savings": savings(no_memory_total, memory_total),
        "by_source_id": source_index,
        "notes": [
            "No-memory prompt tokens estimate answering each QA with its full source conversation as context.",
            "Memory total includes one-time memory write/index tokens, per-question recall query tokens, and answer prompt/completion tokens.",
            "Provider-reported answer total usage is used when present; prompt/completion fields may still be estimated if the provider only reports a total.",
            "For plugin-finalize predictions, index/write tokens use the recorded finalize subagent token total when available; otherwise they estimate benchmark memory_store payload text.",
        ],
    }

    print_summary(summary)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def score_case(
    case: dict[str, Any],
    prediction: dict[str, Any],
    answer: dict[str, Any],
    no_memory_answer: dict[str, Any],
    args: argparse.Namespace,
    counter: "TokenCounter",
) -> dict[str, Any]:
    question = str(case.get("question") or "").strip()
    full_context_prompt = build_full_context_prompt(case)
    no_usage = extract_usage(no_memory_answer)
    no_prompt_tokens = no_usage.get("prompt_tokens") or counter.count(full_context_prompt)
    no_completion_tokens = no_usage.get("completion_tokens")
    if no_completion_tokens is None:
        no_completion_tokens = estimate_completion_tokens(case, no_memory_answer, args.completion_estimate, counter)
    no_total_tokens = no_usage.get("total_tokens") or no_prompt_tokens + no_completion_tokens

    retrieved_context = build_retrieved_context(case, prediction, args.level, args.top_k, args.max_context_chars)
    memory_answer_prompt = build_memory_answer_prompt(question, retrieved_context, case.get("question_date"))
    memory_usage = extract_usage(answer)
    memory_prompt_tokens = memory_usage.get("prompt_tokens") or counter.count(memory_answer_prompt)
    memory_completion_tokens = memory_usage.get("completion_tokens")
    if memory_completion_tokens is None:
        memory_completion_tokens = estimate_completion_tokens(case, answer, args.completion_estimate, counter)
    memory_answer_total_tokens = memory_usage.get("total_tokens") or memory_prompt_tokens + memory_completion_tokens

    return {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark"),
        "source_id": case.get("source_id"),
        "question_type": case.get("question_type"),
        "no_memory": {
            "prompt_tokens": no_prompt_tokens,
            "completion_tokens": no_completion_tokens,
            "total_tokens": no_total_tokens,
            "used_actual_provider_usage": bool(no_usage),
        },
        "memory": {
            "recall_query_tokens": counter.count(question),
            "retrieved_context_tokens": counter.count(retrieved_context),
            "answer_prompt_tokens": memory_prompt_tokens,
            "answer_completion_tokens": memory_completion_tokens,
            "answer_total_tokens": memory_answer_total_tokens,
            "used_actual_provider_usage": bool(memory_usage),
        },
    }


def index_source_tokens(case: dict[str, Any], source_id: str, granularity: str, counter: "TokenCounter") -> dict[str, Any]:
    items = build_turn_items(case, source_id) if granularity == "turn" else build_session_items(case, source_id)
    tokens = sum(counter.count(render_store_payload(item, case, granularity)) for item in items)
    return {
        "tokens": tokens,
        "item_count": len(items),
        "case_count": 0,
    }


def build_session_items(case: dict[str, Any], source_id: str) -> list[dict[str, str]]:
    items = []
    for index, session in enumerate(case.get("sessions", [])):
        if not isinstance(session, dict):
            continue
        session_id = str(session.get("session_id") or f"session_{index}")
        transcript = "\n".join(render_message(message) for message in session.get("messages", []) if isinstance(message, dict))
        detail = "\n".join(
            [
                f"EVAL_SOURCE_ID: {source_id}",
                f"EVAL_SESSION_ID: {session_id}",
                f"EVAL_SOURCE_SESSION_ID: {session.get('source_session_id') or ''}",
                f"EVAL_BENCHMARK: {case.get('benchmark') or ''}",
                f"EVAL_TIMESTAMP: {session.get('timestamp') or ''}",
                "",
                transcript,
            ]
        ).strip()
        items.append({"id": session_id, "title": f"Eval session {session_id}", "detail": detail})
    return items


def build_turn_items(case: dict[str, Any], source_id: str) -> list[dict[str, str]]:
    items = []
    for session_index, session in enumerate(case.get("sessions", [])):
        if not isinstance(session, dict):
            continue
        session_id = str(session.get("session_id") or f"session_{session_index}")
        for turn_index, message in enumerate(session.get("messages", [])):
            if not isinstance(message, dict):
                continue
            turn_id = str(message.get("turn_id") or f"{session_id}:turn_{turn_index:04d}")
            detail = "\n".join(
                [
                    f"EVAL_SOURCE_ID: {source_id}",
                    f"EVAL_SESSION_ID: {session_id}",
                    f"EVAL_TURN_ID: {turn_id}",
                    f"EVAL_SOURCE_SESSION_ID: {session.get('source_session_id') or ''}",
                    f"EVAL_BENCHMARK: {case.get('benchmark') or ''}",
                    f"EVAL_TIMESTAMP: {session.get('timestamp') or ''}",
                    f"EVAL_SPEAKER: {message.get('speaker') or message.get('role') or ''}",
                    "",
                    str(message.get("content") or ""),
                ]
            ).strip()
            items.append({"id": turn_id, "title": f"Eval turn {turn_id}", "detail": detail})
    return items


def render_store_payload(item: dict[str, str], case: dict[str, Any], granularity: str) -> str:
    return json.dumps(
        {
            "title": item["title"],
            "detail": item["detail"],
            "kind": "benchmark-evidence",
            "topics": [case.get("benchmark") or "benchmark", granularity],
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def build_full_context_prompt(case: dict[str, Any]) -> str:
    context = []
    for session in case.get("sessions", []):
        if not isinstance(session, dict):
            continue
        transcript = "\n".join(render_message(message) for message in session.get("messages", []) if isinstance(message, dict))
        context.append(
            "\n".join(
                [
                    f"Session id: {session.get('session_id') or ''}",
                    f"Timestamp: {session.get('timestamp') or ''}",
                    "Transcript:",
                    transcript,
                ]
            ).strip()
        )
    return (
        f"System:\n{FULL_CONTEXT_SYSTEM}\n\n"
        f"{question_date_block(case.get('question_date'))}"
        f"Question:\n{case.get('question') or ''}\n\n"
        f"Conversation history:\n{chr(10).join(context)}\n\n"
        "Answer:"
    )


def build_memory_answer_prompt(question: str, retrieved_context: str, question_date: Any = None) -> str:
    return (
        f"System:\n{ANSWER_SYSTEM}\n\n"
        f"{question_date_block(question_date)}"
        f"Question:\n{question}\n\n"
        f"Memory context:\n{retrieved_context or '(no retrieved memory)'}\n\n"
        "Answer:"
    )


def question_date_block(value: Any) -> str:
    text = str(value or "").strip()
    return f"Question date:\n{text}\n\n" if text else ""


def build_retrieved_context(case: dict[str, Any], prediction: dict[str, Any], level: str, top_k: int, max_chars: int) -> str:
    raw_recall = raw_recall_text(prediction)
    metadata = prediction.get("metadata") if isinstance(prediction.get("metadata"), dict) else {}
    if raw_recall and metadata.get("index_mode") == "plugin-finalize":
        return "\n\n".join(item["text"] for item in trim_context([{"id": "clawmem_recall", "text": "ClawMem recall text:\n" + raw_recall}], max_chars))
    ids = predicted_ids(prediction, level)[:top_k]
    items = session_context(case, ids) if level == "session" else turn_context(case, ids)
    if not items and raw_recall:
        items = [{"id": "raw_recall_text", "text": "Raw recall text:\n" + raw_recall}]
    return "\n\n".join(item["text"] for item in trim_context(items, max_chars))


def raw_recall_text(prediction: dict[str, Any]) -> str:
    direct = str(prediction.get("raw_recall_text") or "").strip()
    if direct:
        return direct
    metadata = prediction.get("metadata") if isinstance(prediction.get("metadata"), dict) else {}
    return str(metadata.get("raw_recall") or "").strip()


def plugin_finalize_index_tokens(predictions: dict[str, dict[str, Any]]) -> int | None:
    by_group: dict[str, int] = {}
    for prediction in predictions.values():
        metadata = prediction.get("metadata") if isinstance(prediction.get("metadata"), dict) else {}
        if metadata.get("index_mode") != "plugin-finalize":
            continue
        finalize = metadata.get("finalize") if isinstance(metadata.get("finalize"), dict) else {}
        total = number_to_int(finalize.get("total_tokens"))
        if total is not None:
            group = str(metadata.get("repo") or metadata.get("source_id") or prediction.get("source_id") or prediction.get("case_id") or "")
            by_group[group] = max(by_group.get(group, 0), total)
    return sum(by_group.values()) if by_group else None


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


def estimate_completion_tokens(case: dict[str, Any], prediction: dict[str, Any], source: str, counter: "TokenCounter") -> int:
    if source == "none":
        return 0
    if source == "answers":
        answer = str(prediction.get("answer") or prediction.get("predicted_answer") or prediction.get("model_answer") or "").strip()
        if answer:
            return counter.count(answer)
    references = unique_strings(case.get("answers"))
    return max((counter.count(reference) for reference in references), default=0)


def extract_usage(prediction: dict[str, Any]) -> dict[str, int]:
    usage = prediction.get("usage") if isinstance(prediction.get("usage"), dict) else {}
    prompt = number_to_int(usage.get("prompt_tokens"))
    completion = number_to_int(usage.get("completion_tokens"))
    total = number_to_int(usage.get("total_tokens"))
    if completion is None and total is not None and prompt is not None and total >= prompt:
        completion = total - prompt
    return {
        **({"prompt_tokens": prompt} if prompt is not None else {}),
        **({"completion_tokens": completion} if completion is not None else {}),
        **({"total_tokens": total} if total is not None else {}),
    }


def add_row(totals: dict[str, dict[str, int]], row: dict[str, Any]) -> None:
    no_memory = row["no_memory"]
    memory = row["memory"]
    totals["no_memory"]["prompt_tokens"] += no_memory["prompt_tokens"]
    totals["no_memory"]["completion_tokens"] += no_memory["completion_tokens"]
    totals["no_memory"]["total_tokens"] += no_memory["total_tokens"]
    totals["no_memory"]["actual_usage_cases"] += 1 if no_memory["used_actual_provider_usage"] else 0
    totals["memory"]["recall_query_tokens"] += memory["recall_query_tokens"]
    totals["memory"]["answer_prompt_tokens"] += memory["answer_prompt_tokens"]
    totals["memory"]["answer_completion_tokens"] += memory["answer_completion_tokens"]
    totals["memory"]["answer_total_tokens"] += memory["answer_total_tokens"]
    totals["memory"]["actual_usage_cases"] += 1 if memory["used_actual_provider_usage"] else 0


def empty_totals() -> dict[str, dict[str, int]]:
    return {
        "no_memory": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "actual_usage_cases": 0},
        "memory": {
            "recall_query_tokens": 0,
            "answer_prompt_tokens": 0,
            "answer_completion_tokens": 0,
            "answer_total_tokens": 0,
            "actual_usage_cases": 0,
        },
    }


def savings(no_memory_total: int, memory_total: int) -> dict[str, float | int | None]:
    delta = no_memory_total - memory_total
    if no_memory_total <= 0:
        return {"absolute_tokens": delta, "ratio_memory_to_no_memory": None, "percent_reduction": None}
    ratio = memory_total / no_memory_total
    return {
        "absolute_tokens": delta,
        "ratio_memory_to_no_memory": ratio,
        "percent_reduction": (1 - ratio) * 100,
    }


def print_summary(summary: dict[str, Any]) -> None:
    no_memory = summary["no_memory"]
    memory = summary["memory"]
    saving = summary["savings"]
    print(f"cases={summary['num_cases']} token_counter={summary['token_counter']}")
    print(
        "no_memory: "
        f"prompt={no_memory['prompt_tokens']} completion={no_memory['completion_tokens']} total={no_memory['total_tokens']}"
    )
    print(
        "memory: "
        f"index_write={memory['index_write_tokens']} recall_query={memory['recall_query_tokens']} "
        f"answer_prompt={memory['answer_prompt_tokens']} answer_completion={memory['answer_completion_tokens']} "
        f"answer_total={memory['answer_total_tokens']} "
        f"total={memory['total_tokens']}"
    )
    ratio = saving["ratio_memory_to_no_memory"]
    reduction = saving["percent_reduction"]
    ratio_text = "n/a" if ratio is None else f"{ratio:.4f}"
    reduction_text = "n/a" if reduction is None else f"{reduction:.2f}%"
    print(f"savings: absolute={saving['absolute_tokens']} ratio={ratio_text} reduction={reduction_text}")


def read_jsonl_map(path: Path) -> dict[str, dict[str, Any]]:
    out = {}
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: expected a JSON object")
            case_id = value.get("case_id")
            if case_id:
                out[str(case_id)] = value
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


def number_to_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return int(value)
    return None


class TokenCounter:
    def __init__(self, mode: str, model: str) -> None:
        self.encoder = None
        self.name = "approx:max(regex,char4)"
        if mode == "approx":
            return
        try:
            import tiktoken  # type: ignore

            if model:
                try:
                    self.encoder = tiktoken.encoding_for_model(model)
                    self.name = f"tiktoken:{model}"
                except Exception:
                    self.encoder = tiktoken.get_encoding("cl100k_base")
                    self.name = f"tiktoken:cl100k_base(model={model})"
            else:
                self.encoder = tiktoken.get_encoding("cl100k_base")
                self.name = "tiktoken:cl100k_base"
        except Exception:
            self.encoder = None

    def count(self, text: str) -> int:
        if self.encoder is not None:
            return len(self.encoder.encode(text))
        if not text:
            return 0
        regex_count = len(re.findall(r"\w+|[^\w\s]", text, flags=re.UNICODE))
        char_count = math.ceil(len(text) / 4)
        return max(regex_count, char_count)


if __name__ == "__main__":
    main()
