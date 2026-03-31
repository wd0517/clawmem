// Shared types for the clawmem plugin.
export type ClawMemAgentConfig = {
  baseUrl?: string;
  defaultRepo?: string;
  repo?: string;
  token?: string;
  authScheme?: "token" | "bearer";
};

export type ClawMemPluginConfig = {
  baseUrl: string;
  defaultRepo?: string;
  repo?: string;
  token?: string;
  authScheme: "token" | "bearer";
  agents: Record<string, ClawMemAgentConfig>;
  memoryRecallLimit: number;
  memoryAutoRecallLimit: number;
  turnCommentDelayMs: number;
  summaryWaitTimeoutMs: number;
};

export type ClawMemResolvedRoute = {
  agentId: string;
  baseUrl: string;
  defaultRepo?: string;
  repo?: string;
  token?: string;
  authScheme: "token" | "bearer";
};

export type BootstrapIdentityResponse = { token: string; repo_full_name: string };
export type AgentRegistrationResponse = BootstrapIdentityResponse & { login: string };
export type AnonymousSessionResponse = BootstrapIdentityResponse & { owner_login: string; repo_name: string };
export type SessionMirrorState = {
  sessionId: string; sessionKey?: string; sessionFile?: string; agentId?: string;
  issueNumber?: number; issueTitle?: string; titleSource?: "placeholder" | "llm";
  lastMirroredCount: number; turnCount: number; lastAssistantText?: string;
  lastMemorySyncCount?: number;
  summaryStatus?: "pending" | "complete";
  finalizedAt?: string; lastSummaryHash?: string; lastTurnHash?: string;
  createdAt?: string; updatedAt?: string;
};
export type PluginState = { version: 2; sessions: Record<string, SessionMirrorState>; migrations?: Record<string, string> };
export type NormalizedMessage = { role: string; text: string; toolName?: string; timestamp?: string; stopReason?: string };
export type TranscriptSnapshot = { sessionId?: string; messages: NormalizedMessage[] };
export type MemoryDraft = { detail: string; kind?: string; topics?: string[] };
export type MemorySchema = { kinds: string[]; topics: string[] };
export type MemoryListOptions = {
  status?: "active" | "stale" | "all";
  kind?: string;
  topic?: string;
  limit?: number;
};
export type ParsedMemoryIssue = {
  issueNumber: number; title: string; memoryId: string; memoryHash?: string;
  date: string; detail: string;
  kind?: string; topics?: string[]; status: "active" | "stale";
};
