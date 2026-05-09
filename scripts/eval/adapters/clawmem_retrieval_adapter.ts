#!/usr/bin/env -S npx --yes tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createClawMemPlugin } from "../../../src/service.js";

type NormalizedMessage = {
  turn_id?: string;
  role?: string;
  speaker?: string;
  content?: string;
};
type NormalizedSession = {
  session_id?: string;
  source_session_id?: string;
  timestamp?: string | null;
  messages?: NormalizedMessage[];
};
type NormalizedCase = {
  case_id: string;
  benchmark?: string;
  question?: string;
  question_type?: string;
  question_date?: string | null;
  sessions?: NormalizedSession[];
};
type ToolResult = { content?: Array<{ text?: string }> };
type ToolExecute = (id: string, params: unknown) => Promise<ToolResult>;
type Tool = { name?: string; execute?: ToolExecute };

const BASE_URL = env("CLAWMEM_EVAL_BASE_URL", "https://git.clawmem.ai/api/v3");
const INDEX_GRANULARITY = env("CLAWMEM_EVAL_INDEX_GRANULARITY", "session");
const TOP_K = clampInt(process.env.CLAWMEM_EVAL_TOP_K, 10, 1, 20);
const MAX_INDEX_ITEMS = clampInt(process.env.CLAWMEM_EVAL_MAX_INDEX_ITEMS, 0, 0, 100000);
const AGENT_PREFIX = env("CLAWMEM_EVAL_AGENT_PREFIX", "eval-clawmem");

async function main(): Promise<void> {
  const testCase = JSON.parse(await readStdin()) as NormalizedCase;
  if (!testCase.case_id) throw new Error("case_id is required");
  if (!testCase.question?.trim()) throw new Error(`case ${testCase.case_id} has no question`);

  const harness = createPluginHarness(testCase.case_id);
  createClawMemPlugin(harness.api as never);

  const memoryStore = harness.tool("memory_store");
  const memoryRecall = harness.tool("memory_recall");
  const indexStartedAt = Date.now();
  const indexed = await indexCase(memoryStore, testCase, harness.agentId);
  const indexLatencyMs = elapsedMs(indexStartedAt);
  log(`indexed ${indexed} ${INDEX_GRANULARITY} memory item(s) for ${testCase.case_id} using agent ${harness.agentId}`);

  const recallStartedAt = Date.now();
  const recallResult = await memoryRecall("eval", {
    agentId: harness.agentId,
    query: testCase.question,
    limit: TOP_K,
  });
  const recallText = resultText(recallResult);
  const prediction = parsePrediction(testCase, recallText, indexed, indexLatencyMs, elapsedMs(recallStartedAt), harness.agentId);
  console.log(JSON.stringify(prediction));
}

function createPluginHarness(caseId: string) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const safeCase = normalizeAgentPart(caseId);
  const hash = crypto.createHash("sha1").update(caseId).digest("hex").slice(0, 8);
  const agentId = normalizeAgentPart(`${AGENT_PREFIX}-${hash}-${safeCase}`).slice(0, 64);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-real-eval-"));
  let configRoot: Record<string, any> = {
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
  };

  const api = {
    id: "clawmem",
    name: "ClawMem",
    source: "eval",
    registrationMode: "eval",
    config: {},
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
        },
      },
      events: {
        onSessionTranscriptUpdate: () => () => {},
      },
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
    on: (event: string, handler: (...args: any[]) => unknown) => {
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
  };
}

async function indexCase(store: ToolExecute, testCase: NormalizedCase, agentId: string): Promise<number> {
  const items = buildIndexItems(testCase);
  let count = 0;
  for (const item of items) {
    if (MAX_INDEX_ITEMS && count >= MAX_INDEX_ITEMS) break;
    const result = await store("eval", {
      agentId,
      title: item.title,
      detail: item.detail,
      kind: "benchmark-evidence",
      topics: [testCase.benchmark ?? "benchmark", INDEX_GRANULARITY],
    });
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
      .map((message) => {
        const speaker = message.speaker || message.role || "speaker";
        return `[${message.turn_id ?? ""}] ${speaker}: ${message.content ?? ""}`.trim();
      })
      .filter(Boolean)
      .join("\n");
    return {
      id: sessionId,
      title: `Eval session ${sessionId}`,
      detail: [
        `EVAL_CASE_ID: ${testCase.case_id}`,
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
          `EVAL_CASE_ID: ${testCase.case_id}`,
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

function parsePrediction(testCase: NormalizedCase, recallText: string, indexed: number, indexLatencyMs: number, recallLatencyMs: number, agentId: string): Record<string, unknown> {
  const sessionIds = unique([...recallText.matchAll(/EVAL_SESSION_ID:\s*([^\s\n]+)/g)].map((match) => match[1] ?? ""));
  const turnIds = unique([...recallText.matchAll(/EVAL_TURN_ID:\s*([^\s\n]+)/g)].map((match) => match[1] ?? ""));
  return {
    case_id: testCase.case_id,
    benchmark: testCase.benchmark,
    retrieved_session_ids: sessionIds,
    retrieved_turn_ids: turnIds,
    metadata: {
      adapter: "clawmem_real_backend_retrieval",
      base_url: BASE_URL,
      index_granularity: INDEX_GRANULARITY,
      indexed_items: indexed,
      index_latency_ms: indexLatencyMs,
      recall_latency_ms: recallLatencyMs,
      recall_top_k: TOP_K,
      agent_id: agentId,
    },
    raw_recall_text: process.env.CLAWMEM_EVAL_INCLUDE_RAW_RECALL === "1" ? recallText : undefined,
  };
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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function normalizeAgentPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "eval";
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
  process.stderr.write(`[clawmem-eval] ${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`[clawmem-eval] ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
