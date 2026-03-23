// Memory CRUD, sha256 dedup, and AI-driven memory extraction.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { LABEL_MEMORY_ACTIVE, LABEL_MEMORY_STALE, MEMORY_TITLE_PREFIX, extractLabelNames, labelVal } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import { normalizeMessages } from "./transcript.js";
import type { ClawMemPluginConfig, NormalizedMessage, ParsedMemoryIssue, SessionMirrorState, TranscriptSnapshot } from "./types.js";
import { fmtTranscript, localDate, sha256, subKey } from "./utils.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";

type MemoryDecision = { save: string[]; stale: string[] };
type SearchIndex = { title: string; detail: string; topics: string[] };

export class MemoryStore {
  constructor(private readonly client: GitHubIssueClient, private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  async search(query: string, limit: number): Promise<ParsedMemoryIssue[]> {
    const memories = await this.list("active");
    const q = normalizeSearch(query);
    if (!q) return [];
    return memories
      .map((m) => ({ m, score: scoreMemoryMatch(m, q) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || b.m.issueNumber - a.m.issueNumber)
      .slice(0, limit)
      .map((e) => e.m);
  }

  async store(detail: string, sessionId = "manual"): Promise<{ created: boolean; memory: ParsedMemoryIssue }> {
    const normalized = norm(detail);
    if (!normalized) throw new Error("memory detail is empty");
    const allActive = await this.list("active");
    const hash = sha256(normalized);
    const existing = allActive.find((m) => (m.memoryHash || sha256(norm(m.detail))) === hash);
    if (existing) return { created: false, memory: existing };

    const date = localDate();
    const labels = memLabels(sessionId, date, "active");
    const title = `${MEMORY_TITLE_PREFIX}${trunc(normalized, 72)}`;
    const body = stringifyFlatYaml([["memory_hash", hash], ["detail", normalized]]);
    await this.client.ensureLabels(labels);
    const issue = await this.client.createIssue({ title, body, labels });
    return {
      created: true,
      memory: {
        issueNumber: issue.number,
        title,
        memoryId: String(issue.number),
        memoryHash: hash,
        sessionId,
        date,
        detail: normalized,
        status: "active",
      },
    };
  }

  async forget(memoryId: string): Promise<ParsedMemoryIssue | null> {
    const id = memoryId.trim();
    if (!id) throw new Error("memoryId is empty");
    const mem = (await this.list("active")).find((m) => m.memoryId === id || String(m.issueNumber) === id);
    if (!mem) return null;
    await this.client.ensureLabels([LABEL_MEMORY_STALE]);
    await this.client.syncManagedLabels(mem.issueNumber, memLabels(mem.sessionId, mem.date, "stale"));
    return { ...mem, status: "stale" };
  }

  async syncFromConversation(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<boolean> {
    try {
      const decision = await this.generateDecision(session, snapshot);
      const { savedCount, staledCount } = await this.applyDecision(session.sessionId, decision);
      if (savedCount > 0 || staledCount > 0)
        this.api.logger.info?.(`clawmem: synced memories for ${session.sessionId} (saved=${savedCount}, stale=${staledCount})`);
      return true;
    } catch (error) {
      this.api.logger.warn(`clawmem: memory capture failed: ${String(error)}`);
      return false;
    }
  }

  private async list(status: "active" | "stale" | "all"): Promise<ParsedMemoryIssue[]> {
    const labels = ["type:memory"];
    if (status === "active") labels.push(LABEL_MEMORY_ACTIVE);
    else if (status === "stale") labels.push(LABEL_MEMORY_STALE);
    const out: ParsedMemoryIssue[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.client.listIssues({ labels, state: "all", page, perPage: 100 });
      for (const issue of batch) { const p = this.parseIssue(issue); if (p) out.push(p); }
      if (batch.length < 100) break;
    }
    return out;
  }

  private parseIssue(issue: { number: number; title?: string; body?: string; labels?: Array<{ name?: string } | string> }): ParsedMemoryIssue | null {
    const labels = extractLabelNames(issue.labels);
    if (!labels.includes("type:memory")) return null;
    const sessionId = labelVal(labels, "session:"), date = labelVal(labels, "date:");
    const topics = labels.filter((l) => l.startsWith("topic:")).map((l) => l.slice(6).trim()).filter(Boolean);
    const rawBody = (issue.body ?? "").trim();
    const body = rawBody ? parseFlatYaml(rawBody) : {};
    const detail = body.detail?.trim() || rawBody;
    if (!sessionId || !date || !detail) return null;
    return {
      issueNumber: issue.number, title: issue.title?.trim() || "",
      memoryId: body.memory_id?.trim() || String(issue.number),
      memoryHash: body.memory_hash?.trim() || undefined,
      sessionId, date, detail,
      ...(topics.length > 0 ? { topics } : {}),
      status: labels.includes(LABEL_MEMORY_STALE) ? "stale" : "active",
    };
  }

  private async applyDecision(sessionId: string, decision: MemoryDecision): Promise<{ savedCount: number; staledCount: number }> {
    const allActive = await this.list("active");
    const activeById = new Map(allActive.map((m) => [m.memoryId, m]));
    const existingHashes = new Set(allActive.map((m) => m.memoryHash || sha256(norm(m.detail))));
    let savedCount = 0;
    for (const raw of decision.save) {
      const detail = norm(raw);
      if (!detail) continue;
      const hash = sha256(detail);
      if (existingHashes.has(hash)) continue;
      const date = localDate(), labels = memLabels(sessionId, date, "active");
      const title = `${MEMORY_TITLE_PREFIX}${trunc(detail, 72)}`;
      const body = stringifyFlatYaml([["memory_hash", hash], ["detail", detail]]);
      await this.client.ensureLabels(labels);
      await this.client.createIssue({ title, body, labels });
      existingHashes.add(hash);
      savedCount++;
    }
    let staledCount = 0;
    for (const id of [...new Set(decision.stale.map((s) => s.trim()).filter(Boolean))]) {
      const mem = activeById.get(id);
      if (!mem) continue;
      await this.client.ensureLabels([LABEL_MEMORY_STALE]);
      await this.client.syncManagedLabels(mem.issueNumber, memLabels(mem.sessionId, mem.date, "stale"));
      staledCount++;
    }
    return { savedCount, staledCount };
  }

  private async generateDecision(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<MemoryDecision> {
    if (snapshot.messages.length === 0) return { save: [], stale: [] };
    const recent = (await this.list("active")).sort((a, b) => b.issueNumber - a.issueNumber).slice(0, 20);
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
}

function memLabels(sessionId: string, date: string, status: "active" | "stale"): string[] {
  return ["type:memory", `session:${sessionId}`, `date:${date}`, status === "active" ? LABEL_MEMORY_ACTIVE : LABEL_MEMORY_STALE];
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
export function scoreMemoryMatch(memory: ParsedMemoryIssue, rawQuery: string): number {
  const query = normalizeSearch(rawQuery);
  if (!query) return 0;
  const idx = buildSearchIndex(memory);
  const tokens = searchTokens(query);
  const queryTokenSet = new Set(tokens);
  const titleTokenSet = new Set(searchTokens(idx.title));
  const detailTokenSet = new Set(searchTokens(idx.detail));
  const topicTokenSet = new Set(idx.topics.flatMap(searchTokens));
  let score = 0;

  if (idx.title.includes(query)) score += 18;
  if (idx.detail.includes(query)) score += 12;
  for (const topic of idx.topics) if (topic.includes(query)) score += 10;

  for (const token of tokens) {
    if (idx.title.includes(token)) score += 4;
    if (idx.detail.includes(token)) score += 2;
    if (idx.topics.some((topic) => topic.includes(token))) score += 3;
  }

  score += overlapRatio(queryTokenSet, titleTokenSet) * 10;
  score += overlapRatio(queryTokenSet, detailTokenSet) * 6;
  score += overlapRatio(queryTokenSet, topicTokenSet) * 8;

  const queryBigrams = charBigrams(query);
  score += overlapRatio(queryBigrams, charBigrams(idx.title)) * 6;
  score += overlapRatio(queryBigrams, charBigrams(idx.detail)) * 3;

  return score;
}
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
