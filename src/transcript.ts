import fs from "node:fs";
import type { NormalizedMessage, TranscriptSnapshot } from "./types.js";

export async function readTranscriptSnapshot(filePath: string): Promise<TranscriptSnapshot> {
  const raw = await fs.promises.readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let sessionId: string | undefined;
  const messages: NormalizedMessage[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) {
      continue;
    }
    if (!sessionId && record.type === "session" && typeof record.id === "string") {
      sessionId = record.id.trim() || undefined;
      continue;
    }
    const message = normalizeMessage(record.message ?? record);
    if (message) {
      messages.push(message);
    }
  }

  return { sessionId, messages };
}

export function normalizeMessages(items: unknown[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const message = normalizeMessage(record.message ?? record);
    if (message) {
      out.push(message);
    }
  }
  return out;
}

function normalizeMessage(value: unknown): NormalizedMessage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const role = typeof record.role === "string" ? record.role : undefined;
  if (role !== "assistant" && role !== "user") {
    return null;
  }
  if (record.tool_call_id || record.toolCallId) {
    return null;
  }

  const directText = typeof record.text === "string" ? normalizeChatText(record.text) : null;
  const text = directText ?? extractChatText(record.content);
  if (!text) {
    return null;
  }

  const timestamp = normalizeTimestamp(record.timestamp);
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
  return {
    role,
    text,
    ...(timestamp ? { timestamp } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function extractChatText(content: unknown): string {
  if (typeof content === "string") {
    return normalizeChatText(content) ?? "";
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      const normalized = normalizeChatText(block);
      if (normalized) {
        parts.push(normalized);
      }
      continue;
    }
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (type.includes("tool")) {
      continue;
    }
    const textCandidates = [
      record.text,
      record.value,
      record.content,
      record.outputText,
      record.inputText,
    ];
    for (const candidate of textCandidates) {
      if (typeof candidate === "string") {
        const normalized = normalizeChatText(candidate);
        if (normalized) {
          parts.push(normalized);
        }
      }
    }
  }
  return compactText(parts);
}

function normalizeChatText(value: string): string | null {
  let trimmed = stripUntrustedMetadataPrefixes(squashWhitespace(value));
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^\[\[\s*reply_to[^\]]*\]\]\s*/i, "").trim();
  if (!trimmed) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  if (upper === "NO_REPLY" || upper === "HEARTBEAT_OK" || upper === "IDLE-CHAT") {
    return null;
  }
  return trimmed;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function compactText(parts: Array<string | undefined>): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function squashWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function stripUntrustedMetadataPrefixes(value: string): string {
  let current = value.trim();

  for (;;) {
    const next = current
      .replace(
        /^Conversation info \(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*/i,
        "",
      )
      .replace(
        /^Sender \(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*/i,
        "",
      )
      .trim();
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
