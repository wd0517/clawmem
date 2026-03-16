// Shared types for the clawmem plugin.
export type ClawMemPluginConfig = {
  baseUrl?: string; repo?: string; token?: string;
  authScheme: "token" | "bearer";
  memoryRecallLimit: number; turnCommentDelayMs: number;
  summaryWaitTimeoutMs: number;
};
export type AnonymousSessionResponse = { token: string; owner_login: string; repo_name: string; repo_full_name: string };
export type SessionMirrorState = {
  sessionId: string; sessionKey?: string; sessionFile?: string; agentId?: string;
  issueNumber?: number; issueTitle?: string;
  lastMirroredCount: number; turnCount: number; lastAssistantText?: string;
  finalizedAt?: string; lastSummaryHash?: string; lastTurnHash?: string;
  createdAt?: string; updatedAt?: string;
};
export type PluginState = { version: 1; sessions: Record<string, SessionMirrorState> };
export type NormalizedMessage = { role: string; text: string; toolName?: string; timestamp?: string; stopReason?: string };
export type TranscriptSnapshot = { sessionId?: string; messages: NormalizedMessage[] };
export type ParsedMemoryIssue = {
  issueNumber: number; title: string; memoryId: string; memoryHash?: string;
  sessionId: string; date: string; detail: string;
  topics?: string[]; status: "active" | "stale";
};
