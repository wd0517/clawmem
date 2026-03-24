// Memory CRUD, sha256 dedup, and AI-driven memory extraction.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { LABEL_MEMORY_ACTIVE, LABEL_MEMORY_STALE, MEMORY_TITLE_PREFIX, extractLabelNames, labelVal } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import { normalizeMessages } from "./transcript.js";
import type { ClawMemPluginConfig, ParsedMemoryIssue, SessionMirrorState, StoreMemoryResult, TranscriptSnapshot } from "./types.js";
import { fmtTranscript, localDate, sha256, subKey } from "./utils.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";

type MemorySaveInput = {
  detail: string;
  kind?: string;
  topics?: string[];
  pinStartup?: boolean;
  title?: string;
};

type MemoryDecision = { save: MemorySaveInput[]; stale: string[] };

type StartupRecall = {
  pinned: ParsedMemoryIssue[];
  matched: ParsedMemoryIssue[];
  recent: ParsedMemoryIssue[];
  memories: ParsedMemoryIssue[];
};

type StoreMemoryInput = MemorySaveInput & {
  sessionId?: string;
  date?: string;
};

type IssueLike = {
  number: number;
  title?: string;
  body?: string;
  labels?: Array<{ name?: string } | string>;
};

export class MemoryStore {
  constructor(private readonly client: GitHubIssueClient, private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  async search(query: string, limit: number): Promise<ParsedMemoryIssue[]> {
    const q = norm(query);
    if (!q) return [];
    return rankMemories(await this.list("active"), q).slice(0, clampLimit(limit));
  }

  async startupRecall(query: string, limit: number): Promise<StartupRecall> {
    const max = clampLimit(limit);
    const active = await this.list("active");
    const pinnedSource = [...active].filter((m) => m.pinStartup).sort(byIssueNumberDesc);
    const matchedSource = norm(query) ? rankMemories(active, query) : [];
    const recentSource = [...active].sort(byIssueNumberDesc);
    const seen = new Set<number>();
    const pinned: ParsedMemoryIssue[] = [];
    const matched: ParsedMemoryIssue[] = [];
    const recent: ParsedMemoryIssue[] = [];
    const memories: ParsedMemoryIssue[] = [];
    addUniqueMemories(pinnedSource, pinned, memories, seen, max);
    addUniqueMemories(matchedSource, matched, memories, seen, max);
    addUniqueMemories(recentSource, recent, memories, seen, max);
    return { pinned, matched, recent, memories };
  }

  async store(input: StoreMemoryInput): Promise<StoreMemoryResult> {
    const detail = norm(input.detail);
    if (!detail) throw new Error("memory detail is required");
    const sessionId = normOrUndefined(input.sessionId);
    const date = normOrUndefined(input.date) ?? localDate();
    const kind = coerceKindForContent(detail, normalizeKindValue(input.kind));
    const topics = normalizeTopicValues(input.topics);
    const pinStartup = Boolean(input.pinStartup);
    const memoryHash = sha256(detail);
    const title = buildMemoryTitle(input.title, detail);
    const active = await this.list("active");
    const candidate = findUpdateCandidate(active, { sessionId, detail, title, kind, topics, memoryHash });
    if (candidate) {
      const merged = mergeMemory(candidate, { sessionId, date, detail, title, kind, topics, pinStartup, memoryHash });
      const labels = buildMemoryLabels({
        sessionId: merged.sessionId,
        date: merged.date,
        status: "active",
        kind: merged.kind,
        topics: merged.topics,
        pinStartup: merged.pinStartup,
      });
      const body = stringifyFlatYaml([["memory_hash", merged.memoryHash], ["detail", merged.detail]]);
      await this.client.ensureLabels(labels);
      await this.client.updateIssue(candidate.issueNumber, { title: merged.title, body, state: "open" });
      await this.client.syncManagedLabels(candidate.issueNumber, labels);
      const refreshed = this.parseIssue(await this.client.getIssue(candidate.issueNumber)) ?? {
        issueNumber: candidate.issueNumber,
        title: merged.title,
        memoryId: candidate.memoryId,
        memoryHash: merged.memoryHash,
        ...(merged.sessionId ? { sessionId: merged.sessionId } : {}),
        ...(merged.date ? { date: merged.date } : {}),
        detail: merged.detail,
        ...(merged.topics.length > 0 ? { topics: merged.topics } : {}),
        ...(merged.kind ? { kind: merged.kind } : {}),
        ...(merged.pinStartup ? { pinStartup: true } : {}),
        status: "active" as const,
      };
      const action: StoreMemoryResult["action"] = candidate.memoryHash === memoryHash ? "existing" : "updated";
      return { action, memory: refreshed };
    }
    const labels = buildMemoryLabels({ sessionId, date, status: "active", kind, topics, pinStartup });
    const body = stringifyFlatYaml([["memory_hash", memoryHash], ["detail", detail]]);
    await this.client.ensureLabels(labels);
    const issue = await this.client.createIssue({ title, body, labels });
    const memory = this.parseIssue(issue) ?? {
      issueNumber: issue.number,
      title: issue.title?.trim() || title,
      memoryId: String(issue.number),
      memoryHash,
      ...(sessionId ? { sessionId } : {}),
      ...(date ? { date } : {}),
      detail,
      ...(topics.length > 0 ? { topics } : {}),
      ...(kind ? { kind } : {}),
      ...(pinStartup ? { pinStartup: true } : {}),
      status: "active" as const,
    };
    return { action: "created", memory };
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

  private async list(status: "active" | "stale" | "all"): Promise<ParsedMemoryIssue[]> {
    const out: ParsedMemoryIssue[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.client.listIssues({ labels: ["type:memory"], state: "all", page, perPage: 100 });
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

  private parseIssue(issue: IssueLike): ParsedMemoryIssue | null {
    const labels = extractLabelNames(issue.labels);
    if (!labels.includes("type:memory")) return null;
    const rawBody = (issue.body ?? "").trim();
    const body = rawBody ? parseFlatYaml(rawBody) : {};
    const detail = norm(body.detail ?? rawBody);
    if (!detail) return null;
    const sessionId = normOrUndefined(labelVal(labels, "session:") ?? body.session_id);
    const date = normOrUndefined(labelVal(labels, "date:") ?? body.date);
    const topics = labels
      .filter((l) => l.startsWith("topic:"))
      .map((l) => norm(l.slice(6)))
      .filter(Boolean);
    const kind = normOrUndefined(labelVal(labels, "kind:") ?? body.kind);
    const pinStartup = labels.some((l) => l.toLowerCase() === "pin:startup") || truthy(body.pin_startup);
    return {
      issueNumber: issue.number,
      title: issue.title?.trim() || "",
      memoryId: normOrUndefined(body.memory_id) ?? String(issue.number),
      memoryHash: normOrUndefined(body.memory_hash),
      ...(sessionId ? { sessionId } : {}),
      ...(date ? { date } : {}),
      detail,
      ...(topics.length > 0 ? { topics } : {}),
      ...(kind ? { kind } : {}),
      ...(pinStartup ? { pinStartup: true } : {}),
      status: resolveMemoryStatus(labels),
    };
  }

  private async applyDecision(sessionId: string, decision: MemoryDecision): Promise<{ savedCount: number; staledCount: number }> {
    const allActive = await this.list("active");
    const activeById = new Map(allActive.map((m) => [m.memoryId, m]));
    const existingHashes = new Set(allActive.map((m) => m.memoryHash || sha256(norm(m.detail))));
    let savedCount = 0;
    for (const save of decision.save) {
      const detail = norm(save.detail);
      if (!detail) continue;
      const hash = sha256(detail);
      if (existingHashes.has(hash)) continue;
      const result = await this.store({
        sessionId,
        detail,
        kind: save.kind,
        topics: save.topics,
        pinStartup: save.pinStartup,
        title: save.title,
      });
      existingHashes.add(hash);
      if (result.action !== "existing") savedCount++;
    }
    let staledCount = 0;
    for (const id of [...new Set(decision.stale.map((s) => s.trim()).filter(Boolean))]) {
      const mem = activeById.get(id);
      if (!mem) continue;
      const labels = buildMemoryLabels({
        sessionId: mem.sessionId,
        date: mem.date,
        status: "stale",
        kind: mem.kind,
        topics: mem.topics,
        pinStartup: mem.pinStartup,
      });
      await this.client.ensureLabels(labels);
      await this.client.syncManagedLabels(mem.issueNumber, labels);
      staledCount++;
    }
    return { savedCount, staledCount };
  }

  private async generateDecision(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<MemoryDecision> {
    if (snapshot.messages.length === 0) return { save: [], stale: [] };
    const recent = (await this.list("active")).sort(byIssueNumberDesc).slice(0, 20);
    const existingBlock = recent.length === 0 ? "None." : recent.map(formatExistingMemory).join("\n");
    const message = [
      "Extract durable memories from the conversation below.",
      'Return JSON only in the form {"save":[...],"stale":["memory-id"]}.',
      'Each save entry may be either a string detail or an object like {"detail":"...","kind":"convention","topics":["startup"],"pinStartup":true,"title":"..."}.',
      "Prefer structured save objects when you can add a kind, topics, pinStartup, or a clearer title.",
      "Use save for stable, reusable facts, preferences, decisions, constraints, ongoing context, troubleshooting conclusions, and repeatable workflows worth remembering later.",
      "Prefer kind:core-fact for stable user preferences/facts, kind:convention for rules, and kind:skill for repeatable workflows or SOPs. Do not invent new kind names.",
      "If multiple turns are refining the same workflow or conclusion, prefer one updated complete memory instead of many partial near-duplicates.",
      "Use stale for existing memory IDs only when the conversation clearly supersedes or invalidates them.",
      "Do not save temporary requests, startup boilerplate, tool chatter, summaries about internal helper sessions, or one-off operational details.",
      "Prefer empty arrays when nothing durable should be remembered.",
      "", "<existing-active-memories>", existingBlock, "</existing-active-memories>",
      "", "<conversation>", fmtTranscript(snapshot.messages), "</conversation>",
    ].join("\n");
    const subagent = this.api.runtime.subagent;
    const sessionKey = subKey(session, "memory");
    try {
      const run = await subagent.run({
        sessionKey, message, deliver: false, lane: "clawmem-memory",
        idempotencyKey: sha256(`${session.sessionId}:${snapshot.messages.length}:memory-decision`),
        extraSystemPrompt: "You extract durable memory updates from OpenClaw conversations. Output JSON only with save (array of strings or objects) and stale (string array).",
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
}

function addUniqueMemories(
  source: ParsedMemoryIssue[],
  bucket: ParsedMemoryIssue[],
  combined: ParsedMemoryIssue[],
  seen: Set<number>,
  limit: number,
): void {
  for (const memory of source) {
    if (combined.length >= limit) return;
    if (seen.has(memory.issueNumber)) continue;
    seen.add(memory.issueNumber);
    bucket.push(memory);
    combined.push(memory);
  }
}

function rankMemories(memories: ParsedMemoryIssue[], query: string): ParsedMemoryIssue[] {
  const q = norm(query).toLowerCase();
  if (!q) return [];
  const tokens = q.split(/[^a-z0-9]+/i).filter((t) => t.length > 1);
  return memories
    .map((memory) => {
      const hay = [
        memory.title,
        memory.detail,
        memory.kind ?? "",
        ...(memory.topics ?? []),
      ].join("\n").toLowerCase();
      let score = hay.includes(q) ? 10 : 0;
      for (const token of tokens) if (hay.includes(token)) score += 1;
      return { memory, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.memory.issueNumber - left.memory.issueNumber)
    .map((entry) => entry.memory);
}

function formatExistingMemory(memory: ParsedMemoryIssue): string {
  const parts = [`[${memory.memoryId}]`, memory.detail];
  if (memory.kind) parts.push(`kind=${memory.kind}`);
  if (memory.pinStartup) parts.push("pin=startup");
  if (memory.topics?.length) parts.push(`topics=${memory.topics.join(",")}`);
  return parts.join(" ");
}

function findUpdateCandidate(
  memories: ParsedMemoryIssue[],
  input: { sessionId?: string; detail: string; title: string; kind?: string; topics: string[]; memoryHash: string },
): ParsedMemoryIssue | undefined {
  const exact = memories.find((memory) => (memory.memoryHash || sha256(norm(memory.detail))) === input.memoryHash);
  if (exact) return exact;
  const desiredTitleKey = titleKey(input.title);
  const desiredSubjectKey = subjectKey(input.detail);
  const desiredKind = input.kind;
  const ranked = memories
    .map((memory) => {
      let score = 0;
      if (desiredTitleKey && titleKey(memory.title) === desiredTitleKey) score += 100;
      if (desiredSubjectKey && subjectKey(memory.detail) === desiredSubjectKey && kindsCompatible(memory.kind, desiredKind)) score += 80;
      if (input.sessionId && memory.sessionId && input.sessionId === memory.sessionId) score += 5;
      if (desiredKind && memory.kind === desiredKind) score += 5;
      score += overlapCount(memory.topics, input.topics) * 2;
      return { memory, score };
    })
    .filter((entry) => entry.score >= 80)
    .sort((left, right) => right.score - left.score || right.memory.issueNumber - left.memory.issueNumber);
  return ranked[0]?.memory;
}

function mergeMemory(
  existing: ParsedMemoryIssue,
  input: { sessionId?: string; date: string; detail: string; title: string; kind?: string; topics: string[]; pinStartup: boolean; memoryHash: string },
): {
  sessionId?: string;
  date: string;
  detail: string;
  title: string;
  kind?: string;
  topics: string[];
  pinStartup: boolean;
  memoryHash: string;
} {
  const kind = input.kind ?? existing.kind;
  const topics = mergeTopics(existing.topics, input.topics);
  return {
    ...(input.sessionId ?? existing.sessionId ? { sessionId: input.sessionId ?? existing.sessionId } : {}),
    date: input.date,
    detail: input.detail,
    title: input.title || existing.title,
    ...(kind ? { kind } : {}),
    topics,
    pinStartup: existing.pinStartup || input.pinStartup,
    memoryHash: input.memoryHash,
  };
}

function mergeTopics(existing: string[] | undefined, incoming: string[]): string[] {
  return normalizeTopicValues([...(existing ?? []), ...incoming]);
}

function kindsCompatible(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true;
  if (left === right) return true;
  if ((left === "skill" || left === "convention") && (right === "skill" || right === "convention")) return true;
  if (left === "core-fact" && right === "core-fact") return true;
  return false;
}

function titleKey(value: string | undefined): string | undefined {
  const base = normOrUndefined(value);
  if (!base) return undefined;
  const stripped = base.replace(/^memory:\s*/i, "").trim().toLowerCase();
  return stripped || undefined;
}

function subjectKey(value: string): string | undefined {
  const base = normOrUndefined(value);
  if (!base) return undefined;
  const first = base.split(/[：:。.!?\n]/, 1)[0]?.trim();
  return first ? first.toLowerCase() : undefined;
}

function overlapCount(left: string[] | undefined, right: string[] | undefined): number {
  if (!left?.length || !right?.length) return 0;
  const set = new Set(left.map((entry) => entry.toLowerCase()));
  let count = 0;
  for (const entry of right) if (set.has(entry.toLowerCase())) count++;
  return count;
}

function buildMemoryLabels(input: {
  sessionId?: string;
  date?: string;
  status: "active" | "stale";
  kind?: string;
  topics?: string[];
  pinStartup?: boolean;
}): string[] {
  const labels = new Set<string>(["type:memory"]);
  if (input.date?.trim()) labels.add(`date:${input.date.trim()}`);
  if (input.sessionId?.trim()) labels.add(`session:${input.sessionId.trim()}`);
  if (input.kind?.trim()) labels.add(`kind:${norm(input.kind)}`);
  for (const topic of normalizeTopicValues(input.topics)) labels.add(`topic:${topic}`);
  if (input.pinStartup) labels.add("pin:startup");
  if (input.status === "stale") {
    labels.add("status:stale");
    labels.add(LABEL_MEMORY_STALE);
  } else {
    labels.add("status:active");
    labels.add(LABEL_MEMORY_ACTIVE);
  }
  return [...labels];
}

function buildMemoryTitle(rawTitle: string | undefined, detail: string): string {
  const title = normOrUndefined(rawTitle);
  if (!title) return `${MEMORY_TITLE_PREFIX}${trunc(detail, 72)}`;
  return title.toLowerCase().startsWith(MEMORY_TITLE_PREFIX.toLowerCase()) ? title : `${MEMORY_TITLE_PREFIX}${title}`;
}

function resolveMemoryStatus(labels: string[]): "active" | "stale" {
  const lowered = labels.map((label) => label.toLowerCase());
  if (lowered.includes(LABEL_MEMORY_STALE.toLowerCase()) || lowered.includes("status:stale")) return "stale";
  return "active";
}

function byIssueNumberDesc(left: ParsedMemoryIssue, right: ParsedMemoryIssue): number {
  return right.issueNumber - left.issueNumber;
}

function clampLimit(value: number): number {
  return Math.min(20, Math.max(1, Math.floor(value)));
}

function norm(v: string): string { return v.replace(/\s+/g, " ").trim(); }
function normOrUndefined(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed || undefined;
}
function trunc(v: string, max: number): string { const s = norm(v); return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`; }

function truthy(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function normalizeTopicValues(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = normalizeTopicValue(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function normalizeTopicValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = norm(value);
  if (!trimmed) return undefined;
  const cleaned = trimmed.toLowerCase().startsWith("topic:") ? norm(trimmed.slice(6)) : trimmed;
  if (!cleaned) return undefined;
  // GitHub label names support spaces; just remove newlines and control chars.
  return cleaned.replace(/[\r\n\t]+/g, " ").trim() || undefined;
}

function normalizeKindValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = norm(value);
  if (!trimmed) return undefined;
  const withoutPrefix = trimmed.toLowerCase().startsWith("kind:") ? norm(trimmed.slice(5)) : trimmed;
  if (!withoutPrefix) return undefined;
  const cleaned = withoutPrefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return undefined;
  const aliases: Record<string, string> = {
    preference: "core-fact",
    preferences: "core-fact",
    profile: "core-fact",
    fact: "core-fact",
    rule: "convention",
    rules: "convention",
    policy: "convention",
    workflow: "skill",
    process: "skill",
    sop: "skill",
    procedure: "skill",
    playbook: "skill",
    runbook: "skill",
    troubleshooting: "skill",
  };
  return aliases[cleaned] ?? cleaned;
}

function coerceKindForContent(detail: string, kind: string | undefined): string | undefined {
  const text = detail.toLowerCase();
  const workflowLike = /流程|步骤|顺序|排查|sop|workflow|runbook|playbook|procedure|troubleshoot|1\)|1\.|①/.test(text);
  if (workflowLike && (!kind || kind === "convention" || kind === "skill")) return "skill";
  const preferenceLike = /偏好|喜欢|不喜欢|爱吃|口味|沟通风格|工作时间|作息|习惯|prefers|likes|dislikes|preference/.test(text);
  if (preferenceLike && (!kind || kind === "convention" || kind === "core-fact")) return "core-fact";
  return kind;
}

function parseDecision(raw: string): MemoryDecision {
  const tryParse = (source: string): MemoryDecision | null => {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      return {
        save: normalizeSaveEntries(parsed.save),
        stale: normalizeStringArray(parsed.stale),
      };
    } catch {
      const start = source.indexOf("{");
      const end = source.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>;
          return {
            save: normalizeSaveEntries(parsed.save),
            stale: normalizeStringArray(parsed.stale),
          };
        } catch {
          return null;
        }
      }
      return null;
    }
  };
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  const nested = fenced?.[1] ? tryParse(fenced[1].trim()) : null;
  if (nested) return nested;
  throw new Error("memory decision subagent returned invalid JSON");
}

function normalizeSaveEntries(value: unknown): MemorySaveInput[] {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  const out: MemorySaveInput[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const detail = norm(entry);
      if (detail) out.push({ detail });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const detail = typeof record.detail === "string" ? norm(record.detail) : "";
    if (!detail) continue;
    const kind = normalizeKindValue(typeof record.kind === "string" ? record.kind : undefined);
    const topics = normalizeTopicValues(normalizeStringArray(record.topics));
    const title = normOrUndefined(typeof record.title === "string" ? record.title : undefined);
    out.push({
      detail,
      ...(kind ? { kind } : {}),
      ...(topics.length > 0 ? { topics } : {}),
      ...(toBoolean(record.pinStartup) ? { pinStartup: true } : {}),
      ...(title ? { title } : {}),
    });
  }
  return out;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
