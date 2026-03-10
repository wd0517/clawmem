export type ClawMemPluginConfig = {
  baseUrl?: string;
  repo?: string;
  token?: string;
  authScheme: "token" | "bearer";
  issueTitlePrefix: string;
  memoryTitlePrefix: string;
  defaultLabels: string[];
  agentLabelPrefix?: string;
  activeStatusLabel?: string;
  closedStatusLabel?: string;
  memoryActiveStatusLabel: string;
  memoryStaleStatusLabel: string;
  autoCreateLabels: boolean;
  closeIssueOnReset: boolean;
  turnCommentDelayMs: number;
  summaryWaitTimeoutMs: number;
  memoryRecallLimit: number;
  labelColor: string;
  maxExcerptChars: number;
};

export type SessionMirrorState = {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
  issueNumber?: number;
  issueTitle?: string;
  lastMirroredCount: number;
  turnCount: number;
  lastAssistantText?: string;
  finalizedAt?: string;
  lastSummaryHash?: string;
  lastTurnHash?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type PluginState = {
  version: 1;
  sessions: Record<string, SessionMirrorState>;
};

export type NormalizedMessage = {
  role: string;
  text: string;
  toolName?: string;
  timestamp?: string;
  stopReason?: string;
};

export type TranscriptSnapshot = {
  sessionId?: string;
  messages: NormalizedMessage[];
};

export type SummarySnapshot = {
  title: string;
  summary: string;
};

export type ConversationSummaryResult = {
  summary: string;
};

export type ParsedMemoryIssue = {
  issueNumber: number;
  title: string;
  memoryId: string;
  sessionId: string;
  date: string;
  detail: string;
  status: "active" | "stale";
};
