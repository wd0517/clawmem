// Tests for conversation title derivation logic.
import { deriveInitialTitle } from "./conversation.js";
import type { NormalizedMessage } from "./types.js";

function msg(role: string, text: string): NormalizedMessage {
  return { role, text };
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
