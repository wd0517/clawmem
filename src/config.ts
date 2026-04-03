// Hardcoded label/prefix constants and plugin config resolution.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ClawMemAgentConfig, ClawMemPluginConfig, ClawMemResolvedRoute } from "./types.js";
import { normalizeAgentId } from "./utils.js";

export const SESSION_TITLE_PREFIX = "Session: ";
export const MEMORY_TITLE_PREFIX = "Memory: ";
export const DEFAULT_LABELS: readonly string[] = [];
export const AGENT_LABEL_PREFIX = "agent:";
export const LABEL_ACTIVE = "status:active";
export const LABEL_CLOSED = "status:closed";
export const LABEL_MEMORY_ACTIVE = "memory-status:active";
export const LABEL_MEMORY_STALE = "memory-status:stale";

const MANAGED_PREFIXES = ["type:", "kind:", "session:", "date:", "topic:", "agent:"];
const MANAGED_EXACT = new Set([LABEL_ACTIVE, LABEL_CLOSED, LABEL_MEMORY_ACTIVE, LABEL_MEMORY_STALE]);

export function resolvePluginConfig(api: OpenClawPluginApi): ClawMemPluginConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
  const num = (v: unknown, d: number) => typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : d;
  const float = (v: unknown, d: number) => typeof v === "number" && Number.isFinite(v) ? v : d;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const baseUrl = (str(raw.baseUrl) ?? "https://git.clawmem.ai").replace(/\/+$/, "");
  const rawAgents = raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents)
    ? (raw.agents as Record<string, unknown>)
    : {};
  const agents: Record<string, ClawMemAgentConfig> = {};
  for (const [rawAgentId, rawAgentConfig] of Object.entries(rawAgents)) {
    if (!rawAgentConfig || typeof rawAgentConfig !== "object" || Array.isArray(rawAgentConfig)) continue;
    const agentId = normalizeAgentId(rawAgentId);
    const agent = rawAgentConfig as Record<string, unknown>;
    agents[agentId] = {
      baseUrl: str(agent.baseUrl)?.replace(/\/+$/, ""),
      defaultRepo: normalizeRepoName(str(agent.defaultRepo) ?? str(agent.repo)),
      repo: str(agent.repo),
      token: str(agent.token),
      authScheme: agent.authScheme === "bearer" ? "bearer" : agent.authScheme === "token" ? "token" : undefined,
    };
  }
  return {
    baseUrl: baseUrl.endsWith("/api/v3") ? baseUrl : `${baseUrl}/api/v3`,
    defaultRepo: normalizeRepoName(str(raw.defaultRepo) ?? str(raw.repo)),
    repo: normalizeRepoName(str(raw.repo)),
    token: str(raw.token),
    authScheme: raw.authScheme === "bearer" ? "bearer" : "token",
    agents,
    memoryRecallLimit: clamp(num(raw.memoryRecallLimit, 5), 1, 20),
    memoryAutoRecallLimit: clamp(num(raw.memoryAutoRecallLimit, 3), 1, 20),
    turnCommentDelayMs: num(raw.turnCommentDelayMs, 1000),
    digestWaitTimeoutMs: clamp(num(raw.digestWaitTimeoutMs, 30000), 1000, 600000),
    summaryWaitTimeoutMs: clamp(num(raw.summaryWaitTimeoutMs, 120000), 1000, 600000),
    memoryExtractWaitTimeoutMs: clamp(num(raw.memoryExtractWaitTimeoutMs, 45000), 1000, 600000),
    memoryReconcileWaitTimeoutMs: clamp(num(raw.memoryReconcileWaitTimeoutMs, 45000), 1000, 600000),
  };
}

export function resolveAgentRoute(config: ClawMemPluginConfig, agentId?: string, repoOverride?: string): ClawMemResolvedRoute {
  const id = normalizeAgentId(agentId);
  const agent = config.agents[id] ?? {};
  const baseUrl = (agent.baseUrl ?? config.baseUrl).replace(/\/+$/, "");
  const defaultRepo = normalizeRepoName(agent.defaultRepo ?? agent.repo) ?? config.defaultRepo ?? normalizeRepoName(config.repo);
  const repo = normalizeRepoName(repoOverride) ?? defaultRepo;
  return {
    agentId: id,
    baseUrl: baseUrl.endsWith("/api/v3") ? baseUrl : `${baseUrl}/api/v3`,
    ...(defaultRepo ? { defaultRepo } : {}),
    ...(repo ? { repo } : {}),
    token: agent.token?.trim() || config.token?.trim() || undefined,
    authScheme: agent.authScheme === "bearer" ? "bearer" : agent.authScheme === "token" ? "token" : config.authScheme,
  };
}

export function isAgentConfigured(route: ClawMemResolvedRoute): boolean {
  return Boolean(route.baseUrl && route.token);
}

export function hasDefaultRepo(route: ClawMemResolvedRoute): boolean {
  return Boolean(route.defaultRepo);
}

export function resolveLabelColor(label: string): string {
  if (label.startsWith("status:")) return "b60205";
  if (label.startsWith("memory-status:")) return label.endsWith(":stale") ? "d93f0b" : "0e8a16";
  if (label.startsWith("type:")) return label === "type:memory" ? "5319e7" : "1d76db";
  if (label.startsWith("kind:")) return "5319e7";
  if (label.startsWith("date:")) return "c5def5";
  if (label.startsWith("topic:")) return "fbca04";
  if (label.startsWith("session:")) return "bfdadc";
  if (label.startsWith("agent:")) return "1d76db";
  return "0e8a16";
}

export function labelDescription(label: string): string {
  for (const [pfx, d] of [["type:", "Issue type"], ["kind:", "Memory kind"], ["memory-status:", "Memory lifecycle status"],
    ["status:", "Conversation lifecycle status"], ["session:", "Session association"],
    ["date:", "Date"], ["topic:", "Topic"], ["agent:", "Agent"]] as const)
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

function normalizeRepoName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : undefined;
}
