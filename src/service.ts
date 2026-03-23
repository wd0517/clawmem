// Thin orchestrator: wires conversation mirroring, memory store, and plugin lifecycle.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isAgentConfigured, resolveAgentRoute, resolvePluginConfig } from "./config.js";
import { ConversationMirror } from "./conversation.js";
import { GitHubIssueClient } from "./github-client.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import { MemoryStore } from "./memory.js";
import { loadState, resolveStatePath, saveState } from "./state.js";
import { readTranscriptSnapshot } from "./transcript.js";
import type { ClawMemPluginConfig, PluginState, SessionMirrorState, TranscriptSnapshot } from "./types.js";
import { inferAgentIdFromTranscriptPath, normalizeAgentId, sessionScopeKey } from "./utils.js";

type TurnPayload = { sessionId?: string; sessionKey?: string; agentId?: string; messages: unknown[] };
type FinalizePayload = { sessionId?: string; sessionKey?: string; sessionFile?: string; agentId?: string; reason?: string; messages?: unknown[] };

class ClawMemService {
  private readonly config: ClawMemPluginConfig;
  private readonly queue = new KeyedAsyncQueue();
  private readonly stateQueue = new KeyedAsyncQueue();
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
    this.api.on("before_agent_start", async (ev, ctx) => this.handleBeforeAgentStart(ev.prompt, ctx.agentId));
    this.api.on("agent_end", (ev, ctx) => this.scheduleTurn({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, agentId: ctx.agentId, messages: ev.messages }));
    this.api.on("before_reset", (ev, ctx) => this.enqueueFinalize({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, sessionFile: ev.sessionFile, agentId: ctx.agentId, reason: ev.reason, messages: ev.messages }));
    this.api.on("session_end", (ev, ctx) => this.enqueueFinalize({ sessionId: ev.sessionId ?? ctx.sessionId, sessionKey: ev.sessionKey ?? ctx.sessionKey, agentId: ctx.agentId, reason: "session_end" }));
    this.registerTools();

    this.api.registerService({
      id: "clawmem",
      start: async (ctx: { stateDir: string }) => {
        this.statePath = resolveStatePath(ctx.stateDir);
        await this.ensureLoaded();
        this.warnIfInactiveMemorySlot();
        this.unsubTranscript = this.api.runtime.events.onSessionTranscriptUpdate((u) => {
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

  private registerTools(): void {
    this.api.registerTool({
      name: "memory_list",
      description: "List ClawMem memories by status or schema so the agent can inspect the current memory index before deduping or saving.",
      required: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["active", "stale", "all"], description: "Which memories to list. Defaults to active." },
          kind: { type: "string", minLength: 1, description: "Optional kind filter, for example core-fact, lesson, or task." },
          topic: { type: "string", minLength: 1, description: "Optional topic filter." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of memories to return." },
          agentId: { type: "string", minLength: 1, description: "Optional agent route override. Defaults to the current agent when available." },
        },
      },
      execute: async (_id: string, params: unknown) => {
        const p = asRecord(params);
        const agentId = this.resolveToolAgentId(p.agentId);
        if (!(await this.ensureConfigured(agentId))) return toolText(`ClawMem route for agent "${agentId}" is not configured.`);
        const { mem } = this.getServices(agentId);
        const status = p.status === "stale" || p.status === "all" ? p.status : "active";
        const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 20;
        const kind = typeof p.kind === "string" && p.kind.trim() ? p.kind.trim() : undefined;
        const topic = typeof p.topic === "string" && p.topic.trim() ? p.topic.trim() : undefined;
        const memories = await mem.listMemories({ status, kind, topic, limit });
        if (memories.length === 0) {
          const filters = [status !== "active" ? `status=${status}` : "", kind ? `kind=${kind}` : "", topic ? `topic=${topic}` : ""].filter(Boolean).join(", ");
          return toolText(`No memories matched${filters ? ` (${filters})` : ""}.`);
        }
        const lines = [
          `Found ${memories.length} ${status === "all" ? "" : `${status} `}memor${memories.length === 1 ? "y" : "ies"}:`,
          ...memories.map((memory) => `- ${renderMemoryLine(memory)}`),
        ];
        return toolText(lines.join("\n"));
      },
    });

    this.api.registerTool({
      name: "memory_labels",
      description: "List existing ClawMem schema labels so the agent can reuse current kinds and topics before adding new ones.",
      required: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentId: { type: "string", minLength: 1, description: "Optional agent route override. Defaults to the current agent when available." },
          limitTopics: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of topic labels to display." },
        },
      },
      execute: async (_id: string, params: unknown) => {
        const p = asRecord(params);
        const agentId = this.resolveToolAgentId(p.agentId);
        if (!(await this.ensureConfigured(agentId))) return toolText(`ClawMem route for agent "${agentId}" is not configured.`);
        const { mem } = this.getServices(agentId);
        const schema = await mem.listSchema();
        const rawLimit = typeof p.limitTopics === "number" && Number.isFinite(p.limitTopics) ? Math.floor(p.limitTopics) : 50;
        const limitTopics = Math.min(200, Math.max(1, rawLimit));
        const kinds = schema.kinds.length > 0 ? schema.kinds.map((kind) => `- kind:${kind}`).join("\n") : "- None";
        const topics = schema.topics.length > 0 ? schema.topics.slice(0, limitTopics).map((topic) => `- topic:${topic}`).join("\n") : "- None";
        const extra = schema.topics.length > limitTopics ? `\n- ...and ${schema.topics.length - limitTopics} more topics` : "";
        return toolText([
          "Current ClawMem schema labels:",
          "",
          "Kinds:",
          kinds,
          "",
          "Topics:",
          `${topics}${extra}`,
        ].join("\n"));
      },
    });

    this.api.registerTool({
      name: "memory_recall",
      description: "Search ClawMem active memories for relevant prior facts, decisions, conventions, and lessons.",
      required: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, description: "What to recall from memory." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum number of memories to return." },
          agentId: { type: "string", minLength: 1, description: "Optional agent route override. Defaults to the current agent when available." },
        },
        required: ["query"],
      },
      execute: async (_id: string, params: unknown) => {
        const p = asRecord(params);
        const query = typeof p.query === "string" ? p.query.trim() : "";
        if (!query) return toolText("Query is empty.");
        const agentId = this.resolveToolAgentId(p.agentId);
        if (!(await this.ensureConfigured(agentId))) return toolText(`ClawMem route for agent "${agentId}" is not configured.`);
        const { mem } = this.getServices(agentId);
        const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : this.config.memoryRecallLimit;
        const limit = Math.min(20, Math.max(1, rawLimit));
        const memories = await mem.search(query, limit);
        if (memories.length === 0) return toolText(`No active memories matched "${query}".`);
        const text = [
          `Found ${memories.length} active memor${memories.length === 1 ? "y" : "ies"} for "${query}":`,
          ...memories.map((memory) => `- ${renderMemoryLine(memory)}`),
        ].join("\n");
        return toolText(text);
      },
    });

    this.api.registerTool({
      name: "memory_get",
      description: "Fetch one ClawMem memory by memory id or issue number so the agent can verify an exact record.",
      required: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          memoryId: { type: "string", minLength: 1, description: "The memory id or issue number to retrieve." },
          status: { type: "string", enum: ["active", "stale", "all"], description: "Which status bucket to search. Defaults to all." },
          agentId: { type: "string", minLength: 1, description: "Optional agent route override. Defaults to the current agent when available." },
        },
        required: ["memoryId"],
      },
      execute: async (_id: string, params: unknown) => {
        const p = asRecord(params);
        const memoryId = typeof p.memoryId === "string" ? p.memoryId.trim() : "";
        if (!memoryId) return toolText("memoryId is empty.");
        const agentId = this.resolveToolAgentId(p.agentId);
        if (!(await this.ensureConfigured(agentId))) return toolText(`ClawMem route for agent "${agentId}" is not configured.`);
        const { mem } = this.getServices(agentId);
        const status = p.status === "active" || p.status === "stale" ? p.status : "all";
        const memory = await mem.get(memoryId, status);
        if (!memory) return toolText(`No ${status === "all" ? "" : `${status} `}memory matched id "${memoryId}".`);
        return toolText(renderMemoryBlock(memory));
      },
    });

    this.api.registerTool({
      name: "memory_store",
      description: "Store a durable ClawMem memory immediately instead of waiting for session finalization.",
      required: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          detail: { type: "string", minLength: 1, description: "The durable fact, lesson, decision, or preference to remember." },
          kind: { type: "string", minLength: 1, description: "Optional schema kind, for example lesson, convention, skill, or task." },
          topics: {
            type: "array",
            description: "Optional topic labels to improve future retrieval.",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 10,
          },
          sessionId: { type: "string", minLength: 1, description: "Optional source session id label. Defaults to manual." },
          agentId: { type: "string", minLength: 1, description: "Optional agent route override. Defaults to the current agent when available." },
        },
        required: ["detail"],
      },
      execute: async (_id: string, params: unknown) => {
        const p = asRecord(params);
        const detail = typeof p.detail === "string" ? p.detail.trim() : "";
        if (!detail) return toolText("Detail is empty.");
        const agentId = this.resolveToolAgentId(p.agentId);
        if (!(await this.ensureConfigured(agentId))) return toolText(`ClawMem route for agent "${agentId}" is not configured.`);
        const { mem } = this.getServices(agentId);
        const sessionId = typeof p.sessionId === "string" && p.sessionId.trim() ? p.sessionId.trim() : "manual";
        const kind = typeof p.kind === "string" && p.kind.trim() ? p.kind.trim() : undefined;
        const topics = Array.isArray(p.topics) ? p.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0) : undefined;
        const result = await mem.store({ detail, ...(kind ? { kind } : {}), ...(topics && topics.length > 0 ? { topics } : {}) }, sessionId);
        if (!result.created) return toolText(`Memory already exists.\n${renderMemoryBlock(result.memory)}`);
        return toolText(`Stored memory.\n${renderMemoryBlock(result.memory)}`);
      },
    });

    this.api.registerTool({
      name: "memory_update",
      description: "Update an existing ClawMem memory in place when the same canonical fact or task has evolved.",
      required: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          memoryId: { type: "string", minLength: 1, description: "The memory id or issue number to update." },
          detail: { type: "string", minLength: 1, description: "Optional replacement detail text for the same memory record." },
          kind: { type: "string", minLength: 1, description: "Optional replacement kind label." },
          topics: {
            type: "array",
            description: "Optional replacement topic labels.",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 10,
          },
          agentId: { type: "string", minLength: 1, description: "Optional agent route override. Defaults to the current agent when available." },
        },
        required: ["memoryId"],
      },
      execute: async (_id: string, params: unknown) => {
        const p = asRecord(params);
        const memoryId = typeof p.memoryId === "string" ? p.memoryId.trim() : "";
        if (!memoryId) return toolText("memoryId is empty.");
        const detail = typeof p.detail === "string" && p.detail.trim() ? p.detail.trim() : undefined;
        const kind = typeof p.kind === "string" && p.kind.trim() ? p.kind.trim() : undefined;
        const topics = Array.isArray(p.topics) ? p.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0) : undefined;
        if (!detail && kind === undefined && topics === undefined) return toolText("Provide at least one of detail, kind, or topics.");
        const agentId = this.resolveToolAgentId(p.agentId);
        if (!(await this.ensureConfigured(agentId))) return toolText(`ClawMem route for agent "${agentId}" is not configured.`);
        const { mem } = this.getServices(agentId);
        let updated;
        try {
          updated = await mem.update(memoryId, { ...(detail ? { detail } : {}), ...(kind !== undefined ? { kind } : {}), ...(topics !== undefined ? { topics } : {}) });
        } catch (error) {
          return toolText(`Unable to update memory "${memoryId}": ${String(error)}`);
        }
        if (!updated) return toolText(`No memory matched id "${memoryId}".`);
        return toolText(`Updated memory.\n${renderMemoryBlock(updated)}`);
      },
    });

    this.api.registerTool({
      name: "memory_forget",
      description: "Mark an active ClawMem memory as stale when it is superseded or no longer true.",
      required: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          memoryId: { type: "string", minLength: 1, description: "The memory id or issue number to mark stale." },
          agentId: { type: "string", minLength: 1, description: "Optional agent route override. Defaults to the current agent when available." },
        },
        required: ["memoryId"],
      },
      execute: async (_id: string, params: unknown) => {
        const p = asRecord(params);
        const memoryId = typeof p.memoryId === "string" ? p.memoryId.trim() : "";
        if (!memoryId) return toolText("memoryId is empty.");
        const agentId = this.resolveToolAgentId(p.agentId);
        if (!(await this.ensureConfigured(agentId))) return toolText(`ClawMem route for agent "${agentId}" is not configured.`);
        const { mem } = this.getServices(agentId);
        const forgotten = await mem.forget(memoryId);
        if (!forgotten) return toolText(`No active memory matched id "${memoryId}".`);
        return toolText(`Marked memory [${forgotten.memoryId}] stale: ${forgotten.detail}`);
      },
    });
  }

  private async handleBeforeAgentStart(prompt: unknown, agentId?: string): Promise<{ prependContext: string } | void> {
    const routeAgentId = normalizeAgentId(agentId);
    if (!(await this.ensureConfigured(routeAgentId))) return;
    await this.runRequestMaintenance(routeAgentId);
    if (typeof prompt !== "string" || prompt.trim().length < 5) return;
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
    const { conv } = this.getServices(agentId);
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
    await conv.syncLabels(s, snap, true);
    await conv.syncBody(s, snap, "pending", true);
    s.summaryStatus = "pending";
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
      const locale = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.locale ?? "";
      const sess = await client.createAnonymousSession(locale);
      await this.persistAgentConfig(agentId, { baseUrl: route.baseUrl, authScheme: "token", token: sess.token, repo: sess.repo_full_name });
      this.config.agents[agentId] = { ...(this.config.agents[agentId] ?? {}), baseUrl: route.baseUrl, authScheme: "token", token: sess.token, repo: sess.repo_full_name };
      this.api.logger.info?.(`clawmem: provisioned Git credentials for agent ${agentId} -> ${sess.repo_full_name} via ${route.baseUrl}`);
      return true;
    } catch (error) { this.api.logger.warn(`clawmem: failed to provision Git credentials for agent ${agentId} via ${route.baseUrl}: ${String(error)}`); return false; }
  }
  private warnIfInactiveMemorySlot(): void {
    try {
      const root = this.api.runtime.config.loadConfig();
      const plugins = asRecord(root.plugins);
      const slots = asRecord(plugins.slots);
      const slot = typeof slots.memory === "string" ? String(slots.memory).trim() : "";
      if (!slot) {
        this.api.logger.warn(
          `clawmem: plugins.slots.memory is not set, so OpenClaw may keep the default memory plugin active. Set plugins.slots.memory to "${this.api.id}" and restart the gateway.`,
        );
        return;
      }
      if (slot !== this.api.id) {
        this.api.logger.warn(
          `clawmem: plugins.slots.memory is "${slot}", so ClawMem is not the selected memory plugin. Set plugins.slots.memory to "${this.api.id}" and restart the gateway.`,
        );
      }
    } catch (error) {
      this.api.logger.warn(`clawmem: memory slot check failed: ${String(error)}`);
    }
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
  private async runRequestMaintenance(agentId: string): Promise<void> {
    const sessions = Object.values(this.state.sessions)
      .filter((session) => normalizeAgentId(session.agentId) === agentId)
      .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""))
      .slice(0, 8);
    if (sessions.length === 0) return;
    const { conv, mem } = this.getServices(agentId);
    let changed = false;
    let workDone = 0;
    for (const session of sessions) {
      if (workDone >= 3) break;
      const snap = await conv.loadSnapshot(session, []);
      if (!conv.shouldMirror(session.sessionId, snap.messages) || snap.messages.length === 0) continue;
      if (!session.issueNumber) {
        await conv.ensureIssue(session, snap);
        changed = true;
      }
      if (session.summaryStatus === "pending") {
        try {
          const result = await conv.generateSummaryAndTitle(session, snap);
          await conv.syncLabels(session, snap, true);
          await conv.syncBody(session, snap, result.summary, true, result.title);
          session.summaryStatus = "complete";
          if (result.title?.trim()) {
            session.issueTitle = result.title.trim();
            session.titleSource = "llm";
          }
          this.maybeAutoNameRepo(agentId, result.summary, result.title);
          changed = true;
          workDone++;
        } catch (error) {
          this.warn(`request-scoped summary sync for ${session.sessionId}`, error);
        }
      }
      if (session.titleSource !== "llm" && snap.messages.length >= 2) {
        await conv.syncTitle(session, snap);
        changed = true;
        workDone++;
      }
      if (snap.messages.length >= 2 && snap.messages.length > (session.lastMemorySyncCount ?? 0)) {
        const ok = await mem.syncFromConversation(session, snap);
        if (ok) {
          session.lastMemorySyncCount = snap.messages.length;
          changed = true;
        }
        workDone++;
      }
    }
    if (changed) await this.persistState();
  }

  private getServices(agentId?: string): { conv: ConversationMirror; mem: MemoryStore } {
    const client = new GitHubIssueClient(resolveAgentRoute(this.config, agentId), this.api.logger);
    return {
      conv: new ConversationMirror(client, this.api, this.config),
      mem: new MemoryStore(client, this.api, this.config),
    };
  }
  private resolveToolAgentId(agentId: unknown): string {
    return normalizeAgentId(typeof agentId === "string" && agentId.trim() ? agentId : process.env.OPENCLAW_AGENT_ID);
  }
  /**
   * After finalization, check if the repo still has an empty/default description.
   * If so, use the conversation summary to suggest a meaningful name and update
   * the repo description automatically. Best-effort, fire-and-forget.
   */
  private maybeAutoNameRepo(agentId: string, summary: string, title?: string): void {
    if (!summary || summary.startsWith("failed:") || summary === "pending") return;
    const snippet = title || summary.slice(0, 100);
    void (async () => {
      try {
        const client = new GitHubIssueClient(resolveAgentRoute(this.config, agentId), this.api.logger);
        const repo = await client.getRepoInfo();
        // Only auto-name if description is still empty or a default placeholder.
        if (repo.description && repo.description !== "My Memory Space" && repo.description !== "我的记忆空间" && repo.description !== "マイメモリースペース") return;
        // Use the conversation title or summary as a lightweight description.
        await client.updateRepoDescription(snippet);
        this.api.logger.info?.(`clawmem: auto-named repo to "${snippet}"`);
      } catch (e) {
        this.api.logger.warn(`clawmem: auto-name repo failed: ${String(e)}`);
      }
    })();
  }
  private warn(scope: string, error: unknown): void { this.api.logger.warn(`clawmem: ${scope} failed: ${String(error)}`); }
}

function asRecord(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; }
function toolText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}
function renderMemoryLine(memory: { memoryId: string; title?: string; detail: string; kind?: string; topics?: string[]; status: "active" | "stale" }): string {
  const schema = [memory.kind ? `kind:${memory.kind}` : "", ...(memory.topics ?? []).map((topic) => `topic:${topic}`)].filter(Boolean).join(", ");
  return `[${memory.memoryId}] ${memory.title || "Memory"}${schema ? ` (${schema})` : ""}${memory.status === "stale" ? " [stale]" : ""}: ${memory.detail}`;
}
function renderMemoryBlock(memory: { memoryId: string; issueNumber?: number; title?: string; detail: string; kind?: string; topics?: string[]; status: "active" | "stale"; sessionId?: string; date?: string }): string {
  const lines = [
    `Memory ID: ${memory.memoryId}`,
    ...(typeof memory.issueNumber === "number" ? [`Issue Number: ${memory.issueNumber}`] : []),
    `Status: ${memory.status}`,
    `Title: ${memory.title || "Memory"}`,
    ...(memory.kind ? [`Kind: ${memory.kind}`] : []),
    ...(memory.topics && memory.topics.length > 0 ? [`Topics: ${memory.topics.join(", ")}`] : []),
    ...(memory.sessionId ? [`Session: ${memory.sessionId}`] : []),
    ...(memory.date ? [`Date: ${memory.date}`] : []),
    `Detail: ${memory.detail}`,
  ];
  return lines.join("\n");
}

export function createClawMemPlugin(api: OpenClawPluginApi): void { new ClawMemService(api).register(); }
