import fs from "node:fs";
import path from "node:path";
import type { MemoryCandidate, PluginState, SessionDerivedState, SessionMirrorState, SessionTaskStatus } from "./types.js";
import { normalizeAgentId, sessionScopeKey } from "./utils.js";

const EMPTY_STATE: PluginState = {
  version: 3,
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
  const sessions =
    raw.sessions && typeof raw.sessions === "object"
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
    version: 3,
    sessions: {},
    ...(Object.keys(migrations).length > 0 ? { migrations } : {}),
  };
  for (const [storedKey, sessionValue] of Object.entries(sessions)) {
    if (!sessionValue || typeof sessionValue !== "object" || !storedKey.trim()) {
      continue;
    }
    const rawSession = sessionValue as Record<string, unknown>;
    const sessionId = readString(rawSession.sessionId) ?? storedKey.trim();
    if (!sessionId) {
      continue;
    }
    const agentId = normalizeAgentId(readString(rawSession.agentId));
    const lastMirroredCount = readNumber(rawSession.lastMirroredCount) ?? 0;
    const finalizedAt = readString(rawSession.finalizedAt);
    const summaryStatus = readEnum(rawSession.summaryStatus, ["pending", "complete"]);
    const lastMemorySyncCount = readNumber(rawSession.lastMemorySyncCount);
    const derived = sanitizeDerivedState(rawSession.derived, {
      lastMirroredCount,
      finalizedAt,
      summaryStatus,
      lastMemorySyncCount,
    });
    out.sessions[sessionScopeKey(sessionId, agentId)] = {
      sessionId,
      sessionKey: readString(rawSession.sessionKey),
      sessionFile: readString(rawSession.sessionFile),
      agentId,
      issueNumber: readNumber(rawSession.issueNumber),
      issueTitle: readString(rawSession.issueTitle),
      titleSource: readEnum(rawSession.titleSource, ["placeholder", "digest", "llm"]),
      lastMirroredCount,
      turnCount: readNumber(rawSession.turnCount) ?? 0,
      lastMemorySyncCount: derived.memory.appliedCursor,
      summaryStatus: derived.summary.status === "complete" ? "complete" : finalizedAt ? "pending" : undefined,
      finalizedAt,
      lastSummaryHash: readString(rawSession.lastSummaryHash),
      lastTurnHash: readString(rawSession.lastTurnHash),
      derived,
      createdAt: readString(rawSession.createdAt),
      updatedAt: readString(rawSession.updatedAt),
    };
  }
  return out;
}

function sanitizeDerivedState(
  value: unknown,
  fallback: {
    lastMirroredCount: number;
    finalizedAt?: string;
    summaryStatus?: "pending" | "complete";
    lastMemorySyncCount?: number;
  },
): SessionDerivedState {
  if (!value || typeof value !== "object") {
    return migrateDerivedState(fallback);
  }
  const record = value as Record<string, unknown>;
  const digest = asRecord(record.digest);
  const summary = asRecord(record.summary);
  const memory = asRecord(record.memory);
  const lastMirroredCount = fallback.lastMirroredCount;
  const extractCursor = clampCursor(readNumber(memory?.extractCursor), lastMirroredCount);
  const appliedCursor = clampCursor(readNumber(memory?.appliedCursor), extractCursor);
  return {
    digest: {
      cursor: clampCursor(readNumber(digest?.cursor), lastMirroredCount),
      status: readTaskStatus(digest?.status, lastMirroredCount > 0 ? "pending" : "idle"),
      attempt: readNumber(digest?.attempt) ?? 0,
      text: readString(digest?.text),
      title: readString(digest?.title),
      lastError: readString(digest?.lastError),
      updatedAt: readString(digest?.updatedAt),
    },
    summary: {
      basedOnCursor: clampCursor(readNumber(summary?.basedOnCursor), lastMirroredCount),
      status: readTaskStatus(summary?.status, fallback.finalizedAt ? "pending" : "idle"),
      text: readString(summary?.text),
      lastError: readString(summary?.lastError),
      updatedAt: readString(summary?.updatedAt),
    },
    memory: {
      extractCursor,
      appliedCursor,
      extractStatus: readTaskStatus(memory?.extractStatus, extractCursor < lastMirroredCount ? "pending" : "idle"),
      reconcileStatus: readTaskStatus(memory?.reconcileStatus, appliedCursor < extractCursor ? "pending" : "idle"),
      attempt: readNumber(memory?.attempt) ?? 0,
      pendingCandidates: Array.isArray(memory?.pendingCandidates)
        ? memory.pendingCandidates.map(sanitizeCandidate).filter((candidate): candidate is MemoryCandidate => Boolean(candidate))
        : [],
      lastError: readString(memory?.lastError),
      updatedAt: readString(memory?.updatedAt),
    },
  };
}

function migrateDerivedState(fallback: {
  lastMirroredCount: number;
  finalizedAt?: string;
  summaryStatus?: "pending" | "complete";
  lastMemorySyncCount?: number;
}): SessionDerivedState {
  const mirrorCursor = fallback.lastMirroredCount;
  const finalized = Boolean(fallback.finalizedAt);
  const summaryComplete = fallback.summaryStatus === "complete";
  const appliedCursor = clampCursor(fallback.lastMemorySyncCount, mirrorCursor);
  const digestCursor = finalized && summaryComplete ? mirrorCursor : 0;
  return {
    digest: {
      cursor: digestCursor,
      status: digestCursor < mirrorCursor ? "pending" : "idle",
      attempt: 0,
    },
    summary: {
      basedOnCursor: summaryComplete ? mirrorCursor : 0,
      status: finalized ? (summaryComplete ? "complete" : "pending") : "idle",
    },
    memory: {
      extractCursor: appliedCursor,
      appliedCursor,
      extractStatus: appliedCursor < mirrorCursor ? "pending" : "idle",
      reconcileStatus: "idle",
      attempt: 0,
      pendingCandidates: [],
    },
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readEnum<T extends string>(value: unknown, allowed: T[]): T | undefined {
  const s = readString(value);
  return s && (allowed as string[]).includes(s) ? (s as T) : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function readTaskStatus(value: unknown, fallback: SessionTaskStatus): SessionTaskStatus {
  const status = readEnum(value, ["idle", "pending", "running", "complete", "error"]);
  if (!status) return fallback;
  return status === "running" ? "pending" : status;
}

function sanitizeCandidate(value: unknown): MemoryCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const detail = readString(record.detail);
  const candidateId = readString(record.candidateId);
  if (!detail) return null;
  return {
    candidateId: candidateId ?? detail,
    detail,
    ...(readString(record.title) ? { title: readString(record.title) } : {}),
    ...(readString(record.kind) ? { kind: readString(record.kind) } : {}),
    ...(Array.isArray(record.topics)
      ? {
          topics: record.topics
            .map((topic) => readString(topic))
            .filter((topic): topic is string => Boolean(topic)),
        }
      : {}),
    ...(readString(record.evidence) ? { evidence: readString(record.evidence) } : {}),
  };
}

function clampCursor(value: number | undefined, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
