// Session mirroring: creates/updates GitHub issues and comments for each conversation.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { AGENT_LABEL_PREFIX, DEFAULT_LABELS, LABEL_ACTIVE, LABEL_CLOSED, SESSION_TITLE_PREFIX, extractLabelNames } from "./config.js";
import type { GitHubIssueClient } from "./github-client.js";
import { normalizeMessages, readTranscriptSnapshot } from "./transcript.js";
import type { ClawMemPluginConfig, NormalizedMessage, SessionMirrorState, TranscriptSnapshot } from "./types.js";
import { fmtTranscript, localDate, localDateTime, sha256, subKey } from "./utils.js";
import { stringifyFlatYaml } from "./yaml.js";

export class ConversationMirror {
  constructor(private readonly client: GitHubIssueClient, private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  shouldMirror(sessionId: string, messages: NormalizedMessage[]): boolean {
    if (sessionId.startsWith("slug-generator-")) return false;
    const first = messages.find((m) => m.role === "user")?.text ?? "";
    if (first.includes("generate a short 1-2 word filename slug") && first.includes("Reply with ONLY the slug")) return false;
    if (first.includes("Summarize the following conversation.") && first.includes('Return valid JSON only in the form {"summary":"..."}')) return false;
    if (first.includes("Extract durable memories from the conversation below.") && first.includes('Return JSON only in the form {"save":')) return false;
    return true;
  }

  async loadSnapshot(session: SessionMirrorState, fallback: unknown[]): Promise<TranscriptSnapshot> {
    const filePath = await this.resolveTranscriptPath(session.sessionFile);
    if (filePath) {
      session.sessionFile = filePath;
      try {
        const t = await readTranscriptSnapshot(filePath);
        return { sessionId: t.sessionId ?? session.sessionId, messages: t.messages };
      } catch (error) {
        this.api.logger.warn(`clawmem: transcript read failed for ${filePath}: ${String(error)}`);
      }
    }
    return { sessionId: session.sessionId, messages: normalizeMessages(fallback) };
  }

  async ensureIssue(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<void> {
    if (session.issueNumber) {
      const existing = await this.lookupBoundIssue(session);
      if (existing && this.isBoundIssue(session, existing)) {
        session.issueTitle = existing.title?.trim() || session.issueTitle;
        return;
      }
      this.api.logger.warn(
        `clawmem: issue binding for ${session.sessionId} is stale or mismatched (${session.issueNumber}); recreating`,
      );
      this.resetIssueBinding(session);
    }
    const title = `${SESSION_TITLE_PREFIX}${session.sessionId}`;
    const labels = this.buildLabels(session, snapshot, false);
    const body = this.renderBody(session, snapshot, "pending", false);
    await this.client.ensureLabels(labels);
    const issue = await this.client.createIssue({ title, body, labels });
    session.issueNumber = issue.number;
    session.issueTitle = issue.title ?? title;
    session.lastSummaryHash = sha256(`${title}\n${body}\nopen`);
    session.createdAt = new Date().toISOString();
    session.updatedAt = session.createdAt;
  }

  async syncBody(session: SessionMirrorState, snapshot: TranscriptSnapshot, summary: string, closed: boolean): Promise<void> {
    if (!session.issueNumber) return;
    const title = `${SESSION_TITLE_PREFIX}${session.sessionId}`;
    const body = this.renderBody(session, snapshot, summary, closed);
    const hash = sha256(`${title}\n${body}\n${closed ? "closed" : "open"}`);
    if (hash === session.lastSummaryHash) return;
    await this.client.updateIssue(session.issueNumber, { title, body, ...(closed ? { state: "closed" as const } : {}) });
    session.issueTitle = title;
    session.lastSummaryHash = hash;
  }

  async syncLabels(session: SessionMirrorState, snapshot: TranscriptSnapshot, closed: boolean): Promise<void> {
    if (!session.issueNumber) return;
    const labels = this.buildLabels(session, snapshot, closed);
    await this.client.ensureLabels(labels);
    await this.client.syncManagedLabels(session.issueNumber, labels);
  }

  async appendComments(issueNumber: number, messages: NormalizedMessage[]): Promise<number> {
    let count = 0;
    for (const msg of messages) {
      try { await this.client.createComment(issueNumber, `role: ${msg.role}\n\n${msg.text.trim()}`); count++; }
      catch (error) { this.api.logger.warn(`clawmem: conversation comment failed: ${String(error)}`); break; }
    }
    return count;
  }

  async generateSummary(session: SessionMirrorState, snapshot: TranscriptSnapshot): Promise<string> {
    if (snapshot.messages.length === 0) throw new Error("no conversation messages to summarize");
    const subagent = this.api.runtime.subagent;
    const sessionKey = subKey(session, "summary");
    const message = [
      "Summarize the following conversation.",
      'Return valid JSON only in the form {"summary":"..."}',
      "The summary should be concise, factual, and written in 2-4 sentences.",
      "Do not include markdown, bullet points, or analysis.",
      "", "<conversation>", fmtTranscript(snapshot.messages), "</conversation>",
    ].join("\n");
    try {
      const run = await subagent.run({
        sessionKey, message, deliver: false, lane: "clawmem-summary",
        idempotencyKey: sha256(`${session.sessionId}:${snapshot.messages.length}:summary`),
        extraSystemPrompt: "You summarize OpenClaw conversations. Output JSON only with one string field named summary.",
      });
      const wait = await subagent.waitForRun({ runId: run.runId, timeoutMs: this.config.summaryWaitTimeoutMs });
      if (wait.status === "timeout") throw new Error("summary subagent timed out");
      if (wait.status === "error") throw new Error(wait.error || "summary subagent failed");
      const msgs = normalizeMessages((await subagent.getSessionMessages({ sessionKey, limit: 50 })).messages);
      const text = [...msgs].reverse().find((e) => e.role === "assistant" && e.text.trim())?.text;
      if (!text) throw new Error("summary subagent returned no assistant text");
      return parseSummary(text);
    } finally { subagent.deleteSession({ sessionKey, deleteTranscript: true }).catch(() => {}); }
  }

  private buildLabels(session: SessionMirrorState, snapshot: TranscriptSnapshot, closed: boolean): string[] {
    const dates = this.resolveDates(session, snapshot.messages);
    const labels = new Set([...DEFAULT_LABELS, "type:conversation", `session:${session.sessionId}`, `date:${dates.date}`]);
    if (session.agentId) labels.add(`${AGENT_LABEL_PREFIX}${session.agentId}`);
    labels.add(closed ? LABEL_CLOSED : LABEL_ACTIVE);
    return [...labels].filter((l) => l.trim().length > 0);
  }

  private renderBody(session: SessionMirrorState, snapshot: TranscriptSnapshot, summary: string, closed: boolean): string {
    const dates = this.resolveDates(session, snapshot.messages);
    return stringifyFlatYaml([
      ["type", "conversation"], ["session_id", session.sessionId], ["date", dates.date],
      ["start_at", dates.startAt], ["end_at", dates.endAt],
      ["status", closed ? "closed" : "active"], ["summary", summary],
    ]);
  }

  private resolveDates(session: SessionMirrorState, messages: NormalizedMessage[]): { date: string; startAt: string; endAt: string } {
    const ts = messages.map((m) => m.timestamp).filter((v): v is string => Boolean(v?.trim()))
      .map((v) => new Date(v)).filter((d) => Number.isFinite(d.getTime()));
    const fallbackStart = session.createdAt ? new Date(session.createdAt) : new Date();
    const fallbackEnd = session.updatedAt ? new Date(session.updatedAt) : fallbackStart;
    const start = ts[0] ?? fallbackStart, end = ts.at(-1) ?? fallbackEnd;
    return { date: localDate(start), startAt: localDateTime(start), endAt: localDateTime(end) };
  }

  private async resolveTranscriptPath(filePath: string | undefined): Promise<string | null> {
    if (!filePath) return null;
    if (await fexists(filePath)) return filePath;
    try {
      const dir = path.dirname(filePath), prefix = `${path.basename(filePath)}.reset.`;
      const latest = (await fs.promises.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.startsWith(prefix)).map((e) => e.name).sort().at(-1);
      if (latest) {
        this.api.logger.info?.(`clawmem: using reset transcript ${path.join(dir, latest)} because ${filePath} is missing`);
        return path.join(dir, latest);
      }
    } catch { /* directory unreadable */ }
    return null;
  }

  private async lookupBoundIssue(session: SessionMirrorState): Promise<{ number: number; title?: string; labels?: Array<{ name?: string } | string> } | null> {
    if (!session.issueNumber) return null;
    try {
      return await this.client.getIssue(session.issueNumber);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  private isBoundIssue(session: SessionMirrorState, issue: { title?: string; labels?: Array<{ name?: string } | string> }): boolean {
    const labels = extractLabelNames(issue.labels);
    return labels.includes("type:conversation") && labels.includes(`session:${session.sessionId}`);
  }

  private resetIssueBinding(session: SessionMirrorState): void {
    session.issueNumber = undefined;
    session.issueTitle = undefined;
    session.lastSummaryHash = undefined;
    session.lastMirroredCount = 0;
    session.turnCount = 0;
    session.finalizedAt = undefined;
  }
}

async function fexists(p: string): Promise<boolean> { try { return (await fs.promises.stat(p)).isFile(); } catch { return false; } }
function isNotFoundError(error: unknown): boolean {
  const text = String(error);
  return text.includes("HTTP 404");
}
function parseSummary(raw: string): string {
  const tryParse = (s: string): string | null => {
    try { const p = JSON.parse(s) as { summary?: unknown }; return typeof p?.summary === "string" && p.summary.trim() ? p.summary.trim() : null; }
    catch { const i = s.indexOf("{"), j = s.lastIndexOf("}");
      if (i >= 0 && j > i) { try { const p = JSON.parse(s.slice(i, j + 1)) as { summary?: unknown }; return typeof p?.summary === "string" && p.summary.trim() ? p.summary.trim() : null; } catch { return null; } }
      return null;
    }
  };
  const t = raw.trim();
  const direct = tryParse(t); if (direct) return direct;
  const f = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
  if (f?.[1]) { const nested = tryParse(f[1].trim()); if (nested) return nested; }
  return t;
}
