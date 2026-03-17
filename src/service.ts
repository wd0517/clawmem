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
    this.api.on("before_agent_start", async (ev, ctx) => this.handleRecall(ev.prompt, ctx.agentId));
    this.api.on("agent_end", (ev, ctx) => this.scheduleTurn({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, agentId: ctx.agentId, messages: ev.messages }));
    this.api.on("before_reset", (ev, ctx) => this.enqueueFinalize({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, sessionFile: ev.sessionFile, agentId: ctx.agentId, reason: ev.reason, messages: ev.messages }));
    this.api.on("session_end", (ev, ctx) => this.enqueueFinalize({ sessionId: ev.sessionId ?? ctx.sessionId, sessionKey: ev.sessionKey ?? ctx.sessionKey, agentId: ctx.agentId, reason: "session_end" }));

    this.api.registerService({
      id: "clawmem",
      start: async (ctx) => {
        this.statePath = resolveStatePath(ctx.stateDir);
        await this.ensureLoaded();
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

export function createClawMemPlugin(api: OpenClawPluginApi): void { new ClawMemService(api).register(); }
