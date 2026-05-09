#!/usr/bin/env python3
"""Evaluate retrieval predictions against normalized benchmark cases."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, help="Normalized cases JSONL.")
    parser.add_argument("--predictions", required=True, help="Predictions JSONL.")
    parser.add_argument("--level", choices=["session", "turn"], default="session")
    parser.add_argument("--ks", default="1,3,5,10", help="Comma-separated cutoff values.")
    parser.add_argument("--output", help="Optional metrics JSON path.")
    parser.add_argument("--per-case-output", help="Optional per-case metrics JSONL path.")
    parser.add_argument("--include-empty-gold", action="store_true", help="Include cases with no gold ids.")
    parser.add_argument("--exclude-abstention", action="store_true", help="Skip LongMemEval abstention cases.")
    args = parser.parse_args()

    ks = parse_ks(args.ks)
    cases = {case["case_id"]: case for case in read_jsonl(Path(args.cases))}
    predictions = {prediction["case_id"]: prediction for prediction in read_jsonl(Path(args.predictions))}

    rows = []
    skipped_empty_gold = 0
    skipped_abstention = 0
    missing_predictions = 0
    for case_id, case in cases.items():
        if args.exclude_abstention and is_abstention(case):
            skipped_abstention += 1
            continue
        gold = gold_ids(case, args.level)
        if not gold and not args.include_empty_gold:
            skipped_empty_gold += 1
            continue
        prediction = predictions.get(case_id)
        if prediction is None:
            missing_predictions += 1
            predicted: list[str] = []
        else:
            predicted = predicted_ids(prediction, args.level)
        rows.append(score_case(case, predicted, gold, ks, args.level, prediction is None))

    summary = {
        "level": args.level,
        "ks": ks,
        "num_cases": len(cases),
        "num_evaluated": len(rows),
        "skipped_empty_gold": skipped_empty_gold,
        "skipped_abstention": skipped_abstention,
        "missing_predictions": missing_predictions,
        "overall": aggregate(rows, ks),
        "by_benchmark": aggregate_groups(rows, ks, "benchmark"),
        "by_question_type": aggregate_groups(rows, ks, "question_type"),
        "by_abstention": aggregate_groups(rows, ks, "is_abstention"),
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


def parse_ks(value: str) -> list[int]:
    ks = sorted({int(part.strip()) for part in value.split(",") if part.strip()})
    if not ks or any(k <= 0 for k in ks):
        raise ValueError("--ks must contain positive integers")
    return ks


def gold_ids(case: dict[str, Any], level: str) -> list[str]:
    field = "gold_session_ids" if level == "session" else "gold_turn_ids"
    return unique_strings(case.get(field))


def predicted_ids(prediction: dict[str, Any], level: str) -> list[str]:
    primary = "retrieved_session_ids" if level == "session" else "retrieved_turn_ids"
    if primary in prediction:
        return unique_strings(prediction.get(primary))
    if "retrieval_results" in prediction:
        return ids_from_objects(prediction.get("retrieval_results"), level)
    if "retrieved" in prediction:
        return ids_from_objects(prediction.get("retrieved"), level)
    return []


def ids_from_objects(value: Any, level: str) -> list[str]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            keys = ["session_id", "id"] if level == "session" else ["turn_id", "id"]
            for key in keys:
                if item.get(key) is not None:
                    out.append(str(item[key]))
                    break
    return unique_strings(out)


def score_case(
    case: dict[str, Any],
    predicted: list[str],
    gold: list[str],
    ks: list[int],
    level: str,
    missing_prediction: bool,
) -> dict[str, Any]:
    gold_set = set(gold)
    row: dict[str, Any] = {
        "case_id": case["case_id"],
        "benchmark": case.get("benchmark") or "",
        "source_id": case.get("source_id") or "",
        "question_type": case.get("question_type") or "",
        "is_abstention": is_abstention(case),
        "level": level,
        "num_gold": len(gold_set),
        "num_predicted": len(predicted),
        "missing_prediction": missing_prediction,
        "metrics": {},
    }
    for k in ks:
        top = predicted[:k]
        hits = sum(1 for item in top if item in gold_set)
        first_rank = next((index + 1 for index, item in enumerate(top) if item in gold_set), None)
        row["metrics"][str(k)] = {
            "hit": 1.0 if hits > 0 else 0.0,
            "recall": hits / len(gold_set) if gold_set else (1.0 if not top else 0.0),
            "precision": hits / k,
            "mrr": 1.0 / first_rank if first_rank else 0.0,
            "ndcg": ndcg(top, gold_set, k),
        }
    return row


def ndcg(predicted: list[str], gold: set[str], k: int) -> float:
    if not gold:
        return 1.0 if not predicted[:k] else 0.0
    dcg = 0.0
    for index, item in enumerate(predicted[:k]):
        if item in gold:
            dcg += 1.0 / math.log2(index + 2)
    ideal_hits = min(len(gold), k)
    ideal = sum(1.0 / math.log2(index + 2) for index in range(ideal_hits))
    return dcg / ideal if ideal else 0.0


def aggregate(rows: list[dict[str, Any]], ks: list[int]) -> dict[str, Any]:
    if not rows:
        return {"count": 0, "metrics": {}}
    metrics = {}
    for k in ks:
        key = str(k)
        metrics[key] = {
            name: sum(row["metrics"][key][name] for row in rows) / len(rows)
            for name in ("hit", "recall", "precision", "mrr", "ndcg")
        }
    return {"count": len(rows), "metrics": metrics}


def aggregate_groups(rows: list[dict[str, Any]], ks: list[int], field: str) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[group_name(row.get(field))].append(row)
    return {name: aggregate(group_rows, ks) for name, group_rows in sorted(groups.items())}


def print_summary(summary: dict[str, Any]) -> None:
    print(
        f"level={summary['level']} evaluated={summary['num_evaluated']} "
        f"skipped_empty_gold={summary['skipped_empty_gold']} "
        f"skipped_abstention={summary.get('skipped_abstention', 0)} "
        f"missing_predictions={summary['missing_predictions']}"
    )
    overall = summary["overall"]["metrics"]
    for k in summary["ks"]:
        metrics = overall[str(k)]
        print(
            f"@{k}: "
            f"hit={metrics['hit']:.4f} "
            f"recall={metrics['recall']:.4f} "
            f"precision={metrics['precision']:.4f} "
            f"mrr={metrics['mrr']:.4f} "
            f"ndcg={metrics['ndcg']:.4f}"
        )


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


def is_abstention(case: dict[str, Any]) -> bool:
    metadata = case.get("metadata") if isinstance(case.get("metadata"), dict) else {}
    return bool(metadata.get("is_abstention"))


def group_name(value: Any) -> str:
    return "unknown" if value is None or value == "" else str(value)


if __name__ == "__main__":
    main()
