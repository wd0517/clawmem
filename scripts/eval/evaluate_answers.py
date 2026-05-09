#!/usr/bin/env python3
"""Evaluate generated benchmark answers against normalized gold answers."""

from __future__ import annotations

import argparse
import json
import math
import re
import string
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


TEXT_METRICS = ("exact", "f1", "bleu1", "contains")
SYSTEM_KEYS = (
    "answer_latency_ms",
    "recall_latency_ms",
    "total_latency_ms",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "context_chars",
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, help="Normalized cases JSONL.")
    parser.add_argument("--answers", required=True, help="Generated answer predictions JSONL.")
    parser.add_argument("--output", help="Optional metrics JSON path.")
    parser.add_argument("--per-case-output", help="Optional per-case metrics JSONL path.")
    parser.add_argument("--include-empty-gold", action="store_true", help="Include cases with no reference answers.")
    parser.add_argument("--only-predicted", action="store_true", help="Evaluate only cases present in --answers.")
    args = parser.parse_args()

    cases = {case["case_id"]: case for case in read_jsonl(Path(args.cases))}
    answers = {prediction["case_id"]: prediction for prediction in read_jsonl(Path(args.answers)) if prediction.get("case_id")}

    rows = []
    skipped_empty_gold = 0
    missing_predictions = 0
    for case_id, case in cases.items():
        prediction = answers.get(case_id)
        if prediction is None and args.only_predicted:
            continue
        references = unique_strings(case.get("answers"))
        if not references and not args.include_empty_gold:
            skipped_empty_gold += 1
            continue
        if prediction is None:
            missing_predictions += 1
            prediction = {"case_id": case_id, "answer": ""}
        rows.append(score_case(case, prediction, references, prediction.get("answer", "") if prediction else ""))

    summary = {
        "num_cases": len(cases),
        "num_answers": len(answers),
        "num_evaluated": len(rows),
        "skipped_empty_gold": skipped_empty_gold,
        "missing_predictions": missing_predictions,
        "overall": aggregate(rows),
        "system": aggregate_system(rows),
        "by_benchmark": aggregate_groups(rows, "benchmark"),
        "by_question_type": aggregate_groups(rows, "question_type"),
        "by_abstention": aggregate_groups(rows, "is_abstention"),
        "by_source_id": aggregate_groups(rows, "source_id"),
    }

    print_summary(summary)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.per_case_output:
        output = Path(args.per_case_output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def score_case(case: dict[str, Any], prediction: dict[str, Any], references: list[str], raw_answer: Any) -> dict[str, Any]:
    answer = answer_text(prediction, raw_answer)
    metric_values = max_reference_scores(answer, references)
    judge = extract_judge(prediction)
    return {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark") or "",
        "source_id": case.get("source_id") or "",
        "question_type": case.get("question_type") or "",
        "is_abstention": is_abstention(case),
        "answer": answer,
        "references": references,
        "missing_prediction": not bool(prediction.get("answer") or prediction.get("predicted_answer") or prediction.get("model_answer")),
        "metrics": metric_values,
        "judge": judge,
        "system": extract_system(prediction),
    }


def max_reference_scores(answer: str, references: list[str]) -> dict[str, float]:
    if not references:
        empty = 1.0 if not normalize_answer(answer) else 0.0
        return {"exact": empty, "f1": empty, "bleu1": empty, "contains": empty}
    return {
        "exact": max(exact_match(answer, reference) for reference in references),
        "f1": max(token_f1(answer, reference) for reference in references),
        "bleu1": max(bleu1(answer, reference) for reference in references),
        "contains": max(contains_answer(answer, reference) for reference in references),
    }


def exact_match(prediction: str, reference: str) -> float:
    return 1.0 if normalize_answer(prediction) == normalize_answer(reference) else 0.0


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


def bleu1(prediction: str, reference: str) -> float:
    pred_tokens = normalize_answer(prediction).split()
    ref_tokens = normalize_answer(reference).split()
    if not pred_tokens and not ref_tokens:
        return 1.0
    if not pred_tokens or not ref_tokens:
        return 0.0
    overlap = sum((Counter(pred_tokens) & Counter(ref_tokens)).values())
    precision = overlap / len(pred_tokens)
    brevity = 1.0 if len(pred_tokens) > len(ref_tokens) else math.exp(1 - len(ref_tokens) / len(pred_tokens))
    return precision * brevity


def contains_answer(prediction: str, reference: str) -> float:
    pred = normalize_answer(prediction)
    ref = normalize_answer(reference)
    if not pred and not ref:
        return 1.0
    return 1.0 if ref and ref in pred else 0.0


def normalize_answer(text: Any) -> str:
    value = str(text or "").lower()
    value = value.translate(str.maketrans("", "", string.punctuation))
    value = re.sub(r"\b(a|an|the)\b", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def answer_text(prediction: dict[str, Any], fallback: Any) -> str:
    for field in ("answer", "predicted_answer", "model_answer"):
        if prediction.get(field) is not None:
            return str(prediction[field]).strip()
    return str(fallback or "").strip()


def extract_judge(prediction: dict[str, Any]) -> dict[str, Any]:
    judge = prediction.get("judge") if isinstance(prediction.get("judge"), dict) else {}
    score = number(judge.get("score")) if judge else number(prediction.get("judge_score"))
    correct_raw = judge.get("correct") if judge else prediction.get("judge_correct")
    correct = bool(correct_raw) if isinstance(correct_raw, bool) else None
    if correct is None and score is not None:
        correct = score >= 0.5
    return {
        "score": score,
        "correct": correct,
        "rationale": str(judge.get("rationale") or "").strip() if judge else "",
    }


def extract_system(prediction: dict[str, Any]) -> dict[str, float]:
    metadata = prediction.get("metadata") if isinstance(prediction.get("metadata"), dict) else {}
    retrieval = metadata.get("retrieval_metadata") if isinstance(metadata.get("retrieval_metadata"), dict) else {}
    usage = prediction.get("usage") if isinstance(prediction.get("usage"), dict) else {}
    out = {
        "answer_latency_ms": first_number(prediction.get("latency_ms"), metadata.get("answer_latency_ms"), metadata.get("latency_ms")),
        "recall_latency_ms": first_number(metadata.get("recall_latency_ms"), retrieval.get("recall_latency_ms")),
        "total_latency_ms": first_number(metadata.get("total_latency_ms")),
        "prompt_tokens": first_number(usage.get("prompt_tokens"), metadata.get("prompt_tokens")),
        "completion_tokens": first_number(usage.get("completion_tokens"), metadata.get("completion_tokens")),
        "total_tokens": first_number(usage.get("total_tokens"), metadata.get("total_tokens")),
        "context_chars": first_number(metadata.get("context_chars")),
    }
    if out["total_latency_ms"] is None and out["answer_latency_ms"] is not None and out["recall_latency_ms"] is not None:
        out["total_latency_ms"] = out["answer_latency_ms"] + out["recall_latency_ms"]
    return {key: value for key, value in out.items() if value is not None}


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"count": 0, "metrics": {}}
    metrics = {name: sum(row["metrics"][name] for row in rows) / len(rows) for name in TEXT_METRICS}
    judged = [row for row in rows if row["judge"].get("score") is not None or row["judge"].get("correct") is not None]
    if judged:
        scores = [row["judge"].get("score") for row in judged if row["judge"].get("score") is not None]
        correct = [row["judge"].get("correct") for row in judged if row["judge"].get("correct") is not None]
        if scores:
            metrics["judge_score"] = sum(scores) / len(scores)
        if correct:
            metrics["judge_accuracy"] = sum(1.0 if value else 0.0 for value in correct) / len(correct)
    return {"count": len(rows), "judge_count": len(judged), "metrics": metrics}


def aggregate_groups(rows: list[dict[str, Any]], field: str) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[group_name(row.get(field))].append(row)
    return {name: aggregate(group_rows) for name, group_rows in sorted(groups.items())}


def aggregate_system(rows: list[dict[str, Any]]) -> dict[str, Any]:
    stats = {}
    for key in SYSTEM_KEYS:
        values = [row["system"][key] for row in rows if key in row["system"]]
        if values:
            stats[key] = describe(values)
    return stats


def describe(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "avg": sum(ordered) / len(ordered),
        "p50": percentile(ordered, 0.50),
        "p95": percentile(ordered, 0.95),
        "sum": sum(ordered),
    }


def percentile(ordered: list[float], p: float) -> float:
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, math.ceil(p * len(ordered)) - 1))
    return ordered[index]


def print_summary(summary: dict[str, Any]) -> None:
    print(
        "answers="
        f"{summary['num_answers']} evaluated={summary['num_evaluated']} "
        f"skipped_empty_gold={summary['skipped_empty_gold']} missing_predictions={summary['missing_predictions']}"
    )
    metrics = summary["overall"]["metrics"]
    parts = [f"{name}={metrics[name]:.4f}" for name in TEXT_METRICS]
    for optional in ("judge_score", "judge_accuracy"):
        if optional in metrics:
            parts.append(f"{optional}={metrics[optional]:.4f}")
    print("overall: " + " ".join(parts))
    system = summary.get("system") or {}
    for key in ("answer_latency_ms", "recall_latency_ms", "total_tokens"):
        if key in system:
            stats = system[key]
            print(f"{key}: avg={stats['avg']:.1f} p50={stats['p50']:.1f} p95={stats['p95']:.1f}")


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


def is_abstention(case: dict[str, Any]) -> bool:
    metadata = case.get("metadata") if isinstance(case.get("metadata"), dict) else {}
    return bool(metadata.get("is_abstention"))


def group_name(value: Any) -> str:
    return "unknown" if value is None or value == "" else str(value)


def first_number(*values: Any) -> float | None:
    for value in values:
        parsed = number(value)
        if parsed is not None:
            return parsed
    return None


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


if __name__ == "__main__":
    main()
