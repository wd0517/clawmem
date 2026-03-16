// Memory CRUD, sha256 dedup, and AI-driven memory extraction.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { LABEL_MEMORY_ACTIVE, LABEL_MEMORY_STALE, MEMORY_TITLE_PREFIX, extractLabelNames, labelVal } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import { normalizeMessages } from "./transcript.js";
import type { ClawMemPluginConfig, NormalizedMessage, ParsedMemoryIssue, SessionMirrorState, TranscriptSnapshot } from "./types.js";
import { fmtTranscript, localDate, sha256, subKey } from "./utils.js";
import { parseFlatYaml, stringifyFlatYaml } from "./yaml.js";

type MemoryDecision = { save: string[]; stale: string[] };

export class MemoryStore {
  constructor(private readonly client: GitHubIssueClient, private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  async search(query: string, limit: number): Promise<ParsedMemoryIssue[]> {
    const memories = await this.list("active");
    const q = query.trim().toLowerCase();
    const tokens = q.split(/[^a-z0-9]+/i).filter((t) => t.length > 1);
    return memories
      .map((m) => {
        const hay = `${m.title}\n${m.detail}`.toLowerCase();
        let score = hay.includes(q) ? 10 : 0;
        for (const t of tokens) if (hay.includes(t)) score += 1;
        return { m, score };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || b.m.issueNumber - a.m.issueNumber)
      .slice(0, limit)
      .map((e) => e.m);
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
