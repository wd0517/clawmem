// Thin orchestrator: wires conversation mirroring, memory store, and plugin lifecycle.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isPluginConfigured, resolvePluginConfig } from "./config.js";
import { ConversationMirror } from "./conversation.js";
import { GitHubIssueClient } from "./github-client.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import { MemoryStore } from "./memory.js";
import { loadState, resolveStatePath, saveState } from "./state.js";
import { readTranscriptSnapshot } from "./transcript.js";
import type { ClawMemPluginConfig, PluginState, SessionMirrorState, TranscriptSnapshot } from "./types.js";

type TurnPayload = { sessionId?: string; sessionKey?: string; agentId?: string; messages: unknown[] };
type FinalizePayload = { sessionId?: string; sessionKey?: string; sessionFile?: string; agentId?: string; reason?: string; messages?: unknown[] };

class ClawMemService {
  private readonly config: ClawMemPluginConfig;
  private readonly client: GitHubIssueClient;
  private readonly conv: ConversationMirror;
  private readonly mem: MemoryStore;
  private readonly queue = new KeyedAsyncQueue();
  private readonly stateQueue = new KeyedAsyncQueue();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statePath = "";
  private state: PluginState = { version: 1, sessions: {} };
  private unsubTranscript?: () => void;
  private loadPromise: Promise<void> | null = null;
  private configPromise: Promise<boolean> | null = null;

  constructor(private readonly api: OpenClawPluginApi) {
    this.config = resolvePluginConfig(api);
    this.client = new GitHubIssueClient(this.config, api.logger);
    this.conv = new ConversationMirror(this.client, api, this.config);
    this.mem = new MemoryStore(this.client, api, this.config);
  }

  register(): void {
    this.api.on("before_agent_start", async (ev) => this.handleRecall(ev.prompt));
    this.api.on("agent_end", (ev, ctx) => this.scheduleTurn({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, agentId: ctx.agentId, messages: ev.messages }));
    this.api.on("before_reset", (ev, ctx) => this.enqueueFinalize({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, sessionFile: ev.sessionFile, agentId: ctx.agentId, reason: ev.reason, messages: ev.messages }));
    this.api.on("session_end", (ev, ctx) => this.enqueueFinalize({ sessionId: ev.sessionId ?? ctx.sessionId, sessionKey: ev.sessionKey ?? ctx.sessionKey, agentId: ctx.agentId, reason: "session_end" }));

    this.api.registerService({
      id: "clawmem",
      start: async (ctx) => {
        this.statePath = resolveStatePath(ctx.stateDir);
        await this.ensureLoaded();
        const ok = await this.ensureConfigured();
        this.unsubTranscript = this.api.runtime.events.onSessionTranscriptUpdate((u) => {
          void this.track(this.handleTranscript(u.sessionFile)).catch((e) => this.warn("transcript update", e));
        });
        if (ok) this.api.logger.info?.(`clawmem: mirroring sessions to ${this.config.repo} via ${this.config.baseUrl}`);
        else this.api.logger.warn(`clawmem: missing repo/token and automatic provisioning failed via ${this.config.baseUrl}; sync will retry on the next use`);
      },
      stop: async () => {
        this.unsubTranscript?.();
        for (const t of this.syncTimers.values()) clearTimeout(t);
        this.syncTimers.clear();
        await Promise.allSettled([...this.pending]);
      },
    });
  }

  private async handleRecall(prompt: unknown): Promise<{ prependContext: string } | void> {
    if (typeof prompt !== "string" || prompt.trim().length < 5) return;
    if (!(await this.ensureConfigured())) return;
    try {
      const memories = await this.mem.search(prompt, this.config.memoryRecallLimit);
      if (memories.length === 0) return;
      const text = memories.map((m) => `- ${m.detail}`).join("\n");
      return { prependContext: `<relevant-memories>\nThe following active memories may be relevant to this conversation:\n${text}\n</relevant-memories>` };
    } catch (error) { this.api.logger.warn(`clawmem: memory recall failed: ${String(error)}`); }
  }

  private async handleTranscript(sessionFile: string): Promise<void> {
    let snap: TranscriptSnapshot;
    try { snap = await readTranscriptSnapshot(sessionFile); } catch (e) { this.warn("transcript read", e); return; }
    if (!snap.sessionId || !this.conv.shouldMirror(snap.sessionId, snap.messages)) return;
    if (!(await this.ensureConfigured())) return;
    await this.enqueueSession(snap.sessionId, async () => {
      const s = this.getOrCreate(snap.sessionId!);
      s.sessionFile = sessionFile;
      s.updatedAt = new Date().toISOString();
      await this.conv.ensureIssue(s, snap);
      await this.persistState();
    });
  }

  private scheduleTurn(p: TurnPayload): void {
    if (!p.sessionId) return;
    const prev = this.syncTimers.get(p.sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.syncTimers.delete(p.sessionId!);
      void this.track(this.enqueueSession(p.sessionId!, () => this.syncTurn(p))).catch((e) => this.warn("turn sync", e));
    }, this.config.turnCommentDelayMs);
    timer.unref?.();
    this.syncTimers.set(p.sessionId, timer);
  }

  private async syncTurn(p: TurnPayload): Promise<void> {
    if (!p.sessionId || !(await this.ensureConfigured())) return;
    const s = this.getOrCreate(p.sessionId);
    s.sessionKey = p.sessionKey ?? s.sessionKey; s.agentId = p.agentId ?? s.agentId; s.updatedAt = new Date().toISOString();
    const snap = await this.conv.loadSnapshot(s, p.messages);
    if (!this.conv.shouldMirror(s.sessionId, snap.messages) || snap.messages.length === 0) { await this.persistState(); return; }
    await this.conv.ensureIssue(s, snap);
    await this.conv.syncLabels(s, snap, false);
    const next = snap.messages.slice(s.lastMirroredCount);
    if (next.length > 0) { const n = await this.conv.appendComments(s.issueNumber!, next); s.lastMirroredCount += n; s.turnCount += n; }
    await this.persistState();
  }

  private enqueueFinalize(p: FinalizePayload): void {
    if (!p.sessionId) return;
    const prev = this.syncTimers.get(p.sessionId);
    if (prev) { clearTimeout(prev); this.syncTimers.delete(p.sessionId); }
    void this.track(this.enqueueSession(p.sessionId, () => this.finalize(p))).catch((e) => this.warn("finalize", e));
  }

  private async finalize(p: FinalizePayload): Promise<void> {
    if (!p.sessionId || !(await this.ensureConfigured())) return;
    const s = this.getOrCreate(p.sessionId);
    if (s.finalizedAt) return;
    s.sessionKey = p.sessionKey ?? s.sessionKey; s.sessionFile = p.sessionFile ?? s.sessionFile;
    s.agentId = p.agentId ?? s.agentId; s.updatedAt = new Date().toISOString();
    const snap = await this.conv.loadSnapshot(s, p.messages ?? []);
    if (!this.conv.shouldMirror(s.sessionId, snap.messages)) { await this.persistState(); return; }
    if (snap.messages.length === 0 && !s.issueNumber) { await this.persistState(); return; }
    await this.conv.ensureIssue(s, snap);
    const next = snap.messages.slice(s.lastMirroredCount);
    let allOk = true;
    if (next.length > 0) { const n = await this.conv.appendComments(s.issueNumber!, next); s.lastMirroredCount += n; s.turnCount += n; allOk = n === next.length; }
    let summary = "pending";
    try { summary = await this.conv.generateSummary(s, snap); } catch (e) { summary = `failed: ${String(e)}`; }
    await this.conv.syncLabels(s, snap, true);
    await this.conv.syncBody(s, snap, summary, true);
    await this.mem.syncFromConversation(s, snap);
    if (allOk) s.finalizedAt = new Date().toISOString();
    await this.persistState();
  }

  // --- Infrastructure ---

  private enqueueSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(sessionId, async () => { await this.ensureLoaded(); return task(); });
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise); void promise.finally(() => this.pending.delete(promise)); return promise;
  }
  private getOrCreate(sessionId: string): SessionMirrorState {
    if (this.state.sessions[sessionId]) return this.state.sessions[sessionId];
    const now = new Date().toISOString();
    const s: SessionMirrorState = { sessionId, lastMirroredCount: 0, turnCount: 0, createdAt: now, updatedAt: now };
    this.state.sessions[sessionId] = s;
    return s;
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
  private async ensureConfigured(): Promise<boolean> {
    if (isPluginConfigured(this.config)) return true;
    if (this.configPromise) return this.configPromise;
    const p = this.bootstrap();
    this.configPromise = p;
    try { return await p; } finally { if (this.configPromise === p) this.configPromise = null; }
  }
  private async bootstrap(): Promise<boolean> {
    if (!this.config.baseUrl) { this.api.logger.warn("clawmem: cannot provision Git credentials without a baseUrl"); return false; }
    try {
      const sess = await this.client.createAnonymousSession();
      await this.persistPluginConfig({ baseUrl: this.config.baseUrl, authScheme: "token", token: sess.token, repo: sess.repo_full_name });
      this.config.authScheme = "token"; this.config.token = sess.token; this.config.repo = sess.repo_full_name;
      this.api.logger.info?.(`clawmem: provisioned Git credentials for ${sess.repo_full_name} via ${this.config.baseUrl}`);
      return true;
    } catch (error) { this.api.logger.warn(`clawmem: failed to provision Git credentials via ${this.config.baseUrl}: ${String(error)}`); return false; }
  }
  private async persistPluginConfig(values: Partial<ClawMemPluginConfig>): Promise<void> {
    const root = this.api.runtime.config.loadConfig();
    const plugins = root.plugins;
    const entries = plugins?.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries) ? (plugins.entries as Record<string, unknown>) : {};
    const ex = asRecord(entries[this.api.id]), exCfg = asRecord(ex.config);
    await this.api.runtime.config.writeConfigFile({ ...root, plugins: { ...(plugins ?? {}), entries: { ...entries, [this.api.id]: { ...ex, config: { ...exCfg, ...values } } } } });
  }
  private warn(scope: string, error: unknown): void { this.api.logger.warn(`clawmem: ${scope} failed: ${String(error)}`); }
}

function asRecord(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; }

export function createClawMemPlugin(api: OpenClawPluginApi): void { new ClawMemService(api).register(); }
