// Memory CRUD, sha256 dedup, and AI-driven memory extraction.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { LABEL_MEMORY_STALE, MEMORY_TITLE_PREFIX, extractLabelNames, labelVal } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import { normalizeMessages } from "./transcript.js";
import type {
  ClawMemPluginConfig,
  MemoryDraft,
  MemoryListOptions,
  MemorySchema,
  MemorySourceRole,
  ParsedMemoryIssue,
  SessionMirrorState,
  TranscriptSnapshot,
} from "./types.js";
import { fmtTranscript, localDate, sha256, subKey } from "./utils.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";

type MemoryDecision = { save: MemoryDraft[]; stale: string[] };
type SearchIndex = {
  title: string;
  detail: string;
  kind?: string;
  topics: string[];
  sourceRole?: string;
  entities: string[];
  factType?: string;
  eventDate?: string;
  timeAnchor?: string;
};

export class MemoryStore {
  constructor(private readonly client: GitHubIssueClient, private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  async search(query: string, limit: number): Promise<ParsedMemoryIssue[]> {
    const rawQuery = query.trim();
    if (!rawQuery) return [];
    try {
      const backend = await this.searchViaBackend(rawQuery, limit);
      if (backend.length > 0) return backend;
    } catch (error) {
      this.api.logger?.warn?.(`clawmem: backend memory search failed, falling back to local lexical search: ${String(error)}`);
    }
    const active = await this.listByStatus("active");
    if (active.length === 0) return [];
    return this.searchLocally(normalizeSearch(rawQuery), limit, active);
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
    const factType = normalizeFactType(options.factType);
    const limit = Math.min(200, Math.max(1, options.limit ?? 20));
    return (await this.listByStatus(status))
      .filter((memory) => {
        if (kind && memory.kind !== kind) return false;
        if (topic && !(memory.topics ?? []).includes(topic)) return false;
        if (options.sourceRole && memory.sourceRole !== options.sourceRole) return false;
        if (factType && memory.factType !== factType) return false;
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
      const memory = await this.mergeMemoryDraft(existing, normalized);
      return { created: false, memory };
    }

    const memory = createMemoryRecord(normalized, hash);
    await this.client.ensureLabels(memLabels(memory.kind, memory.topics, memory.sourceRole));
    const issue = await this.client.createIssue({
      title: memory.title,
      body: buildMemoryBody(memory),
      labels: memLabels(memory.kind, memory.topics, memory.sourceRole),
    });
    return { created: true, memory: { ...memory, issueNumber: issue.number, memoryId: String(issue.number) } };
  }

  async update(memoryId: string, patch: {
    detail?: string;
    kind?: string;
    topics?: string[];
    sourceRole?: MemorySourceRole;
    entities?: string[];
    factType?: string;
    eventDate?: string;
    timeAnchor?: string;
  }): Promise<ParsedMemoryIssue | null> {
    const current = await this.get(memoryId, "all");
    if (!current) return null;
    const nextDetail = typeof patch.detail === "string" && patch.detail.trim() ? norm(patch.detail) : current.detail;
    const nextKind = patch.kind !== undefined ? normalizeLabelValue(patch.kind, "kind:") : current.kind;
    const nextTopics = patch.topics !== undefined
      ? uniqueNormalized(patch.topics.map((topic) => normalizeLabelValue(topic, "topic:")).filter(Boolean) as string[])
      : uniqueNormalized(current.topics ?? []);
    const nextSourceRole = patch.sourceRole !== undefined ? normalizeSourceRole(patch.sourceRole) : current.sourceRole;
    const nextEntities = patch.entities !== undefined ? normalizeEntities(patch.entities) : normalizeEntities(current.entities ?? []);
    const nextFactType = patch.factType !== undefined ? normalizeFactType(patch.factType) : current.factType;
    const nextEventDate = patch.eventDate !== undefined ? normalizeDateValue(patch.eventDate) : current.eventDate;
    const nextTimeAnchor = patch.timeAnchor !== undefined ? normalizeFreeformText(patch.timeAnchor) : current.timeAnchor;
    const nextHash = sha256(nextDetail);
    const duplicate = (await this.listByStatus("active")).find((memory) => {
      if (memory.issueNumber === current.issueNumber) return false;
      return (memory.memoryHash || sha256(norm(memory.detail))) === nextHash;
    });
    if (duplicate) throw new Error(`another active memory already stores this detail as [${duplicate.memoryId}]`);
    const next: ParsedMemoryIssue = {
      ...current,
      title: `${MEMORY_TITLE_PREFIX}${trunc(nextDetail, 72)}`,
      memoryHash: nextHash,
      detail: nextDetail,
      ...(nextKind ? { kind: nextKind } : {}),
      ...(nextTopics.length > 0 ? { topics: nextTopics } : {}),
      ...(nextSourceRole ? { sourceRole: nextSourceRole } : {}),
      ...(nextEntities.length > 0 ? { entities: nextEntities } : {}),
      ...(nextFactType ? { factType: nextFactType } : {}),
      ...(nextEventDate ? { eventDate: nextEventDate } : {}),
      ...(nextTimeAnchor ? { timeAnchor: nextTimeAnchor } : {}),
    };
    const nextLabels = memLabels(next.kind, next.topics, next.sourceRole);
    await this.client.ensureLabels(nextLabels);
    await this.client.updateIssue(current.issueNumber, { title: next.title, body: buildMemoryBody(next) });
    await this.client.syncManagedLabels(current.issueNumber, nextLabels);
    return next;
  }

  async forget(memoryId: string): Promise<ParsedMemoryIssue | null> {
    const id = memoryId.trim();
    if (!id) throw new Error("memoryId is empty");
    const mem = await this.get(id, "active");
    if (!mem) return null;
    await this.client.syncManagedLabels(mem.issueNumber, memLabels(mem.kind, mem.topics, mem.sourceRole));
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
    if (!repo) return [];
    const qualified = buildMemorySearchQuery(query, repo);
    const batch = await this.client.searchIssues(qualified, { perPage: Math.min(100, Math.max(limit, 20)) });
    return batch
      .map((issue) => this.parseIssue(issue))
      .filter((memory): memory is ParsedMemoryIssue => memory !== null && memory.status === "active")
      .slice(0, limit);
  }

  private searchLocally(normalizedQuery: string, limit: number, memories: ParsedMemoryIssue[]): ParsedMemoryIssue[] {
    if (!normalizedQuery) return [];
    return memories
      .map((m) => ({ m, score: scoreSearchIndex(buildSearchIndex(m), normalizedQuery) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || b.m.issueNumber - a.m.issueNumber)
      .slice(0, limit)
      .map((e) => e.m);
  }

  private parseIssue(issue: { number: number; title?: string; body?: string; state?: string; labels?: Array<{ name?: string } | string> }): ParsedMemoryIssue | null {
    const labels = extractLabelNames(issue.labels);
    if (!labels.includes("type:memory")) return null;
    const kind = labelVal(labels, "kind:");
    const topics = labels.filter((l) => l.startsWith("topic:")).map((l) => l.slice(6).trim()).filter(Boolean);
    const sourceRole = normalizeSourceRole(labelVal(labels, "source:") as MemorySourceRole | undefined);
    const rawBody = (issue.body ?? "").trim();
    const body = rawBody ? parseFlatYaml(rawBody) : {};
    const detail = body.detail?.trim() || rawBody;
    const status = issue.state === "closed" || labels.includes(LABEL_MEMORY_STALE) ? "stale" : "active";
    if (!detail) return null;
    const entities = parseEntityList(body.entities_json?.trim() || body.entities?.trim());
    return {
      issueNumber: issue.number,
      title: issue.title?.trim() || "",
      memoryId: body.memory_id?.trim() || String(issue.number),
      memoryHash: body.memory_hash?.trim() || undefined,
      date: body.date?.trim() || "1970-01-01",
      detail,
      ...(kind ? { kind } : {}),
      ...(topics.length > 0 ? { topics } : {}),
      ...(sourceRole || body.source_role?.trim() ? { sourceRole: normalizeSourceRole((body.source_role?.trim() || sourceRole) as MemorySourceRole | undefined) } : {}),
      ...(entities.length > 0 ? { entities } : {}),
      ...(normalizeFactType(body.fact_type?.trim()) ? { factType: normalizeFactType(body.fact_type?.trim()) } : {}),
      ...(normalizeDateValue(body.event_date?.trim()) ? { eventDate: normalizeDateValue(body.event_date?.trim()) } : {}),
      ...(normalizeFreeformText(body.time_anchor?.trim()) ? { timeAnchor: normalizeFreeformText(body.time_anchor?.trim()) } : {}),
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
        const merged = await this.mergeMemoryDraft(existing, draft);
        activeByHash.set(hash, merged);
        continue;
      }
      const memory = createMemoryRecord(draft, hash);
      await this.client.ensureLabels(memLabels(memory.kind, memory.topics, memory.sourceRole));
      const issue = await this.client.createIssue({
        title: memory.title,
        body: buildMemoryBody(memory),
        labels: memLabels(memory.kind, memory.topics, memory.sourceRole),
      });
      activeByHash.set(hash, { ...memory, issueNumber: issue.number, memoryId: String(issue.number) });
      savedCount++;
    }
    let staledCount = 0;
    for (const id of [...new Set(decision.stale.map((s) => s.trim()).filter(Boolean))]) {
      const mem = activeById.get(id);
      if (!mem) continue;
      await this.client.syncManagedLabels(mem.issueNumber, memLabels(mem.kind, mem.topics, mem.sourceRole));
      await this.client.updateIssue(mem.issueNumber, { state: "closed" });
      staledCount++;
    }
    return { savedCount, staledCount };
  }

  private async generateDecision(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<MemoryDecision> {
    if (snapshot.messages.length === 0) return { save: [], stale: [] };
    const recent = (await this.listByStatus("active")).sort((a, b) => b.issueNumber - a.issueNumber).slice(0, 20);
    const existingBlock = recent.length === 0 ? "None." : recent.map((m) => {
      const schema = [
        m.kind ? `kind=${m.kind}` : "",
        ...(m.topics ?? []).map((topic) => `topic=${topic}`),
        m.sourceRole ? `source=${m.sourceRole}` : "",
        m.factType ? `fact_type=${m.factType}` : "",
        m.eventDate ? `event_date=${m.eventDate}` : "",
      ].filter(Boolean).join(", ");
      return `[${m.memoryId}] ${schema ? `${schema} | ` : ""}${m.detail}`;
    }).join("\n");
    const schema = await this.listSchema();
    const schemaBlock = [
      `Existing kinds: ${schema.kinds.length > 0 ? schema.kinds.join(", ") : "None."}`,
      `Existing topics: ${schema.topics.length > 0 ? schema.topics.join(", ") : "None."}`,
      `Today: ${localDate()}`,
    ].join("\n");
    const subagent = this.api.runtime.subagent;
    const sessionKey = subKey(session, "memory");
    const message = [
      "Extract durable memories from the conversation below.",
      'Return JSON only in the form {"save":[{"detail":"...","kind":"...","topics":["..."],"sourceRole":"user|assistant","entities":["..."],"factType":"...","eventDate":"YYYY-MM-DD","timeAnchor":"..."}],"stale":["memory-id"]}.',
      "Each save item must contain exactly one atomic memory. Never bundle multiple facts, people, motivations, or timeline updates into one memory.",
      "Split independent facts even when they appear in the same turn. If one message contains three durable facts, return three save items.",
      "Use save for stable, reusable facts, preferences, decisions, constraints, workflows, and ongoing context worth remembering later.",
      "Use stale for existing memory IDs only when the conversation clearly supersedes or invalidates them.",
      "Infer kind and topics only when they materially help future retrieval. Reuse existing kinds and topics when possible, and prefer leaving them empty over inventing one-off labels.",
      "sourceRole must reflect whether the durable fact originated from the user or the assistant.",
      "entities should contain 1-5 short names, products, people, places, organizations, or exact concepts that anchor future retrieval.",
      "factType should be a short reusable category such as preference, identity, timeline-event, project-status, assistant-knowledge, task, or decision.",
      "If the conversation gives an absolute date, normalize it into eventDate as YYYY-MM-DD. If it only gives a relative time such as yesterday or next quarter, preserve that in timeAnchor.",
      "Topics should be short reusable tags, not sentences. Prefer 0-3 topics per memory.",
      "Do not create separate memories that only restate the same fact with slightly different wording.",
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
        extraSystemPrompt: "You extract durable memory updates from OpenClaw conversations. Output JSON only. Store one atomic fact per save item. Prefer precise entities, sourceRole, factType, and normalized dates when present.",
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

  private async mergeMemoryDraft(memory: ParsedMemoryIssue, draft: MemoryDraft): Promise<ParsedMemoryIssue> {
    const normalized = normalizeDraft(draft);
    const nextKind = normalized.kind ?? memory.kind;
    const currentTopics = uniqueNormalized(memory.topics ?? []);
    const nextTopics = uniqueNormalized([...currentTopics, ...(normalized.topics ?? [])]);
    const nextSourceRole = normalized.sourceRole ?? memory.sourceRole;
    const nextEntities = mergeEntities(memory.entities ?? [], normalized.entities ?? []);
    const nextFactType = normalized.factType ?? memory.factType;
    const nextEventDate = normalized.eventDate ?? memory.eventDate;
    const nextTimeAnchor = normalized.timeAnchor ?? memory.timeAnchor;
    const sameKind = (memory.kind ?? "") === (nextKind ?? "");
    const sameTopics = JSON.stringify(currentTopics) === JSON.stringify(nextTopics);
    const sameSourceRole = (memory.sourceRole ?? "") === (nextSourceRole ?? "");
    const sameEntities = JSON.stringify(memory.entities ?? []) === JSON.stringify(nextEntities);
    const sameFactType = (memory.factType ?? "") === (nextFactType ?? "");
    const sameEventDate = (memory.eventDate ?? "") === (nextEventDate ?? "");
    const sameTimeAnchor = (memory.timeAnchor ?? "") === (nextTimeAnchor ?? "");
    if (sameKind && sameTopics && sameSourceRole && sameEntities && sameFactType && sameEventDate && sameTimeAnchor) return memory;
    const next: ParsedMemoryIssue = {
      ...memory,
      ...(nextKind ? { kind: nextKind } : {}),
      ...(nextTopics.length > 0 ? { topics: nextTopics } : {}),
      ...(nextSourceRole ? { sourceRole: nextSourceRole } : {}),
      ...(nextEntities.length > 0 ? { entities: nextEntities } : {}),
      ...(nextFactType ? { factType: nextFactType } : {}),
      ...(nextEventDate ? { eventDate: nextEventDate } : {}),
      ...(nextTimeAnchor ? { timeAnchor: nextTimeAnchor } : {}),
    };
    const labels = memLabels(next.kind, next.topics, next.sourceRole);
    await this.client.ensureLabels(labels);
    await this.client.updateIssue(memory.issueNumber, { body: buildMemoryBody(next) });
    await this.client.syncManagedLabels(memory.issueNumber, labels);
    return next;
  }
}

function memLabels(kind?: string, topics?: string[], sourceRole?: MemorySourceRole): string[] {
  return [
    "type:memory",
    ...(kind ? [`kind:${kind}`] : []),
    ...(sourceRole ? [`source:${sourceRole}`] : []),
    ...((topics ?? []).map((topic) => `topic:${topic}`)),
  ];
}

function createMemoryRecord(draft: MemoryDraft, hash: string): ParsedMemoryIssue {
  const date = localDate();
  const detail = norm(draft.detail);
  return {
    issueNumber: 0,
    title: `${MEMORY_TITLE_PREFIX}${trunc(detail, 72)}`,
    memoryId: "0",
    memoryHash: hash,
    date,
    detail,
    ...(draft.kind ? { kind: draft.kind } : {}),
    ...(draft.topics && draft.topics.length > 0 ? { topics: draft.topics } : {}),
    ...(draft.sourceRole ? { sourceRole: draft.sourceRole } : {}),
    ...(draft.entities && draft.entities.length > 0 ? { entities: draft.entities } : {}),
    ...(draft.factType ? { factType: draft.factType } : {}),
    ...(draft.eventDate ? { eventDate: draft.eventDate } : {}),
    ...(draft.timeAnchor ? { timeAnchor: draft.timeAnchor } : {}),
    status: "active",
  };
}

function buildMemoryBody(memory: Pick<ParsedMemoryIssue, "memoryHash" | "date" | "detail" | "sourceRole" | "entities" | "factType" | "eventDate" | "timeAnchor">): string {
  return filteredYaml([
    ["memory_hash", memory.memoryHash?.trim() || undefined],
    ["date", memory.date],
    ["detail", memory.detail],
    ["source_role", memory.sourceRole],
    ["fact_type", memory.factType],
    ["event_date", memory.eventDate],
    ["time_anchor", memory.timeAnchor],
    ["entities_json", memory.entities && memory.entities.length > 0 ? JSON.stringify(memory.entities) : undefined],
  ]);
}

function filteredYaml(entries: Array<[key: string, value: string | undefined]>): string {
  return stringifyFlatYaml(entries.filter(([, value]) => value !== undefined));
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
    ...(memory.sourceRole ? { sourceRole: normalizeSearch(memory.sourceRole) } : {}),
    entities: (memory.entities ?? []).map(normalizeSearch).filter(Boolean),
    ...(memory.factType ? { factType: normalizeSearch(memory.factType) } : {}),
    ...(memory.eventDate ? { eventDate: normalizeSearch(memory.eventDate) } : {}),
    ...(memory.timeAnchor ? { timeAnchor: normalizeSearch(memory.timeAnchor) } : {}),
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
  const parts = [query.trim(), `repo:${repo}`, "is:issue", "state:open", 'label:"type:memory"'].filter(Boolean);
  return parts.join(" ");
}

function scoreSearchIndex(idx: SearchIndex, normalizedQuery: string): number {
  const tokens = searchTokens(normalizedQuery);
  const queryTokenSet = new Set(tokens);
  const titleTokenSet = new Set(searchTokens(idx.title));
  const detailTokenSet = new Set(searchTokens(idx.detail));
  const kindTokenSet = new Set(searchTokens(idx.kind ?? ""));
  const topicTokenSet = new Set(idx.topics.flatMap(searchTokens));
  const entityTokenSet = new Set(idx.entities.flatMap(searchTokens));
  const factTypeTokenSet = new Set(searchTokens(idx.factType ?? ""));
  const dateTokenSet = new Set(searchTokens(`${idx.eventDate ?? ""} ${idx.timeAnchor ?? ""}`));
  let score = 0;

  if (idx.title.includes(normalizedQuery)) score += 18;
  if (idx.detail.includes(normalizedQuery)) score += 12;
  if (idx.kind?.includes(normalizedQuery)) score += 8;
  if (idx.factType?.includes(normalizedQuery)) score += 8;
  if (idx.eventDate?.includes(normalizedQuery)) score += 10;
  if (idx.timeAnchor?.includes(normalizedQuery)) score += 6;
  for (const topic of idx.topics) if (topic.includes(normalizedQuery)) score += 10;
  for (const entity of idx.entities) if (entity.includes(normalizedQuery)) score += 10;

  for (const token of tokens) {
    if (idx.title.includes(token)) score += 4;
    if (idx.detail.includes(token)) score += 2;
    if (idx.kind?.includes(token)) score += 3;
    if (idx.factType?.includes(token)) score += 3;
    if (idx.eventDate?.includes(token)) score += 4;
    if (idx.timeAnchor?.includes(token)) score += 2;
    if (idx.topics.some((topic) => topic.includes(token))) score += 3;
    if (idx.entities.some((entity) => entity.includes(token))) score += 4;
  }

  score += overlapRatio(queryTokenSet, titleTokenSet) * 10;
  score += overlapRatio(queryTokenSet, detailTokenSet) * 6;
  score += overlapRatio(queryTokenSet, kindTokenSet) * 6;
  score += overlapRatio(queryTokenSet, topicTokenSet) * 8;
  score += overlapRatio(queryTokenSet, entityTokenSet) * 10;
  score += overlapRatio(queryTokenSet, factTypeTokenSet) * 6;
  score += overlapRatio(queryTokenSet, dateTokenSet) * 8;

  const queryBigrams = charBigrams(normalizedQuery);
  score += overlapRatio(queryBigrams, charBigrams(idx.title)) * 6;
  score += overlapRatio(queryBigrams, charBigrams(idx.detail)) * 3;
  score += overlapRatio(queryBigrams, new Set(idx.entities.flatMap((entity) => [...charBigrams(entity)]))) * 5;

  return score;
}
function normalizeDraft(input: MemoryDraft): MemoryDraft {
  const detail = norm(input.detail);
  if (!detail) throw new Error("memory detail is empty");
  const kind = normalizeLabelValue(input.kind, "kind:");
  const topics = uniqueNormalized((input.topics ?? []).map((topic) => normalizeLabelValue(topic, "topic:")).filter(Boolean) as string[]);
  const sourceRole = normalizeSourceRole(input.sourceRole);
  const entities = normalizeEntities(input.entities ?? []);
  const factType = normalizeFactType(input.factType);
  const eventDate = normalizeDateValue(input.eventDate);
  const timeAnchor = normalizeFreeformText(input.timeAnchor);
  return {
    detail,
    ...(kind ? { kind } : {}),
    ...(topics.length > 0 ? { topics } : {}),
    ...(sourceRole ? { sourceRole } : {}),
    ...(entities.length > 0 ? { entities } : {}),
    ...(factType ? { factType } : {}),
    ...(eventDate ? { eventDate } : {}),
    ...(timeAnchor ? { timeAnchor } : {}),
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

function normalizeSourceRole(value: MemorySourceRole | undefined): MemorySourceRole | undefined {
  if (value !== "assistant" && value !== "user") return undefined;
  return value;
}

function normalizeFactType(value: string | undefined): string | undefined {
  return normalizeLabelValue(value, "fact_type:");
}

function normalizeDateValue(value: string | undefined): string | undefined {
  const trimmed = normalizeFreeformText(value);
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? localDate(parsed) : undefined;
}

function normalizeFreeformText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = norm(value);
  return normalized || undefined;
}

function normalizeEntities(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeFreeformText(value);
    if (!normalized) continue;
    const key = normalizeSearch(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.slice(0, 8);
}

function mergeEntities(left: string[], right: string[]): string[] {
  return normalizeEntities([...left, ...right]);
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function parseEntityList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return normalizeEntities(parsed.filter((item): item is string => typeof item === "string"));
  } catch { /* fall through */ }
  return normalizeEntities(value.split(/[,\n]/g));
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

function parseSaveItem(value: unknown): MemoryDraft | null {
  if (typeof value === "string") {
    const detail = norm(value);
    return detail ? { detail } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const detail = typeof record.detail === "string" ? norm(record.detail) : "";
  if (!detail) return null;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  const topics = Array.isArray(record.topics) ? record.topics.filter((v): v is string => typeof v === "string") : undefined;
  const sourceRole = record.sourceRole === "assistant" || record.sourceRole === "user"
    ? record.sourceRole
    : record.source_role === "assistant" || record.source_role === "user"
      ? record.source_role
      : undefined;
  const entities = Array.isArray(record.entities)
    ? record.entities.filter((v): v is string => typeof v === "string")
    : typeof record.entities === "string"
      ? parseEntityList(record.entities)
      : undefined;
  const factType = typeof record.factType === "string" ? record.factType : typeof record.fact_type === "string" ? record.fact_type : undefined;
  const eventDate = typeof record.eventDate === "string" ? record.eventDate : typeof record.event_date === "string" ? record.event_date : undefined;
  const timeAnchor = typeof record.timeAnchor === "string" ? record.timeAnchor : typeof record.time_anchor === "string" ? record.time_anchor : undefined;
  try {
    return normalizeDraft({
      detail,
      ...(kind ? { kind } : {}),
      ...(topics ? { topics } : {}),
      ...(sourceRole ? { sourceRole } : {}),
      ...(entities ? { entities } : {}),
      ...(factType ? { factType } : {}),
      ...(eventDate ? { eventDate } : {}),
      ...(timeAnchor ? { timeAnchor } : {}),
    });
  } catch {
    return null;
  }
}
