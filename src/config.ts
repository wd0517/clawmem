import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ClawMemPluginConfig } from "./types.js";

const DEFAULT_LABELS = ["source:openclaw"];
const DEFAULT_API_BASE_URL = "https://gh.pingkai.xyz";

export function resolvePluginConfig(api: OpenClawPluginApi): ClawMemPluginConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  return {
    baseUrl: normalizeApiBaseUrl(readTrimmedString(raw.baseUrl) ?? DEFAULT_API_BASE_URL),
    repo: readTrimmedString(raw.repo),
    token: readTrimmedString(raw.token),
    authScheme: readEnum(raw.authScheme, ["token", "bearer"], "token"),
    issueTitlePrefix: readTrimmedString(raw.issueTitlePrefix) ?? "Session: ",
    memoryTitlePrefix: readTrimmedString(raw.memoryTitlePrefix) ?? "Memory: ",
    defaultLabels: readStringArray(raw.defaultLabels, DEFAULT_LABELS),
    agentLabelPrefix: readTrimmedString(raw.agentLabelPrefix) ?? "agent:",
    activeStatusLabel: readTrimmedString(raw.activeStatusLabel) ?? "status:active",
    closedStatusLabel: readTrimmedString(raw.closedStatusLabel) ?? "status:closed",
    memoryActiveStatusLabel:
      readTrimmedString(raw.memoryActiveStatusLabel) ?? "memory-status:active",
    memoryStaleStatusLabel:
      readTrimmedString(raw.memoryStaleStatusLabel) ?? "memory-status:stale",
    autoCreateLabels: readBoolean(raw.autoCreateLabels, true),
    closeIssueOnReset: readBoolean(raw.closeIssueOnReset, true),
    turnCommentDelayMs: readNumber(raw.turnCommentDelayMs, 1000),
    summaryWaitTimeoutMs: clamp(readNumber(raw.summaryWaitTimeoutMs, 120000), 1000, 600000),
    memoryRecallLimit: clamp(readNumber(raw.memoryRecallLimit, 5), 1, 20),
    labelColor: normalizeHexColor(readTrimmedString(raw.labelColor) ?? "0e8a16"),
    maxExcerptChars: clamp(readNumber(raw.maxExcerptChars, 600), 120, 4000),
  };
}

export function isPluginConfigured(config: ClawMemPluginConfig): boolean {
  return Boolean(config.baseUrl && config.repo && config.token);
}

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v3")) {
    return trimmed;
  }
  return `${trimmed}/api/v3`;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : [...fallback];
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHexColor(value: string): string {
  return value.replace(/^#/, "").toLowerCase();
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
