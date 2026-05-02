# LoCoMo ClawMem Plugin-Finalize Evaluation - 2026-04-30

This report records a full LoCoMo10 rerun using the corrected ClawMem plugin
lifecycle. Unlike the earlier raw-session baseline, this run does not store
benchmark transcripts directly as `type:memory`. It mirrors benchmark sessions
into the plugin finalization path, lets the finalize subagent extract durable
memory candidates, stores those candidates through the real ClawMem backend, and
answers from `memory_recall` output.

Raw benchmark data and run artifacts live under ignored paths `eval/data/` and
`eval/runs/`.

## Summary

Headline result:

| Metric | Value |
| --- | ---: |
| Retrieval `hit@10` | 52.81% |
| Retrieval `recall@10` | 48.10% |
| Answer judge accuracy | 31.00% |
| Memory token volume vs full-context baseline | 2.78% |
| Estimated token reduction | 97.22% |

Interpretation: the true plugin-finalize flow is far cheaper in token volume
than the raw-session baseline, but it loses much more evidence during memory
extraction and recall. The earlier raw-session run is useful as an upper-bound
retrieval baseline, not as a faithful test of how ClawMem is normally used.

## Dataset

| Item | Count |
| --- | ---: |
| Dataset | LoCoMo10 |
| Source conversations | 10 |
| Normalized QA cases | 1986 |
| Source sessions present | 272 |
| Sessions with at least one mapped extracted memory | 255 |
| Mapped extracted memory rows | 718 |
| Unique extracted memories | 701 |
| Retrieval-evaluated cases | 1977 |
| Retrieval cases skipped because no gold evidence was present | 9 |
| Answer-evaluated cases | 1542 |
| Answer cases skipped because no normalized gold answer was present | 444 |

LoCoMo category mapping used in this report:

| Category | Meaning |
| --- | --- |
| 1 | Multi-hop |
| 2 | Temporal |
| 3 | Open-domain |
| 4 | Single-hop |
| 5 | Adversarial |

## Corrected Pipeline

The run used one backend agent and one repo per LoCoMo source conversation.

1. Normalize LoCoMo into `eval/runs/locomo.cases.jsonl`.
2. Split the 10 source conversations into per-source case files.
3. For each source conversation, create or reuse one ClawMem memory repo.
4. Replay each benchmark session through the plugin finalization path.
5. Let the Codex CLI finalize subagent extract durable memory candidates.
6. Store extracted candidates through the real plugin `MemoryStore` path.
7. Build a sidecar `memory_id -> benchmark_session_id` map by probing recall
   after each finalized session.
8. Run `memory_recall` for each benchmark question.
9. Generate answers from the raw ClawMem recall text saved in
   `metadata.raw_recall`, not from the original source transcript.
10. Judge answers with Codex CLI and aggregate retrieval, QA, judge, latency,
    and token metrics.

This is the important semantic difference from the 2026-04-29 report: the
answerer only sees memory text returned by ClawMem, so answer quality reflects
both memory extraction and recall quality.

## Run Configuration

Backend and plugin:

| Setting | Value |
| --- | --- |
| Backend base URL | `https://git.clawmem.ai/api/v3` |
| Eval agent id | `eval-clawmem-locomo-plugin-finalize-20260429` |
| Saved local config | `eval/runs/clawmem-locomo-plugin-finalize-config.json` |
| Repo layout | 10 repos, one per `source_id` |
| Repo prefix | `eval-locomo-plugin-finalize-20260429` |
| Retrieval granularity | session |
| Retrieval top-k | 10 |
| Raw recall saved in predictions | yes |

Model usage:

| Stage | Model | Reasoning effort |
| --- | --- | --- |
| Memory finalize subagent | Codex CLI `gpt-5.4-mini` | `low` |
| Answer generation | Codex CLI `gpt-5.4-mini` | `low` |
| Answer judge | Codex CLI `gpt-5.4-mini` | `low` |

OpenAI API keys were not used; the run used the local Codex CLI login.

## Retrieval Results

Session-level retrieval, evaluated against LoCoMo gold evidence:

| k | Hit | Recall | Precision | MRR | NDCG |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 28.88% | 25.36% | 28.88% | 28.88% | 28.88% |
| 3 | 41.38% | 36.84% | 14.65% | 34.25% | 33.39% |
| 5 | 48.81% | 43.90% | 10.68% | 35.94% | 36.26% |
| 10 | 52.81% | 48.10% | 5.96% | 36.54% | 37.75% |

By LoCoMo category:

| Category | Cases | Hit@10 | Recall@10 |
| --- | ---: | ---: | ---: |
| Multi-hop | 281 | 67.97% | 41.22% |
| Temporal | 320 | 48.12% | 45.83% |
| Open-domain | 89 | 56.18% | 44.40% |
| Single-hop | 841 | 50.30% | 50.30% |
| Adversarial | 446 | 50.67% | 50.67% |

Per source conversation:

| Source | Cases | Mapped memories | Mapped sessions | Evaluated | Hit@5 | Hit@10 | Recall@10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `conv-26` | 199 | 72 | 19 | 196 | 56.12% | 62.24% | 57.59% |
| `conv-30` | 105 | 49 | 18 | 105 | 63.81% | 71.43% | 69.76% |
| `conv-41` | 193 | 82 | 31 | 193 | 50.26% | 58.55% | 53.28% |
| `conv-42` | 260 | 83 | 28 | 260 | 52.69% | 56.54% | 50.89% |
| `conv-43` | 242 | 83 | 29 | 242 | 58.68% | 61.98% | 56.60% |
| `conv-44` | 158 | 59 | 22 | 158 | 51.90% | 57.59% | 48.79% |
| `conv-47` | 190 | 84 | 30 | 190 | 53.16% | 55.79% | 52.39% |
| `conv-48` | 239 | 75 | 27 | 239 | 48.54% | 50.63% | 47.03% |
| `conv-49` | 196 | 60 | 24 | 193 | 58.55% | 61.66% | 53.75% |
| `conv-50` | 204 | 71 | 27 | 201 | 0.00% | 0.00% | 0.00% |

`conv-50` is the main outlier. It completed without prediction errors, but its
mapped recall ids did not match any gold sessions in the final retrieval
evaluation and its downstream QA score was also zero. Treat this as a target for
manual inspection before using the headline number as a product claim.

## Answer And Judge Results

End-to-end answer quality from ClawMem recall text:

| Metric | Value |
| --- | ---: |
| Exact match | 9.79% |
| Token F1 | 21.75% |
| BLEU-1 | 19.04% |
| Contains | 13.68% |
| Judge score | 31.00% |
| Judge accuracy | 31.00% |

By LoCoMo category:

| Category | Cases | Judge accuracy | Token F1 | Contains |
| --- | ---: | ---: | ---: | ---: |
| Multi-hop | 282 | 28.01% | 22.88% | 9.93% |
| Temporal | 321 | 19.00% | 3.60% | 2.18% |
| Open-domain | 96 | 30.21% | 17.14% | 15.62% |
| Single-hop | 841 | 36.62% | 28.76% | 19.02% |
| Adversarial | 2 | 50.00% | 50.00% | 50.00% |

By source conversation:

| Source | Cases | Judge accuracy | Token F1 | Contains |
| --- | ---: | ---: | ---: | ---: |
| `conv-26` | 154 | 29.22% | 18.15% | 8.44% |
| `conv-30` | 81 | 38.27% | 16.22% | 11.11% |
| `conv-41` | 152 | 40.13% | 25.51% | 15.79% |
| `conv-42` | 199 | 18.59% | 26.29% | 16.58% |
| `conv-43` | 178 | 35.39% | 26.44% | 14.61% |
| `conv-44` | 123 | 34.96% | 26.84% | 15.45% |
| `conv-47` | 150 | 32.67% | 26.94% | 19.33% |
| `conv-48` | 191 | 47.12% | 19.86% | 12.04% |
| `conv-49` | 156 | 37.82% | 28.72% | 21.15% |
| `conv-50` | 158 | 0.00% | 0.00% | 1.27% |

System stats over answer-evaluated cases:

| Metric | Avg | P50 | P95 |
| --- | ---: | ---: | ---: |
| Answer latency | 132110.2 ms | 131007 ms | 150527 ms |
| Recall latency | 5608.0 ms | 1869 ms | 18621 ms |
| Total latency | 137718.2 ms | 135892 ms | 157429 ms |
| Codex answer tokens | 340.3 | 69.7 | 960.1 |

Integrity checks:

| Check | Result |
| --- | ---: |
| Retrieval prediction rows | 1986 |
| Prediction errors | 0 |
| Prediction rows with raw recall saved | 1986 |
| Judged answer rows | 1986 |
| Unique judged case ids | 1986 |
| Answer generation errors retained in output | 8 |

## Token Accounting

The no-memory baseline estimates answering each QA with the full source
conversation in context. The memory path counts:

- finalize subagent token totals for memory extraction/write,
- per-question recall query tokens,
- provider-reported Codex answer total tokens when available.

| Path | Tokens |
| --- | ---: |
| No-memory full-context prompt | 44027808 |
| No-memory completion estimate | 12032 |
| No-memory total | 44039840 |
| Memory index/write, finalize subagent | 543811 |
| Memory recall query | 28787 |
| Memory answer total, provider-reported | 653075 |
| Memory total | 1225673 |
| Absolute reduction | 42814167 |
| Memory/no-memory ratio | 2.78% |
| Token reduction | 97.22% |

Notes:

- The tokenizer fell back to `approx:max(regex,char4)`, so prompt-side estimates
  are comparable approximations rather than provider-billing exact counts.
- The memory answer prompt estimate was also recorded as 1087481 tokens, but the
  memory total uses provider-reported Codex batch usage where available.
- The no-memory side was not run through the provider; it is an estimated
  full-context baseline.
- This cost result is much lower than the raw-session baseline because the
  answerer sees compact extracted memories instead of large raw conversation
  chunks. The quality drop shows the tradeoff.

## Comparison To Prior Results

These comparisons are directional. Public LoCoMo reports vary in answer models,
judges, prompts, chunking, and memory semantics.

| System | Overall LoCoMo result | Notes |
| --- | ---: | --- |
| ClawMem plugin-finalize, this run | 31.00% | Faithful plugin lifecycle; answerer sees ClawMem recall memory text |
| ClawMem raw-session baseline | 67.96% | Stores source sessions directly as memory; useful upper-bound, not faithful plugin usage |
| Mem0 | 66.88% | 2025 Mem0 paper result recorded in prior report |
| Mem0-Graph | 68.44% | 2025 Mem0 paper result recorded in prior report |
| Full-context baseline | 72.90% | Reported by Mem0 paper / later summaries |
| Newer vendor/research claims | 75%-92% | See 2026-04-29 report for the broader comparison table |

Practical read: with the corrected lifecycle, ClawMem is currently far below
published LoCoMo memory-system results on this harness. The likely bottleneck is
not only retrieval ranking; it is also memory extraction coverage and preserving
the exact evidence needed for LoCoMo questions.

## Reproduction Commands

Normalize LoCoMo:

```bash
python3 scripts/eval/normalize_benchmark.py \
  --benchmark locomo \
  --input eval/data/locomo10.json \
  --output eval/runs/locomo.cases.jsonl
```

Provision or reuse the saved ClawMem eval identity:

```bash
npx --yes tsx scripts/eval/clawmem_agent_config.ts \
  --agent-id eval-clawmem-locomo-plugin-finalize-20260429 \
  --output eval/runs/clawmem-locomo-plugin-finalize-config.json
```

Run plugin-finalize retrieval per source conversation. In the actual run these
commands were executed per source shard with `--resume --keep-going` and merged
after completion:

```bash
CLAWMEM_EVAL_CONFIG_FILE=eval/runs/clawmem-locomo-plugin-finalize-config.json \
CLAWMEM_EVAL_AGENT_ID=eval-clawmem-locomo-plugin-finalize-20260429 \
CLAWMEM_EVAL_REPO_PREFIX=eval-locomo-plugin-finalize-20260429 \
CLAWMEM_EVAL_TOP_K=10 \
CLAWMEM_EVAL_INCLUDE_RAW_RECALL=1 \
npx --yes tsx scripts/eval/clawmem_plugin_finalize_batch.ts \
  --cases eval/runs/locomo.cases.jsonl \
  --output eval/runs/locomo.clawmem.plugin_finalize.predictions.jsonl \
  --memory-map-output eval/runs/locomo.clawmem.plugin_finalize.memory_map.jsonl \
  --resume \
  --keep-going
```

Evaluate retrieval:

```bash
python3 scripts/eval/evaluate_retrieval.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.plugin_finalize.predictions.jsonl \
  --level session \
  --ks 1,3,5,10 \
  --output eval/runs/locomo.clawmem.plugin_finalize.metrics.json \
  --per-case-output eval/runs/locomo.clawmem.plugin_finalize.per_case_metrics.jsonl
```

Generate answers through Codex CLI:

```bash
python3 scripts/eval/codex_batch_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.plugin_finalize.predictions.jsonl \
  --output eval/runs/locomo.clawmem.plugin_finalize.codex.answers.jsonl \
  --level session \
  --top-k 10 \
  --batch-size 32 \
  --timeout-sec 1200 \
  --model gpt-5.4-mini \
  --reasoning-effort low \
  --resume \
  --keep-going
```

Judge answers:

```bash
python3 scripts/eval/codex_batch_judge.py \
  --cases eval/runs/locomo.cases.jsonl \
  --answers eval/runs/locomo.clawmem.plugin_finalize.codex.answers.jsonl \
  --output eval/runs/locomo.clawmem.plugin_finalize.codex.judged_answers.jsonl \
  --batch-size 64 \
  --timeout-sec 1200 \
  --model gpt-5.4-mini \
  --reasoning-effort low \
  --resume \
  --keep-going
```

Aggregate judged answer metrics:

```bash
python3 scripts/eval/evaluate_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --answers eval/runs/locomo.clawmem.plugin_finalize.codex.judged_answers.jsonl \
  --output eval/runs/locomo.clawmem.plugin_finalize.codex.judged_answer_metrics.json \
  --per-case-output eval/runs/locomo.clawmem.plugin_finalize.codex.per_case_judged_answer_metrics.jsonl
```

Estimate token usage:

```bash
python3 scripts/eval/estimate_token_usage.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.plugin_finalize.predictions.jsonl \
  --answers eval/runs/locomo.clawmem.plugin_finalize.codex.answers.jsonl \
  --output eval/runs/locomo.clawmem.plugin_finalize.codex.token_usage.json \
  --per-case-output eval/runs/locomo.clawmem.plugin_finalize.codex.per_case_token_usage.jsonl \
  --level session \
  --top-k 10 \
  --index-granularity session \
  --completion-estimate gold
```

## Caveats And Next Steps

- `conv-50` should be inspected manually before treating this as a stable
  product score.
- The sidecar map depends on post-finalize recall probing because `memory_list`
  was not reliable enough for mapping in this backend run.
- Some sessions finalized into no durable memory, which is a realistic plugin
  behavior but hurts LoCoMo evidence coverage.
- The judge uses Codex CLI `gpt-5.4-mini`, not the official LoCoMo judge setup.
- The next useful experiments are finer memory extraction prompts, temporal
  metadata preservation, stronger reranking, and a source-level debug report for
  sessions whose gold evidence was never extracted.
