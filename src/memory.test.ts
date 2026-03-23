import { MemoryStore, scoreMemoryMatch } from "./memory.js";
import type { ParsedMemoryIssue } from "./types.js";

function memory(overrides: Partial<ParsedMemoryIssue> = {}): ParsedMemoryIssue {
  return {
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "Memory: Example",
    memoryId: overrides.memoryId ?? String(overrides.issueNumber ?? 1),
    sessionId: overrides.sessionId ?? "sess-1",
    date: overrides.date ?? "2026-03-23",
    detail: overrides.detail ?? "Example durable detail",
    status: overrides.status ?? "active",
    ...(overrides.memoryHash ? { memoryHash: overrides.memoryHash } : {}),
    ...(overrides.topics ? { topics: overrides.topics } : {}),
  };
}

type IssueRecord = { number: number; title?: string; body?: string; labels?: string[] };

function issueFromMemory(m: ParsedMemoryIssue): IssueRecord {
  return {
    number: m.issueNumber,
    title: m.title,
    body: m.detail,
    labels: [
      "type:memory",
      `session:${m.sessionId}`,
      `date:${m.date}`,
      m.status === "stale" ? "memory-status:stale" : "memory-status:active",
      ...(m.topics ?? []).map((topic) => `topic:${topic}`),
    ],
  };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function testSearchRanking(): Promise<void> {
  const issues = [
    issueFromMemory(memory({
      issueNumber: 1,
      title: "Memory: Redis rate limit tuning",
      detail: "Distributed Redis rate limiting must use Lua scripts to stay atomic.",
      topics: ["redis", "rate-limiting"],
    })),
    issueFromMemory(memory({
      issueNumber: 2,
      title: "Memory: Generic backend notes",
      detail: "We use Redis in several services, but this one is not about rate limiting.",
      topics: ["backend"],
    })),
  ];
  const client = {
    listIssues: async () => issues,
  };
  const store = new MemoryStore(client as never, {} as never, { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000 } as never);
  const found = await store.search("redis rate limiting", 5);
  assert(found.length === 2, "expected both memories to match");
  assert(found[0]?.issueNumber === 1, "expected the more specific Redis rate limiting memory to rank first");
}

function testCjkScoring(): void {
  const billing = memory({
    issueNumber: 3,
    title: "Memory: 账单修复流程",
    detail: "遇到账单不一致时，先核对 invoice_id，再补发 webhook。",
    topics: ["账单", "支付"],
  });
  const unrelated = memory({
    issueNumber: 4,
    title: "Memory: 部署备注",
    detail: "发布前需要确认灰度流量比例。",
    topics: ["部署"],
  });
  const billingScore = scoreMemoryMatch(billing, "账单 webhook");
  const unrelatedScore = scoreMemoryMatch(unrelated, "账单 webhook");
  assert(billingScore > unrelatedScore, "expected Chinese query scoring to prefer the billing memory");
  assert(billingScore > 0, "expected Chinese query to produce a positive match score");
}

async function main(): Promise<void> {
  await testSearchRanking();
  testCjkScoring();
  console.log("memory tests passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
