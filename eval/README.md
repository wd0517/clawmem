# ClawMem Benchmark Evaluation

This directory is for benchmark-style memory evaluation, not unit tests.

The first supported target is retrieval and answer quality on LoCoMo and
LongMemEval style data. The harness normalizes both datasets into one JSONL case
format, accepts retrieval predictions from any memory system, can generate
answers from retrieved context, and reports retrieval, answer, judge, latency,
and token metrics.

## Recorded Results

- [LoCoMo ClawMem Plugin-Finalize Evaluation - 2026-04-30](reports/locomo-clawmem-plugin-finalize-2026-04-30.md):
  corrected full LoCoMo10 run through the real plugin finalization lifecycle.
  This is the faithful ClawMem behavior test; answer context comes from
  `memory_recall` output, not raw source transcripts.
- [LoCoMo ClawMem Evaluation - 2026-04-29](reports/locomo-clawmem-2026-04-29.md):
  full LoCoMo10 run against the real ClawMem backend, including retrieval,
  answer/judge, token accounting, and public comparison notes. This run stored
  raw source sessions directly as memories and should be treated as a baseline,
  not the faithful plugin lifecycle result.
- [LongMemEval_S ClawMem Pilot - 2026-04-29](reports/longmemeval-s-clawmem-pilot-2026-04-29.md):
  initial LongMemEval_S cleaned pilot, metric choices, backend cost estimate,
  and next full-run options.

## Sources

- LoCoMo: https://github.com/snap-research/locomo
- LongMemEval: https://github.com/xiaowu0162/LongMemEval
- LongMemEval cleaned data: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned

Do not commit the official benchmark datasets to this repo.

## Data Preparation

LoCoMo:

```bash
mkdir -p eval/data eval/runs
curl -L -o eval/data/locomo10.json \
  https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json

python3 scripts/eval/normalize_benchmark.py \
  --benchmark locomo \
  --input eval/data/locomo10.json \
  --output eval/runs/locomo.cases.jsonl
```

LongMemEval:

```bash
mkdir -p eval/data eval/runs
# Download one of the official files, for example longmemeval_s_cleaned.json,
# from the Hugging Face dataset page above.

python3 scripts/eval/normalize_benchmark.py \
  --benchmark longmemeval \
  --input eval/data/longmemeval_s_cleaned.json \
  --output eval/runs/longmemeval_s.cases.jsonl
```

## Prediction Format

Each prediction is one JSON object per line:

```json
{
  "case_id": "longmemeval:example_question",
  "retrieved_session_ids": ["session_17", "session_03"],
  "retrieved_turn_ids": ["session_17:turn_0002"]
}
```

Only `case_id` and the ids for the level being evaluated are required.

## Run A System Adapter

Use `run_case_adapter.py` when a memory system can evaluate one normalized case at
a time. The adapter command receives one case JSON object on stdin and must write
one prediction JSON object on stdout.

```bash
python3 scripts/eval/run_case_adapter.py \
  --cases eval/runs/longmemeval_s.cases.jsonl \
  --command "python3 path/to/your_adapter.py" \
  --output eval/runs/longmemeval_s.clawmem.predictions.jsonl \
  --timeout-sec 120
```

An adapter is responsible for indexing the `sessions` field, querying with the
case `question`, and returning `retrieved_session_ids` and/or
`retrieved_turn_ids`. This keeps the benchmark harness independent of any one
runtime.

## Run ClawMem Against The Real Backend

`scripts/eval/adapters/clawmem_retrieval_adapter.ts` uses the actual plugin and
the real ClawMem backend. It starts with an empty agent config, lets the plugin
provision an agent through `POST /api/v3/agents`, indexes each case with
`memory_store`, then queries with `memory_recall`.

By default it indexes one memory per session. This keeps real-backend benchmark
runs reasonably small while supporting LoCoMo and LongMemEval session-level
retrieval. Use `CLAWMEM_EVAL_INDEX_GRANULARITY=turn` when you want turn-level
gold evidence.

```bash
python3 scripts/eval/run_case_adapter.py \
  --cases eval/runs/locomo.cases.jsonl \
  --command "npx --yes tsx scripts/eval/adapters/clawmem_retrieval_adapter.ts" \
  --output eval/runs/locomo.clawmem.session.predictions.jsonl \
  --timeout-sec 600 \
  --limit 3

python3 scripts/eval/evaluate_retrieval.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --level session \
  --ks 1,3,5,10
```

Useful environment variables:

- `CLAWMEM_EVAL_BASE_URL`: defaults to `https://git.clawmem.ai/api/v3`.
- `CLAWMEM_EVAL_INDEX_GRANULARITY`: `session` or `turn`; defaults to `session`.
- `CLAWMEM_EVAL_TOP_K`: recall cutoff requested from `memory_recall`, max 20.
- `CLAWMEM_EVAL_AGENT_PREFIX`: prefix for provisioned benchmark agents.
- `CLAWMEM_EVAL_MAX_INDEX_ITEMS`: optional cap for quick shakedown runs.
- `CLAWMEM_EVAL_CONFIG_FILE`: optional local JSON config containing saved
  agent tokens. Files under `eval/runs/` are ignored by git.
- `CLAWMEM_EVAL_INCLUDE_RAW_RECALL=1`: include raw tool output in predictions.

Real-backend runs create backend identities and memory repos. Start with
`--limit` and a small fixture before running full benchmark splits.

To save a reusable ClawMem agent token locally:

```bash
npx --yes tsx scripts/eval/clawmem_agent_config.ts \
  --agent-id eval-clawmem-plugin-finalize-mini-20260429 \
  --output eval/runs/clawmem-eval-agent-config.json
```

Then reuse it in later eval commands:

```bash
CLAWMEM_EVAL_CONFIG_FILE=eval/runs/clawmem-eval-agent-config.json \
npx --yes tsx scripts/eval/clawmem_plugin_finalize_batch.ts \
  --cases eval/runs/longmemeval-mini.plugin-finalize.cases.jsonl \
  --output eval/runs/longmemeval-mini.clawmem.plugin_finalize.predictions.jsonl
```

For faithful plugin-lifecycle evaluation, use
`clawmem_plugin_finalize_batch.ts`. This runner mirrors benchmark sessions into
the plugin finalization flow, lets the finalize subagent extract durable memory
candidates, stores those through the real backend, and saves raw
`memory_recall` text for downstream answer generation.

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

For the raw-session baseline, use the older batch runner. It groups normalized
cases by `source_id`, provisions one backend agent identity for the whole run,
creates one memory repo per source conversation, indexes that conversation once
into its repo, then runs recall for all questions in the group.

```bash
npx --yes tsx scripts/eval/clawmem_retrieval_batch.ts \
  --cases eval/runs/locomo.cases.jsonl \
  --output eval/runs/locomo.clawmem.session.predictions.jsonl

python3 scripts/eval/evaluate_retrieval.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --level session \
  --ks 1,3,5,10 \
  --output eval/runs/locomo.clawmem.session.metrics.json
```

This is the recommended LoCoMo layout for ClawMem:

```text
one eval agent
  eval-locomo-conv-26-* repo
  eval-locomo-conv-30-* repo
  ...
  eval-locomo-conv-50-* repo
```

Useful batch-specific environment variables:

- `CLAWMEM_EVAL_AGENT_ID`: stable agent identity for the whole benchmark run.
- `CLAWMEM_EVAL_REPO_PREFIX`: prefix for source-conversation repos.
- `CLAWMEM_EVAL_STORE_TIMEOUT_MS`: timeout for each `memory_store` call.
- `CLAWMEM_EVAL_RECALL_TIMEOUT_MS`: timeout for each `memory_recall` call.

Batch runner resilience flags:

- `--resume`: append to an existing prediction file and skip completed case ids.
- `--keep-going`: write error predictions and continue when a source fails.

For LongMemEval_S, each question has its own independent history. A full
session-level run therefore creates roughly one repo per question and indexes
about 24k sessions for the 500-case split. Use `--resume`, `--keep-going`, and
timeouts for these long runs.

## LongMemEval Metrics

LongMemEval's headline QA metric is answer correctness judged by an LLM, similar
to the official `evaluate_qa.py` flow. The harness reports this as
`judge_accuracy` after running `judge_answers.py` or `codex_batch_judge.py`.

Recommended reporting:

- QA: `judge_accuracy` overall, by `question_type`, and by abstention status.
- Retrieval: session-level `hit@k`, `recall@k`, `precision@k`, `mrr@k`, and
  `ndcg@k`.
- Abstention: include abstention cases for QA correctness, but skip them for
  retrieval metrics with `--exclude-abstention`, matching the official
  retrieval guidance.
- Cost: report no-memory full-history tokens versus memory write + recall +
  answer tokens. Unlike LoCoMo, LongMemEval usually has one question per
  history, so memory write cost is not heavily amortized.

## Generate And Evaluate Answers

Retrieval metrics say whether the right memory was found. Answer metrics say
whether a model can answer the benchmark question from those retrieved memories.

`generate_answers.py` builds a context from the retrieved session or turn ids and
then either calls an answerer command or an OpenAI-compatible chat completions
endpoint. The answerer input intentionally omits the gold answer.

With an OpenAI-compatible endpoint:

```bash
EVAL_LLM_MODEL=gpt-4o-mini \
EVAL_LLM_API_KEY="$OPENAI_API_KEY" \
python3 scripts/eval/generate_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --output eval/runs/locomo.clawmem.session.answers.jsonl \
  --level session \
  --top-k 5
```

With a custom answerer command:

```bash
python3 scripts/eval/generate_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --output eval/runs/locomo.clawmem.session.answers.jsonl \
  --level session \
  --top-k 5 \
  --command "python3 path/to/answerer.py"
```

Evaluate exact match, token F1, BLEU-1, answer containment, latency, and token
usage:

```bash
python3 scripts/eval/evaluate_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --answers eval/runs/locomo.clawmem.session.answers.jsonl \
  --output eval/runs/locomo.clawmem.session.answer_metrics.json
```

Add LLM-as-judge scoring when you want metrics closer to Mem0/Zep/Letta-style
reports:

```bash
EVAL_JUDGE_MODEL=gpt-4o-mini \
EVAL_JUDGE_API_KEY="$OPENAI_API_KEY" \
python3 scripts/eval/judge_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --answers eval/runs/locomo.clawmem.session.answers.jsonl \
  --output eval/runs/locomo.clawmem.session.judged_answers.jsonl

python3 scripts/eval/evaluate_answers.py \
  --cases eval/runs/locomo.cases.jsonl \
  --answers eval/runs/locomo.clawmem.session.judged_answers.jsonl \
  --output eval/runs/locomo.clawmem.session.judged_answer_metrics.json
```

Final reports should include:

- Retrieval: `hit@k`, `recall@k`, `precision@k`, `mrr@k`, `ndcg@k`.
- Answer text: exact match, token F1, BLEU-1, contains.
- Judge: judge score and judge accuracy when judged answers are provided.
- System: answer latency, recall latency, total tokens, and context size.

## Estimate Token Usage

Use `estimate_token_usage.py` to compare the full-context no-memory cost against
the memory-based cost. The memory total includes:

- one-time memory write/index tokens for the benchmark run,
- per-question recall query tokens,
- per-question answer prompt tokens from retrieved context,
- answer completion tokens.

```bash
python3 scripts/eval/estimate_token_usage.py \
  --cases eval/runs/locomo.cases.jsonl \
  --predictions eval/runs/locomo.clawmem.session.predictions.jsonl \
  --answers eval/runs/locomo.clawmem.session.answers.jsonl \
  --output eval/runs/locomo.clawmem.session.token_usage.json \
  --level session \
  --top-k 5 \
  --index-granularity session
```

The no-memory side estimates answering every QA with the full source
conversation in context. If you have actually run a full-context answer baseline,
pass its answer JSONL with `--no-memory-answers` and provider-reported usage will
be used when available.

The script uses `tiktoken` when it is installed. Otherwise it uses a labeled
approximate tokenizer, so treat those numbers as comparable estimates rather
than provider-billing exact counts.

## Run A Sanity Baseline

The lexical baseline is intentionally simple. It exists to verify the harness
and provide a floor for future ClawMem runs.

```bash
python3 scripts/eval/lexical_retrieval.py \
  --cases eval/runs/longmemeval_s.cases.jsonl \
  --output eval/runs/longmemeval_s.lexical.session.jsonl \
  --granularity session \
  --top-k 10

python3 scripts/eval/evaluate_retrieval.py \
  --cases eval/runs/longmemeval_s.cases.jsonl \
  --predictions eval/runs/longmemeval_s.lexical.session.jsonl \
  --level session \
  --ks 1,3,5,10 \
  --output eval/runs/longmemeval_s.lexical.session.metrics.json
```

Turn-level evaluation is also supported when the benchmark provides gold turns:

```bash
python3 scripts/eval/lexical_retrieval.py \
  --cases eval/runs/longmemeval_s.cases.jsonl \
  --output eval/runs/longmemeval_s.lexical.turn.jsonl \
  --granularity turn \
  --top-k 20

python3 scripts/eval/evaluate_retrieval.py \
  --cases eval/runs/longmemeval_s.cases.jsonl \
  --predictions eval/runs/longmemeval_s.lexical.turn.jsonl \
  --level turn \
  --ks 1,5,10,20
```

LongMemEval abstention cases usually have no gold evidence location. By default,
the evaluator skips cases without gold ids, matching the benchmark's retrieval
evaluation convention.
