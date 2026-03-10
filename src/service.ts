import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { isPluginConfigured, resolvePluginConfig } from "./config.js";
import { GitHubIssueClient } from "./github-client.js";
import { loadState, resolveStatePath, saveState } from "./state.js";
import { normalizeMessages, readTranscriptSnapshot } from "./transcript.js";
import type {
  ClawMemPluginConfig,
  ConversationSummaryResult,
  NormalizedMessage,
  ParsedMemoryIssue,
  PluginState,
  SessionMirrorState,
  TranscriptSnapshot,
} from "./types.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";

type AgentEndPayload = {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  messages: unknown[];
};

type FinalizePayload = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
  reason?: string;
  messages?: unknown[];
};

type MemoryToolContext = {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
};

class ClawMemService {
  private readonly config: ClawMemPluginConfig;

  private readonly client: GitHubIssueClient;

  private readonly queue = new KeyedAsyncQueue();

  private readonly stateQueue = new KeyedAsyncQueue();

  private readonly pendingTasks = new Set<Promise<unknown>>();

  private readonly pendingSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private statePath = "";

  private state: PluginState = {
    version: 1,
    sessions: {},
  };

  private transcriptUnsubscribe?: () => void;

  private loadPromise: Promise<void> | null = null;

  constructor(private readonly api: OpenClawPluginApi) {
    this.config = resolvePluginConfig(api);
    this.client = new GitHubIssueClient(this.config, api.logger);
  }

  register(): void {
    this.registerMemoryTools();

    this.api.on("before_agent_start", async (event) => {
      return this.handleBeforeAgentStart(event.prompt);
    });

    this.api.on("agent_end", (event, ctx) => {
      this.scheduleTurnSync({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        messages: event.messages,
      });
    });

    this.api.on("before_reset", (event, ctx) => {
      this.enqueueFinalize({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        sessionFile: event.sessionFile,
        agentId: ctx.agentId,
        reason: event.reason,
        messages: event.messages,
      });
    });

    this.api.on("session_end", (event, ctx) => {
      this.enqueueFinalize({
        sessionId: event.sessionId ?? ctx.sessionId,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
        agentId: ctx.agentId,
        reason: "session_end",
      });
    });

    this.api.registerService({
      id: "clawmem",
      start: async (ctx) => {
        this.statePath = resolveStatePath(ctx.stateDir);
        await this.ensureLoaded();

        if (!isPluginConfigured(this.config)) {
          this.api.logger.warn(
            "clawmem: missing baseUrl/repo/token in plugin config; plugin loaded in no-op mode",
          );
          return;
        }

        this.transcriptUnsubscribe = this.api.runtime.events.onSessionTranscriptUpdate((update) => {
          void this.track(this.handleTranscriptUpdate(update.sessionFile)).catch((error) => {
            this.logBackgroundError("transcript update", error);
          });
        });

        this.api.logger.info?.(
          `clawmem: mirroring sessions to ${this.config.repo} via ${this.config.baseUrl}`,
        );
      },
      stop: async () => {
        this.transcriptUnsubscribe?.();
        this.transcriptUnsubscribe = undefined;
        for (const timer of this.pendingSyncTimers.values()) {
          clearTimeout(timer);
        }
        this.pendingSyncTimers.clear();
        await Promise.allSettled([...this.pendingTasks]);
      },
    });
  }

  private registerMemoryTools(): void {
    this.api.registerTool(
      (ctx) => this.buildSaveMemoryTool(ctx),
      { name: "save_memory" },
    );
    this.api.registerTool(
      (ctx) => this.buildSearchMemoryTool(ctx),
      { name: "search_memory" },
    );
    this.api.registerTool(
      (ctx) => this.buildRetrieveMemoryTool(ctx),
      { name: "retrieve_memory" },
    );
    this.api.registerTool(
      (ctx) => this.buildDeleteMemoryTool(ctx),
      { name: "delete_memory" },
    );
  }

  private buildSaveMemoryTool(ctx: MemoryToolContext): AnyAgentTool {
    return {
      name: "save_memory",
      label: "Save Memory",
      description:
        "Store a reusable memory as a GitHub-backed memory issue tied to the current conversation session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["detail"],
        properties: {
          detail: {
            type: "string",
            description: "The memory detail to store.",
          },
          sessionId: {
            type: "string",
            description: "Optional session override. Defaults to the current session.",
          },
        },
      },
      execute: async (_toolCallId, args) => {
        const params = asRecord(args);
        const detail = readRequiredString(params, "detail");
        const sessionId = readOptionalString(params, "sessionId") ?? ctx.sessionId;
        if (!detail) {
          return this.errorResult("save_memory requires a non-empty detail.");
        }
        if (!sessionId) {
          return this.errorResult("save_memory requires a sessionId or an active session.");
        }
        if (!isPluginConfigured(this.config)) {
          return this.errorResult("clawmem is not configured.");
        }

        try {
          const memory = await this.createMemoryIssue(sessionId, detail);
          return this.textResult(
            `Saved memory ${memory.memoryId}.`,
            {
              action: "saved",
              memory,
            },
          );
        } catch (error) {
          return this.errorResult(`save_memory failed: ${String(error)}`);
        }
      },
    };
  }

  private buildSearchMemoryTool(_ctx: MemoryToolContext): AnyAgentTool {
    return {
      name: "search_memory",
      label: "Search Memory",
      description:
        "Search active memories and return only memories that are currently marked active.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "The natural-language query used to search active memories.",
          },
          limit: {
            type: "number",
            description: `Max results to return. Defaults to ${this.config.memoryRecallLimit}.`,
          },
        },
      },
      execute: async (_toolCallId, args) => {
        const params = asRecord(args);
        const query = readRequiredString(params, "query");
        if (!query) {
          return this.errorResult("search_memory requires a non-empty query.");
        }
        const limit = clampNumber(
          readOptionalNumber(params, "limit") ?? this.config.memoryRecallLimit,
          1,
          20,
        );
        if (!isPluginConfigured(this.config)) {
          return this.errorResult("clawmem is not configured.");
        }

        try {
          const memories = await this.searchActiveMemories(query, limit);
          if (memories.length === 0) {
            return this.textResult("No active memories found.", { count: 0, memories: [] });
          }
          const text = memories
            .map((memory, index) => `${index + 1}. [${memory.memoryId}] ${memory.detail}`)
            .join("\n");
          return this.textResult(`Found ${memories.length} active memories:\n\n${text}`, {
            count: memories.length,
            memories,
          });
        } catch (error) {
          return this.errorResult(`search_memory failed: ${String(error)}`);
        }
      },
    };
  }

  private buildRetrieveMemoryTool(_ctx: MemoryToolContext): AnyAgentTool {
    return {
      name: "retrieve_memory",
      label: "Retrieve Memory",
      description: "Retrieve a specific memory by memoryId.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["memoryId"],
        properties: {
          memoryId: {
            type: "string",
            description: "The memoryId returned by save_memory or search_memory.",
          },
        },
      },
      execute: async (_toolCallId, args) => {
        const params = asRecord(args);
        const memoryId = readRequiredString(params, "memoryId");
        if (!memoryId) {
          return this.errorResult("retrieve_memory requires memoryId.");
        }
        if (!isPluginConfigured(this.config)) {
          return this.errorResult("clawmem is not configured.");
        }

        try {
          const memory = await this.findMemoryById(memoryId);
          if (!memory) {
            return this.errorResult(`Memory ${memoryId} not found.`);
          }
          return this.textResult(
            `Memory ${memory.memoryId} (${memory.status}):\n${memory.detail}`,
            { memory },
          );
        } catch (error) {
          return this.errorResult(`retrieve_memory failed: ${String(error)}`);
        }
      },
    };
  }

  private buildDeleteMemoryTool(_ctx: MemoryToolContext): AnyAgentTool {
    return {
      name: "delete_memory",
      label: "Delete Memory",
      description:
        "Mark an active memory as stale. This is a soft delete and does not remove the issue.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["memoryId"],
        properties: {
          memoryId: {
            type: "string",
            description: "The memoryId to mark as stale.",
          },
        },
      },
      execute: async (_toolCallId, args) => {
        const params = asRecord(args);
        const memoryId = readRequiredString(params, "memoryId");
        if (!memoryId) {
          return this.errorResult("delete_memory requires memoryId.");
        }
        if (!isPluginConfigured(this.config)) {
          return this.errorResult("clawmem is not configured.");
        }

        try {
          const memory = await this.findMemoryById(memoryId);
          if (!memory) {
            return this.errorResult(`Memory ${memoryId} not found.`);
          }
          await this.ensureLabels([this.config.memoryStaleStatusLabel]);
          await this.syncManagedLabels(
            memory.issueNumber,
            this.buildMemoryLabels(memory.sessionId, memory.date, "stale"),
          );
          return this.textResult(`Memory ${memory.memoryId} marked stale.`, {
            action: "stale",
            memoryId: memory.memoryId,
          });
        } catch (error) {
          return this.errorResult(`delete_memory failed: ${String(error)}`);
        }
      },
    };
  }

  private async handleBeforeAgentStart(prompt: unknown): Promise<{ prependContext: string } | void> {
    if (!isPluginConfigured(this.config) || typeof prompt !== "string" || prompt.trim().length < 5) {
      return;
    }

    try {
      const memories = await this.searchActiveMemories(prompt, this.config.memoryRecallLimit);
      if (memories.length === 0) {
        return;
      }
      const memoryText = memories.map((memory) => `- ${memory.detail}`).join("\n");
      return {
        prependContext:
          `<relevant-memories>\n` +
          `The following active memories may be relevant to this conversation:\n` +
          `${memoryText}\n` +
          `</relevant-memories>`,
      };
    } catch (error) {
      this.api.logger.warn(`clawmem: memory recall failed: ${String(error)}`);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = (async () => {
      if (!this.statePath) {
        const baseStateDir = this.api.runtime.state.resolveStateDir();
        this.statePath = resolveStatePath(baseStateDir);
      }
      this.state = await loadState(this.statePath);
    })();
    return this.loadPromise;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pendingTasks.add(promise);
    void promise.finally(() => {
      this.pendingTasks.delete(promise);
    });
    return promise;
  }

  private scheduleTurnSync(payload: AgentEndPayload): void {
    if (!payload.sessionId) {
      return;
    }
    const existing = this.pendingSyncTimers.get(payload.sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingSyncTimers.delete(payload.sessionId!);
      void this.track(
        this.enqueueSessionTask(payload.sessionId!, async () => {
          await this.syncTurn(payload);
        }),
      ).catch((error) => {
        this.logBackgroundError("turn sync", error);
      });
    }, this.config.turnCommentDelayMs);
    timer.unref?.();
    this.pendingSyncTimers.set(payload.sessionId, timer);
  }

  private enqueueFinalize(payload: FinalizePayload): void {
    if (!payload.sessionId) {
      return;
    }
    const existing = this.pendingSyncTimers.get(payload.sessionId);
    if (existing) {
      clearTimeout(existing);
      this.pendingSyncTimers.delete(payload.sessionId);
    }
    void this.track(
      this.enqueueSessionTask(payload.sessionId, async () => {
        await this.finalizeSession(payload);
      }),
    ).catch((error) => {
      this.logBackgroundError("session finalize", error);
    });
  }

  private enqueueSessionTask<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(sessionId, async () => {
      await this.ensureLoaded();
      return task();
    });
  }

  private async handleTranscriptUpdate(sessionFile: string): Promise<void> {
    if (!isPluginConfigured(this.config)) {
      return;
    }

    let snapshot: TranscriptSnapshot;
    try {
      snapshot = await readTranscriptSnapshot(sessionFile);
    } catch (error) {
      this.api.logger.warn(`clawmem: failed to read transcript ${sessionFile}: ${String(error)}`);
      return;
    }
    if (!snapshot.sessionId) {
      return;
    }
    if (!this.shouldMirrorConversation(snapshot.sessionId, snapshot.messages)) {
      return;
    }

    await this.enqueueSessionTask(snapshot.sessionId, async () => {
      const session = this.getOrCreateSession(snapshot.sessionId!);
      session.sessionFile = sessionFile;
      session.updatedAt = new Date().toISOString();
      if (!session.issueNumber) {
        await this.ensureConversationIssue(session, snapshot);
      }
      await this.persistState();
    });
  }

  private async syncTurn(payload: AgentEndPayload): Promise<void> {
    if (!payload.sessionId || !isPluginConfigured(this.config)) {
      return;
    }

    const session = this.getOrCreateSession(payload.sessionId);
    session.sessionKey = payload.sessionKey ?? session.sessionKey;
    session.agentId = payload.agentId ?? session.agentId;
    session.updatedAt = new Date().toISOString();

    const snapshot = await this.loadBestSnapshot(session, payload.messages);
    if (!this.shouldMirrorConversation(session.sessionId, snapshot.messages)) {
      await this.persistState();
      return;
    }
    if (snapshot.messages.length === 0) {
      await this.persistState();
      return;
    }

    await this.ensureConversationIssue(session, snapshot);
    await this.ensureConversationLabels(session, snapshot, false);

    const nextMessages = snapshot.messages.slice(session.lastMirroredCount);
    if (nextMessages.length > 0) {
      const appended = await this.appendConversationComments(session.issueNumber!, nextMessages);
      if (appended > 0) {
        session.lastMirroredCount += appended;
        session.turnCount += appended;
      }
    }

    await this.persistState();
  }

  private async finalizeSession(payload: FinalizePayload): Promise<void> {
    if (!payload.sessionId || !isPluginConfigured(this.config)) {
      return;
    }

    const session = this.getOrCreateSession(payload.sessionId);
    if (session.finalizedAt) {
      return;
    }
    session.sessionKey = payload.sessionKey ?? session.sessionKey;
    session.sessionFile = payload.sessionFile ?? session.sessionFile;
    session.agentId = payload.agentId ?? session.agentId;
    session.updatedAt = new Date().toISOString();

    const snapshot = await this.loadBestSnapshot(session, payload.messages ?? []);
    if (!this.shouldMirrorConversation(session.sessionId, snapshot.messages)) {
      await this.persistState();
      return;
    }
    if (snapshot.messages.length === 0 && !session.issueNumber) {
      await this.persistState();
      return;
    }

    await this.ensureConversationIssue(session, snapshot);

    const nextMessages = snapshot.messages.slice(session.lastMirroredCount);
    let commentsComplete = true;
    if (nextMessages.length > 0) {
      const appended = await this.appendConversationComments(session.issueNumber!, nextMessages);
      if (appended > 0) {
        session.lastMirroredCount += appended;
        session.turnCount += appended;
      }
      commentsComplete = appended === nextMessages.length;
    }

    const summary = await this.safeGenerateConversationSummary(session, snapshot);
    await this.ensureConversationLabels(session, snapshot, true);
    await this.syncConversationIssueBody(session, snapshot, summary, true);

    if (commentsComplete) {
      session.finalizedAt = new Date().toISOString();
    }
    await this.persistState();
  }

  private async loadBestSnapshot(
    session: SessionMirrorState,
    fallbackMessages: unknown[],
  ): Promise<TranscriptSnapshot> {
    const transcriptPath = await this.resolveReadableTranscriptPath(session.sessionFile);
    if (transcriptPath) {
      if (session.sessionFile !== transcriptPath) {
        session.sessionFile = transcriptPath;
      }
      try {
        const transcript = await readTranscriptSnapshot(transcriptPath);
        return {
          sessionId: transcript.sessionId ?? session.sessionId,
          messages: transcript.messages,
        };
      } catch (error) {
        this.api.logger.warn(
          `clawmem: transcript read failed for ${transcriptPath}: ${String(error)}`,
        );
      }
    }
    return {
      sessionId: session.sessionId,
      messages: normalizeMessages(fallbackMessages),
    };
  }

  private async ensureConversationIssue(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
  ): Promise<void> {
    if (session.issueNumber) {
      return;
    }

    const title = this.buildConversationTitle(session);
    const labels = this.buildConversationLabels(session, snapshot, false);
    const body = this.renderConversationBody(session, snapshot, "pending", false);
    await this.ensureLabels(labels);

    const issue = await this.client.createIssue({
      title,
      body,
      labels,
    });
    session.issueNumber = issue.number;
    session.issueTitle = issue.title ?? title;
    session.lastSummaryHash = this.hash(`${title}\n${body}\nopen`);
    session.createdAt = new Date().toISOString();
    session.updatedAt = session.createdAt;
  }

  private async syncConversationIssueBody(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
    summary: ConversationSummaryResult,
    closed: boolean,
  ): Promise<void> {
    if (!session.issueNumber) {
      return;
    }

    const title = this.buildConversationTitle(session);
    const body = this.renderConversationBody(session, snapshot, summary.summary, closed);
    const bodyHash = this.hash(`${title}\n${body}\n${closed ? "closed" : "open"}`);
    if (bodyHash === session.lastSummaryHash) {
      return;
    }

    await this.client.updateIssue(session.issueNumber, {
      title,
      body,
      ...(closed && this.config.closeIssueOnReset ? { state: "closed" as const } : {}),
    });
    session.issueTitle = title;
    session.lastSummaryHash = bodyHash;
  }

  private async ensureConversationLabels(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
    closed: boolean,
  ): Promise<void> {
    if (!session.issueNumber) {
      return;
    }
    const labels = this.buildConversationLabels(session, snapshot, closed);
    await this.ensureLabels(labels);
    await this.syncManagedLabels(session.issueNumber, labels);
  }

  private async appendConversationComments(
    issueNumber: number,
    messages: NormalizedMessage[],
  ): Promise<number> {
    let appended = 0;
    for (const message of messages) {
      const body = this.renderConversationComment(message);
      try {
        await this.client.createComment(issueNumber, body);
        appended += 1;
      } catch (error) {
        this.logBackgroundError("conversation comment", error);
        break;
      }
    }
    return appended;
  }

  private async safeGenerateConversationSummary(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
  ): Promise<ConversationSummaryResult> {
    try {
      const summary = await this.generateConversationSummary(session, snapshot);
      return { summary };
    } catch (error) {
      return {
        summary: `failed: ${String(error)}`,
      };
    }
  }

  private async generateConversationSummary(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
  ): Promise<string> {
    if (snapshot.messages.length === 0) {
      throw new Error("no conversation messages to summarize");
    }

    const subagent = this.api.runtime.subagent;
    const sessionKey = this.buildSummarySessionKey(session);
    const idempotencyKey = this.hash(`${session.sessionId}:${snapshot.messages.length}:summary`);
    const message = [
      "Summarize the following conversation.",
      'Return valid JSON only in the form {"summary":"..."}',
      "The summary should be concise, factual, and written in 2-4 sentences.",
      "Do not include markdown, bullet points, or analysis.",
      "",
      "<conversation>",
      this.formatTranscriptForSummary(snapshot.messages),
      "</conversation>",
    ].join("\n");

    try {
      const run = await subagent.run({
        sessionKey,
        message,
        deliver: false,
        lane: "clawmem-summary",
        idempotencyKey,
        extraSystemPrompt:
          "You summarize OpenClaw conversations. Output JSON only with one string field named summary.",
      });

      const waitResult = await subagent.waitForRun({
        runId: run.runId,
        timeoutMs: this.config.summaryWaitTimeoutMs,
      });
      if (waitResult.status === "timeout") {
        throw new Error("summary subagent timed out");
      }
      if (waitResult.status === "error") {
        throw new Error(waitResult.error || "summary subagent failed");
      }

      const result = await subagent.getSessionMessages({ sessionKey, limit: 50 });
      const messages = normalizeMessages(result.messages);
      const finalText = [...messages]
        .reverse()
        .find((entry) => entry.role === "assistant" && entry.text.trim().length > 0)?.text;
      if (!finalText) {
        throw new Error("summary subagent returned no assistant text");
      }
      return extractSummaryText(finalText);
    } finally {
      try {
        await subagent.deleteSession({ sessionKey, deleteTranscript: true });
      } catch (error) {
        this.logBackgroundError("summary subagent cleanup", error);
      }
    }
  }

  private async createMemoryIssue(sessionId: string, detail: string): Promise<ParsedMemoryIssue> {
    const date = this.toLocalDateString();
    const memoryId = crypto.randomUUID();
    const labels = this.buildMemoryLabels(sessionId, date, "active");
    const title = `${this.config.memoryTitlePrefix}${this.truncateInline(detail, 72)}`;
    const body = this.renderMemoryBody({
      memoryId,
      sessionId,
      date,
      detail,
    });
    await this.ensureLabels(labels);
    const issue = await this.client.createIssue({
      title,
      body,
      labels,
    });
    return {
      issueNumber: issue.number,
      title: issue.title ?? title,
      memoryId,
      sessionId,
      date,
      detail,
      status: "active",
    };
  }

  private async searchActiveMemories(query: string, limit: number): Promise<ParsedMemoryIssue[]> {
    const memories = await this.listMemoryIssues("active");
    const normalizedQuery = query.trim().toLowerCase();
    const scored = memories
      .map((memory) => ({
        memory,
        score: this.scoreMemory(memory, normalizedQuery),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.memory.issueNumber - left.memory.issueNumber;
      })
      .slice(0, limit)
      .map((entry) => entry.memory);
    return scored;
  }

  private async findMemoryById(memoryId: string): Promise<ParsedMemoryIssue | null> {
    const memories = await this.listMemoryIssues("all");
    return memories.find((memory) => memory.memoryId === memoryId) ?? null;
  }

  private async listMemoryIssues(status: "active" | "stale" | "all"): Promise<ParsedMemoryIssue[]> {
    const labels = ["type:memory"];
    if (status === "active") {
      labels.push(this.config.memoryActiveStatusLabel);
    } else if (status === "stale") {
      labels.push(this.config.memoryStaleStatusLabel);
    }

    const issues: ParsedMemoryIssue[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await this.client.listIssues({
        labels,
        state: "all",
        page,
        perPage: 100,
      });
      for (const issue of batch) {
        const parsed = this.parseMemoryIssue(issue);
        if (parsed) {
          issues.push(parsed);
        }
      }
      if (batch.length < 100) {
        break;
      }
    }
    return issues;
  }

  private parseMemoryIssue(issue: {
    number: number;
    title?: string;
    body?: string;
    labels?: Array<{ name?: string } | string>;
  }): ParsedMemoryIssue | null {
    const labels = this.extractLabelNames(issue.labels);
    if (!labels.includes("type:memory")) {
      return null;
    }
    const body = typeof issue.body === "string" ? parseFlatYaml(issue.body) : {};
    const memoryId = body.memory_id?.trim();
    const sessionId = body.session_id?.trim();
    const date = body.date?.trim();
    const detail = body.detail ?? "";
    if (!memoryId || !sessionId || !date || !detail.trim()) {
      return null;
    }
    return {
      issueNumber: issue.number,
      title: issue.title?.trim() || "",
      memoryId,
      sessionId,
      date,
      detail,
      status: labels.includes(this.config.memoryStaleStatusLabel) ? "stale" : "active",
    };
  }

  private async ensureLabels(labels: string[]): Promise<void> {
    if (!this.config.autoCreateLabels) {
      return;
    }
    for (const label of labels) {
      await this.client.ensureLabel(label, this.resolveLabelColor(label), this.labelDescription(label));
    }
  }

  private async syncManagedLabels(issueNumber: number, desiredManagedLabels: string[]): Promise<void> {
    const issue = await this.client.getIssue(issueNumber);
    const existingLabels = this.extractLabelNames(issue.labels);
    const unmanagedLabels = existingLabels.filter((label) => !this.isManagedLabel(label));
    const nextLabels = [...new Set([...unmanagedLabels, ...desiredManagedLabels])];
    await this.client.updateIssue(issueNumber, { labels: nextLabels });
  }

  private buildConversationTitle(session: SessionMirrorState): string {
    return `${this.config.issueTitlePrefix}${session.sessionId}`;
  }

  private buildConversationLabels(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
    closed: boolean,
  ): string[] {
    const dates = this.resolveConversationDates(session, snapshot.messages);
    const labels = new Set<string>([
      ...this.config.defaultLabels,
      "type:conversation",
      `session:${session.sessionId}`,
      `date:${dates.date}`,
    ]);

    if (session.agentId && this.config.agentLabelPrefix) {
      labels.add(`${this.config.agentLabelPrefix}${session.agentId}`);
    }
    if (closed) {
      if (this.config.closedStatusLabel) {
        labels.add(this.config.closedStatusLabel);
      }
    } else if (this.config.activeStatusLabel) {
      labels.add(this.config.activeStatusLabel);
    }
    return [...labels].filter((label) => label.trim().length > 0);
  }

  private buildMemoryLabels(
    sessionId: string,
    date: string,
    status: "active" | "stale",
  ): string[] {
    return [
      "type:memory",
      `session:${sessionId}`,
      `date:${date}`,
      status === "active" ? this.config.memoryActiveStatusLabel : this.config.memoryStaleStatusLabel,
    ];
  }

  private renderConversationBody(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
    summary: string,
    closed: boolean,
  ): string {
    const dates = this.resolveConversationDates(session, snapshot.messages);
    return stringifyFlatYaml([
      ["type", "conversation"],
      ["session_id", session.sessionId],
      ["date", dates.date],
      ["start_at", dates.startAt],
      ["end_at", dates.endAt],
      ["status", closed ? "closed" : "active"],
      ["summary", summary],
    ]);
  }

  private renderMemoryBody(params: {
    memoryId: string;
    sessionId: string;
    date: string;
    detail: string;
  }): string {
    return stringifyFlatYaml([
      ["type", "memory"],
      ["memory_id", params.memoryId],
      ["session_id", params.sessionId],
      ["date", params.date],
      ["detail", params.detail],
    ]);
  }

  private renderConversationComment(message: NormalizedMessage): string {
    return `role: ${message.role}\n\n${message.text.trim()}`;
  }

  private resolveConversationDates(
    session: SessionMirrorState,
    messages: NormalizedMessage[],
  ): { date: string; startAt: string; endAt: string } {
    const timestamps = messages
      .map((message) => message.timestamp)
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => new Date(value))
      .filter((value) => Number.isFinite(value.getTime()));
    const fallbackCreated = session.createdAt ? new Date(session.createdAt) : new Date();
    const fallbackUpdated = session.updatedAt ? new Date(session.updatedAt) : fallbackCreated;
    const started = timestamps[0] ?? fallbackCreated;
    const ended = timestamps[timestamps.length - 1] ?? fallbackUpdated;
    return {
      date: this.toLocalDateString(started),
      startAt: this.toLocalDateTimeString(started),
      endAt: this.toLocalDateTimeString(ended),
    };
  }

  private formatTranscriptForSummary(messages: NormalizedMessage[]): string {
    return messages
      .map((message, index) => {
        const label = message.role === "assistant" ? "assistant" : "user";
        return `${index + 1}. ${label}: ${message.text}`;
      })
      .join("\n\n");
  }

  private buildSummarySessionKey(session: SessionMirrorState): string {
    const agentId = sanitizeSessionKeyPart(session.agentId || "main");
    const sessionId = sanitizeSessionKeyPart(session.sessionId);
    return `agent:${agentId}:subagent:clawmem-summary-${sessionId}`;
  }

  private getOrCreateSession(sessionId: string): SessionMirrorState {
    const existing = this.state.sessions[sessionId];
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const created: SessionMirrorState = {
      sessionId,
      lastMirroredCount: 0,
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.state.sessions[sessionId] = created;
    return created;
  }

  private async persistState(): Promise<void> {
    if (!this.statePath) {
      this.statePath = resolveStatePath(this.api.runtime.state.resolveStateDir());
    }
    await this.stateQueue.enqueue("state", async () => {
      await saveState(this.statePath, this.state);
    });
  }

  private resolveLabelColor(label: string): string {
    if (label.startsWith("status:")) {
      return "b60205";
    }
    if (label.startsWith("memory-status:")) {
      return label.endsWith(":stale") ? "d93f0b" : "0e8a16";
    }
    if (label.startsWith("type:")) {
      return label === "type:memory" ? "5319e7" : "1d76db";
    }
    if (label.startsWith("date:")) {
      return "c5def5";
    }
    if (label.startsWith("session:")) {
      return "bfdadc";
    }
    if (label.startsWith("agent:")) {
      return "1d76db";
    }
    if (label.startsWith("source:")) {
      return "0e8a16";
    }
    return this.config.labelColor;
  }

  private labelDescription(label: string): string {
    if (label.startsWith("type:")) {
      return "Issue type managed by clawmem.";
    }
    if (label.startsWith("memory-status:")) {
      return "Memory lifecycle status managed by clawmem.";
    }
    if (label.startsWith("status:")) {
      return "Conversation lifecycle status managed by clawmem.";
    }
    if (label.startsWith("session:")) {
      return "Session association label managed by clawmem.";
    }
    if (label.startsWith("date:")) {
      return "Date label managed by clawmem.";
    }
    if (label.startsWith("agent:")) {
      return "Agent label generated by clawmem.";
    }
    if (label.startsWith("source:")) {
      return "Source label generated by clawmem.";
    }
    return "Label managed by clawmem.";
  }

  private scoreMemory(memory: ParsedMemoryIssue, query: string): number {
    const haystack = `${memory.title}\n${memory.detail}`.toLowerCase();
    if (!haystack.trim() || !query.trim()) {
      return 0;
    }
    let score = 0;
    if (haystack.includes(query)) {
      score += 10;
    }
    const tokens = query
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);
    for (const token of tokens) {
      if (haystack.includes(token.toLowerCase())) {
        score += 1;
      }
    }
    return score;
  }

  private extractLabelNames(labels: Array<{ name?: string } | string> | undefined): string[] {
    if (!Array.isArray(labels)) {
      return [];
    }
    return labels
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        return typeof entry?.name === "string" ? entry.name.trim() : "";
      })
      .filter((label) => label.length > 0);
  }

  private isManagedLabel(label: string): boolean {
    if (this.config.defaultLabels.includes(label)) {
      return true;
    }
    return (
      label.startsWith("type:") ||
      label.startsWith("session:") ||
      label.startsWith("date:") ||
      label.startsWith("agent:") ||
      label.startsWith("source:") ||
      label === this.config.activeStatusLabel ||
      label === this.config.closedStatusLabel ||
      label === this.config.memoryActiveStatusLabel ||
      label === this.config.memoryStaleStatusLabel
    );
  }

  private shouldMirrorConversation(sessionId: string, messages: NormalizedMessage[]): boolean {
    if (sessionId.startsWith("slug-generator-")) {
      return false;
    }
    const firstUserMessage = messages.find((message) => message.role === "user")?.text ?? "";
    if (
      firstUserMessage.includes("generate a short 1-2 word filename slug") &&
      firstUserMessage.includes("Reply with ONLY the slug")
    ) {
      return false;
    }
    if (
      firstUserMessage.includes("Summarize the following conversation.") &&
      firstUserMessage.includes('Return valid JSON only in the form {"summary":"..."}') &&
      firstUserMessage.includes("<conversation>")
    ) {
      return false;
    }
    return true;
  }

  private toLocalDateString(input: Date | string | undefined = undefined): string {
    const date =
      input instanceof Date ? input : typeof input === "string" ? new Date(input) : new Date();
    const resolved = Number.isFinite(date.getTime()) ? date : new Date();
    const year = resolved.getFullYear();
    const month = String(resolved.getMonth() + 1).padStart(2, "0");
    const day = String(resolved.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private toLocalDateTimeString(input: Date | string | undefined = undefined): string {
    const date =
      input instanceof Date ? input : typeof input === "string" ? new Date(input) : new Date();
    const resolved = Number.isFinite(date.getTime()) ? date : new Date();
    const year = resolved.getFullYear();
    const month = String(resolved.getMonth() + 1).padStart(2, "0");
    const day = String(resolved.getDate()).padStart(2, "0");
    const hours = String(resolved.getHours()).padStart(2, "0");
    const minutes = String(resolved.getMinutes()).padStart(2, "0");
    const seconds = String(resolved.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  }

  private textResult(text: string, details: Record<string, unknown>) {
    return {
      content: [{ type: "text", text }],
      details,
    };
  }

  private errorResult(text: string) {
    return {
      content: [{ type: "text", text }],
      details: { error: text },
    };
  }

  private truncateInline(value: string, maxChars: number): string {
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxChars) {
      return singleLine;
    }
    return `${singleLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  private hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private async resolveReadableTranscriptPath(filePath: string | undefined): Promise<string | null> {
    if (!filePath) {
      return null;
    }
    if (await this.fileExists(filePath)) {
      return filePath;
    }
    const resetPath = await this.findLatestResetTranscript(filePath);
    if (resetPath) {
      this.api.logger.info?.(
        `clawmem: using reset transcript ${resetPath} because ${filePath} is missing`,
      );
      return resetPath;
    }
    return null;
  }

  private async findLatestResetTranscript(filePath: string): Promise<string | null> {
    const directory = path.dirname(filePath);
    const basename = path.basename(filePath);
    const prefix = `${basename}.reset.`;

    try {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
      const latest = candidates.at(-1);
      return latest ? path.join(directory, latest) : null;
    } catch (error) {
      this.api.logger.warn?.(
        `clawmem: failed to scan reset transcripts for ${filePath}: ${String(error)}`,
      );
      return null;
    }
  }

  private logBackgroundError(scope: string, error: unknown): void {
    this.api.logger.warn(`clawmem: ${scope} failed: ${String(error)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  return readOptionalString(params, key) ?? "";
}

function readOptionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sanitizeSessionKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "main";
}

function extractSummaryText(raw: string): string {
  const trimmed = raw.trim();
  const direct = tryParseSummaryJson(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = tryParseSummaryJson(fenced[1].trim());
    if (parsed) {
      return parsed;
    }
  }

  return trimmed;
}

function tryParseSummaryJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown };
    if (typeof parsed?.summary === "string" && parsed.summary.trim()) {
      return parsed.summary.trim();
    }
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as { summary?: unknown };
        if (typeof parsed?.summary === "string" && parsed.summary.trim()) {
          return parsed.summary.trim();
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createClawMemPlugin(api: OpenClawPluginApi): void {
  const service = new ClawMemService(api);
  service.register();
}
