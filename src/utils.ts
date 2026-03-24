// Shared utility helpers used by memory.ts and conversation.ts.
import crypto from "node:crypto";
import path from "node:path";
import type { NormalizedMessage } from "./types.js";

export const DEFAULT_AGENT_ID = "main";

export function sha256(v: string): string { return crypto.createHash("sha256").update(v).digest("hex"); }

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return DEFAULT_AGENT_ID;
  return trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || DEFAULT_AGENT_ID;
}

export function sessionScopeKey(sessionId: string, agentId?: string): string {
  return `${normalizeAgentId(agentId)}:${sessionId.trim()}`;
}

export function inferAgentIdFromTranscriptPath(filePath: string): string | undefined {
  const parts = path.resolve(filePath).split(path.sep);
  const idx = parts.lastIndexOf("agents");
  if (idx < 0 || !parts[idx + 1] || parts[idx + 2] !== "sessions") return undefined;
  return normalizeAgentId(parts[idx + 1]);
}

export function subKey(s: { sessionId: string; agentId?: string }, suffix: string): string {
  const san = (v: string) => v.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "main";
  return `agent:${san(s.agentId || "main")}:subagent:clawmem-${suffix}-${san(s.sessionId)}`;
}

export function fmtTranscript(msgs: NormalizedMessage[]): string {
  return msgs.map((m, i) => `${i + 1}. ${m.role === "assistant" ? "assistant" : "user"}: ${m.text}`).join("\n\n");
}

export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function localDateTime(d: Date): string {
  return `${localDate(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
