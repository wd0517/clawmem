// Tests for conversation title derivation logic.
import { ConversationMirror, deriveInitialTitle } from "./conversation.js";
import type { NormalizedMessage, SessionMirrorState } from "./types.js";

function msg(role: string, text: string): NormalizedMessage {
  return { role, text };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const tests: Array<{ name: string; messages: NormalizedMessage[]; sessionId: string; expected: string }> = [
  {
    name: "returns placeholder regardless of user message content",
    messages: [msg("user", "How do I configure Redis rate limiting?")],
    sessionId: "abc123",
    expected: "Session: abc123",
  },
  {
    name: "returns placeholder for long messages",
    messages: [msg("user", "I need help with configuring the distributed rate limiting system for our production Redis cluster")],
    sessionId: "abc123",
    expected: "Session: abc123",
  },
  {
    name: "returns placeholder for messages with markdown",
    messages: [msg("user", "## How do I **configure** `Redis` rate limiting?")],
    sessionId: "abc123",
    expected: "Session: abc123",
  },
  {
    name: "returns placeholder for short messages",
    messages: [msg("user", "hi")],
    sessionId: "abc-def-123",
    expected: "Session: abc-def-123",
  },
  {
    name: "returns placeholder when no user messages",
    messages: [msg("assistant", "Hello!")],
    sessionId: "xyz-789",
    expected: "Session: xyz-789",
  },
  {
    name: "returns placeholder for empty messages",
    messages: [],
    sessionId: "empty-sess",
    expected: "Session: empty-sess",
  },
  {
    name: "returns placeholder with session ID for any input",
    messages: [msg("assistant", "Welcome!"), msg("user", "Fix the login bug please")],
    sessionId: "abc",
    expected: "Session: abc",
  },
];

let passed = 0;
let failed = 0;

async function testLoadSnapshotPrefersFallbackMessages(): Promise<void> {
  const mirror = new ConversationMirror(
    {} as never,
    { logger: { warn() {}, info() {} } } as never,
    {} as never,
  );
  const session: SessionMirrorState = {
    sessionId: "sync-session",
    sessionFile: "/tmp/does-not-need-to-exist.jsonl",
    lastMirroredCount: 0,
    turnCount: 0,
  };
  const snapshot = await mirror.loadSnapshot(session, [{ role: "user", text: "Use the in-request transcript." }]);
  assert(snapshot.messages.length === 1, "expected loadSnapshot to return fallback messages");
  assert(snapshot.messages[0]?.text === "Use the in-request transcript.", "expected loadSnapshot to prefer in-request messages over transcript files");
}

async function main(): Promise<void> {
  for (const t of tests) {
    const got = deriveInitialTitle(t.messages, t.sessionId);
    const ok = got === t.expected;
    if (!ok) {
      console.error(`FAIL: ${t.name}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(t.expected)}`);
      failed++;
    } else {
      console.log(`PASS: ${t.name}`);
      passed++;
    }
  }
  await testLoadSnapshotPrefersFallbackMessages();
  console.log("PASS: loadSnapshot prefers fallback messages");

  console.log(`\n${passed + 1} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
