// Hardcoded label/prefix constants and plugin config resolution.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ClawMemPluginConfig } from "./types.js";

export const SESSION_TITLE_PREFIX = "Session: ";
export const MEMORY_TITLE_PREFIX = "Memory: ";
export const DEFAULT_LABELS: readonly string[] = ["source:openclaw"];
export const AGENT_LABEL_PREFIX = "agent:";
export const LABEL_ACTIVE = "status:active";
export const LABEL_CLOSED = "status:closed";
export const LABEL_MEMORY_ACTIVE = "memory-status:active";
export const LABEL_MEMORY_STALE = "memory-status:stale";

const MANAGED_PREFIXES = ["type:", "session:", "date:", "topic:", "agent:", "source:"];
const MANAGED_EXACT = new Set([LABEL_ACTIVE, LABEL_CLOSED, LABEL_MEMORY_ACTIVE, LABEL_MEMORY_STALE]);

export function resolvePluginConfig(api: OpenClawPluginApi): ClawMemPluginConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
  const num = (v: unknown, d: number) => typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : d;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const baseUrl = (str(raw.baseUrl) ?? "https://git.staging.clawmem.ai").replace(/\/+$/, "");
  return {
    baseUrl: baseUrl.endsWith("/api/v3") ? baseUrl : `${baseUrl}/api/v3`,
    repo: str(raw.repo), token: str(raw.token),
    authScheme: raw.authScheme === "bearer" ? "bearer" : "token",
    memoryRecallLimit: clamp(num(raw.memoryRecallLimit, 5), 1, 20),
    turnCommentDelayMs: num(raw.turnCommentDelayMs, 1000),
    summaryWaitTimeoutMs: clamp(num(raw.summaryWaitTimeoutMs, 120000), 1000, 600000),
  };
}

export function isPluginConfigured(config: ClawMemPluginConfig): boolean {
  return Boolean(config.baseUrl && config.repo && config.token);
}

export function resolveLabelColor(label: string): string {
  if (label.startsWith("status:")) return "b60205";
  if (label.startsWith("memory-status:")) return label.endsWith(":stale") ? "d93f0b" : "0e8a16";
  if (label.startsWith("type:")) return label === "type:memory" ? "5319e7" : "1d76db";
  if (label.startsWith("date:")) return "c5def5";
  if (label.startsWith("topic:")) return "fbca04";
  if (label.startsWith("session:")) return "bfdadc";
  if (label.startsWith("agent:")) return "1d76db";
  if (label.startsWith("source:")) return "0e8a16";
  return "0e8a16";
}

export function labelDescription(label: string): string {
  for (const [pfx, d] of [["type:", "Issue type"], ["memory-status:", "Memory lifecycle status"],
    ["status:", "Conversation lifecycle status"], ["session:", "Session association"],
    ["date:", "Date"], ["topic:", "Topic"], ["agent:", "Agent"], ["source:", "Source"]] as const)
    if (label.startsWith(pfx)) return `${d} label managed by clawmem.`;
  return "Label managed by clawmem.";
}

export function isManagedLabel(label: string): boolean {
  return DEFAULT_LABELS.includes(label) || MANAGED_EXACT.has(label) || MANAGED_PREFIXES.some((p) => label.startsWith(p));
}

export function extractLabelNames(labels: Array<{ name?: string } | string> | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((e) => (typeof e === "string" ? e : e?.name ?? "").trim()).filter(Boolean);
}

export function labelVal(labels: string[], prefix: string): string | undefined {
  const m = labels.find((l) => l.startsWith(prefix));
  return m ? m.slice(prefix.length).trim() || undefined : undefined;
}
