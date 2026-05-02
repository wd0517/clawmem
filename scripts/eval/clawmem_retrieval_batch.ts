#!/usr/bin/env -S npx --yes tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createClawMemPlugin } from "../../src/service.js";

type NormalizedMessage = { turn_id?: string; role?: string; speaker?: string; content?: string };
type NormalizedSession = { session_id?: string; source_session_id?: string; timestamp?: string | null; messages?: NormalizedMessage[] };
type NormalizedCase = {
  case_id: string;
  benchmark?: string;
  source_id?: string;
  question?: string;
  sessions?: NormalizedSession[];
};
type ToolResult = { content?: Array<{ text?: string }> };
type ToolExecute = (id: string, params: unknown) => Promise<ToolResult>;
type Tool = { name?: string; execute?: ToolExecute };

type Args = {
  cases: string;
  output: string;
  limit: number;
  sourceLimit: number;
  resume: boolean;
  keepGoing: boolean;
};

const BASE_URL = env("CLAWMEM_EVAL_BASE_URL", "https://git.clawmem.ai/api/v3");
const INDEX_GRANULARITY = env("CLAWMEM_EVAL_INDEX_GRANULARITY", "session");
const TOP_K = clampInt(process.env.CLAWMEM_EVAL_TOP_K, 10, 1, 20);
const MAX_INDEX_ITEMS = clampInt(process.env.CLAWMEM_EVAL_MAX_INDEX_ITEMS, 0, 0, 100000);
const STORE_TIMEOUT_MS = clampInt(process.env.CLAWMEM_EVAL_STORE_TIMEOUT_MS, 120000, 1000, 3600000);
const RECALL_TIMEOUT_MS = clampInt(process.env.CLAWMEM_EVAL_RECALL_TIMEOUT_MS, 120000, 1000, 3600000);
const CONFIG_FILE = process.env.CLAWMEM_EVAL_CONFIG_FILE?.trim() || "";
const AGENT_PREFIX = env("CLAWMEM_EVAL_AGENT_PREFIX", "eval-clawmem");
const AGENT_ID = normalizeAgentPart(env("CLAWMEM_EVAL_AGENT_ID", `${AGENT_PREFIX}-locomo`)).slice(0, 64);
const REPO_PREFIX = env("CLAWMEM_EVAL_REPO_PREFIX", "eval-locomo");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = readJsonl(args.cases);
  const limitedCases = args.limit > 0 ? cases.slice(0, args.limit) : cases;
  const completed = args.resume ? readCompletedIds(args.output) : new Set<string>();
  const pendingCases = limitedCases.filter((testCase) => !completed.has(testCase.case_id));
  const groups = groupCases(pendingCases);
  const selectedGroups = args.sourceLimit > 0 ? groups.slice(0, args.sourceLimit) : groups;
  fs.mkdirSync(path.dirname(args.output), { recursive: true });

  const harness = createPluginHarness();
  createClawMemPlugin(harness.api as never);
  const repoCreate = harness.tool("memory_repo_create");
  const repoList = harness.tool("memory_repos");
  const store = harness.tool("memory_store");
  const recall = harness.tool("memory_recall");

  let totalPredictions = 0;
  const sink = fs.createWriteStream(args.output, { encoding: "utf8", flags: args.resume ? "a" : "w" });
  try {
    for (const group of selectedGroups) {
      try {
        const first = group.cases[0];
        if (!first) continue;
        const repo = await ensureSourceRepo(repoCreate, repoList, group.key, harness.agentId);
        const indexStartedAt = Date.now();
        const indexed = await indexCase(store, first, harness.agentId, repo);
        const indexLatencyMs = elapsedMs(indexStartedAt);
        log(`indexed ${indexed} ${INDEX_GRANULARITY} memory item(s) for source ${group.key} in ${repo} using agent ${harness.agentId}`);

        for (const testCase of group.cases) {
          if (!testCase.question?.trim()) {
            sink.write(JSON.stringify(errorPrediction(testCase, "case has no question", {
              agentId: harness.agentId,
              sourceId: group.key,
              repo,
              indexed,
              indexLatencyMs,
            })) + "\n");
            totalPredictions += 1;
            continue;
          }
          const recallStartedAt = Date.now();
          const result = await withTimeout(recall("eval", {
            agentId: harness.agentId,
            repo,
            query: testCase.question,
            limit: TOP_K,
          }), RECALL_TIMEOUT_MS, `memory_recall timed out after ${RECALL_TIMEOUT_MS}ms for ${testCase.case_id}`);
          const prediction = parsePrediction(testCase, resultText(result), {
            agentId: harness.agentId,
            sourceId: group.key,
            repo,
            indexed,
            indexLatencyMs,
            recallLatencyMs: elapsedMs(recallStartedAt),
          });
          sink.write(JSON.stringify(prediction) + "\n");
          totalPredictions += 1;
        }
        log(`wrote ${group.cases.length} prediction(s) for source ${group.key} from ${repo}`);
      } catch (error) {
        if (!args.keepGoing) throw error;
        const message = error instanceof Error ? error.message : String(error);
        log(`WARN source ${group.key} failed: ${message}`);
        for (const testCase of group.cases) {
          sink.write(JSON.stringify(errorPrediction(testCase, message, {
            agentId: harness.agentId,
            sourceId: group.key,
          })) + "\n");
          totalPredictions += 1;
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      sink.end(() => resolve());
      sink.on("error", reject);
    });
  }
  log(`wrote ${totalPredictions} total prediction(s) to ${args.output}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cases: "", output: "", limit: 0, sourceLimit: 0, resume: false, keepGoing: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === "--cases" && next) { args.cases = next; index += 1; continue; }
    if (flag === "--output" && next) { args.output = next; index += 1; continue; }
    if (flag === "--limit" && next) { args.limit = Number(next); index += 1; continue; }
    if (flag === "--source-limit" && next) { args.sourceLimit = Number(next); index += 1; continue; }
    if (flag === "--resume") { args.resume = true; continue; }
    if (flag === "--keep-going") { args.keepGoing = true; continue; }
    if (flag === "--help") usage(0);
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!args.cases || !args.output) usage(1);
  if (!Number.isFinite(args.limit) || args.limit < 0) throw new Error("--limit must be a non-negative number");
  if (!Number.isFinite(args.sourceLimit) || args.sourceLimit < 0) throw new Error("--source-limit must be a non-negative number");
  return args;
}

function usage(exitCode: number): never {
  const message = [
    "Usage:",
    "  npx --yes tsx scripts/eval/clawmem_retrieval_batch.ts --cases eval/runs/locomo.cases.jsonl --output eval/runs/locomo.clawmem.session.predictions.jsonl",
    "",
    "Options:",
    "  --limit N         evaluate at most N cases",
    "  --source-limit N  evaluate at most N source conversations",
    "  --resume          append to output and skip completed case ids",
    "  --keep-going      write error predictions instead of stopping on a failed source",
    "",
    "Environment:",
    "  CLAWMEM_EVAL_AGENT_ID     one backend agent identity for the whole run",
    "  CLAWMEM_EVAL_REPO_PREFIX  prefix for one repo per source conversation",
    "  CLAWMEM_EVAL_STORE_TIMEOUT_MS   timeout per memory_store call, default 120000",
    "  CLAWMEM_EVAL_RECALL_TIMEOUT_MS  timeout per memory_recall call, default 120000",
    "  CLAWMEM_EVAL_CONFIG_FILE        optional local JSON config containing saved agent tokens",
  ].join("\n");
  (exitCode === 0 ? console.log : console.error)(message);
  process.exit(exitCode);
}

function readJsonl(filePath: string): NormalizedCase[] {
  return fs.readFileSync(filePath, "utf8")
    .split(/\n+/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const value = JSON.parse(line) as NormalizedCase;
      if (!value.case_id) throw new Error(`${filePath}:${index + 1}: case_id is required`);
      return value;
    });
}

function readCompletedIds(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  const completed = new Set<string>();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\n+/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { case_id?: unknown };
      if (value.case_id) completed.add(String(value.case_id));
    } catch {
      // Ignore partial trailing lines from interrupted runs.
    }
  }
  return completed;
}

function groupCases(cases: NormalizedCase[]): Array<{ key: string; cases: NormalizedCase[] }> {
  const map = new Map<string, NormalizedCase[]>();
  for (const testCase of cases) {
    const key = testCase.source_id || testCase.case_id;
    map.set(key, [...(map.get(key) ?? []), testCase]);
  }
  return [...map.entries()].map(([key, values]) => ({ key, cases: values }));
}

function createPluginHarness() {
  const tools = new Map<string, Tool>();
  const agentId = AGENT_ID;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-batch-eval-"));
  let configRoot: Record<string, any> = loadConfigRoot({
    plugins: {
      entries: {
        clawmem: {
          config: {
            baseUrl: BASE_URL,
            authScheme: "token",
            agents: {},
          },
        },
      },
      slots: {
        memory: "clawmem",
      },
    },
  });

  const api = {
    id: "clawmem",
    pluginConfig: configRoot.plugins.entries.clawmem.config,
    logger: {
      info: (message: string) => log(message),
      warn: (message: string) => log(`WARN ${message}`),
    },
    runtime: {
      version: "2026.4.9",
      config: {
        loadConfig: () => configRoot,
        writeConfigFile: async (next: Record<string, any>) => {
          configRoot = next;
          if (CONFIG_FILE) saveConfigRoot(CONFIG_FILE, configRoot);
        },
      },
      events: { onSessionTranscriptUpdate: () => () => {} },
      state: {
        get: () => undefined,
        set: () => {},
        resolveStateDir: () => stateDir,
      },
      subagent: {
        run: async () => ({ runId: "eval-run" }),
        waitForRun: async () => ({ status: "complete" }),
        getSessionMessages: async () => ({ messages: [] }),
        deleteSession: async () => {},
      },
    },
    on: () => {},
    registerTool: (tool: Tool) => {
      if (tool.name) tools.set(tool.name, tool);
    },
    registerService: () => {},
    registerMemoryCapability: () => {},
  };

  return {
    api,
    agentId,
    tool(name: string): ToolExecute {
      const execute = tools.get(name)?.execute;
      if (typeof execute !== "function") throw new Error(`ClawMem did not register ${name}`);
      return execute;
    },
  };
}

function loadConfigRoot(fallback: Record<string, any>): Record<string, any> {
  if (!CONFIG_FILE || !fs.existsSync(CONFIG_FILE)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const config = parsed?.plugins?.entries?.clawmem?.config;
    if (config && typeof config === "object" && !Array.isArray(config)) {
      return parsed;
    }
    log(`WARN ignored ${CONFIG_FILE}: missing plugins.entries.clawmem.config`);
  } catch (error) {
    log(`WARN unable to read ${CONFIG_FILE}: ${String(error)}`);
  }
  return fallback;
}

function saveConfigRoot(filePath: string, configRoot: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { ...configRoot, saved_at: new Date().toISOString() };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

async function ensureSourceRepo(createRepo: ToolExecute, listRepos: ToolExecute, sourceId: string, agentId: string): Promise<string> {
  const repoName = sourceRepoName(sourceId);
  const before = await findAccessibleRepo(listRepos, agentId, repoName);
  if (before) return before;

  try {
    const result = await withTimeout(createRepo("eval", {
      agentId,
      name: repoName,
      description: `LoCoMo eval source conversation ${sourceId}`,
      private: true,
      setDefault: false,
    }), STORE_TIMEOUT_MS, `memory_repo_create timed out after ${STORE_TIMEOUT_MS}ms for ${sourceId}`);
    const created = parseCreatedRepo(resultText(result));
    if (created) return created;
  } catch (error) {
    log(`repo ${repoName} create failed or already exists; checking accessible repos: ${String(error)}`);
  }

  const after = await findAccessibleRepo(listRepos, agentId, repoName);
  if (after) return after;
  throw new Error(`unable to create or find source repo ${repoName} for ${sourceId}`);
}

async function findAccessibleRepo(listRepos: ToolExecute, agentId: string, repoName: string): Promise<string | undefined> {
  const text = resultText(await withTimeout(listRepos("eval", { agentId }), STORE_TIMEOUT_MS, `memory_repos timed out after ${STORE_TIMEOUT_MS}ms`));
  for (const match of text.matchAll(/^- ([^\s/]+\/([^\s\[]+))/gm)) {
    const fullName = match[1]?.trim();
    const name = match[2]?.trim();
    if (fullName && name === repoName) return fullName;
  }
  return undefined;
}

function parseCreatedRepo(text: string): string | undefined {
  const match = /Created memory repo\s+([^\s.]+\/[^\s.]+)\./.exec(text);
  return match?.[1]?.trim();
}

async function indexCase(store: ToolExecute, testCase: NormalizedCase, agentId: string, repo: string): Promise<number> {
  const items = buildIndexItems(testCase);
  let count = 0;
  for (const item of items) {
    if (MAX_INDEX_ITEMS && count >= MAX_INDEX_ITEMS) break;
    const result = await withTimeout(store("eval", {
      agentId,
      repo,
      title: item.title,
      detail: item.detail,
      kind: "benchmark-evidence",
      topics: [testCase.benchmark ?? "benchmark", INDEX_GRANULARITY],
    }), STORE_TIMEOUT_MS, `memory_store timed out after ${STORE_TIMEOUT_MS}ms while indexing ${item.id}`);
    const text = resultText(result);
    if (!/^(Stored memory|Memory already exists)/.test(text)) {
      throw new Error(`memory_store failed while indexing ${item.id}: ${text}`);
    }
    count += 1;
  }
  return count;
}

function buildIndexItems(testCase: NormalizedCase): Array<{ id: string; title: string; detail: string }> {
  if (INDEX_GRANULARITY === "turn") return buildTurnItems(testCase);
  if (INDEX_GRANULARITY !== "session") throw new Error("CLAWMEM_EVAL_INDEX_GRANULARITY must be session or turn");
  return buildSessionItems(testCase);
}

function buildSessionItems(testCase: NormalizedCase): Array<{ id: string; title: string; detail: string }> {
  return (testCase.sessions ?? []).map((session, index) => {
    const sessionId = session.session_id || `session_${index}`;
    const transcript = (session.messages ?? [])
      .map((message) => `[${message.turn_id ?? ""}] ${message.speaker || message.role || "speaker"}: ${message.content ?? ""}`.trim())
      .filter(Boolean)
      .join("\n");
    return {
      id: sessionId,
      title: `Eval session ${sessionId}`,
      detail: [
        `EVAL_SOURCE_ID: ${testCase.source_id ?? ""}`,
        `EVAL_SESSION_ID: ${sessionId}`,
        `EVAL_SOURCE_SESSION_ID: ${session.source_session_id ?? ""}`,
        `EVAL_BENCHMARK: ${testCase.benchmark ?? ""}`,
        `EVAL_TIMESTAMP: ${session.timestamp ?? ""}`,
        "",
        transcript,
      ].join("\n").trim(),
    };
  });
}

function buildTurnItems(testCase: NormalizedCase): Array<{ id: string; title: string; detail: string }> {
  const items: Array<{ id: string; title: string; detail: string }> = [];
  for (const [sessionIndex, session] of (testCase.sessions ?? []).entries()) {
    const sessionId = session.session_id || `session_${sessionIndex}`;
    for (const [turnIndex, message] of (session.messages ?? []).entries()) {
      const turnId = message.turn_id || `${sessionId}:turn_${String(turnIndex).padStart(4, "0")}`;
      items.push({
        id: turnId,
        title: `Eval turn ${turnId}`,
        detail: [
          `EVAL_SOURCE_ID: ${testCase.source_id ?? ""}`,
          `EVAL_SESSION_ID: ${sessionId}`,
          `EVAL_TURN_ID: ${turnId}`,
          `EVAL_SOURCE_SESSION_ID: ${session.source_session_id ?? ""}`,
          `EVAL_BENCHMARK: ${testCase.benchmark ?? ""}`,
          `EVAL_TIMESTAMP: ${session.timestamp ?? ""}`,
          `EVAL_SPEAKER: ${message.speaker || message.role || ""}`,
          "",
          message.content ?? "",
        ].join("\n").trim(),
      });
    }
  }
  return items;
}

function parsePrediction(
  testCase: NormalizedCase,
  recallText: string,
  run: { agentId: string; sourceId: string; repo: string; indexed: number; indexLatencyMs: number; recallLatencyMs: number },
): Record<string, unknown> {
  const sessionIds = unique([...recallText.matchAll(/EVAL_SESSION_ID:\s*([^\s\n]+)/g)].map((match) => match[1] ?? ""));
  const turnIds = unique([...recallText.matchAll(/EVAL_TURN_ID:\s*([^\s\n]+)/g)].map((match) => match[1] ?? ""));
  return {
    case_id: testCase.case_id,
    benchmark: testCase.benchmark,
    retrieved_session_ids: sessionIds,
    retrieved_turn_ids: turnIds,
    metadata: {
      adapter: "clawmem_real_backend_batch_retrieval",
      base_url: BASE_URL,
      index_granularity: INDEX_GRANULARITY,
      indexed_items: run.indexed,
      index_latency_ms: run.indexLatencyMs,
      recall_latency_ms: run.recallLatencyMs,
      recall_top_k: TOP_K,
      source_id: run.sourceId,
      agent_id: run.agentId,
      repo: run.repo,
    },
  };
}

function errorPrediction(
  testCase: NormalizedCase,
  message: string,
  run: { agentId: string; sourceId: string; repo?: string; indexed?: number; indexLatencyMs?: number },
): Record<string, unknown> {
  return {
    case_id: testCase.case_id,
    benchmark: testCase.benchmark,
    retrieved_session_ids: [],
    retrieved_turn_ids: [],
    error: message,
    metadata: {
      adapter: "clawmem_real_backend_batch_retrieval",
      base_url: BASE_URL,
      index_granularity: INDEX_GRANULARITY,
      indexed_items: run.indexed ?? 0,
      index_latency_ms: run.indexLatencyMs,
      recall_top_k: TOP_K,
      source_id: run.sourceId,
      agent_id: run.agentId,
      repo: run.repo,
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resultText(result: ToolResult | undefined): string {
  return result?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeAgentPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-") || "eval";
}

function sourceRepoName(sourceId: string): string {
  const hash = crypto.createHash("sha1").update(sourceId).digest("hex").slice(0, 8);
  const raw = normalizeAgentPart(`${REPO_PREFIX}-${sourceId}`).replace(/_/g, "-");
  const prefix = raw.slice(0, 90).replace(/-+$/g, "") || "eval-locomo";
  return `${prefix}-${hash}`;
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function log(message: string): void {
  process.stderr.write(`[clawmem-batch-eval] ${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`[clawmem-batch-eval] ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
