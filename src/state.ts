import fs from "node:fs";
import path from "node:path";
import type { MemoryCandidate, PluginState, SessionDerivedState, SessionMirrorState, SessionTaskStatus } from "./types.js";
import { normalizeAgentId, sessionScopeKey } from "./utils.js";

const EMPTY_STATE: PluginState = {
  version: 4,
  sessions: {},
};

export function resolveStatePath(stateDir: string): string {
  return path.join(stateDir, "clawmem", "state.json");
}

export async function loadState(filePath: string): Promise<PluginState> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return sanitizeState(JSON.parse(raw));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return structuredClone(EMPTY_STATE);
    }
    return structuredClone(EMPTY_STATE);
  }
}

export async function saveState(filePath: string, state: PluginState): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const next = JSON.stringify(state, null, 2) + "\n";
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, next, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(tmpPath, filePath);
}

function sanitizeState(value: unknown): PluginState {
  if (!value || typeof value !== "object") {
    return structuredClone(EMPTY_STATE);
  }
  const raw = value as Record<string, unknown>;
  const sessions = raw.sessions && typeof raw.sessions === "object"
    ? (raw.sessions as Record<string, unknown>)
    : {};
  const migrations: Record<string, string> = {};
  if (raw.migrations && typeof raw.migrations === "object") {
    for (const [k, v] of Object.entries(raw.migrations as Record<string, unknown>)) {
      const s = readString(v);
      if (s) migrations[k] = s;
    }
  }
  const out: PluginState = {
    version: 4,
    sessions: {},
    ...(Object.keys(migrations).length > 0 ? { migrations } : {}),
  };
  for (const [storedKey, sessionValue] of Object.entries(sessions)) {
    if (!sessionValue || typeof sessionValue !== "object" || !storedKey.trim()) continue;
    const rawSession = sessionValue as Record<string, unknown>;
    const sessionId = readString(rawSession.sessionId) ?? storedKey.trim();
    if (!sessionId) continue;
    const agentId = normalizeAgentId(readString(rawSession.agentId));
    const lastMirroredCount = readNumber(rawSession.lastMirroredCount) ?? 0;
    const finalizedAt = readString(rawSession.finalizedAt);
    const derived = sanitizeDerivedState(rawSession, lastMirroredCount, finalizedAt);
    out.sessions[sessionScopeKey(sessionId, agentId)] = {
      sessionId,
      sessionKey: readString(rawSession.sessionKey),
      sessionFile: readString(rawSession.sessionFile),
      agentId,
      issueNumber: readNumber(rawSession.issueNumber),
      issueTitle: readString(rawSession.issueTitle),
      titleSource: readTitleSource(rawSession.titleSource),
      lastMirroredCount,
      turnCount: readNumber(rawSession.turnCount) ?? 0,
      finalizedAt,
      lastSummaryHash: readString(rawSession.lastSummaryHash),
      derived,
      createdAt: readString(rawSession.createdAt),
      updatedAt: readString(rawSession.updatedAt),
    };
  }
  return out;
}

function sanitizeDerivedState(
  rawSession: Record<string, unknown>,
  lastMirroredCount: number,
  finalizedAt?: string,
): SessionDerivedState {
  const rawDerived = asRecord(rawSession.derived);
  const rawSummary = asRecord(rawDerived?.summary);
  const rawMemory = asRecord(rawDerived?.memory);
  const legacySummaryStatus = readEnum(rawSession.summaryStatus, ["pending", "complete"]);
  const legacyMemoryCursor = readNumber(rawSession.lastMemorySyncCount);

  const summaryText = readString(rawSummary?.text);
  const summaryTitle = readString(rawSummary?.title);
  const summaryStatus = readTaskStatus(
    rawSummary?.status,
    summaryText || legacySummaryStatus === "complete" ? "complete" : "idle",
  );
  const summaryCursor = clampCursor(
    readNumber(rawSummary?.basedOnCursor),
    summaryStatus === "complete" ? lastMirroredCount : 0,
    lastMirroredCount,
  );

  const capturedCursor = clampCursor(
    readNumber(rawMemory?.capturedCursor)
      ?? readNumber(rawMemory?.appliedCursor)
      ?? legacyMemoryCursor,
    summaryStatus === "complete" ? lastMirroredCount : 0,
    lastMirroredCount,
  );
  const memoryStatus = readTaskStatus(
    rawMemory?.status ?? rawMemory?.extractStatus ?? rawMemory?.reconcileStatus,
    capturedCursor >= lastMirroredCount && lastMirroredCount > 0 ? "complete" : "idle",
  );
  const candidates = readMemoryCandidates(rawMemory?.candidates);

  return {
    summary: {
      basedOnCursor: summaryCursor,
      status: finalizedAt && summaryStatus === "idle" && lastMirroredCount > 0 ? "error" : summaryStatus,
      ...(summaryText ? { text: summaryText } : {}),
      ...(summaryTitle ? { title: summaryTitle } : {}),
      ...(readString(rawSummary?.lastError) ? { lastError: readString(rawSummary?.lastError) } : {}),
      ...(readString(rawSummary?.updatedAt) ? { updatedAt: readString(rawSummary?.updatedAt) } : {}),
    },
    memory: {
      capturedCursor,
      status: memoryStatus,
      ...(candidates ? { candidates } : {}),
      ...(readString(rawMemory?.lastError) ? { lastError: readString(rawMemory?.lastError) } : {}),
      ...(readString(rawMemory?.updatedAt) ? { updatedAt: readString(rawMemory?.updatedAt) } : {}),
    },
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readEnum<T extends string>(value: unknown, allowed: T[]): T | undefined {
  const s = readString(value);
  return s && (allowed as string[]).includes(s) ? (s as T) : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function readTaskStatus(value: unknown, fallback: SessionTaskStatus): SessionTaskStatus {
  const status = readEnum(value, ["idle", "pending", "running", "complete", "error"]);
  if (!status) return fallback;
  if (status === "pending" || status === "running") return "idle";
  return status;
}

function readTitleSource(value: unknown): "placeholder" | "llm" | undefined {
  const source = readEnum(value, ["placeholder", "digest", "llm"]);
  if (!source) return undefined;
  return source === "digest" ? "llm" : source;
}

function readMemoryCandidates(value: unknown): MemoryCandidate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry) => sanitizeMemoryCandidate(entry))
    .filter((candidate): candidate is MemoryCandidate => candidate !== null);
  return out;
}

function sanitizeMemoryCandidate(value: unknown): MemoryCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidateId = readString(record.candidateId);
  const detail = readString(record.detail);
  if (!candidateId || !detail) return null;
  const title = readString(record.title);
  const kind = readString(record.kind);
  const topics = Array.isArray(record.topics)
    ? record.topics.map((topic) => readString(topic)).filter((topic): topic is string => Boolean(topic))
    : undefined;
  const evidence = readString(record.evidence);
  return {
    candidateId,
    detail,
    ...(title ? { title } : {}),
    ...(kind ? { kind } : {}),
    ...(topics && topics.length > 0 ? { topics } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function clampCursor(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.min(max, Math.max(0, fallback));
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
