# LongMemEval_S ClawMem Pilot - 2026-04-29

This is an initial LongMemEval_S pilot using the real ClawMem backend. It is not
a final benchmark result. The goal was to validate the LoCoMo-style evaluation
path on LongMemEval, confirm the right metrics, and estimate full-run cost.

## Metric Choice

LongMemEval's headline metric is QA correctness judged by an LLM. In this
harness that is `judge_accuracy` from judged answer outputs. Retrieval metrics
are still useful diagnostics, but they should be reported separately.

Recommended LongMemEval reporting:

- QA: `judge_accuracy`, overall and by `question_type`.
- Abstention QA: include abstention questions in answer/judge metrics and report
  them separately.
- Retrieval: session-level `hit@k`, `recall@k`, `precision@k`, `mrr@k`, and
  `ndcg@k`.
- Retrieval abstention: skip abstention questions with `--exclude-abstention`,
  matching the official LongMemEval retrieval guidance.
- Cost: no-memory full-history tokens versus memory write + recall + answer
  tokens. LongMemEval has one question per history, so memory write cost is not
  amortized like LoCoMo.

## Dataset Scale

Downloaded file:

- `eval/data/longmemeval_s_cleaned.json`

Normalized file:

- `eval/runs/longmemeval_s.cases.jsonl`

Observed LongMemEval_S cleaned scale:

| Item | Value |
| --- | ---: |
| Cases | 500 |
| Abstention cases | 30 |
| Sessions | 23867 |
| Turns | 246750 |
| Avg sessions/case | 47.73 |
| Avg turns/case | 493.5 |
| Gold sessions | 948 |
| Gold turns | 896 |

Question type distribution:

| Question type | Count |
| --- | ---: |
| `knowledge-update` | 78 |
| `multi-session` | 133 |
| `single-session-assistant` | 56 |
| `single-session-preference` | 30 |
| `single-session-user` | 70 |
| `temporal-reasoning` | 133 |

## Pilot Sample

The pilot used 8 cases:

- one non-abstention case per LongMemEval question type,
- two abstention cases.

File:

- `eval/runs/longmemeval_s.sample8.cases.jsonl`

## Backend Layout

- Agent: `eval-clawmem-longmemeval-s-sample8-20260429`
- Repo layout: one memory repo per LongMemEval question/history
- Retrieval granularity: session
- Retrieval top-k: 10
- Answer model: Codex CLI `gpt-5.4-mini`
- Judge model: Codex CLI `gpt-5.4-mini`

The first sample run exposed the need for resumable retrieval. The batch runner
now supports:

- `--resume`
- `--keep-going`
- `CLAWMEM_EVAL_STORE_TIMEOUT_MS`
- `CLAWMEM_EVAL_RECALL_TIMEOUT_MS`

## Pilot Retrieval Results

Session-level retrieval, excluding the 2 abstention cases:

| k | Hit | Recall | Precision | MRR | NDCG |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 83.33% | 55.56% | 83.33% | 83.33% | 83.33% |
| 3 | 83.33% | 66.67% | 38.89% | 83.33% | 70.44% |
| 5 | 83.33% | 83.33% | 30.00% | 83.33% | 79.24% |
| 10 | 83.33% | 83.33% | 15.00% | 83.33% | 79.24% |

Backend timing over all 8 pilot cases:

| Metric | Value |
| --- | ---: |
| Indexed session items | 385 |
| Index latency total | 1752066 ms |
| Index latency avg/case | 219008.25 ms |
| Index latency per session item | 4550.82 ms |
| Recall latency avg/case | 5312.38 ms |

At the observed pilot speed, a full 23867-session LongMemEval_S session-level
run would be roughly day-scale. It should be run as a resumable long task, not
as an interactive foreground command.

## Pilot QA Results

End-to-end QA over all 8 pilot cases:

| Metric | Value |
| --- | ---: |
| Exact match | 0.00% |
| Token F1 | 14.75% |
| BLEU-1 | 9.68% |
| Contains | 0.00% |
| Judge score | 25.00% |
| Judge accuracy | 25.00% |

By abstention status:

| Abstention | Cases | Judge accuracy |
| --- | ---: | ---: |
| False | 6 | 33.33% |
| True | 2 | 0.00% |

Per-case judge outcomes:

| Case | Type | Abstention | Correct | Answer |
| --- | --- | ---: | ---: | --- |
| `longmemeval:6a1eabeb` | `knowledge-update` | false | true | `25:50` |
| `longmemeval:0a995998` | `multi-session` | false | false | `I don't know.` |
| `longmemeval:7161e7e2` | `single-session-assistant` | false | true | `Admon was on the Sunday rotation for the 8 am - 4 pm shift.` |
| `longmemeval:8a2466db` | `single-session-preference` | false | false | long Premiere Pro resource list |
| `longmemeval:e47becba` | `single-session-user` | false | false | `I don't know.` |
| `longmemeval:gpt4_59149c77` | `temporal-reasoning` | false | false | `I don't know.` |
| `longmemeval:0862e8bf_abs` | `single-session-user` | true | false | `Luna` |
| `longmemeval:15745da0_abs` | `single-session-user` | true | false | `I don't know.` |

## Pilot Token Accounting

For this 8-case sample:

| Path | Tokens |
| --- | ---: |
| No-memory full-history total | 1019665 |
| Memory index/write | 1057392 |
| Memory recall query | 154 |
| Memory answer total, provider-reported | 1116 |
| Memory total | 1058662 |
| Memory/no-memory ratio | 103.82% |
| Token reduction | -3.82% |

This is expected for LongMemEval-style data: each history generally serves one
question, so memory write cost is not amortized. Memory may still reduce answer
prompt size, but the write/index cost can dominate unless the memories are
reused across many questions or backend write costs are excluded from the
serving-time budget.

## Reproduction Commands

Download through the local proxy:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
ALL_PROXY=http://127.0.0.1:7890 \
curl -L --fail --retry 5 --retry-delay 5 --connect-timeout 30 \
  -C - \
  -o eval/data/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

Normalize:

```bash
python3 scripts/eval/normalize_benchmark.py \
  --benchmark longmemeval \
  --input eval/data/longmemeval_s_cleaned.json \
  --output eval/runs/longmemeval_s.cases.jsonl
```

Run sample retrieval:

```bash
CLAWMEM_EVAL_AGENT_ID=eval-clawmem-longmemeval-s-sample8-20260429 \
CLAWMEM_EVAL_REPO_PREFIX=eval-longmemeval-s-sample8-20260429 \
CLAWMEM_EVAL_TOP_K=10 \
CLAWMEM_EVAL_STORE_TIMEOUT_MS=120000 \
CLAWMEM_EVAL_RECALL_TIMEOUT_MS=120000 \
npx --yes tsx scripts/eval/clawmem_retrieval_batch.ts \
  --cases eval/runs/longmemeval_s.sample8.cases.jsonl \
  --output eval/runs/longmemeval_s.sample8.clawmem.session.predictions.jsonl \
  --resume \
  --keep-going
```

Evaluate retrieval:

```bash
python3 scripts/eval/evaluate_retrieval.py \
  --cases eval/runs/longmemeval_s.sample8.cases.jsonl \
  --predictions eval/runs/longmemeval_s.sample8.clawmem.session.predictions.jsonl \
  --level session \
  --ks 1,3,5,10 \
  --exclude-abstention \
  --output eval/runs/longmemeval_s.sample8.clawmem.session.metrics.json
```

Generate answers:

```bash
python3 scripts/eval/codex_batch_answers.py \
  --cases eval/runs/longmemeval_s.sample8.cases.jsonl \
  --predictions eval/runs/longmemeval_s.sample8.clawmem.session.predictions.jsonl \
  --output eval/runs/longmemeval_s.sample8.clawmem.session.codex.answers.jsonl \
  --level session \
  --top-k 10 \
  --batch-size 4 \
  --timeout-sec 900 \
  --model gpt-5.4-mini \
  --reasoning-effort low \
  --resume \
  --keep-going
```

Judge answers:

```bash
python3 scripts/eval/codex_batch_judge.py \
  --cases eval/runs/longmemeval_s.sample8.cases.jsonl \
  --answers eval/runs/longmemeval_s.sample8.clawmem.session.codex.answers.jsonl \
  --output eval/runs/longmemeval_s.sample8.clawmem.session.codex.judged_answers.jsonl \
  --batch-size 8 \
  --timeout-sec 900 \
  --model gpt-5.4-mini \
  --reasoning-effort low \
  --resume \
  --keep-going
```

## Next Full-Run Options

1. Full LongMemEval_S session-level retrieval and QA. Most faithful, but likely
   day-scale at current backend write latency.
2. Stratified 60-case subset. Much faster and enough to compare failure modes
   across question types and abstention.
3. Oracle retrieval QA using `longmemeval_oracle.json`. This tests answer
   generation from evidence sessions, not ClawMem retrieval.
4. Turn-level retrieval. More diagnostic, but much heavier because the S split
   contains roughly 247k turns.
