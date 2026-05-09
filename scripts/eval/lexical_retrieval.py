#!/usr/bin/env python3
"""No-dependency lexical retrieval baseline for normalized benchmark cases."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, help="Normalized cases JSONL.")
    parser.add_argument("--output", required=True, help="Predictions JSONL path.")
    parser.add_argument("--granularity", choices=["session", "turn"], default="session")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with Path(args.cases).open("r", encoding="utf-8") as source, output.open("w", encoding="utf-8") as sink:
        for line in source:
            if not line.strip():
                continue
            case = json.loads(line)
            prediction = retrieve_case(case, args.granularity, args.top_k)
            sink.write(json.dumps(prediction, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
            if args.limit and count >= args.limit:
                break
    print(f"wrote {count} lexical retrieval prediction(s) to {output}")


def retrieve_case(case: dict[str, Any], granularity: str, top_k: int) -> dict[str, Any]:
    docs = build_documents(case, granularity)
    ranked = bm25_rank(str(case.get("question") or ""), docs)
    top = ranked[: max(1, top_k)]
    session_ids = unique([doc["session_id"] for doc in top])
    prediction = {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark"),
        "retrieved_session_ids": session_ids,
        "scores": [
            {
                "id": doc["id"],
                "session_id": doc["session_id"],
                "score": doc["score"],
            }
            for doc in top
        ],
    }
    if granularity == "turn":
        prediction["retrieved_turn_ids"] = [doc["id"] for doc in top]
    return prediction


def build_documents(case: dict[str, Any], granularity: str) -> list[dict[str, Any]]:
    docs = []
    for session in case.get("sessions") or []:
        if not isinstance(session, dict):
            continue
        session_id = str(session.get("session_id") or "")
        messages = [message for message in session.get("messages") or [] if isinstance(message, dict)]
        if granularity == "session":
            text = "\n".join(str(message.get("content") or "") for message in messages)
            docs.append({"id": session_id, "session_id": session_id, "text": text})
            continue
        for index, message in enumerate(messages):
            turn_id = str(message.get("turn_id") or f"{session_id}:turn_{index:04d}")
            docs.append(
                {
                    "id": turn_id,
                    "session_id": session_id,
                    "text": str(message.get("content") or ""),
                }
            )
    return docs


def bm25_rank(query: str, docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    query_terms = tokenize(query)
    if not query_terms:
        return []
    tokenized = [tokenize(str(doc.get("text") or "")) for doc in docs]
    lengths = [len(tokens) for tokens in tokenized]
    avgdl = sum(lengths) / len(lengths) if lengths else 0.0
    dfs = Counter()
    for tokens in tokenized:
        dfs.update(set(tokens))
    total_docs = len(docs)
    query_counts = Counter(query_terms)
    ranked = []
    for doc, tokens, doc_len in zip(docs, tokenized, lengths):
        counts = Counter(tokens)
        score = 0.0
        for term, query_weight in query_counts.items():
            freq = counts.get(term, 0)
            if not freq:
                continue
            df = dfs.get(term, 0)
            idf = math.log(1.0 + (total_docs - df + 0.5) / (df + 0.5))
            k1 = 1.2
            b = 0.75
            denom = freq + k1 * (1.0 - b + b * (doc_len / avgdl if avgdl else 0.0))
            score += query_weight * idf * (freq * (k1 + 1.0) / denom)
        ranked.append({**doc, "score": score})
    ranked.sort(key=lambda item: (-item["score"], item["id"]))
    return ranked


def tokenize(text: str) -> list[str]:
    return [match.group(0).lower() for match in TOKEN_RE.finditer(text)]


def unique(values: list[str]) -> list[str]:
    seen = set()
    out = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


if __name__ == "__main__":
    main()
