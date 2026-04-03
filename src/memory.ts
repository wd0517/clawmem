// Memory CRUD, sha256 dedup, and AI-driven memory extraction.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { LABEL_MEMORY_STALE, MEMORY_TITLE_PREFIX, extractLabelNames, labelVal } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import { normalizeMessages } from "./transcript.js";
import type { ClawMemPluginConfig, MemoryCandidate, MemoryDraft, MemoryListOptions, MemorySchema, ParsedMemoryIssue, SessionMirrorState, TranscriptSnapshot } from "./types.js";
import { fmtTranscript, fmtTranscriptFrom, localDate, sha256, sliceTranscriptDelta, subKey } from "./utils.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";
import { sanitizeRecallQueryInput } from "./recall-sanitize.js";

type MemoryDecision = { save: MemoryDraft[]; stale: string[] };
type SearchIndex = { title: string; detail: string; kind?: string; topics: string[] };

const MAX_BACKEND_QUERY_CHARS = 1500;
const MEMORY_RECONCILE_RECALL_LIMIT = 5;

const RECALL_INJECTED_BLOCKS = [
  /<clawmem-context>[\s\S]*?<\/clawmem-context>/gi,
  /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi,
  /<memories>[\s\S]*?<\/memories>/gi,
];

const URL_RE = /https?:\/\/\S+/gi;

export class MemoryStore {
  constructor(private readonly client: GitHubIssueClient, private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  async search(query: string, limit: number): Promise<ParsedMemoryIssue[]> {
    const q = normalizeSearch(query);
    if (!q) return [];
    return this.searchViaBackend(query, limit);
  }

  async listSchema(): Promise<MemorySchema> {
    const kinds = new Set<string>();
    const topics = new Set<string>();
    for (let page = 1; page <= 20; page++) {
      const batch = await this.client.listLabels({ page, perPage: 100 });
      for (const label of batch) {
        const name = typeof label?.name === "string" ? label.name.trim() : "";
        if (name.startsWith("kind:")) {
          const kind = labelVal([name], "kind:");
          if (kind) kinds.add(kind);
        }
        if (name.startsWith("topic:")) {
          const topic = labelVal([name], "topic:");
          if (topic) topics.add(topic);
        }
      }
      if (batch.length < 100) break;
    }
    for (const memory of await this.listByStatus("all")) {
      if (memory.kind) kinds.add(memory.kind);
      for (const topic of memory.topics ?? []) topics.add(topic);
    }
    return { kinds: [...kinds].sort(), topics: [...topics].sort() };
  }

  async get(memoryId: string, status: "active" | "stale" | "all" = "all"): Promise<ParsedMemoryIssue | null> {
    const id = memoryId.trim();
    if (!id) throw new Error("memoryId is empty");
    return (await this.listByStatus(status)).find((m) => m.memoryId === id || String(m.issueNumber) === id) ?? null;
  }

  async listMemories(options: MemoryListOptions = {}): Promise<ParsedMemoryIssue[]> {
    const status = options.status ?? "active";
    const kind = normalizeOptionalLabelValue(options.kind, "kind:");
    const topic = normalizeOptionalLabelValue(options.topic, "topic:");
    const limit = Math.min(200, Math.max(1, options.limit ?? 20));
    return (await this.listByStatus(status))
      .filter((memory) => {
        if (kind && memory.kind !== kind) return false;
        if (topic && !(memory.topics ?? []).includes(topic)) return false;
        return true;
      })
      .sort((a, b) => b.issueNumber - a.issueNumber)
      .slice(0, limit);
  }

  async store(draft: MemoryDraft): Promise<{ created: boolean; memory: ParsedMemoryIssue }> {
    const normalized = normalizeDraft(draft);
    const detail = norm(normalized.detail);
    const allActive = await this.listByStatus("active");
    const hash = sha256(detail);
    const existing = allActive.find((m) => (m.memoryHash || sha256(norm(m.detail))) === hash);
    if (existing) {
      const memory = await this.mergeSchema(existing, normalized);
      return { created: false, memory };
    }

    const date = localDate();
    const labels = memLabels(normalized.kind, normalized.topics);
    const title = renderMemoryTitle(normalized);
    const body = renderMemoryBody(detail, hash, date);
    await this.client.ensureLabels(labels);
    const issue = await this.client.createIssue({ title, body, labels });
    return {
      created: true,
      memory: {
        issueNumber: issue.number,
        title,
        memoryId: String(issue.number),
        memoryHash: hash,
        date,
        detail,
        ...(normalized.kind ? { kind: normalized.kind } : {}),
        ...(normalized.topics && normalized.topics.length > 0 ? { topics: normalized.topics } : {}),
        status: "active",
      },
    };
  }

  async update(memoryId: string, patch: { title?: string; detail?: string; kind?: string; topics?: string[] }): Promise<ParsedMemoryIssue | null> {
    const current = await this.get(memoryId, "all");
    if (!current) return null;
    const nextDetail = typeof patch.detail === "string" && patch.detail.trim() ? norm(patch.detail) : current.detail;
    const nextTitle = typeof patch.title === "string" && patch.title.trim()
      ? renderMemoryTitle({ title: patch.title.trim(), detail: nextDetail })
      : patch.detail !== undefined
        ? renderMemoryTitle({ detail: nextDetail })
        : current.title || renderMemoryTitle({ detail: nextDetail });
    const nextKind = patch.kind !== undefined ? normalizeLabelValue(patch.kind, "kind:") : current.kind;
    const nextTopics = patch.topics !== undefined
      ? uniqueNormalized(patch.topics.map((topic) => normalizeLabelValue(topic, "topic:")).filter(Boolean) as string[])
      : uniqueNormalized(current.topics ?? []);
    const nextHash = sha256(nextDetail);
    const duplicate = (await this.listByStatus("active")).find((memory) => {
      if (memory.issueNumber === current.issueNumber) return false;
      return (memory.memoryHash || sha256(norm(memory.detail))) === nextHash;
    });
    if (duplicate) throw new Error(`another active memory already stores this detail as [${duplicate.memoryId}]`);
    const nextBody = renderMemoryBody(nextDetail, nextHash, current.date);
    const nextLabels = memLabels(nextKind, nextTopics);
    await this.client.ensureLabels(nextLabels);
    await this.client.updateIssue(current.issueNumber, { title: nextTitle, body: nextBody });
    await this.client.syncManagedLabels(current.issueNumber, nextLabels);
    return {
      ...current,
      title: nextTitle,
      memoryHash: nextHash,
      detail: nextDetail,
      ...(nextKind ? { kind: nextKind } : {}),
      ...(nextTopics.length > 0 ? { topics: nextTopics } : {}),
    };
  }

  async forget(memoryId: string): Promise<ParsedMemoryIssue | null> {
    const id = memoryId.trim();
    if (!id) throw new Error("memoryId is empty");
    const mem = await this.get(id, "active");
    if (!mem) return null;
    await this.client.syncManagedLabels(mem.issueNumber, memLabels(mem.kind, mem.topics));
    await this.client.updateIssue(mem.issueNumber, { state: "closed" });
    return { ...mem, status: "stale" };
  }

  async syncFromConversation(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<boolean> {
    try {
      const decision = await this.generateDecision(session, snapshot);
      const { savedCount, staledCount } = await this.applyDecision(decision);
      if (savedCount > 0 || staledCount > 0)
        this.api.logger.info?.(`clawmem: synced memories for ${session.sessionId} (saved=${savedCount}, stale=${staledCount})`);
      return true;
    } catch (error) {
      this.api.logger.warn(`clawmem: memory capture failed: ${String(error)}`);
      return false;
    }
  }

  async applyReconciledDecision(decision: { save: MemoryDraft[]; stale: string[] }): Promise<{ savedCount: number; staledCount: number }> {
    return this.applyDecision(decision);
  }

  async extractCandidates(
    session: SessionMirrorState,
    snapshot: TranscriptSnapshot,
    fromCursor: number,
    digestText?: string,
  ): Promise<MemoryCandidate[]> {
    const { anchorStart, deltaStart, anchorMessages, deltaMessages } = sliceTranscriptDelta(snapshot.messages, fromCursor, 2);
    if (deltaMessages.length === 0) return [];
    const subagent = this.api.runtime.subagent;
    const sessionKey = subKey(session, "memory-extract");
    const message = [
      "Extract atomic durable memory candidates from the conversation delta below.",
      'Return JSON only in the form {"candidates":[{"title":"...","detail":"...","kind":"...","topics":["..."],"evidence":"..."}]}.',
      "Only extract durable facts, preferences, decisions, constraints, workflows, and ongoing context worth remembering later.",
      "Use the anchor messages and rolling digest only for context resolution. The new messages are the only source that may add new candidates now.",
      "Each candidate must represent one durable fact. Split independent facts into separate candidates.",
      "Do not extract temporary requests, tool chatter, startup boilerplate, or summaries about internal helper sessions.",
      "Kind and topics are optional. Keep them short, reusable, and low-cardinality.",
      "Evidence is optional. If present, keep it short and quote-free.",
      "Prefer an empty candidates array when nothing durable was added.",
      "",
      "<rolling-digest>",
      digestText?.trim() || "None.",
      "</rolling-digest>",
      "",
      "<anchor-messages>",
      anchorMessages.length > 0 ? fmtTranscriptFrom(anchorMessages, anchorStart) : "None.",
      "</anchor-messages>",
      "",
      "<new-messages>",
      fmtTranscriptFrom(deltaMessages, deltaStart),
      "</new-messages>",
    ].join("\n");
    try {
      const run = await subagent.run({
        sessionKey,
        message,
        deliver: false,
        lane: "clawmem-memory-extract",
        idempotencyKey: sha256(`${session.sessionId}:${fromCursor}:${snapshot.messages.length}:memory-extract-v1`),
        extraSystemPrompt: "You extract atomic durable memory candidates for ClawMem. Output JSON only with an array field candidates.",
      });
      const wait = await subagent.waitForRun({ runId: run.runId, timeoutMs: this.config.memoryExtractWaitTimeoutMs });
      if (wait.status === "timeout") throw new Error("memory extraction subagent timed out");
      if (wait.status === "error") throw new Error(wait.error || "memory extraction subagent failed");
      const msgs = normalizeMessages((await subagent.getSessionMessages({ sessionKey, limit: 50 })).messages);
      const text = [...msgs].reverse().find((e) => e.role === "assistant" && e.text.trim())?.text;
      if (!text) throw new Error("memory extraction subagent returned no assistant text");
      return parseCandidates(text);
    } finally {
      subagent.deleteSession({ sessionKey, deleteTranscript: true }).catch(() => {});
    }
  }

  async reconcileCandidates(session: SessionMirrorState, candidates: MemoryCandidate[]): Promise<MemoryDecision> {
    const pending = mergeMemoryCandidates([], candidates);
    if (pending.length === 0) return { save: [], stale: [] };
    const existingByCandidate = await Promise.all(pending.map(async (candidate) => ({
      candidate,
      matches: await this.searchViaBackend(candidate.detail, MEMORY_RECONCILE_RECALL_LIMIT),
    })));
    const candidateBlock = pending.map((candidate) => [
      `[${candidate.candidateId}] ${candidate.title ? `${candidate.title} | ` : ""}${candidate.detail}`,
      ...(candidate.kind ? [`kind=${candidate.kind}`] : []),
      ...(candidate.topics && candidate.topics.length > 0 ? [`topics=${candidate.topics.join(", ")}`] : []),
      ...(candidate.evidence ? [`evidence=${candidate.evidence}`] : []),
    ].join("\n")).join("\n\n");
    const existingBlock = existingByCandidate.map(({ candidate, matches }) => {
      const lines = matches.length > 0
        ? matches.map((memory) => {
            const schema = [memory.kind ? `kind=${memory.kind}` : "", ...(memory.topics ?? []).map((topic) => `topic=${topic}`)]
              .filter(Boolean)
              .join(", ");
            return `- [${memory.memoryId}] ${schema ? `${schema} | ` : ""}${memory.detail}`;
          })
        : ["- None."];
      return [`Candidate [${candidate.candidateId}] matches:`, ...lines].join("\n");
    }).join("\n\n");
    const subagent = this.api.runtime.subagent;
    const sessionKey = subKey(session, "memory-reconcile");
    const message = [
      "Reconcile extracted durable memory candidates against existing memories.",
      'Return JSON only in the form {"save":[{"title":"...","detail":"...","kind":"...","topics":["..."]}],"stale":["memory-id"]}.',
      "Use save only for candidates that should become durable memories after comparing them with existing memories.",
      "If a candidate is already fully covered by an existing memory, omit it from save.",
      "Use stale only when a candidate clearly supersedes or invalidates an existing memory.",
      "Do not stale memories just because they overlap or are related. Prefer keeping both when they can coexist.",
      "Keep each save item atomic and durable.",
      "",
      "<candidates>",
      candidateBlock,
      "</candidates>",
      "",
      "<matching-existing-memories>",
      existingBlock,
      "</matching-existing-memories>",
    ].join("\n");
    try {
      const run = await subagent.run({
        sessionKey,
        message,
        deliver: false,
        lane: "clawmem-memory-reconcile",
        idempotencyKey: sha256(`${session.sessionId}:${pending.map((candidate) => candidate.candidateId).join(",")}:memory-reconcile-v1`),
        extraSystemPrompt: "You reconcile extracted durable memory candidates for ClawMem. Output JSON only with save memory drafts and stale memory ids.",
      });
      const wait = await subagent.waitForRun({ runId: run.runId, timeoutMs: this.config.memoryReconcileWaitTimeoutMs });
      if (wait.status === "timeout") throw new Error("memory reconcile subagent timed out");
      if (wait.status === "error") throw new Error(wait.error || "memory reconcile subagent failed");
      const msgs = normalizeMessages((await subagent.getSessionMessages({ sessionKey, limit: 50 })).messages);
      const text = [...msgs].reverse().find((e) => e.role === "assistant" && e.text.trim())?.text;
      if (!text) throw new Error("memory reconcile subagent returned no assistant text");
      return parseDecision(text);
    } finally {
      subagent.deleteSession({ sessionKey, deleteTranscript: true }).catch(() => {});
    }
  }

  private async listByStatus(status: "active" | "stale" | "all"): Promise<ParsedMemoryIssue[]> {
    const labels = ["type:memory"];
    const state = status === "active" ? "open" : "all";
    const out: ParsedMemoryIssue[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.client.listIssues({ labels, state, page, perPage: 100 });
      for (const issue of batch) {
        const parsed = this.parseIssue(issue);
        if (!parsed) continue;
        if (status !== "all" && parsed.status !== status) continue;
        out.push(parsed);
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  private async searchViaBackend(query: string, limit: number): Promise<ParsedMemoryIssue[]> {
    const repo = this.client.repo();
    if (!repo) throw new Error("ClawMem memory recall requires a configured repo.");
    const qualified = buildMemorySearchQuery(query, repo);
    const batch = await this.client.searchIssues(qualified, { perPage: Math.min(100, Math.max(limit * 3, 20)) });
    return batch
      .map((issue) => this.parseIssue(issue))
      .filter((memory): memory is ParsedMemoryIssue => memory !== null && memory.status === "active")
      .slice(0, limit);
  }

  private parseIssue(issue: { number: number; title?: string; body?: string; state?: string; labels?: Array<{ name?: string } | string> }): ParsedMemoryIssue | null {
    const labels = extractLabelNames(issue.labels);
    if (!labels.includes("type:memory")) return null;
    const kind = labelVal(labels, "kind:");
    const topics = labels.filter((l) => l.startsWith("topic:")).map((l) => l.slice(6).trim()).filter(Boolean);
    const rawBody = (issue.body ?? "").trim();
    const parsed = parseStoredMemoryBody(rawBody);
    const detail = parsed.detail?.trim() || rawBody;
    const status = issue.state === "closed" || labels.includes(LABEL_MEMORY_STALE) ? "stale" : "active";
    if (!detail) return null;
    return {
      issueNumber: issue.number,
      title: issue.title?.trim() || "",
      memoryId: parsed.meta.memory_id?.trim() || String(issue.number),
      memoryHash: parsed.meta.memory_hash?.trim() || undefined,
      date: parsed.meta.date?.trim() || "1970-01-01",
      detail,
      ...(kind ? { kind } : {}),
      ...(topics.length > 0 ? { topics } : {}),
      status,
    };
  }

  private async applyDecision(decision: MemoryDecision): Promise<{ savedCount: number; staledCount: number }> {
    const allActive = await this.listByStatus("active");
    const activeById = new Map(allActive.map((m) => [m.memoryId, m]));
    const activeByHash = new Map(allActive.map((m) => [m.memoryHash || sha256(norm(m.detail)), m]));
    let savedCount = 0;
    for (const raw of decision.save) {
      const draft = normalizeDraft(raw);
      const detail = norm(draft.detail);
      if (!detail) continue;
      const hash = sha256(detail);
      const existing = activeByHash.get(hash);
      if (existing) {
        const merged = await this.mergeSchema(existing, draft);
        activeByHash.set(hash, merged);
        continue;
      }
      const labels = memLabels(draft.kind, draft.topics);
      const date = localDate();
      const title = renderMemoryTitle(draft);
      const body = renderMemoryBody(detail, hash, date);
      await this.client.ensureLabels(labels);
      const issue = await this.client.createIssue({ title, body, labels });
      activeByHash.set(hash, {
        issueNumber: issue.number,
        title,
        memoryId: String(issue.number),
        memoryHash: hash,
        date,
        detail,
        ...(draft.kind ? { kind: draft.kind } : {}),
        ...(draft.topics && draft.topics.length > 0 ? { topics: draft.topics } : {}),
        status: "active",
      });
      savedCount++;
    }
    let staledCount = 0;
    for (const id of [...new Set(decision.stale.map((s) => s.trim()).filter(Boolean))]) {
      const mem = activeById.get(id);
      if (!mem) continue;
      await this.client.syncManagedLabels(mem.issueNumber, memLabels(mem.kind, mem.topics));
      await this.client.updateIssue(mem.issueNumber, { state: "closed" });
      staledCount++;
    }
    return { savedCount, staledCount };
  }

  private async generateDecision(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<MemoryDecision> {
    if (snapshot.messages.length === 0) return { save: [], stale: [] };
    const recent = (await this.listByStatus("active")).sort((a, b) => b.issueNumber - a.issueNumber).slice(0, 20);
    const existingBlock = recent.length === 0 ? "None." : recent.map((m) => {
      const schema = [m.kind ? `kind=${m.kind}` : "", ...(m.topics ?? []).map((topic) => `topic=${topic}`)].filter(Boolean).join(", ");
      return `[${m.memoryId}] ${schema ? `${schema} | ` : ""}${m.detail}`;
    }).join("\n");
    const schema = await this.listSchema();
    const schemaBlock = [
      `Existing kinds: ${schema.kinds.length > 0 ? schema.kinds.join(", ") : "None."}`,
      `Existing topics: ${schema.topics.length > 0 ? schema.topics.join(", ") : "None."}`,
    ].join("\n");
    const subagent = this.api.runtime.subagent;
    const sessionKey = subKey(session, "memory");
    const message = [
      "Extract durable memories from the conversation below.",
      'Return JSON only in the form {"save":[{"title":"...","detail":"...","kind":"...","topics":["..."]}],"stale":["memory-id"]}.',
      "Each save item must contain one durable fact. If a turn contains several independent facts, save them separately instead of bundling them into one summary memory.",
      "Use save for stable, reusable facts, preferences, decisions, constraints, workflows, and ongoing context worth remembering later.",
      "Title is optional. If you provide one, make it concise and human-readable.",
      "Use stale for existing memory IDs only when the conversation clearly supersedes or invalidates them.",
      "Infer kind and topics when they would help future retrieval. Reuse existing kinds and topics when possible.",
      "If no existing kind fits, you may propose a new short kind label. Keep kinds concise and reusable.",
      "Topics should be short reusable tags, not sentences. Prefer 0-3 topics per memory.",
      "Do not save temporary requests, startup boilerplate, tool chatter, summaries about internal helper sessions, or one-off operational details.",
      "Prefer empty arrays when nothing durable should be remembered.",
      "", "<existing-schema>", schemaBlock, "</existing-schema>",
      "", "<existing-active-memories>", existingBlock, "</existing-active-memories>",
      "", "<conversation>", fmtTranscript(snapshot.messages), "</conversation>",
    ].join("\n");
    try {
      const run = await subagent.run({
        sessionKey,
        message,
        deliver: false,
        lane: "clawmem-memory",
        idempotencyKey: sha256(`${session.sessionId}:${snapshot.messages.length}:memory-decision`),
        extraSystemPrompt: "You extract durable memory updates from OpenClaw conversations. Output JSON only with save objects containing detail, optional title, optional kind, and optional topics, plus stale string ids. Keep each save item to one durable fact.",
      });
      const wait = await subagent.waitForRun({ runId: run.runId, timeoutMs: this.config.summaryWaitTimeoutMs });
      if (wait.status === "timeout") throw new Error("memory decision subagent timed out");
      if (wait.status === "error") throw new Error(wait.error || "memory decision subagent failed");
      const msgs = normalizeMessages((await subagent.getSessionMessages({ sessionKey, limit: 50 })).messages);
      const text = [...msgs].reverse().find((e) => e.role === "assistant" && e.text.trim())?.text;
      if (!text) throw new Error("memory decision subagent returned no assistant text");
      return parseDecision(text);
    } finally {
      subagent.deleteSession({ sessionKey, deleteTranscript: true }).catch(() => {});
    }
  }

  private async mergeSchema(memory: ParsedMemoryIssue, draft: MemoryDraft): Promise<ParsedMemoryIssue> {
    const normalized = normalizeDraft(draft);
    const nextKind = normalized.kind ?? memory.kind;
    const currentTopics = uniqueNormalized(memory.topics ?? []);
    const nextTopics = uniqueNormalized([...currentTopics, ...(normalized.topics ?? [])]);
    const sameKind = (memory.kind ?? "") === (nextKind ?? "");
    const sameTopics = JSON.stringify(currentTopics) === JSON.stringify(nextTopics);
    if (sameKind && sameTopics) return memory;
    const labels = memLabels(nextKind, nextTopics);
    await this.client.ensureLabels(labels);
    await this.client.syncManagedLabels(memory.issueNumber, labels);
    return {
      ...memory,
      ...(nextKind ? { kind: nextKind } : {}),
      ...(nextTopics.length > 0 ? { topics: nextTopics } : {}),
    };
  }
}

function memLabels(kind?: string, topics?: string[]): string[] {
  return [
    "type:memory",
    ...(kind ? [`kind:${kind}`] : []),
    ...((topics ?? []).map((topic) => `topic:${topic}`)),
  ];
}

function renderMemoryTitle(draft: Pick<MemoryDraft, "detail" | "title">): string {
  const raw = typeof draft.title === "string" && draft.title.trim() ? draft.title : draft.detail;
  const normalized = norm(raw);
  return normalized.startsWith(MEMORY_TITLE_PREFIX) ? normalized : `${MEMORY_TITLE_PREFIX}${normalized}`;
}

function renderMemoryBody(detail: string, memoryHash: string, date: string): string {
  return stringifyFlatYaml([["memory_hash", memoryHash], ["date", date], ["detail", norm(detail)]]);
}

function parseStoredMemoryBody(rawBody: string): { detail: string; meta: Record<string, string> } {
  const trimmed = rawBody.trim();
  if (!trimmed) return { detail: "", meta: {} };

  const legacyYaml = parseFlatYaml(trimmed);
  if (legacyYaml.detail?.trim()) {
    return { detail: legacyYaml.detail.trim(), meta: legacyYaml };
  }

  const hiddenMeta = /(?:^|\n)<!--\s*clawmem-meta\s*\n([\s\S]*?)\n-->\s*$/.exec(trimmed);
  if (!hiddenMeta) {
    return { detail: trimmed, meta: {} };
  }

  const meta = parseFlatYaml(hiddenMeta[1] ?? "");
  const detail = trimmed.slice(0, hiddenMeta.index).trim() || meta.detail?.trim() || "";
  return { detail, meta };
}

function norm(v: string): string { return v.replace(/\s+/g, " ").trim(); }
function trunc(v: string, max: number): string { const s = norm(v); return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`; }
function normalizeSearch(v: string): string {
  return v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function buildSearchIndex(memory: ParsedMemoryIssue): SearchIndex {
  return {
    title: normalizeSearch(memory.title),
    detail: normalizeSearch(memory.detail),
    ...(memory.kind ? { kind: normalizeSearch(memory.kind) } : {}),
    topics: (memory.topics ?? []).map(normalizeSearch).filter(Boolean),
  };
}

function searchTokens(v: string): string[] {
  const seen = new Set<string>();
  for (const token of v.split(/[^0-9\p{L}]+/u)) {
    if (token.length > 1) seen.add(token);
  }
  for (const chunk of v.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) ?? []) {
    for (let i = 0; i < chunk.length; i++) {
      seen.add(chunk[i]!);
      if (i + 1 < chunk.length) seen.add(chunk.slice(i, i + 2));
    }
  }
  return [...seen];
}

function charBigrams(v: string): Set<string> {
  const compact = v.replace(/\s+/g, "");
  if (compact.length < 2) return new Set(compact ? [compact] : []);
  const out = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) out.add(compact.slice(i, i + 2));
  return out;
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits++;
  return hits / Math.max(left.size, right.size);
}

function buildMemorySearchQuery(query: string, repo: string): string {
  const parts = [buildRecallSearchText(query), `repo:${repo}`, "is:issue", "state:open", 'label:"type:memory"'].filter(Boolean);
  return parts.join(" ");
}

function buildRecallSearchText(rawQuery: string): string {
  const cleaned = sanitizeRecallQueryInput(stripRecallArtifacts(rawQuery));
  return truncateRecallQuery(cleaned, MAX_BACKEND_QUERY_CHARS);
}

function stripRecallArtifacts(rawQuery: string): string {
  let text = rawQuery.replace(/\r/g, "\n").replace(URL_RE, " ");
  for (const block of RECALL_INJECTED_BLOCKS) text = text.replace(block, " ");
  return text;
}

function truncateRecallQuery(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= maxLen ? compact : compact.slice(0, maxLen).trimEnd();
}

export function scoreMemoryMatch(memory: ParsedMemoryIssue, rawQuery: string): number {
  const query = normalizeSearch(rawQuery);
  if (!query) return 0;
  const idx = buildSearchIndex(memory);
  const tokens = searchTokens(query);
  const queryTokenSet = new Set(tokens);
  const titleTokenSet = new Set(searchTokens(idx.title));
  const detailTokenSet = new Set(searchTokens(idx.detail));
  const kindTokenSet = new Set(searchTokens(idx.kind ?? ""));
  const topicTokenSet = new Set(idx.topics.flatMap(searchTokens));
  let score = 0;

  if (idx.title.includes(query)) score += 18;
  if (idx.detail.includes(query)) score += 12;
  if (idx.kind?.includes(query)) score += 8;
  for (const topic of idx.topics) if (topic.includes(query)) score += 10;

  for (const token of tokens) {
    if (idx.title.includes(token)) score += 4;
    if (idx.detail.includes(token)) score += 2;
    if (idx.kind?.includes(token)) score += 3;
    if (idx.topics.some((topic) => topic.includes(token))) score += 3;
  }

  score += overlapRatio(queryTokenSet, titleTokenSet) * 10;
  score += overlapRatio(queryTokenSet, detailTokenSet) * 6;
  score += overlapRatio(queryTokenSet, kindTokenSet) * 6;
  score += overlapRatio(queryTokenSet, topicTokenSet) * 8;

  const queryBigrams = charBigrams(query);
  score += overlapRatio(queryBigrams, charBigrams(idx.title)) * 6;
  score += overlapRatio(queryBigrams, charBigrams(idx.detail)) * 3;

  return score;
}

function normalizeDraft(input: MemoryDraft): MemoryDraft {
  const detail = norm(input.detail);
  if (!detail) throw new Error("memory detail is empty");
  const title = typeof input.title === "string" && input.title.trim() ? norm(input.title) : undefined;
  const kind = normalizeLabelValue(input.kind, "kind:");
  const topics = uniqueNormalized((input.topics ?? []).map((topic) => normalizeLabelValue(topic, "topic:")).filter(Boolean) as string[]);
  return {
    ...(title ? { title } : {}),
    detail,
    ...(kind ? { kind } : {}),
    ...(topics.length > 0 ? { topics } : {}),
  };
}

function normalizeLabelValue(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  const raw = value.trim().replace(new RegExp(`^${prefix}`, "i"), "");
  const normalized = raw.normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function normalizeOptionalLabelValue(value: string | undefined, prefix: string): string | undefined {
  try {
    return normalizeLabelValue(value, prefix);
  } catch {
    return undefined;
  }
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function parseDecision(raw: string): MemoryDecision {
  const tryParse = (s: string): MemoryDecision | null => {
    try {
      const p = JSON.parse(s) as Record<string, unknown>;
      return {
        save: Array.isArray(p.save) ? p.save.map(parseSaveItem).filter((v): v is MemoryDraft => Boolean(v)) : [],
        stale: Array.isArray(p.stale) ? p.stale.filter((v): v is string => typeof v === "string") : [],
      };
    } catch {
      return null;
    }
  };
  const t = raw.trim();
  return tryParse(t) ?? (() => {
    const f = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
    const nested = f?.[1] ? tryParse(f[1].trim()) : null;
    if (nested) return nested;
    throw new Error("memory decision subagent returned invalid JSON");
  })();
}

export function parseCandidates(raw: string): MemoryCandidate[] {
  const tryParse = (s: string): MemoryCandidate[] | null => {
    try {
      const payload = JSON.parse(s) as Record<string, unknown>;
      const candidates = Array.isArray(payload.candidates)
        ? payload.candidates.map(parseCandidateItem).filter((candidate): candidate is MemoryCandidate => Boolean(candidate))
        : [];
      return mergeMemoryCandidates([], candidates);
    } catch {
      return null;
    }
  };
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  if (fenced?.[1]) {
    const nested = tryParse(fenced[1].trim());
    if (nested) return nested;
  }
  throw new Error("memory extraction subagent returned invalid JSON");
}

function parseSaveItem(value: unknown): MemoryDraft | null {
  if (typeof value === "string") {
    const detail = norm(value);
    return detail ? { detail } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : undefined;
  const detail = typeof record.detail === "string" ? norm(record.detail) : "";
  if (!detail) return null;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  const topics = Array.isArray(record.topics) ? record.topics.filter((v): v is string => typeof v === "string") : undefined;
  try {
    return normalizeDraft({ ...(title ? { title } : {}), detail, ...(kind ? { kind } : {}), ...(topics ? { topics } : {}) });
  } catch {
    return null;
  }
}

function parseCandidateItem(value: unknown): MemoryCandidate | null {
  if (typeof value === "string") {
    const detail = norm(value);
    return detail ? { candidateId: sha256(detail), detail } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const detail = typeof record.detail === "string" ? norm(record.detail) : "";
  if (!detail) return null;
  const title = typeof record.title === "string" ? record.title : undefined;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  const topics = Array.isArray(record.topics) ? record.topics.filter((topic): topic is string => typeof topic === "string") : undefined;
  const evidence = typeof record.evidence === "string" ? norm(record.evidence) : undefined;
  try {
    const draft = normalizeDraft({
      ...(title ? { title } : {}),
      detail,
      ...(kind ? { kind } : {}),
      ...(topics ? { topics } : {}),
    });
    return {
      candidateId: sha256(draft.detail),
      detail: draft.detail,
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.kind ? { kind: draft.kind } : {}),
      ...(draft.topics ? { topics: draft.topics } : {}),
      ...(evidence ? { evidence } : {}),
    };
  } catch {
    return null;
  }
}

export function mergeMemoryCandidates(base: MemoryCandidate[], next: MemoryCandidate[]): MemoryCandidate[] {
  const out = new Map<string, MemoryCandidate>();
  for (const candidate of [...base, ...next]) {
    const existing = out.get(candidate.candidateId);
    if (!existing) {
      out.set(candidate.candidateId, {
        ...candidate,
        ...(candidate.topics ? { topics: uniqueNormalized(candidate.topics) } : {}),
      });
      continue;
    }
    out.set(candidate.candidateId, {
      candidateId: candidate.candidateId,
      detail: candidate.detail || existing.detail,
      ...(candidate.title || existing.title ? { title: candidate.title || existing.title } : {}),
      ...(candidate.kind || existing.kind ? { kind: candidate.kind || existing.kind } : {}),
      ...((candidate.topics || existing.topics)
        ? { topics: uniqueNormalized([...(existing.topics ?? []), ...(candidate.topics ?? [])]) }
        : {}),
      ...(candidate.evidence || existing.evidence ? { evidence: candidate.evidence || existing.evidence } : {}),
    });
  }
  return [...out.values()];
}
