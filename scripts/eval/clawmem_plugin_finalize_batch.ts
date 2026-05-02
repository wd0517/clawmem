#!/usr/bin/env -S npx --yes tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
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
type Handler = (ev: any, ctx: any) => unknown;
type MemoryMapRow = {
  memory_id: string;
  session_id: string;
  source_id: string;
  repo: string;
  line?: string;
  metadata?: Record<string, unknown>;
};

type Args = {
  cases: string;
  output: string;
  memoryMapOutput: string;
  limit: number;
  sourceLimit: number;
  resume: boolean;
  keepGoing: boolean;
};

const BASE_URL = env("CLAWMEM_EVAL_BASE_URL", "https://git.clawmem.ai/api/v3");
const TOP_K = clampInt(process.env.CLAWMEM_EVAL_TOP_K, 10, 1, 20);
const MAX_FINALIZE_SESSIONS = clampInt(process.env.CLAWMEM_EVAL_MAX_FINALIZE_SESSIONS ?? process.env.CLAWMEM_EVAL_MAX_INDEX_ITEMS, 0, 0, 100000);
const AGENT_PREFIX = env("CLAWMEM_EVAL_AGENT_PREFIX", "eval-clawmem-plugin-finalize");
const AGENT_ID = normalizeAgentPart(env("CLAWMEM_EVAL_AGENT_ID", `${AGENT_PREFIX}-locomo`)).slice(0, 64);
const REPO_PREFIX = env("CLAWMEM_EVAL_REPO_PREFIX", "eval-locomo-plugin-finalize");
const FINALIZE_MODEL = env("CLAWMEM_EVAL_FINALIZE_MODEL", env("CODEX_EVAL_MODEL", "gpt-5.4-mini"));
const FINALIZE_REASONING_EFFORT = env("CLAWMEM_EVAL_FINALIZE_REASONING_EFFORT", env("CODEX_EVAL_REASONING_EFFORT", "low"));
const FINALIZE_TIMEOUT_MS = clampInt(process.env.CLAWMEM_EVAL_FINALIZE_TIMEOUT_MS, 600000, 1000, 3600000);
const SESSION_TIMEOUT_MS = clampInt(process.env.CLAWMEM_EVAL_SESSION_FINALIZE_TIMEOUT_MS, 900000, 1000, 3600000);
const STORE_TIMEOUT_MS = clampInt(process.env.CLAWMEM_EVAL_STORE_TIMEOUT_MS, 120000, 1000, 3600000);
const RECALL_TIMEOUT_MS = clampInt(process.env.CLAWMEM_EVAL_RECALL_TIMEOUT_MS, 120000, 1000, 3600000);
const MEMORY_MAP_TIMEOUT_MS = clampInt(process.env.CLAWMEM_EVAL_MEMORY_MAP_TIMEOUT_MS, 30000, 0, 300000);
const CONFIG_FILE = process.env.CLAWMEM_EVAL_CONFIG_FILE?.trim() || "";
const INCLUDE_SESSION_DATE_MESSAGE = envFlag("CLAWMEM_EVAL_INCLUDE_SESSION_DATE_MESSAGE", true);
const INCLUDE_RAW_RECALL = envFlag("CLAWMEM_EVAL_INCLUDE_RAW_RECALL", false);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = readJsonl(args.cases);
  const limitedCases = args.limit > 0 ? cases.slice(0, args.limit) : cases;
  const completed = args.resume ? readCompletedIds(args.output) : new Set<string>();
  const pendingCases = limitedCases.filter((testCase) => !completed.has(testCase.case_id));
  const groups = groupCases(pendingCases);
  const selectedGroups = args.sourceLimit > 0 ? groups.slice(0, args.sourceLimit) : groups;
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.mkdirSync(path.dirname(args.memoryMapOutput), { recursive: true });

  const memorySessionMap = readMemorySessionMap(args.memoryMapOutput);
  const memoryMapSink = fs.createWriteStream(args.memoryMapOutput, { encoding: "utf8", flags: args.resume ? "a" : "w" });
  const predictionSink = fs.createWriteStream(args.output, { encoding: "utf8", flags: args.resume ? "a" : "w" });

  const harness = createPluginHarness();
  createClawMemPlugin(harness.api as never);
  const repoCreate = harness.tool("memory_repo_create");
  const repoList = harness.tool("memory_repos");
  const repoSetDefault = harness.tool("memory_repo_set_default");
  const recall = harness.tool("memory_recall");

  let totalPredictions = 0;
  try {
    for (const group of selectedGroups) {
      try {
        const first = group.cases[0];
        if (!first) continue;
        const repo = await ensureSourceRepo(repoCreate, repoList, repoSetDefault, group.key, harness.agentId);
        const sourceFinalizeStart = harness.finalizeStats();
        const indexStartedAt = Date.now();
        const indexed = await finalizeCaseSessions({
          harness,
          memoryRecall: recall,
          testCase: first,
          sourceId: group.key,
          repo,
          memorySessionMap,
          memoryMapSink,
        });
        const indexLatencyMs = elapsedMs(indexStartedAt);
        log(`finalized ${indexed} session(s) for source ${group.key} into ${repo} using agent ${harness.agentId}`);

        for (const testCase of group.cases) {
          if (!testCase.question?.trim()) {
            predictionSink.write(JSON.stringify(errorPrediction(testCase, "case has no question", {
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
            memorySessionMap,
            finalizeStats: diffFinalizeStats(sourceFinalizeStart, harness.finalizeStats()),
          });
          predictionSink.write(JSON.stringify(prediction) + "\n");
          totalPredictions += 1;
        }
        log(`wrote ${group.cases.length} prediction(s) for source ${group.key} from ${repo}`);
      } catch (error) {
        if (!args.keepGoing) throw error;
        const message = error instanceof Error ? error.message : String(error);
        log(`WARN source ${group.key} failed: ${message}`);
        for (const testCase of group.cases) {
          predictionSink.write(JSON.stringify(errorPrediction(testCase, message, {
            agentId: harness.agentId,
            sourceId: group.key,
          })) + "\n");
          totalPredictions += 1;
        }
      }
    }
  } finally {
    await Promise.all([
      closeStream(predictionSink),
      closeStream(memoryMapSink),
    ]);
  }
  log(`wrote ${totalPredictions} total prediction(s) to ${args.output}`);
  log(`memory/session map: ${args.memoryMapOutput}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cases: "", output: "", memoryMapOutput: "", limit: 0, sourceLimit: 0, resume: false, keepGoing: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === "--cases" && next) { args.cases = next; index += 1; continue; }
    if (flag === "--output" && next) { args.output = next; index += 1; continue; }
    if (flag === "--memory-map-output" && next) { args.memoryMapOutput = next; index += 1; continue; }
    if (flag === "--limit" && next) { args.limit = Number(next); index += 1; continue; }
    if (flag === "--source-limit" && next) { args.sourceLimit = Number(next); index += 1; continue; }
    if (flag === "--resume") { args.resume = true; continue; }
    if (flag === "--keep-going") { args.keepGoing = true; continue; }
    if (flag === "--help") usage(0);
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!args.cases || !args.output) usage(1);
  if (!args.memoryMapOutput) args.memoryMapOutput = `${args.output}.memory-map.jsonl`;
  if (!Number.isFinite(args.limit) || args.limit < 0) throw new Error("--limit must be a non-negative number");
  if (!Number.isFinite(args.sourceLimit) || args.sourceLimit < 0) throw new Error("--source-limit must be a non-negative number");
  return args;
}

function usage(exitCode: number): never {
  const message = [
    "Usage:",
    "  npx --yes tsx scripts/eval/clawmem_plugin_finalize_batch.ts --cases eval/runs/locomo.cases.jsonl --output eval/runs/locomo.clawmem.plugin_finalize.predictions.jsonl",
    "",
    "This runner exercises the plugin lifecycle: benchmark sessions are mirrored as conversations,",
    "the finalize subagent extracts durable memory candidates, the plugin stores those candidates,",
    "and memory_recall answers benchmark queries. It does not write raw sessions with memory_store.",
    "",
    "Options:",
    "  --limit N              evaluate at most N cases",
    "  --source-limit N       evaluate at most N source conversations",
    "  --memory-map-output P  write/read memory-id to benchmark-session mapping sidecar",
    "  --resume               append to output and skip completed case ids",
    "  --keep-going           write error predictions instead of stopping on a failed source",
    "",
    "Environment:",
    "  CLAWMEM_EVAL_AGENT_ID                       stable agent identity for the whole run",
    "  CLAWMEM_EVAL_REPO_PREFIX                    prefix for source-conversation repos",
    "  CLAWMEM_EVAL_FINALIZE_MODEL                 Codex CLI model used as the finalize subagent",
    "  CLAWMEM_EVAL_FINALIZE_REASONING_EFFORT      Codex reasoning effort, default low",
    "  CLAWMEM_EVAL_MAX_FINALIZE_SESSIONS          optional cap for quick shakedown runs",
    "  CLAWMEM_EVAL_INCLUDE_SESSION_DATE_MESSAGE   include benchmark timestamp as a normal transcript message, default 1",
    "  CLAWMEM_EVAL_STORE_TIMEOUT_MS               timeout for repo/list writes, default 120000",
    "  CLAWMEM_EVAL_RECALL_TIMEOUT_MS              timeout per memory_recall call, default 120000",
    "  CLAWMEM_EVAL_MEMORY_MAP_TIMEOUT_MS          wait for newly stored memories to appear in memory_list, default 30000",
    "  CLAWMEM_EVAL_CONFIG_FILE                    optional local JSON config containing saved agent tokens",
  ].join("\n");
  (exitCode === 0 ? console.log : console.error)(message);
  process.exit(exitCode);
}

function createPluginHarness() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const subagentMessages = new Map<string, Array<{ role: string; text: string }>>();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-plugin-finalize-eval-"));
  const agentId = AGENT_ID;
  let runCounter = 0;
  let finalizeCalls = 0;
  let finalizeTokens = 0;
  let finalizeLatencyMs = 0;
  let configRoot: Record<string, any> = loadConfigRoot({
    plugins: {
      entries: {
        clawmem: {
          config: {
            baseUrl: BASE_URL,
            authScheme: "token",
            summaryWaitTimeoutMs: 600000,
            memoryExtractWaitTimeoutMs: 600000,
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
        run: async (request: { sessionKey: string; message: string; extraSystemPrompt?: string }) => {
          const startedAt = Date.now();
          const prompt = [
            request.extraSystemPrompt?.trim() || "",
            "",
            request.message,
          ].join("\n").trim();
          const result = await callCodex(prompt);
          finalizeCalls += 1;
          finalizeTokens += result.tokens ?? 0;
          finalizeLatencyMs += elapsedMs(startedAt);
          subagentMessages.set(request.sessionKey, [{ role: "assistant", text: result.text }]);
          runCounter += 1;
          return { runId: `eval-finalize-${runCounter}` };
        },
        waitForRun: async () => ({ status: "complete" }),
        getSessionMessages: async ({ sessionKey }: { sessionKey: string }) => ({ messages: subagentMessages.get(sessionKey) ?? [] }),
        deleteSession: async ({ sessionKey }: { sessionKey: string }) => { subagentMessages.delete(sessionKey); },
      },
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
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
    async emit(event: string, ev: any, ctx: any): Promise<void> {
      for (const handler of handlers.get(event) ?? []) {
        await handler(ev, ctx);
      }
    },
    finalizeStats() {
      return {
        model: FINALIZE_MODEL,
        reasoning_effort: FINALIZE_REASONING_EFFORT,
        calls: finalizeCalls,
        total_tokens: finalizeTokens || undefined,
        total_latency_ms: finalizeLatencyMs,
      };
    },
  };
}

function diffFinalizeStats(
  before: { model?: unknown; reasoning_effort?: unknown; calls?: unknown; total_tokens?: unknown; total_latency_ms?: unknown },
  after: { model?: unknown; reasoning_effort?: unknown; calls?: unknown; total_tokens?: unknown; total_latency_ms?: unknown },
): Record<string, unknown> {
  const beforeCalls = typeof before.calls === "number" ? before.calls : 0;
  const afterCalls = typeof after.calls === "number" ? after.calls : 0;
  const beforeTokens = typeof before.total_tokens === "number" ? before.total_tokens : 0;
  const afterTokens = typeof after.total_tokens === "number" ? after.total_tokens : 0;
  const beforeLatency = typeof before.total_latency_ms === "number" ? before.total_latency_ms : 0;
  const afterLatency = typeof after.total_latency_ms === "number" ? after.total_latency_ms : 0;
  return {
    model: after.model,
    reasoning_effort: after.reasoning_effort,
    calls: Math.max(0, afterCalls - beforeCalls),
    total_tokens: Math.max(0, afterTokens - beforeTokens) || undefined,
    total_latency_ms: Math.max(0, afterLatency - beforeLatency),
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

async function ensureSourceRepo(createRepo: ToolExecute, listRepos: ToolExecute, setDefault: ToolExecute, sourceId: string, agentId: string): Promise<string> {
  const repoName = sourceRepoName(sourceId);
  const before = await findAccessibleRepo(listRepos, agentId, repoName);
  if (before) {
    await setDefaultRepo(setDefault, agentId, before);
    return before;
  }

  try {
    const result = await withTimeout(createRepo("eval", {
      agentId,
      name: repoName,
      description: `Plugin-finalize eval source conversation ${sourceId}`,
      private: true,
      setDefault: true,
    }), STORE_TIMEOUT_MS, `memory_repo_create timed out after ${STORE_TIMEOUT_MS}ms for ${sourceId}`);
    const created = parseCreatedRepo(resultText(result));
    if (created) {
      await setDefaultRepo(setDefault, agentId, created);
      return created;
    }
  } catch (error) {
    log(`repo ${repoName} create failed or already exists; checking accessible repos: ${String(error)}`);
  }

  const after = await findAccessibleRepo(listRepos, agentId, repoName);
  if (after) {
    await setDefaultRepo(setDefault, agentId, after);
    return after;
  }
  throw new Error(`unable to create or find source repo ${repoName} for ${sourceId}`);
}

async function setDefaultRepo(setDefault: ToolExecute, agentId: string, repo: string): Promise<void> {
  const result = await withTimeout(setDefault("eval", {
    agentId,
    repo,
    confirmed: true,
  }), STORE_TIMEOUT_MS, `memory_repo_set_default timed out after ${STORE_TIMEOUT_MS}ms for ${repo}`);
  const text = resultText(result);
  if (!/^Set defaultRepo\b/.test(text)) throw new Error(text || `unable to set default repo ${repo}`);
}

async function finalizeCaseSessions(input: {
  harness: ReturnType<typeof createPluginHarness>;
  memoryRecall: ToolExecute;
  testCase: NormalizedCase;
  sourceId: string;
  repo: string;
  memorySessionMap: Map<string, Set<string>>;
  memoryMapSink: fs.WriteStream;
}): Promise<number> {
  const sessions = uniqueSessions(input.testCase.sessions ?? []);
  let count = 0;
  for (const [index, session] of sessions.entries()) {
    if (MAX_FINALIZE_SESSIONS && count >= MAX_FINALIZE_SESSIONS) break;
    const sessionId = session.session_id || `${input.sourceId}:session_${index}`;
    const pluginMessages = toPluginMessages(session);
    if (pluginMessages.length < 2) {
      log(`skip ${sessionId}: fewer than two user/assistant messages after normalization`);
      continue;
    }
    if (isSessionMapped(input.memorySessionMap, sessionId)) {
      log(`skip ${sessionId}: already present in memory/session map`);
      continue;
    }
    const probeQuery = buildSessionProbeQuery(session, pluginMessages);
    const startedAt = Date.now();
    try {
      const before = await recallProbeMemories(input.memoryRecall, input.harness.agentId, input.repo, probeQuery);
      await withTimeout(input.harness.emit("before_reset", {
        reason: "eval_plugin_finalize",
        messages: pluginMessages,
      }, {
        agentId: input.harness.agentId,
        sessionId: `${normalizeAgentPart(input.sourceId)}-${normalizeAgentPart(sessionId)}`.slice(0, 96),
        sessionKey: `eval:${input.sourceId}:${sessionId}`,
      }), SESSION_TIMEOUT_MS, `plugin finalize timed out after ${SESSION_TIMEOUT_MS}ms for ${sessionId}`);
      const created = await waitForCreatedProbeMemories(input.memoryRecall, input.harness.agentId, input.repo, probeQuery, before);
      for (const memory of created) {
        addMemorySession(input.memorySessionMap, memory.memoryId, sessionId);
        const row: MemoryMapRow = {
          memory_id: memory.memoryId,
          session_id: sessionId,
          source_id: input.sourceId,
          repo: input.repo,
          line: memory.line,
          metadata: {
            benchmark: input.testCase.benchmark,
            source_session_id: session.source_session_id,
            timestamp: session.timestamp,
          },
        };
        input.memoryMapSink.write(JSON.stringify(row, ensureJsonSafe, 0) + "\n");
      }
      log(`finalized ${sessionId}: ${created.length} new memor${created.length === 1 ? "y" : "ies"} in ${elapsedMs(startedAt)}ms`);
    } catch (error) {
      log(`WARN finalize ${sessionId} failed; continuing source: ${error instanceof Error ? error.message : String(error)}`);
    }
    count += 1;
  }
  return count;
}

function toPluginMessages(session: NormalizedSession): Array<{ role: "user" | "assistant"; text: string; timestamp?: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string; timestamp?: string }> = [];
  const timestamp = typeof session.timestamp === "string" && session.timestamp.trim() ? session.timestamp.trim() : undefined;
  if (INCLUDE_SESSION_DATE_MESSAGE && timestamp) {
    out.push({ role: "user", text: `Conversation date: ${timestamp}.`, timestamp });
  }
  for (const [index, message] of (session.messages ?? []).entries()) {
    const content = (message.content ?? "").trim();
    if (!content) continue;
    const role = normalizeRole(message.role, index);
    const speaker = (message.speaker ?? "").trim();
    const shouldPrefixSpeaker = speaker && speaker !== "user" && speaker !== "assistant";
    out.push({
      role,
      text: shouldPrefixSpeaker ? `${speaker}: ${content}` : content,
      ...(timestamp ? { timestamp } : {}),
    });
  }
  return out;
}

function normalizeRole(role: string | undefined, index: number): "user" | "assistant" {
  const normalized = (role ?? "").trim().toLowerCase();
  if (normalized === "user" || normalized === "assistant") return normalized;
  return index % 2 === 0 ? "user" : "assistant";
}

async function recallProbeMemories(memoryRecall: ToolExecute, agentId: string, repo: string, query: string): Promise<Array<{ memoryId: string; line: string }>> {
  if (!query.trim()) return [];
  const result = await withTimeout(memoryRecall("eval", {
    agentId,
    repo,
    query,
    limit: 20,
  }), RECALL_TIMEOUT_MS, `memory_recall probe timed out after ${RECALL_TIMEOUT_MS}ms for ${repo}`);
  return parseMemoryLines(resultText(result));
}

async function waitForCreatedProbeMemories(
  memoryRecall: ToolExecute,
  agentId: string,
  repo: string,
  query: string,
  before: Array<{ memoryId: string; line: string }>,
): Promise<Array<{ memoryId: string; line: string }>> {
  const beforeIds = new Set(before.map((memory) => memory.memoryId));
  const startedAt = Date.now();
  let last: Array<{ memoryId: string; line: string }> = [];
  while (true) {
    last = await recallProbeMemories(memoryRecall, agentId, repo, query);
    const created = last.filter((memory) => !beforeIds.has(memory.memoryId));
    if (created.length > 0 || elapsedMs(startedAt) >= MEMORY_MAP_TIMEOUT_MS) return created;
    await sleep(Math.min(1000, Math.max(100, MEMORY_MAP_TIMEOUT_MS - elapsedMs(startedAt))));
  }
}

function parseMemoryLines(text: string): Array<{ memoryId: string; line: string }> {
  const out: Array<{ memoryId: string; line: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^-\s+\[([^\]]+)\]\s+(.+)$/.exec(line.trim());
    if (!match?.[1]) continue;
    out.push({ memoryId: match[1].trim(), line: line.trim() });
  }
  return out;
}

function buildSessionProbeQuery(session: NormalizedSession, pluginMessages: Array<{ role: "user" | "assistant"; text: string }>): string {
  const sessionId = session.session_id || session.source_session_id || "";
  const timestamp = typeof session.timestamp === "string" && session.timestamp.trim() ? session.timestamp.trim() : "";
  const text = pluginMessages
    .map((message) => message.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return [`session ${sessionId}`, timestamp, text].filter(Boolean).join("\n").slice(0, 1400);
}

function parsePrediction(
  testCase: NormalizedCase,
  recallText: string,
  run: {
    agentId: string;
    sourceId: string;
    repo: string;
    indexed: number;
    indexLatencyMs: number;
    recallLatencyMs: number;
    memorySessionMap: Map<string, Set<string>>;
    finalizeStats: Record<string, unknown>;
  },
): Record<string, unknown> {
  const memoryIds = unique([...recallText.matchAll(/(?:^|\n)-\s+\[([^\]]+)\]/g)].map((match) => match[1] ?? ""));
  const sessionIds: string[] = [];
  const unmappedMemoryIds: string[] = [];
  for (const memoryId of memoryIds) {
    const mapped = run.memorySessionMap.get(memoryId);
    if (!mapped || mapped.size === 0) {
      unmappedMemoryIds.push(memoryId);
      continue;
    }
    sessionIds.push(...mapped);
  }
  return {
    case_id: testCase.case_id,
    benchmark: testCase.benchmark,
    retrieved_session_ids: unique(sessionIds),
    retrieved_turn_ids: [],
    retrieved_memory_ids: memoryIds,
    unmapped_memory_ids: unmappedMemoryIds,
    metadata: {
      adapter: "clawmem_real_backend_plugin_finalize_batch",
      base_url: BASE_URL,
      index_mode: "plugin-finalize",
      indexed_sessions: run.indexed,
      index_latency_ms: run.indexLatencyMs,
      recall_latency_ms: run.recallLatencyMs,
      recall_top_k: TOP_K,
      source_id: run.sourceId,
      agent_id: run.agentId,
      repo: run.repo,
      finalize: run.finalizeStats,
      include_session_date_message: INCLUDE_SESSION_DATE_MESSAGE,
      ...(INCLUDE_RAW_RECALL ? { raw_recall: recallText } : {}),
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
    retrieved_memory_ids: [],
    error: message,
    metadata: {
      adapter: "clawmem_real_backend_plugin_finalize_batch",
      base_url: BASE_URL,
      index_mode: "plugin-finalize",
      indexed_sessions: run.indexed ?? 0,
      index_latency_ms: run.indexLatencyMs,
      recall_top_k: TOP_K,
      source_id: run.sourceId,
      agent_id: run.agentId,
      repo: run.repo,
    },
  };
}

async function callCodex(prompt: string): Promise<{ text: string; tokens?: number }> {
  const outputPath = path.join(os.tmpdir(), `clawmem-finalize-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.out`);
  const command = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-m",
    FINALIZE_MODEL,
    "-c",
    `model_reasoning_effort="${FINALIZE_REASONING_EFFORT}"`,
    "-o",
    outputPath,
    "-",
  ];
  try {
    const completed = await runWithInput("codex", command, prompt, FINALIZE_TIMEOUT_MS);
    const text = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";
    if (completed.code !== 0) {
      throw new Error(completed.stderr.trim() || completed.stdout.trim() || `codex exited with code ${completed.code}`);
    }
    if (!text) throw new Error("codex finalize returned no output");
    return {
      text,
      tokens: parseTokensUsed(`${completed.stdout}\n${completed.stderr}`),
    };
  } finally {
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

function runWithInput(command: string, args: string[], input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(input);
  });
}

function parseTokensUsed(logText: string): number | undefined {
  const matches = [...logText.matchAll(/tokens used\s+([0-9,]+)/gi)];
  const last = matches.at(-1)?.[1];
  if (!last) return undefined;
  return Number(last.replace(/,/g, ""));
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

function readMemorySessionMap(filePath: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\n+/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as MemoryMapRow;
      if (row.memory_id && row.session_id) addMemorySession(out, String(row.memory_id), String(row.session_id));
    } catch {
      // Ignore partial trailing lines from interrupted runs.
    }
  }
  return out;
}

function addMemorySession(map: Map<string, Set<string>>, memoryId: string, sessionId: string): void {
  const key = memoryId.trim();
  const value = sessionId.trim();
  if (!key || !value) return;
  map.set(key, new Set([...(map.get(key) ?? []), value]));
}

function isSessionMapped(map: Map<string, Set<string>>, sessionId: string): boolean {
  const target = sessionId.trim();
  if (!target) return false;
  for (const values of map.values()) {
    if (values.has(target)) return true;
  }
  return false;
}

function groupCases(cases: NormalizedCase[]): Array<{ key: string; cases: NormalizedCase[] }> {
  const map = new Map<string, NormalizedCase[]>();
  for (const testCase of cases) {
    const key = testCase.source_id || testCase.case_id;
    map.set(key, [...(map.get(key) ?? []), testCase]);
  }
  return [...map.entries()].map(([key, values]) => ({ key, cases: values }));
}

function uniqueSessions(sessions: NormalizedSession[]): NormalizedSession[] {
  const seen = new Set<string>();
  const out: NormalizedSession[] = [];
  for (const [index, session] of sessions.entries()) {
    const key = session.session_id || session.source_session_id || `session_${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(session);
  }
  return out;
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
  const prefix = raw.slice(0, 90).replace(/-+$/g, "") || "eval-plugin-finalize";
  return `${prefix}-${hash}`;
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

function ensureJsonSafe(_key: string, value: unknown): unknown {
  if (value instanceof Set) return [...value];
  return value;
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.on("error", reject);
  });
}

function log(message: string): void {
  process.stderr.write(`[clawmem-plugin-finalize-eval] ${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`[clawmem-plugin-finalize-eval] ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
