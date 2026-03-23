import fs from "node:fs";
import path from "node:path";
import type { PluginState } from "./types.js";
import { normalizeAgentId, sessionScopeKey } from "./utils.js";

const EMPTY_STATE: PluginState = {
  version: 2,
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
    version: 2,
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
    out.sessions[sessionScopeKey(sessionId, agentId)] = {
      sessionId,
      sessionKey: readString(rawSession.sessionKey),
      sessionFile: readString(rawSession.sessionFile),
      agentId,
      issueNumber: readNumber(rawSession.issueNumber),
      issueTitle: readString(rawSession.issueTitle),
      titleSource: readEnum(rawSession.titleSource, ["placeholder", "llm"]),
      lastMirroredCount: readNumber(rawSession.lastMirroredCount) ?? 0,
      turnCount: readNumber(rawSession.turnCount) ?? 0,
      lastMemorySyncCount: readNumber(rawSession.lastMemorySyncCount),
      summaryStatus: readEnum(rawSession.summaryStatus, ["pending", "complete"]),
      finalizedAt: readString(rawSession.finalizedAt),
      lastSummaryHash: readString(rawSession.lastSummaryHash),
      lastTurnHash: readString(rawSession.lastTurnHash),
      createdAt: readString(rawSession.createdAt),
      updatedAt: readString(rawSession.updatedAt),
    };
  }
  return out;
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
