// Memory CRUD, sha256 dedup, and AI-driven memory extraction.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { LABEL_MEMORY_ACTIVE, LABEL_MEMORY_STALE, MEMORY_TITLE_PREFIX, extractLabelNames, labelVal } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import { normalizeMessages } from "./transcript.js";
import type { ClawMemPluginConfig, ParsedMemoryIssue, SessionMirrorState, TranscriptSnapshot } from "./types.js";
import { fmtTranscript, localDate, sha256, subKey } from "./utils.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";

type MemoryDecision = { save: string[]; stale: string[] };
type MemoryStatus = "active" | "stale";
type IssueState = "open" | "closed" | "all";

type ManualMemoryStoreParams = {
  content: string;
  labels?: string[];
  sessionId: string;
};

type ManualMemoryStoreResult = {
  created: boolean;
  duplicate: boolean;
  memory: ParsedMemoryIssue;
};

export class MemoryStore {
  constructor(private readonly client: GitHubIssueClient, private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  async search(query: string, limit: number, opts: { issueState?: IssueState } = {}): Promise<ParsedMemoryIssue[]> {
    const q = norm(query).toLowerCase();
    if (!q) return [];
    const tokens = [...new Set(q.split(/[^a-z0-9]+/i).filter((t) => t.length > 1))];
    const issueState = opts.issueState ?? "open";
    const memories = await this.list("active", { issueState });
    return memories
      .map((m) => {
        const titleHay = m.title.toLowerCase();
        const detailHay = m.detail.toLowerCase();
        const labelHay = m.labels.join("\n").toLowerCase();
        let score = 0;
        if (titleHay.includes(q)) score += 12;
        if (detailHay.includes(q)) score += 10;
        if (labelHay.includes(q)) score += 6;
        for (const token of tokens) {
          if (titleHay.includes(token)) score += 2;
          if (detailHay.includes(token)) score += 1;
          if (labelHay.includes(token)) score += 1;
        }
        return { memory: m, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.issueNumber - a.memory.issueNumber)
      .slice(0, Math.max(1, Math.floor(limit)))
      .map((entry) => entry.memory);
  }

  async storeManual(params: ManualMemoryStoreParams): Promise<ManualMemoryStoreResult> {
    const detail = norm(params.content);
    if (!detail) throw new Error("content required");
    const sessionId = params.sessionId.trim();
    if (!sessionId) throw new Error("sessionId required");
    const existing = await this.findExistingActiveByHash(sha256(detail));
    if (existing) return { created: false, duplicate: true, memory: existing };
    const created = await this.createMemoryIssue({
      detail,
      sessionId,
      date: localDate(),
      status: "active",
      extraLabels: normalizeMemoryLabels(params.labels),
      memoryHash: sha256(detail),
    });
    return { created: true, duplicate: false, memory: created };
  }

  async syncFromConversation(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<void> {
    try {
      const decision = await this.generateDecision(session, snapshot);
      const { savedCount, staledCount } = await this.applyDecision(session.sessionId, decision);
      if (savedCount > 0 || staledCount > 0)
        this.api.logger.info?.(`clawmem: synced memories for ${session.sessionId} (saved=${savedCount}, stale=${staledCount})`);
    } catch (error) {
      this.api.logger.warn(`clawmem: memory capture failed: ${String(error)}`);
    }
  }

  private async list(status: MemoryStatus | "all", opts: { issueState?: IssueState } = {}): Promise<ParsedMemoryIssue[]> {
    const labels = ["type:memory"];
    if (status === "active") labels.push(LABEL_MEMORY_ACTIVE);
    else if (status === "stale") labels.push(LABEL_MEMORY_STALE);
    const out: ParsedMemoryIssue[] = [];
    const issueState = opts.issueState ?? "open";
    for (let page = 1; page <= 20; page++) {
      const batch = await this.client.listIssues({ labels, state: issueState, page, perPage: 100 });
      for (const issue of batch) {
        const parsed = this.parseIssue(issue);
        if (!parsed) continue;
        if (status === "all" || parsed.status === status) out.push(parsed);
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  private parseIssue(issue: { number: number; title?: string; body?: string; labels?: Array<{ name?: string } | string> }): ParsedMemoryIssue | null {
    const labels = extractLabelNames(issue.labels);
    if (!labels.includes("type:memory")) return null;
    const sessionId = labelVal(labels, "session:");
    const date = labelVal(labels, "date:");
    const topics = labels.filter((l) => l.startsWith("topic:")).map((l) => l.slice(6).trim()).filter(Boolean);
    const rawBody = (issue.body ?? "").trim();
    const body = rawBody ? parseFlatYaml(rawBody) : {};
    const detail = body.detail?.trim() || rawBody;
    if (!sessionId || !date || !detail) return null;
    return {
      issueNumber: issue.number,
      title: issue.title?.trim() || "",
      memoryId: body.memory_id?.trim() || String(issue.number),
      memoryHash: body.memory_hash?.trim() || undefined,
      sessionId,
      date,
      detail,
      labels,
      ...(topics.length > 0 ? { topics } : {}),
      status: labels.includes(LABEL_MEMORY_STALE) ? "stale" : "active",
    };
  }

  private async applyDecision(sessionId: string, decision: MemoryDecision): Promise<{ savedCount: number; staledCount: number }> {
    const allActive = await this.list("active", { issueState: "open" });
    const activeById = new Map(allActive.map((memory) => [memory.memoryId, memory]));
    const existingHashes = new Set(allActive.map((memory) => memory.memoryHash || sha256(norm(memory.detail))));
    let savedCount = 0;
    for (const raw of decision.save) {
      const detail = norm(raw);
      if (!detail) continue;
      const hash = sha256(detail);
      if (existingHashes.has(hash)) continue;
      await this.createMemoryIssue({
        detail,
        sessionId,
        date: localDate(),
        status: "active",
        extraLabels: [],
        memoryHash: hash,
      });
      existingHashes.add(hash);
      savedCount++;
    }
    let staledCount = 0;
    for (const id of [...new Set(decision.stale.map((s) => s.trim()).filter(Boolean))]) {
      const memory = activeById.get(id);
      if (!memory) continue;
      const labels = buildMemoryLabels({
        sessionId: memory.sessionId,
        date: memory.date,
        status: "stale",
        extraLabels: preserveCustomMemoryLabels(memory.labels),
      });
      await this.client.ensureLabels(labels);
      await this.client.syncManagedLabels(memory.issueNumber, labels);
      staledCount++;
    }
    return { savedCount, staledCount };
  }

  private async generateDecision(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<MemoryDecision> {
    if (snapshot.messages.length === 0) return { save: [], stale: [] };
    const recent = (await this.list("active", { issueState: "open" })).sort((a, b) => b.issueNumber - a.issueNumber).slice(0, 20);
    const existingBlock = recent.length === 0 ? "None." : recent.map((m) => `[${m.memoryId}] ${m.detail}`).join("\n");
    const subagent = this.api.runtime.subagent;
    const sessionKey = subKey(session, "memory");
    const message = [
      "Extract durable memories from the conversation below.",
      'Return JSON only in the form {"save":["..."],"stale":["memory-id"]}.',
      "Use save for stable, reusable facts, preferences, decisions, constraints, and ongoing context worth remembering later.",
      "Use stale for existing memory IDs only when the conversation clearly supersedes or invalidates them.",
      "Do not save temporary requests, startup boilerplate, tool chatter, summaries about internal helper sessions, or one-off operational details.",
      "Prefer empty arrays when nothing durable should be remembered.",
      "", "<existing-active-memories>", existingBlock, "</existing-active-memories>",
      "", "<conversation>", fmtTranscript(snapshot.messages), "</conversation>",
    ].join("\n");
    try {
      const run = await subagent.run({
        sessionKey, message, deliver: false, lane: "clawmem-memory",
        idempotencyKey: sha256(`${session.sessionId}:${snapshot.messages.length}:memory-decision`),
        extraSystemPrompt: "You extract durable memory updates from OpenClaw conversations. Output JSON only with string arrays save and stale.",
      });
      const wait = await subagent.waitForRun({ runId: run.runId, timeoutMs: this.config.summaryWaitTimeoutMs });
      if (wait.status === "timeout") throw new Error("memory decision subagent timed out");
      if (wait.status === "error") throw new Error(wait.error || "memory decision subagent failed");
      const msgs = normalizeMessages((await subagent.getSessionMessages({ sessionKey, limit: 50 })).messages);
      const text = [...msgs].reverse().find((e) => e.role === "assistant" && e.text.trim())?.text;
      if (!text) throw new Error("memory decision subagent returned no assistant text");
      return parseDecision(text);
    } finally { subagent.deleteSession({ sessionKey, deleteTranscript: true }).catch(() => {}); }
  }

  private async findExistingActiveByHash(hash: string): Promise<ParsedMemoryIssue | null> {
    const active = await this.list("active", { issueState: "open" });
    return active.find((memory) => (memory.memoryHash || sha256(norm(memory.detail))) === hash) ?? null;
  }

  private async createMemoryIssue(params: {
    detail: string;
    sessionId: string;
    date: string;
    status: MemoryStatus;
    extraLabels: string[];
    memoryHash: string;
  }): Promise<ParsedMemoryIssue> {
    const labels = buildMemoryLabels({
      sessionId: params.sessionId,
      date: params.date,
      status: params.status,
      extraLabels: params.extraLabels,
    });
    const title = `${MEMORY_TITLE_PREFIX}${trunc(params.detail, 72)}`;
    const body = stringifyFlatYaml([["memory_hash", params.memoryHash], ["detail", params.detail]]);
    await this.client.ensureLabels(labels);
    const issue = await this.client.createIssue({ title, body, labels });
    const topics = labels.filter((label) => label.startsWith("topic:")).map((label) => label.slice(6).trim()).filter(Boolean);
    return {
      issueNumber: issue.number,
      title: issue.title?.trim() || title,
      memoryId: String(issue.number),
      memoryHash: params.memoryHash,
      sessionId: params.sessionId,
      date: params.date,
      detail: params.detail,
      labels,
      ...(topics.length > 0 ? { topics } : {}),
      status: params.status,
    };
  }
}

function buildMemoryLabels(params: {
  sessionId: string;
  date: string;
  status: MemoryStatus;
  extraLabels?: string[];
}): string[] {
  return [
    ...new Set([
      ...normalizeMemoryLabels(params.extraLabels),
      "type:memory",
      `date:${params.date}`,
      `session:${params.sessionId}`,
      params.status === "active" ? LABEL_MEMORY_ACTIVE : LABEL_MEMORY_STALE,
    ]),
  ];
}

function normalizeMemoryLabels(labels: string[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (typeof label !== "string") continue;
    const trimmed = label.trim();
    if (!trimmed || trimmed.includes("\n") || trimmed.includes(",")) continue;
    if (isReservedMemoryLabel(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function preserveCustomMemoryLabels(labels: string[]): string[] {
  return normalizeMemoryLabels(labels.filter((label) => !isSystemMemoryLabel(label)));
}

function isReservedMemoryLabel(label: string): boolean {
  return label.startsWith("type:") || label.startsWith("date:") || label.startsWith("session:") || label.startsWith("memory-status:");
}

function isSystemMemoryLabel(label: string): boolean {
  return label === "type:memory" || label.startsWith("date:") || label.startsWith("session:") || label === LABEL_MEMORY_ACTIVE || label === LABEL_MEMORY_STALE;
}

function norm(v: string): string { return v.replace(/\s+/g, " ").trim(); }
function trunc(v: string, max: number): string { const s = norm(v); return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`; }
function parseDecision(raw: string): MemoryDecision {
  const tryParse = (s: string): MemoryDecision | null => {
    try {
      const p = JSON.parse(s) as Record<string, unknown>;
      return { save: Array.isArray(p.save) ? p.save.filter((v): v is string => typeof v === "string") : [],
               stale: Array.isArray(p.stale) ? p.stale.filter((v): v is string => typeof v === "string") : [] };
    } catch { return null; }
  };
  const t = raw.trim();
  return tryParse(t) ?? (() => {
    const f = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
    const nested = f?.[1] ? tryParse(f[1].trim()) : null;
    if (nested) return nested;
    throw new Error("memory decision subagent returned invalid JSON");
  })();
}
