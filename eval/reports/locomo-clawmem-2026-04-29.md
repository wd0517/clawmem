# LoCoMo ClawMem Evaluation - 2026-04-29

This report records a full LoCoMo10 evaluation of ClawMem using the real
backend. Raw benchmark data and run artifacts are intentionally not committed;
they live under ignored paths `eval/data/` and `eval/runs/`.

## Summary

ClawMem was evaluated with one backend agent and one memory repo per LoCoMo
source conversation. The primary end-to-end answer run used Codex CLI
`gpt-5.4-mini` for answer generation and LLM-as-judge scoring.

Headline result:

- Retrieval `hit@10`: 81.94%
- Retrieval `recall@10`: 77.84%
- Answer judge accuracy: 67.96%
- Memory token volume vs full-context baseline: 20.26%
- Estimated token reduction: 79.74%

Interpretation: this ClawMem run is close to 2025-era Mem0/Mem0-Graph LoCoMo
results, but trails stronger 2026 vendor and research claims. The strongest
local result is single-hop recall; the weakest areas are multi-hop and
open-domain answer quality.

## Dataset

- Dataset: LoCoMo10
- Source conversations: 10
- Normalized QA cases: 1986
- Sessions indexed: 272
- Turns present: 5882
- Primary answer evaluation cases: 1542
- Answer cases skipped because the normalized case had no gold answer: 444
- Retrieval evaluation cases: 1977
- Retrieval cases skipped because no gold evidence was present: 9

LoCoMo category mapping used in this report:

| Category | Meaning |
| --- | --- |
| 1 | Multi-hop |
| 2 | Temporal |
| 3 | Open-domain |
| 4 | Single-hop |
| 5 | Adversarial |

Category 5 adversarial questions mostly do not include normal gold answers in
the local normalized answer metric and are therefore excluded from the primary
answer judge accuracy.

## Run Configuration

Backend layout:

- Agent: `eval-clawmem-locomo-20260429`
- Repos: 10, one per `source_id`
- Repo prefix: `eval-locomo-20260429`
- Retrieval granularity: session
- Retrieval top-k: 10
- Backend base URL: `https://git.clawmem.ai/api/v3`

Primary model configuration:

- Answer model: Codex CLI `gpt-5.4-mini`
- Answer reasoning effort: `low`
- Judge model: Codex CLI `gpt-5.4-mini`
- Judge reasoning effort: `low`
- OpenAI API key: not used

A small `gpt-5.5` smoke/pilot run was also completed after upgrading Codex CLI,
but it is not used as the primary headline result.

## Retrieval Results

Session-level retrieval, evaluated against LoCoMo gold evidence:

| k | Hit | Recall | Precision | MRR | NDCG |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 36.77% | 32.72% | 36.77% | 36.77% | 36.77% |
| 3 | 58.73% | 52.95% | 20.94% | 46.59% | 46.44% |
| 5 | 68.54% | 63.24% | 15.32% | 48.81% | 50.67% |
| 10 | 81.94% | 77.84% | 9.65% | 50.62% | 55.67% |

Per source conversation:

| Source | Evaluated cases | Hit@5 | Hit@10 |
| --- | ---: | ---: | ---: |
| `conv-26` | 196 | 71.43% | 86.22% |
| `conv-30` | 105 | 76.19% | 94.29% |
| `conv-41` | 193 | 58.03% | 74.09% |
| `conv-42` | 260 | 63.46% | 78.46% |
| `conv-43` | 242 | 64.88% | 79.34% |
| `conv-44` | 158 | 72.78% | 84.18% |
| `conv-47` | 190 | 78.42% | 85.79% |
| `conv-48` | 239 | 69.87% | 81.17% |
| `conv-49` | 193 | 68.39% | 84.46% |
| `conv-50` | 201 | 68.66% | 79.60% |

Retrieval latency:

| Metric | Value |
| --- | ---: |
| Recall latency avg | 2388.2 ms |
| Recall latency p50 | 1700 ms |
| Recall latency p95 | 7200 ms |
| Recall latency max | 11327 ms |
| Index latency total | 937919 ms |
| Index latency avg/source | 93791.9 ms |
| Index latency max/source | 122508 ms |

## Answer And Judge Results

End-to-end answer quality from retrieved memory context:

| Metric | Value |
| --- | ---: |
| Exact match | 22.37% |
| Token F1 | 48.27% |
| BLEU-1 | 42.54% |
| Contains | 34.57% |
| Judge score | 68.28% |
| Judge accuracy | 67.96% |

By LoCoMo category:

| Category | Cases | Judge score | Judge accuracy | Token F1 | Contains |
| --- | ---: | ---: | ---: | ---: | ---: |
| Multi-hop | 282 | 52.32% | 51.06% | 39.21% | 16.31% |
| Temporal | 321 | 59.75% | 59.81% | 34.32% | 16.51% |
| Open-domain | 96 | 44.27% | 43.75% | 26.75% | 19.79% |
| Single-hop | 841 | 79.67% | 79.55% | 59.09% | 49.23% |
| Adversarial | 2 | 50.00% | 50.00% | 50.00% | 50.00% |

The adversarial row is not meaningful as a headline number because most
category 5 cases are skipped by the current answer evaluator when no normal
gold answer is present.

System stats over the 1542 answer-evaluated cases:

| Metric | Avg | P50 | P95 |
| --- | ---: | ---: | ---: |
| Answer latency | 7471.5 ms | 6536 ms | 11629 ms |
| Recall latency | 2462.4 ms | 1794 ms | 7336 ms |
| Total latency | 9933.9 ms | 8885 ms | 15382 ms |
| Codex answer tokens | 4412.1 | 4656.5 | 6423.2 |

## Token Accounting

The token comparison uses a full-context no-memory baseline: answer every QA by
putting the full source conversation in the prompt. The memory path counts:

- one-time session memory write/index payload tokens,
- per-question recall query tokens,
- provider-reported Codex answer total tokens when present.

| Path | Tokens |
| --- | ---: |
| No-memory full-context prompt | 44027808 |
| No-memory completion estimate | 12032 |
| No-memory total | 44039840 |
| Memory index/write | 245214 |
| Memory recall query | 28787 |
| Memory answer total, provider-reported | 8646444 |
| Memory total | 8920445 |
| Absolute reduction | 35119395 |
| Memory/no-memory ratio | 20.26% |
| Token reduction | 79.74% |

Caveats:

- The no-memory side is estimated, not a full provider-billed run.
- The memory answer side uses Codex CLI reported total tokens, amortized per
  batch.
- Hidden ClawMem backend costs such as extraction, summarization, embeddings, or
  internal service overhead are not included unless represented in the payload
  text counted by this harness.
- The local tokenizer fell back to `approx:max(regex,char4)` because `tiktoken`
  was not installed.

## Public Comparison

These numbers are not perfectly apples-to-apples. Public LoCoMo reports often
use different answer models, prompts, judges, memory chunking, and service
versions. Some public reports also disagree on historical baselines such as Zep
and A-Mem. Treat the table as orientation, not a leaderboard claim.

| System | Overall LoCoMo result | Notes |
| --- | ---: | --- |
| ClawMem, this run | 67.96% | Codex CLI `gpt-5.4-mini` judge; real ClawMem backend; session top-k=10 |
| Mem0-Graph | 68.44% | 2025 Mem0 paper result |
| Mem0 | 66.88% | 2025 Mem0 paper result |
| Zep | 65.99% | 2025 Mem0 paper-reported result |
| LangMem | 58.10% | 2025 Mem0 paper result |
| A-Mem | 48.38% | 2025 Mem0 paper result |
| Full-context baseline | 72.90% | Reported by Mem0 paper / later summaries |
| Memobase v0.0.37 | 75.78% | Memobase benchmark README |
| Zep, updated third-party run | 75.14% | Memobase / Backboard benchmark README |
| StructMem | 76.82% | 2026 OpenReview preprint |
| Zep, vendor claim | 80.32% | Zep marketing benchmark page |
| Hindsight, OSS-20B | 83.18% | Hindsight benchmark README |
| Hindsight, Gemini-3 | 89.61% | Hindsight benchmark README |
| Backboard, vendor claim | 90.0% | Backboard benchmark/changelog page |
| Mem0 new algorithm, vendor claim | 91.6% | Mem0 April 2026 blog/docs |

Practical read: ClawMem is competitive with 2025 Mem0/Mem0-Graph style results,
but behind newer systems that report stronger graph/entity/reranking,
structured memory, or dedicated long-term memory pipelines.

## Improvement Hypotheses

The gap between `hit@10 = 81.94%` and `judge accuracy = 67.96%` suggests that
the right source session is often present, but the answer model still fails to
extract the exact fact. The most likely next improvements are:

- index at a finer granularity than full sessions,
- rerank retrieved memories before answer context assembly,
- include stronger temporal metadata and temporal query handling,
- preserve speaker ownership and entity links in stored memory,
- reduce noisy context around the relevant evidence.

## Reproduction Commands

Normalize LoCoMo:

```bash
python3 scripts/eval/normalize_benchmark.py \
  --benchmark locomo \
  --input eval/data/locomo10.json \
  --output eval/runs/locomo.cases.jsonl
```

Run ClawMem real-backend retrieval:

```bash
CLAWMEM_EVAL_AGENT_ID=eval-clawmem-locomo-20260429 \
CLAWMEM_EVAL_REPO_PREFIX=eval-locomo-20260429 \
CLAWMEM_EVAL_TOP_K=10 \
npx --yes tsx scripts/eval/clawmem_retrieval_batch.ts \
  --cases eval/runs/locomo.cases.jsonl \
  --output eval/runs/locomo.clawmem.session.predictions.jsonl
```

Evaluate retrieval:

```bash
python3 scripts/eval/evaluate_retrieval.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --level session \
  --ks 1,3,5,10 \
  --output eval/runs/locomo.clawmem.session.metrics.json \
  --per-case-output eval/runs/locomo.clawmem.session.per_case_metrics.jsonl
```

Generate answers through Codex CLI:

```bash
python3 scripts/eval/codex_batch_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --output eval/runs/locomo.clawmem.session.codex.answers.jsonl \
  --level session \
  --top-k 10 \
  --batch-size 4 \
  --timeout-sec 900 \
  --model gpt-5.4-mini \
  --reasoning-effort low \
  --resume \
  --keep-going
```

Judge answers through Codex CLI:

```bash
python3 scripts/eval/codex_batch_judge.py \
  --cases eval/runs/locomo.cases.jsonl \
  --answers eval/runs/locomo.clawmem.session.codex.answers.jsonl \
  --output eval/runs/locomo.clawmem.session.codex.judged_answers.jsonl \
  --batch-size 32 \
  --timeout-sec 900 \
  --model gpt-5.4-mini \
  --reasoning-effort low \
  --resume \
  --keep-going
```

Evaluate judged answers:

```bash
python3 scripts/eval/evaluate_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --answers eval/runs/locomo.clawmem.session.codex.judged_answers.jsonl \
  --output eval/runs/locomo.clawmem.session.codex.judged_answer_metrics.json \
  --per-case-output eval/runs/locomo.clawmem.session.codex.per_case_judged_answer_metrics.jsonl
```

Estimate token usage:

```bash
python3 scripts/eval/estimate_token_usage.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --answers eval/runs/locomo.clawmem.session.codex.answers.jsonl \
  --output eval/runs/locomo.clawmem.session.codex.token_usage.json \
  --level session \
  --top-k 10 \
  --index-granularity session
```

## Local Artifact Paths

These files were generated locally and are ignored by git:

- `eval/runs/locomo.cases.jsonl`
- `eval/runs/locomo.clawmem.session.predictions.jsonl`
- `eval/runs/locomo.clawmem.session.metrics.json`
- `eval/runs/locomo.clawmem.session.codex.answers.jsonl`
- `eval/runs/locomo.clawmem.session.codex.judged_answers.jsonl`
- `eval/runs/locomo.clawmem.session.codex.judged_answer_metrics.json`
- `eval/runs/locomo.clawmem.session.codex.token_usage.json`

## References

- LoCoMo dataset: https://github.com/snap-research/locomo
- Mem0 paper HTML mirror: https://ar5iv.labs.arxiv.org/html/2504.19413v1
- Memobase LoCoMo benchmark README: https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md
- Backboard LoCoMo benchmark README: https://github.com/Backboard-io/Backboard-Locomo-Benchmark
- Backboard benchmark/changelog page: https://backboard.io/changelog/best-ai-memory-score-in-the-world
- Hindsight benchmark README: https://github.com/vectorize-io/hindsight-benchmarks
- StructMem preprint: https://openreview.net/pdf/568a18c27dfbe54943d359928a5af24df7eb5afb.pdf
- Zep benchmark page: https://www.getzep.com/mem0-alternative/
- Mem0 April 2026 token-efficient algorithm blog: https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm
