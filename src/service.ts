// Thin orchestrator: wires conversation mirroring, memory store, agent-scoped tools, and plugin lifecycle.
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isAgentConfigured, resolveAgentRoute, resolvePluginConfig } from "./config.js";
import { ConversationMirror } from "./conversation.js";
import { GitHubIssueClient } from "./github-client.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import { MemoryStore } from "./memory.js";
import { loadState, resolveStatePath, saveState } from "./state.js";
import { readTranscriptSnapshot } from "./transcript.js";
import type { ClawMemPluginConfig, ParsedMemoryIssue, PluginState, SessionMirrorState, TranscriptSnapshot } from "./types.js";
import { inferAgentIdFromTranscriptPath, normalizeAgentId, sessionScopeKey, sha256 } from "./utils.js";

type TurnPayload = { sessionId?: string; sessionKey?: string; agentId?: string; messages: unknown[] };
type FinalizePayload = { sessionId?: string; sessionKey?: string; sessionFile?: string; agentId?: string; reason?: string; messages?: unknown[] };
type MemoryToolName = "memory_store" | "memory_search";

class ClawMemService {
  private readonly config: ClawMemPluginConfig;
  private readonly queue = new KeyedAsyncQueue();
  private readonly stateQueue = new KeyedAsyncQueue();
  private readonly toolQueue = new KeyedAsyncQueue();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statePath = "";
  private state: PluginState = { version: 2, sessions: {} };
  private unsubTranscript?: () => void;
  private loadPromise: Promise<void> | null = null;
  private readonly configPromises = new Map<string, Promise<boolean>>();

  constructor(private readonly api: OpenClawPluginApi) {
    this.config = resolvePluginConfig(api);
  }

  register(): void {
    this.api.on("before_agent_start", async (ev, ctx) => this.handleRecall(ev.prompt, ctx.agentId));
    this.api.on("agent_end", (ev, ctx) => this.scheduleTurn({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, agentId: ctx.agentId, messages: ev.messages }));
    this.api.on("before_reset", (ev, ctx) => this.enqueueFinalize({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, sessionFile: ev.sessionFile, agentId: ctx.agentId, reason: ev.reason, messages: ev.messages }));
    this.api.on("session_end", (ev, ctx) => this.enqueueFinalize({ sessionId: ev.sessionId ?? ctx.sessionId, sessionKey: ev.sessionKey ?? ctx.sessionKey, agentId: ctx.agentId, reason: "session_end" }));
    this.api.registerTool((ctx) => this.createTools(ctx), { names: ["memory_store", "memory_search"] });

    this.api.registerService({
      id: "clawmem",
      start: async (ctx: { stateDir: string }) => {
        this.statePath = resolveStatePath(ctx.stateDir);
        await this.ensureLoaded();
        this.unsubTranscript = this.api.runtime.events.onSessionTranscriptUpdate((u: { sessionFile: string }) => {
          void this.track(this.handleTranscript(u.sessionFile)).catch((e) => this.warn("transcript update", e));
        });
        const configuredCount = Object.keys(this.config.agents).filter((agentId) => {
          return isAgentConfigured(resolveAgentRoute(this.config, agentId));
        }).length;
        this.api.logger.info?.(
          configuredCount > 0
            ? `clawmem: ready with ${configuredCount} configured agent route(s); missing routes will provision on first use via ${this.config.baseUrl}`
            : `clawmem: ready; agent routes will provision on first use via ${this.config.baseUrl}`,
        );
      },
      stop: async () => {
        this.unsubTranscript?.();
        for (const t of this.syncTimers.values()) clearTimeout(t);
        this.syncTimers.clear();
        await Promise.allSettled([...this.pending]);
      },
    });
  }

  private createTools(ctx: { agentId?: string; sessionId?: string }): AnyAgentTool[] {
    return [
      this.createMemoryStoreTool(ctx),
      this.createMemorySearchTool(ctx),
    ];
  }

  private createMemoryStoreTool(ctx: { agentId?: string; sessionId?: string }): AnyAgentTool {
    return {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory via ClawMem. Use for preferences, facts, decisions, and anything worth remembering.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Memory content to store.",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Optional extra labels. Multiple labels are supported. Reserved system labels are ignored.",
          },
          sessionId: {
            type: "string",
            description: "Current session id. Must match the active runtime session.",
          },
        },
        required: ["content", "sessionId"],
      },
      execute: async (_toolCallId, rawParams) => {
        const params = asToolParams(rawParams);
        const content = readRequiredToolString(params, ["content"], "content");
        const requestedSessionId = readRequiredToolString(params, ["sessionId", "session_id", "sessionid"], "sessionId");
        const labels = readToolStringArray(params, ["labels"], "labels") ?? [];
        const runtimeSessionId = ctx.sessionId?.trim();
        if (runtimeSessionId && requestedSessionId !== runtimeSessionId) {
          throw new Error(`sessionId mismatch: got ${JSON.stringify(requestedSessionId)}, expected ${JSON.stringify(runtimeSessionId)}`);
        }
        const sessionId = runtimeSessionId || requestedSessionId;
        const agentId = normalizeAgentId(ctx.agentId);
        return await this.toolQueue.enqueue(memoryStoreQueueKey(agentId, content), async () => {
          if (!(await this.ensureConfigured(agentId))) {
            const route = resolveAgentRoute(this.config, agentId);
            return buildToolErrorResult("memory_store", {
              agentId,
              repo: route.repo ?? null,
              code: "route_unavailable",
              message: `clawmem route unavailable for agent ${agentId}`,
              data: { sessionId },
            });
          }
          const route = resolveAgentRoute(this.config, agentId);
          const { mem } = this.getServices(agentId);
          const result = await mem.storeManual({ content, labels, sessionId });
          return buildToolSuccessResult("memory_store", {
            agentId,
            repo: route.repo ?? null,
            data: {
              created: result.created,
              duplicate: result.duplicate,
              memory: serializeMemory(result.memory),
            },
          });
        });
      },
    };
  }

  private createMemorySearchTool(ctx: { agentId?: string }): AnyAgentTool {
    return {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search for memories by natural-language query. Returns only active memories. Use for finding specific memories or confirming information.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for active memories.",
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 10,
            description: "Maximum number of results to return. Defaults to 5.",
          },
        },
        required: ["query"],
      },
      execute: async (_toolCallId, rawParams) => {
        const params = asToolParams(rawParams);
        const query = readRequiredToolString(params, ["query"], "query");
        const limit = clampInteger(readToolNumber(params, ["limit"], "limit") ?? 5, 1, 10);
        const agentId = normalizeAgentId(ctx.agentId);
        if (!(await this.ensureConfigured(agentId))) {
          const route = resolveAgentRoute(this.config, agentId);
          return buildToolErrorResult("memory_search", {
            agentId,
            repo: route.repo ?? null,
            code: "route_unavailable",
            message: `clawmem route unavailable for agent ${agentId}`,
            data: {
              query,
              limit,
              count: 0,
              memories: [],
            },
          });
        }
        const route = resolveAgentRoute(this.config, agentId);
        const { mem } = this.getServices(agentId);
        const results = await mem.search(query, limit, { issueState: "open" });
        return buildToolSuccessResult("memory_search", {
          agentId,
          repo: route.repo ?? null,
          data: {
            query,
            limit,
            count: results.length,
            memories: results.map(serializeMemory),
          },
        });
      },
    };
  }

  private async handleRecall(prompt: unknown, agentId?: string): Promise<{ prependContext: string } | void> {
    if (typeof prompt !== "string" || prompt.trim().length < 5) return;
    const routeAgentId = normalizeAgentId(agentId);
    if (!(await this.ensureConfigured(routeAgentId))) return;
    try {
      const { mem } = this.getServices(routeAgentId);
      const memories = await mem.search(prompt, this.config.memoryRecallLimit);
      if (memories.length === 0) return;
      const text = memories.map((m) => `- ${m.detail}`).join("\n");
      return { prependContext: `<relevant-memories>\nThe following active memories may be relevant to this conversation:\n${text}\n</relevant-memories>` };
    } catch (error) { this.api.logger.warn(`clawmem: memory recall failed: ${String(error)}`); }
  }

  private async handleTranscript(sessionFile: string): Promise<void> {
    let snap: TranscriptSnapshot;
    try { snap = await readTranscriptSnapshot(sessionFile); } catch (e) { this.warn("transcript read", e); return; }
    if (!snap.sessionId) return;
    const agentId = this.resolveTranscriptAgentId(snap.sessionId, sessionFile);
    if (!agentId) {
      this.api.logger.info?.(
        `clawmem: skipping transcript sync for ${snap.sessionId} because agent ownership could not be inferred from ${sessionFile}`,
      );
      return;
    }
    const { conv } = this.getServices(agentId);
    if (!conv.shouldMirror(snap.sessionId, snap.messages)) return;
    if (!(await this.ensureConfigured(agentId))) return;
    await this.enqueueSession(sessionScopeKey(snap.sessionId, agentId), async () => {
      const s = this.getOrCreate(snap.sessionId!, agentId);
      s.sessionFile = sessionFile;
      s.updatedAt = new Date().toISOString();
      await conv.ensureIssue(s, snap);
      await this.persistState();
    });
  }

  private scheduleTurn(p: TurnPayload): void {
    if (!p.sessionId) return;
    const scopeKey = sessionScopeKey(p.sessionId, p.agentId);
    const prev = this.syncTimers.get(scopeKey);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.syncTimers.delete(scopeKey);
      void this.track(this.enqueueSession(scopeKey, () => this.syncTurn(p))).catch((e) => this.warn("turn sync", e));
    }, this.config.turnCommentDelayMs);
    timer.unref?.();
    this.syncTimers.set(scopeKey, timer);
  }

  private async syncTurn(p: TurnPayload): Promise<void> {
    if (!p.sessionId) return;
    const agentId = normalizeAgentId(p.agentId);
    if (!(await this.ensureConfigured(agentId))) return;
    const { conv } = this.getServices(agentId);
    const s = this.getOrCreate(p.sessionId, agentId);
    s.sessionKey = p.sessionKey ?? s.sessionKey; s.agentId = agentId; s.updatedAt = new Date().toISOString();
    const snap = await conv.loadSnapshot(s, p.messages);
    if (!conv.shouldMirror(s.sessionId, snap.messages) || snap.messages.length === 0) { await this.persistState(); return; }
    await conv.ensureIssue(s, snap);
    await conv.syncLabels(s, snap, false);
    const next = snap.messages.slice(s.lastMirroredCount);
    if (next.length > 0) { const n = await conv.appendComments(s.issueNumber!, next); s.lastMirroredCount += n; s.turnCount += n; }
    await this.persistState();
  }

  private enqueueFinalize(p: FinalizePayload): void {
    if (!p.sessionId) return;
    const scopeKey = sessionScopeKey(p.sessionId, p.agentId);
    const prev = this.syncTimers.get(scopeKey);
    if (prev) { clearTimeout(prev); this.syncTimers.delete(scopeKey); }
    void this.track(this.enqueueSession(scopeKey, () => this.finalize(p))).catch((e) => this.warn("finalize", e));
  }

  private async finalize(p: FinalizePayload): Promise<void> {
    if (!p.sessionId) return;
    const agentId = normalizeAgentId(p.agentId);
    if (!(await this.ensureConfigured(agentId))) return;
    const { conv, mem } = this.getServices(agentId);
    const s = this.getOrCreate(p.sessionId, agentId);
    if (s.finalizedAt) return;
    s.sessionKey = p.sessionKey ?? s.sessionKey; s.sessionFile = p.sessionFile ?? s.sessionFile;
    s.agentId = agentId; s.updatedAt = new Date().toISOString();
    const snap = await conv.loadSnapshot(s, p.messages ?? []);
    if (!conv.shouldMirror(s.sessionId, snap.messages)) { await this.persistState(); return; }
    if (snap.messages.length === 0 && !s.issueNumber) { await this.persistState(); return; }
    await conv.ensureIssue(s, snap);
    const next = snap.messages.slice(s.lastMirroredCount);
    let allOk = true;
    if (next.length > 0) { const n = await conv.appendComments(s.issueNumber!, next); s.lastMirroredCount += n; s.turnCount += n; allOk = n === next.length; }
    let summary = "pending";
    try { summary = await conv.generateSummary(s, snap); } catch (e) { summary = `failed: ${String(e)}`; }
    await conv.syncLabels(s, snap, true);
    await conv.syncBody(s, snap, summary, true);
    await mem.syncFromConversation(s, snap);
    if (allOk) s.finalizedAt = new Date().toISOString();
    await this.persistState();
  }

  // --- Infrastructure ---

  private enqueueSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(sessionId, async () => { await this.ensureLoaded(); return task(); });
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    // Avoid creating a second rejecting promise via finally(); OpenClaw treats
    // unhandled rejections as fatal and exits the gateway process.
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  private getOrCreate(sessionId: string, agentId?: string): SessionMirrorState {
    const scopeKey = sessionScopeKey(sessionId, agentId);
    if (this.state.sessions[scopeKey]) return this.state.sessions[scopeKey];
    const now = new Date().toISOString();
    const s: SessionMirrorState = {
      sessionId,
      agentId: normalizeAgentId(agentId),
      lastMirroredCount: 0,
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.state.sessions[scopeKey] = s;
    return s;
  }
  private resolveTranscriptAgentId(sessionId: string, sessionFile: string): string | null {
    const fromPath = inferAgentIdFromTranscriptPath(sessionFile);
    if (fromPath) return fromPath;
    const knownAgents = new Set(
      Object.values(this.state.sessions)
        .filter((session) => session.sessionId === sessionId)
        .map((session) => normalizeAgentId(session.agentId)),
    );
    if (knownAgents.size === 1) return [...knownAgents][0] ?? null;
    return null;
  }
  private async persistState(): Promise<void> {
    if (!this.statePath) this.statePath = resolveStatePath(this.api.runtime.state.resolveStateDir());
    await this.stateQueue.enqueue("state", () => saveState(this.statePath, this.state));
  }
  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      if (!this.statePath) this.statePath = resolveStatePath(this.api.runtime.state.resolveStateDir());
      this.state = await loadState(this.statePath);
    })();
    return this.loadPromise;
  }
  private async ensureConfigured(agentId?: string): Promise<boolean> {
    const id = normalizeAgentId(agentId);
    if (isAgentConfigured(resolveAgentRoute(this.config, id))) return true;
    const pending = this.configPromises.get(id);
    if (pending) return pending;
    const p = this.bootstrap(id);
    this.configPromises.set(id, p);
    try { return await p; } finally { if (this.configPromises.get(id) === p) this.configPromises.delete(id); }
  }
  private async bootstrap(agentId: string): Promise<boolean> {
    const route = resolveAgentRoute(this.config, agentId);
    if (!route.baseUrl) { this.api.logger.warn(`clawmem: cannot provision Git credentials for ${agentId} without a baseUrl`); return false; }
    try {
      const client = new GitHubIssueClient(route, this.api.logger);
      const sess = await client.createAnonymousSession();
      await this.persistAgentConfig(agentId, { baseUrl: route.baseUrl, authScheme: "token", token: sess.token, repo: sess.repo_full_name });
      this.config.agents[agentId] = { ...(this.config.agents[agentId] ?? {}), baseUrl: route.baseUrl, authScheme: "token", token: sess.token, repo: sess.repo_full_name };
      this.api.logger.info?.(`clawmem: provisioned Git credentials for agent ${agentId} -> ${sess.repo_full_name} via ${route.baseUrl}`);
      return true;
    } catch (error) { this.api.logger.warn(`clawmem: failed to provision Git credentials for agent ${agentId} via ${route.baseUrl}: ${String(error)}`); return false; }
  }
  private async persistAgentConfig(agentId: string, values: { baseUrl: string; authScheme: "token" | "bearer"; token: string; repo: string }): Promise<void> {
    const root = this.api.runtime.config.loadConfig();
    const plugins = root.plugins;
    const entries = plugins?.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries) ? (plugins.entries as Record<string, unknown>) : {};
    const ex = asRecord(entries[this.api.id]), exCfg = asRecord(ex.config);
    const agents = exCfg.agents && typeof exCfg.agents === "object" && !Array.isArray(exCfg.agents) ? (exCfg.agents as Record<string, unknown>) : {};
    const existingAgent = asRecord(agents[agentId]);
    await this.api.runtime.config.writeConfigFile({
      ...root,
      plugins: {
        ...(plugins ?? {}),
        entries: {
          ...entries,
          [this.api.id]: {
            ...ex,
            config: {
              ...exCfg,
              agents: {
                ...agents,
                [agentId]: { ...existingAgent, ...values },
              },
            },
          },
        },
      },
    });
  }
  private getServices(agentId?: string): { conv: ConversationMirror; mem: MemoryStore } {
    const client = new GitHubIssueClient(resolveAgentRoute(this.config, agentId), this.api.logger);
    return {
      conv: new ConversationMirror(client, this.api, this.config),
      mem: new MemoryStore(client, this.api, this.config),
    };
  }
  private warn(scope: string, error: unknown): void { this.api.logger.warn(`clawmem: ${scope} failed: ${String(error)}`); }
}

function asRecord(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; }

function asToolParams(v: unknown): Record<string, unknown> {
  return asRecord(v);
}

function readToolRaw(params: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(params, key)) return params[key];
  }
  return undefined;
}

function readRequiredToolString(params: Record<string, unknown>, keys: string[], label: string): string {
  const raw = readToolRaw(params, keys);
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} required`);
  return raw.trim();
}

function readToolStringArray(params: Record<string, unknown>, keys: string[], label: string): string[] | undefined {
  const raw = readToolRaw(params, keys);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) throw new Error(`${label} must be a string or array of strings`);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") throw new Error(`${label} entries must be strings`);
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function readToolNumber(params: Record<string, unknown>, keys: string[], label: string): number | undefined {
  const raw = readToolRaw(params, keys);
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${label} must be a number`);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function memoryStoreQueueKey(agentId: string, content: string): string {
  return `memory-store:${agentId}:${sha256(normalizeToolText(content))}`;
}

function normalizeToolText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function serializeMemory(memory: ParsedMemoryIssue) {
  return {
    issueNumber: memory.issueNumber,
    memoryId: memory.memoryId,
    title: memory.title,
    detail: memory.detail,
    labels: memory.labels,
    sessionId: memory.sessionId,
    date: memory.date,
    status: memory.status,
  };
}

function buildToolSuccessResult(
  tool: MemoryToolName,
  params: { agentId: string; repo: string | null; data: unknown },
) {
  return toolJsonResult({
    ok: true,
    tool,
    agentId: params.agentId,
    repo: params.repo,
    data: params.data,
  });
}

function buildToolErrorResult(
  tool: MemoryToolName,
  params: {
    agentId: string;
    repo: string | null;
    code: string;
    message: string;
    data?: unknown;
  },
) {
  return toolJsonResult({
    ok: false,
    tool,
    agentId: params.agentId,
    repo: params.repo,
    error: {
      code: params.code,
      message: params.message,
    },
    ...(params.data !== undefined ? { data: params.data } : {}),
  });
}

function toolJsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

export function createClawMemPlugin(api: OpenClawPluginApi): void { new ClawMemService(api).register(); }
