import { MemoryStore, mergeMemoryCandidates, scoreMemoryMatch } from "./memory.js";
import type { ParsedMemoryIssue } from "./types.js";
import { stringifyFlatYaml } from "./yaml.js";

function memory(overrides: Partial<ParsedMemoryIssue> = {}): ParsedMemoryIssue {
  return {
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "Memory: Example",
    memoryId: overrides.memoryId ?? String(overrides.issueNumber ?? 1),
    date: overrides.date ?? "2026-03-23",
    detail: overrides.detail ?? "Example durable detail",
    status: overrides.status ?? "active",
    ...(overrides.kind ? { kind: overrides.kind } : {}),
    ...(overrides.memoryHash ? { memoryHash: overrides.memoryHash } : {}),
    ...(overrides.topics ? { topics: overrides.topics } : {}),
  };
}

type IssueRecord = { number: number; title?: string; body?: string; state?: "open" | "closed"; labels?: string[] };
type LabelRecord = { name?: string };

function issueFromMemory(m: ParsedMemoryIssue): IssueRecord {
  return {
    number: m.issueNumber,
    title: m.title,
    body: stringifyFlatYaml([
      ["memory_hash", m.memoryHash ?? ""],
      ["date", m.date],
      ["detail", m.detail],
    ]),
    state: m.status === "stale" ? "closed" : "open",
    labels: [
      "type:memory",
      ...(m.kind ? [`kind:${m.kind}`] : []),
      ...(m.topics ?? []).map((topic) => `topic:${topic}`),
    ],
  };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function testConfig(): never {
  return {
    memoryRecallLimit: 5,
    memoryAutoRecallLimit: 3,
    turnCommentDelayMs: 1000,
    digestWaitTimeoutMs: 30000,
    summaryWaitTimeoutMs: 120000,
    memoryExtractWaitTimeoutMs: 45000,
    memoryReconcileWaitTimeoutMs: 45000,
  } as never;
}

async function testBackendSearchBuildsSingleCleanedQuery(): Promise<void> {
  const queries: string[] = [];
  const client = {
    repo: () => "owner/main-memory",
    searchIssues: async (query: string) => {
      queries.push(query);
      return [] as IssueRecord[];
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  await store.search([
    "<clawmem-context>",
    "- [11] Previous memory that should be stripped",
    "</clawmem-context>",
    "Conversation info (untrusted metadata):",
    "```json",
    '{"channel":"slack"}',
    "```",
    "",
    "[message_id: abc-123]",
    "",
    "[Slack 2026-04-03 09:30]: Please help debug the Redis rate limiting path.",
    "See https://example.com/debug for more context.",
    "throw new TimeoutError('lua script timeout')",
    "[System: auto-translated]",
  ].join("\n"), 5);

  assert(queries.length === 1, "expected a single backend search query");
  assert(queries[0]?.includes("repo:owner/main-memory"), "expected the backend query to stay scoped to the repo");
  assert(queries[0]?.includes('label:"type:memory"'), "expected the backend query to filter memory issues");
  assert((queries[0] ?? "").length <= 1610, "expected the backend search query to stay within the configured cap plus qualifiers");
  assert(queries[0]?.toLowerCase().includes("redis"), "expected the backend query to retain key terms");
  assert(!queries[0]?.includes("<clawmem-context>"), "expected injected clawmem context to be stripped");
  assert(!queries[0]?.includes("https://example.com/debug"), "expected URLs to be stripped from backend recall");
  assert(!queries[0]?.includes("Conversation info (untrusted metadata):"), "expected inbound metadata blocks to be stripped");
  assert(!queries[0]?.includes("[message_id:"), "expected message id hints to be stripped");
  assert(!queries[0]?.includes("[Slack 2026-04-03 09:30]"), "expected envelope prefixes to be stripped");
  assert(!queries[0]?.includes("[System: auto-translated]"), "expected trailing system hints to be stripped");
}

async function testBackendSearchPreferredForRecall(): Promise<void> {
  const searched = [
    issueFromMemory(memory({
      issueNumber: 2,
      title: "Memory: semantic winner",
      detail: "Use Lua scripts to keep Redis rate limiting atomic.",
      kind: "lesson",
      topics: ["redis"],
    })),
  ];
  const queries: string[] = [];
  const client = {
    repo: () => "owner/main-memory",
    searchIssues: async (query: string) => {
      queries.push(query);
      return searched;
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const found = await store.search("redis rate limiting", 1);

  assert(queries.length === 1, "expected backend search to be called once");
  assert(queries[0]?.includes('repo:owner/main-memory'), "expected backend query to scope to the current repo");
  assert(queries[0]?.includes('label:\"type:memory\"') || queries[0]?.includes('label:"type:memory"'), "expected backend query to filter memory issues");
  assert(found.length === 1 && found[0]?.issueNumber === 2, "expected backend search results to be preferred");
}

async function testBackendSearchReturnsEmptyWithoutLexicalFallback(): Promise<void> {
  const issues = [
    issueFromMemory(memory({
      issueNumber: 3,
      title: "Memory: Redis rate limit tuning",
      detail: "Distributed Redis rate limiting must use Lua scripts to stay atomic.",
      kind: "lesson",
      topics: ["redis"],
    })),
  ];
  const client = {
    repo: () => "owner/main-memory",
    listIssues: async () => issues,
    searchIssues: async () => [] as IssueRecord[],
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const found = await store.search("redis rate limiting", 5);

  assert(found.length === 0, "expected backend-only recall to return no results when the backend finds nothing");
}

async function testBackendSearchPropagatesErrors(): Promise<void> {
  const client = {
    repo: () => "owner/main-memory",
    searchIssues: async () => { throw new Error("search unavailable"); },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  let message = "";
  try {
    await store.search("redis rate limiting", 5);
  } catch (error) {
    message = String(error);
  }

  assert(message.includes("search unavailable"), "expected backend failures to propagate instead of falling back locally");
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

function testMergeMemoryCandidates(): void {
  const merged = mergeMemoryCandidates(
    [
      {
        candidateId: "abc",
        detail: "Redis Lua scripts keep rate limiting atomic.",
        topics: ["redis"],
      },
    ],
    [
      {
        candidateId: "abc",
        detail: "Redis Lua scripts keep rate limiting atomic.",
        kind: "lesson",
        topics: ["rate-limit"],
        evidence: "User confirmed the production path uses Lua.",
      },
    ],
  );

  assert(merged.length === 1, "expected duplicate candidates to merge by candidateId");
  assert(merged[0]?.kind === "lesson", "expected merged candidates to preserve new schema hints");
  assert(JSON.stringify(merged[0]?.topics) === JSON.stringify(["rate-limit", "redis"]), "expected merged candidates to union topics");
  assert(merged[0]?.evidence === "User confirmed the production path uses Lua.", "expected merged candidates to preserve evidence");
}

async function testStructuredStoreAndSchema(): Promise<void> {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const ensured: string[][] = [];
  const labels: LabelRecord[] = [{ name: "kind:lesson" }, { name: "topic:redis" }];
  const client = {
    listIssues: async () => [] as IssueRecord[],
    listLabels: async () => labels,
    ensureLabels: async (next: string[]) => { ensured.push(next); },
    createIssue: async (payload: { title: string; body: string; labels: string[] }) => {
      created.push(payload);
      return { number: 99, title: payload.title };
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const result = await store.store({ detail: "Redis Lua scripts are required for atomic rate limiting.", kind: "Lesson", topics: ["Redis Ops", "rate_limit"] });
  const schema = await store.listSchema();

  assert(result.created === true, "expected a new structured memory to be created");
  assert(result.memory.kind === "lesson", "expected kind to be normalized");
  assert(JSON.stringify(result.memory.topics) === JSON.stringify(["rate-limit", "redis-ops"]), "expected topics to be normalized and sorted");
  assert(created.length === 1, "expected a single issue creation");
  assert(created[0]?.labels.includes("kind:lesson"), "expected created labels to include normalized kind");
  assert(created[0]?.labels.includes("topic:redis-ops"), "expected created labels to include normalized topic");
  assert(created[0]?.labels.includes("topic:rate-limit"), "expected created labels to include normalized topic");
  assert(!created[0]?.labels.some((label) => label.startsWith("session:")), "expected manual memory_store writes to omit synthetic session labels");
  assert(!created[0]?.labels.some((label) => label.startsWith("date:")), "expected new memory labels to omit date labels");
  assert(created[0]?.body.includes("memory_hash:"), "expected new memory body to retain metadata fields");
  assert(created[0]?.body.includes("detail: Redis Lua scripts are required for atomic rate limiting."), "expected new memory body to store detail in YAML");
  assert(created[0]?.body.includes(`date: ${result.memory.date}`), "expected new memory body to retain logical date metadata");
  assert(ensured[0]?.includes("kind:lesson"), "expected ensureLabels to include kind label");
  assert(schema.kinds.includes("lesson"), "expected schema to expose existing kind labels");
  assert(schema.topics.includes("redis"), "expected schema to expose existing topic labels");
}

async function testStoreKeepsFullAutoTitleAndSupportsExplicitTitle(): Promise<void> {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const client = {
    listIssues: async () => [] as IssueRecord[],
    listLabels: async () => [] as LabelRecord[],
    ensureLabels: async () => {},
    createIssue: async (payload: { title: string; body: string; labels: string[] }) => {
      created.push(payload);
      return { number: created.length + 100, title: payload.title };
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const longDetail = "Tech Decision #001: Frontend = React Native, Backend = FastAPI, Database = PostgreSQL, and analytics events must stay append-only for auditability.";
  const auto = await store.store({ detail: longDetail });
  const explicit = await store.store({ title: "Architecture Decision #001", detail: "Use React Native + FastAPI for the first mobile stack." });

  assert(auto.memory.title === `Memory: ${longDetail}`, "expected auto-generated memory title to keep the full detail without truncation");
  assert(explicit.memory.title === "Memory: Architecture Decision #001", "expected explicit memory title to be preserved");
  assert(created[0]?.title === `Memory: ${longDetail}`, "expected created issue title to keep the full auto title");
  assert(created[1]?.title === "Memory: Architecture Decision #001", "expected created issue title to use the explicit title");
}

async function testGetAndListMemories(): Promise<void> {
  const issues = [
    issueFromMemory(memory({
      issueNumber: 4,
      title: "Memory: xiangz preferences",
      detail: "xiangz likes F1 and watches Dota 2 as a viewer.",
      kind: "core-fact",
      topics: ["preferences", "hobbies"],
    })),
    issueFromMemory(memory({
      issueNumber: 10,
      title: "Memory: fruit preference",
      detail: "xiangz likes mango.",
      kind: "core-fact",
      topics: ["food"],
    })),
    issueFromMemory(memory({
      issueNumber: 11,
      title: "Memory: old sports note",
      detail: "xiangz follows F1.",
      kind: "lesson",
      status: "stale",
      topics: ["sports"],
    })),
  ];
  const client = {
    listIssues: async (params?: { labels?: string[]; state?: "open" | "closed" | "all" }) => {
      const labels = params?.labels ?? [];
      const state = params?.state ?? "open";
      return issues.filter((issue) => {
        const issueLabels = issue.labels ?? [];
        if (!labels.every((label) => issueLabels.includes(label))) return false;
        if (state === "all") return true;
        return (issue.state ?? "open") === state;
      });
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const exact = await store.get("4");
  const activeFacts = await store.listMemories({ status: "active", kind: "core-fact", limit: 10 });
  const sports = await store.listMemories({ status: "all", topic: "sports", limit: 10 });

  assert(exact?.issueNumber === 4, "expected direct memory lookup to find issue #4");
  assert(activeFacts.length === 2, "expected listMemories to filter active core facts");
  assert(activeFacts[0]?.issueNumber === 10, "expected listMemories to sort newest-first");
  assert(sports.length === 1 && sports[0]?.issueNumber === 11, "expected listMemories to filter by topic across statuses");
}

async function testLegacyMemoriesWithoutSessionOrDate(): Promise<void> {
  const issues: IssueRecord[] = [
    {
      number: 4,
      title: "Memory: xiangz preferences",
      body: "xiangz likes F1 and watches Dota 2 as a viewer.",
      labels: ["type:memory", "kind:core-fact", "topic:preferences"],
    },
  ];
  const client = {
    repo: () => "owner/main-memory",
    listIssues: async (params?: { labels?: string[]; state?: "open" | "closed" | "all" }) => {
      const labels = params?.labels ?? [];
      const state = params?.state ?? "open";
      return issues.filter((issue) => {
        const issueLabels = issue.labels ?? [];
        if (!labels.every((label) => issueLabels.includes(label))) return false;
        if (state === "all") return true;
        return (issue.state ?? "open") === state;
      });
    },
    searchIssues: async () => issues,
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const exact = await store.get("4");
  const recalled = await store.search("F1 Dota 2", 5);

  assert(exact?.issueNumber === 4, "expected legacy memory without session/date to be readable");
  assert(exact?.date === "1970-01-01", "expected missing date label to fall back to a placeholder");
  assert(recalled.some((memory) => memory.issueNumber === 4), "expected legacy memory to participate in recall");
}

async function testUpdateMemoryInPlace(): Promise<void> {
  const issues: IssueRecord[] = [
    issueFromMemory(memory({
      issueNumber: 4,
      title: "Memory: xiangz preferences",
      detail: "xiangz likes F1 and watches Dota 2 as a viewer.",
      kind: "core-fact",
      topics: ["preferences"],
    })),
  ];
  const ensured: string[][] = [];
  const updatedIssues: Array<{ number: number; title?: string; body?: string }> = [];
  const syncedLabels: Array<{ number: number; labels: string[] }> = [];
  const client = {
    listIssues: async (params?: { labels?: string[]; state?: "open" | "closed" | "all" }) => {
      const labels = params?.labels ?? [];
      const state = params?.state ?? "open";
      return issues.filter((issue) => {
        const issueLabels = issue.labels ?? [];
        if (!labels.every((label) => issueLabels.includes(label))) return false;
        if (state === "all") return true;
        return (issue.state ?? "open") === state;
      });
    },
    ensureLabels: async (labels: string[]) => { ensured.push(labels); },
    updateIssue: async (number: number, patch: { title?: string; body?: string }) => {
      updatedIssues.push({ number, ...patch });
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) throw new Error("issue missing");
      if (patch.title) issue.title = patch.title;
      if (patch.body) issue.body = patch.body;
      return issue;
    },
    syncManagedLabels: async (number: number, labels: string[]) => {
      syncedLabels.push({ number, labels });
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) throw new Error("issue missing");
      issue.labels = labels;
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const updated = await store.update("4", {
    detail: "xiangz likes F1, watches Dota 2 as a viewer, and recently follows tennis.",
    topics: ["preferences", "sports"],
  });

  assert(updated?.issueNumber === 4, "expected memory_update to modify the same issue");
  assert(updated?.detail.includes("tennis"), "expected updated detail to be returned");
  assert(JSON.stringify(updated?.topics) === JSON.stringify(["preferences", "sports"]), "expected topics to be replaced");
  assert(updatedIssues.length === 1, "expected a single issue update");
  assert(updatedIssues[0]?.title !== "Memory: xiangz preferences", "expected title to refresh from updated detail");
  assert(updatedIssues[0]?.body?.includes("memory_hash:"), "expected updated body to retain metadata");
  assert(updatedIssues[0]?.body?.includes("detail:"), "expected updated body to store a detail field in YAML");
  assert(updatedIssues[0]?.body?.includes("recently follows tennis"), "expected updated body to contain the updated detail text");
  assert(ensured[0]?.includes("topic:sports"), "expected new topic label to be ensured");
  assert(syncedLabels[0]?.labels.includes("kind:core-fact"), "expected existing kind label to be preserved");
}

async function testUpdateSupportsExplicitRetitle(): Promise<void> {
  const issues: IssueRecord[] = [
    issueFromMemory(memory({
      issueNumber: 20,
      title: "Memory: old short title",
      detail: "We use append-only audit events for billing changes.",
      kind: "convention",
    })),
  ];
  const updatedIssues: Array<{ number: number; title?: string; body?: string }> = [];
  const client = {
    listIssues: async (params?: { labels?: string[]; state?: "open" | "closed" | "all" }) => {
      const labels = params?.labels ?? [];
      const state = params?.state ?? "open";
      return issues.filter((issue) => {
        const issueLabels = issue.labels ?? [];
        if (!labels.every((label) => issueLabels.includes(label))) return false;
        if (state === "all") return true;
        return (issue.state ?? "open") === state;
      });
    },
    ensureLabels: async () => {},
    updateIssue: async (number: number, patch: { title?: string; body?: string }) => {
      updatedIssues.push({ number, ...patch });
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) throw new Error("issue missing");
      if (patch.title) issue.title = patch.title;
      if (patch.body) issue.body = patch.body;
      return issue;
    },
    syncManagedLabels: async () => {},
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const updated = await store.update("20", { title: "Billing Audit Convention" });

  assert(updated?.title === "Memory: Billing Audit Convention", "expected memory_update to support explicit retitle");
  assert(updatedIssues[0]?.title === "Memory: Billing Audit Convention", "expected issue title patch to use the explicit retitle");
}

async function testForgetClosesMemoryIssue(): Promise<void> {
  const issues: IssueRecord[] = [
    issueFromMemory(memory({
      issueNumber: 12,
      title: "Memory: outdated deployment rule",
      detail: "Always restart the full cluster after deploy.",
      kind: "convention",
      topics: ["deploy"],
    })),
  ];
  const syncedLabels: Array<{ number: number; labels: string[] }> = [];
  const updatedIssues: Array<{ number: number; state?: "open" | "closed" }> = [];
  const client = {
    listIssues: async (params?: { labels?: string[]; state?: "open" | "closed" | "all" }) => {
      const labels = params?.labels ?? [];
      const state = params?.state ?? "open";
      return issues.filter((issue) => {
        const issueLabels = issue.labels ?? [];
        if (!labels.every((label) => issueLabels.includes(label))) return false;
        if (state === "all") return true;
        return (issue.state ?? "open") === state;
      });
    },
    syncManagedLabels: async (number: number, labels: string[]) => {
      syncedLabels.push({ number, labels });
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) throw new Error("issue missing");
      issue.labels = labels;
    },
    updateIssue: async (number: number, patch: { state?: "open" | "closed" }) => {
      updatedIssues.push({ number, state: patch.state });
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) throw new Error("issue missing");
      if (patch.state) issue.state = patch.state;
      return issue;
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const forgotten = await store.forget("12");

  assert(forgotten?.status === "stale", "expected forgotten memory to be returned as stale");
  assert(updatedIssues[0]?.state === "closed", "expected memory_forget to close the issue");
  assert(syncedLabels[0]?.labels.every((label) => !label.startsWith("memory-status:")), "expected memory_forget to stop writing lifecycle labels");
}

async function main(): Promise<void> {
  await testBackendSearchBuildsSingleCleanedQuery();
  await testBackendSearchPreferredForRecall();
  await testBackendSearchReturnsEmptyWithoutLexicalFallback();
  await testBackendSearchPropagatesErrors();
testCjkScoring();
testMergeMemoryCandidates();
await testStructuredStoreAndSchema();
  await testStoreKeepsFullAutoTitleAndSupportsExplicitTitle();
  await testGetAndListMemories();
  await testLegacyMemoriesWithoutSessionOrDate();
  await testUpdateMemoryInPlace();
  await testUpdateSupportsExplicitRetitle();
  await testForgetClosesMemoryIssue();
  console.log("memory tests passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
