// Tests for conversation title derivation logic.
import { deriveInitialTitle } from "./conversation.js";
import type { NormalizedMessage } from "./types.js";

function msg(role: string, text: string): NormalizedMessage {
  return { role, text };
}

const tests: Array<{ name: string; messages: NormalizedMessage[]; sessionId: string; expected: string | RegExp }> = [
  {
    name: "uses first user message",
    messages: [msg("user", "How do I configure Redis rate limiting?")],
    sessionId: "abc123",
    expected: "How do I configure Redis rate limiting?",
  },
  {
    name: "truncates long messages to 50 chars",
    messages: [msg("user", "I need help with configuring the distributed rate limiting system for our production Redis cluster")],
    sessionId: "abc123",
    expected: /^I need help with configuring the distributed rate…$/,
  },
  {
    name: "strips markdown formatting",
    messages: [msg("user", "## How do I **configure** `Redis` rate limiting?")],
    sessionId: "abc123",
    expected: "How do I configure Redis rate limiting?",
  },
  {
    name: "falls back to session ID for short messages",
    messages: [msg("user", "hi")],
    sessionId: "abc-def-123",
    expected: "Session: abc-def-123",
  },
  {
    name: "falls back to session ID when no user messages",
    messages: [msg("assistant", "Hello!")],
    sessionId: "xyz-789",
    expected: "Session: xyz-789",
  },
  {
    name: "falls back to session ID for empty messages",
    messages: [],
    sessionId: "empty-sess",
    expected: "Session: empty-sess",
  },
  {
    name: "collapses whitespace",
    messages: [msg("user", "How do   I    configure\n\nRedis?")],
    sessionId: "abc",
    expected: "How do I configure Redis?",
  },
  {
    name: "skips assistant messages, uses first user message",
    messages: [msg("assistant", "Welcome!"), msg("user", "Fix the login bug please")],
    sessionId: "abc",
    expected: "Fix the login bug please",
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const got = deriveInitialTitle(t.messages, t.sessionId);
  const ok = t.expected instanceof RegExp ? t.expected.test(got) : got === t.expected;
  if (!ok) {
    console.error(`FAIL: ${t.name}\n  got:      ${JSON.stringify(got)}\n  expected: ${t.expected instanceof RegExp ? t.expected.toString() : JSON.stringify(t.expected)}`);
    failed++;
  } else {
    console.log(`PASS: ${t.name}`);
    passed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
