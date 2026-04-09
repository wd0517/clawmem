// Memory CRUD, recall search helpers, and candidate parsing.
import { LABEL_MEMORY_STALE, MEMORY_TITLE_PREFIX, extractLabelNames, labelVal } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import type { MemoryCandidate, MemoryDraft, MemoryListOptions, MemorySchema, ParsedMemoryIssue } from "./types.js";
import { localDate, sha256 } from "./utils.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";
import { sanitizeRecallQueryInput } from "./recall-sanitize.js";

const MAX_BACKEND_QUERY_CHARS = 1500;

const RECALL_INJECTED_BLOCKS = [
  /<clawmem-context>[\s\S]*?<\/clawmem-context>/gi,
  /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi,
  /<memories>[\s\S]*?<\/memories>/gi,
];

const URL_RE = /https?:\/\/\S+/gi;

export class MemoryStore {
  constructor(private readonly client: GitHubIssueClient) {}

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
    return { kinds: [...kinds].sort(), topics: [...topics].sort() };
  }

  async get(memoryId: string, status: "active" | "stale" | "all" = "all"): Promise<ParsedMemoryIssue | null> {
    const id = memoryId.trim();
    if (!id) throw new Error("memoryId is empty");
    return this.findByRef(id, status);
  }

  async listMemories(options: MemoryListOptions = {}): Promise<ParsedMemoryIssue[]> {
    const status = options.status ?? "active";
    const kind = normalizeOptionalLabelValue(options.kind, "kind:");
    const topic = normalizeOptionalLabelValue(options.topic, "topic:");
    const limit = Math.min(200, Math.max(1, options.limit ?? 20));
    const labels = ["type:memory", ...(kind ? [`kind:${kind}`] : []), ...(topic ? [`topic:${topic}`] : [])];
    const state = status === "active" ? "open" : "all";
    const out: ParsedMemoryIssue[] = [];
    for (let page = 1; page <= 20 && out.length < limit; page++) {
      const batch = await this.client.listIssues({ labels, state, page, perPage: Math.min(100, limit) });
      for (const issue of batch) {
        const memory = this.parseIssue(issue);
        if (!memory) continue;
        if (status !== "all" && memory.status !== status) continue;
        out.push(memory);
        if (out.length >= limit) break;
      }
      if (batch.length < Math.min(100, limit)) break;
    }
    return out.sort((a, b) => b.issueNumber - a.issueNumber).slice(0, limit);
  }

  async store(draft: MemoryDraft): Promise<{ created: boolean; memory: ParsedMemoryIssue }> {
    const normalized = normalizeDraft(draft);
    const detail = norm(normalized.detail);
    const hash = sha256(detail);
    const existing = await this.findActiveByHash(hash);
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
    const duplicate = await this.findActiveByHash(nextHash);
    if (duplicate?.issueNumber === current.issueNumber) {
      // Updating schema/title without changing the underlying detail is always safe.
    } else if (duplicate) {
      throw new Error(`another active memory already stores this detail as [${duplicate.memoryId}]`);
    }
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

  private async findActiveByHash(hash: string): Promise<ParsedMemoryIssue | null> {
    const repo = this.client.repo?.();
    if (!repo) return null;
    const query = buildMemoryHashSearchQuery(hash, repo);
    const batch = await this.client.searchIssues(query, { perPage: 10 });
    return batch
      .map((issue) => this.parseIssue(issue))
      .find((memory): memory is ParsedMemoryIssue =>
        memory !== null && memory.status === "active" && (memory.memoryHash || sha256(norm(memory.detail))) === hash,
      ) ?? null;
  }

  private async findByRef(id: string, status: "active" | "stale" | "all"): Promise<ParsedMemoryIssue | null> {
    const trimmed = id.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      try {
        const issue = await this.client.getIssue(Number(trimmed));
        const parsed = this.parseIssue(issue);
        if (!parsed) return null;
        if (status !== "all" && parsed.status !== status) return null;
        return parsed;
      } catch {
        // Fall through to memory-id search for nonstandard repos that expose custom memory ids.
      }
    }
    const repo = this.client.repo?.();
    if (!repo) return null;
    const batch = await this.client.searchIssues(buildMemoryRefSearchQuery(trimmed, repo, status), { perPage: 10 });
    return batch
      .map((issue) => this.parseIssue(issue))
      .find((memory): memory is ParsedMemoryIssue =>
        memory !== null && (status === "all" || memory.status === status) && (memory.memoryId === trimmed || String(memory.issueNumber) === trimmed),
      ) ?? null;
  }

  private async findActiveByRef(id: string): Promise<ParsedMemoryIssue | null> {
    return this.findByRef(id, "active");
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

function buildMemorySearchQuery(query: string, repo: string): string {
  const parts = [buildRecallSearchText(query), `repo:${repo}`, "is:issue", "state:open", 'label:"type:memory"'].filter(Boolean);
  return parts.join(" ");
}

function buildMemoryHashSearchQuery(hash: string, repo: string): string {
  const needle = hash.trim();
  if (!needle) return "";
  return [`"${needle}"`, `repo:${repo}`, "is:issue", "state:open", 'label:"type:memory"'].join(" ");
}

function buildMemoryRefSearchQuery(memoryId: string, repo: string, status: "active" | "stale" | "all"): string {
  const needle = memoryId.trim();
  if (!needle) return "";
  const parts = [`"${needle}"`, `repo:${repo}`, "is:issue", 'label:"type:memory"'];
  if (status === "active") parts.push("state:open");
  if (status === "stale") parts.push("state:closed");
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
  throw new Error("finalize memory candidates returned invalid JSON");
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
