import { MemoryStore, scoreMemoryMatch } from "./memory.js";
import type { MemorySemanticProvider } from "./semantic-search.js";
import type { ParsedMemoryIssue } from "./types.js";
import { stringifyFlatYaml } from "./yaml.js";

function memory(overrides: Partial<ParsedMemoryIssue> = {}): ParsedMemoryIssue {
  return {
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "Memory: Example",
    memoryId: overrides.memoryId ?? String(overrides.issueNumber ?? 1),
    sessionId: overrides.sessionId ?? "sess-1",
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
      `session:${m.sessionId}`,
      ...(m.kind ? [`kind:${m.kind}`] : []),
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
      kind: "lesson",
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
  const store = new MemoryStore(client as never, {} as never, { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000 } as never);
  const result = await store.store({ detail: "Redis Lua scripts are required for atomic rate limiting.", kind: "Lesson", topics: ["Redis Ops", "rate_limit"] }, "manual");
  const schema = await store.listSchema();

  assert(result.created === true, "expected a new structured memory to be created");
  assert(result.memory.kind === "lesson", "expected kind to be normalized");
  assert(JSON.stringify(result.memory.topics) === JSON.stringify(["rate-limit", "redis-ops"]), "expected topics to be normalized and sorted");
  assert(created.length === 1, "expected a single issue creation");
  assert(created[0]?.labels.includes("kind:lesson"), "expected created labels to include normalized kind");
  assert(created[0]?.labels.includes("topic:redis-ops"), "expected created labels to include normalized topic");
  assert(created[0]?.labels.includes("topic:rate-limit"), "expected created labels to include normalized topic");
  assert(!created[0]?.labels.some((label) => label.startsWith("date:")), "expected new memory labels to omit date labels");
  assert(created[0]?.body.includes(`date: ${result.memory.date}`), "expected new memory body to retain logical date metadata");
  assert(ensured[0]?.includes("kind:lesson"), "expected ensureLabels to include kind label");
  assert(schema.kinds.includes("lesson"), "expected schema to expose existing kind labels");
  assert(schema.topics.includes("redis"), "expected schema to expose existing topic labels");
}

async function testHybridSemanticRecallRescuesLexicalMiss(): Promise<void> {
  const issues = [
    issueFromMemory(memory({
      issueNumber: 21,
      title: "Memory: node-21",
      detail: "草莓 西瓜 凤梨 F1 赛车 Dota 2 云玩家。",
    })),
    issueFromMemory(memory({
      issueNumber: 22,
      title: "Memory: favorite hobbies and sports checklist",
      detail: "Generic onboarding checklist for spectator events.",
    })),
  ];
  const client = {
    listIssues: async () => issues,
  };
  const semanticProvider: MemorySemanticProvider = {
    score: async () => new Map([
      [21, 0.86],
      [22, 0.14],
    ]),
  };
  const lexicalStore = new MemoryStore(
    client as never,
    { logger: { warn: () => {} } } as never,
    { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000, semanticSearchWeight: 0.65 } as never,
  );
  const store = new MemoryStore(
    client as never,
    { logger: { warn: () => {} } } as never,
    { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000, semanticSearchWeight: 0.65 } as never,
    semanticProvider,
  );
  const lexicalOnly = await lexicalStore.search("favorite hobbies and spectator sports", 5);
  const found = await store.search("favorite hobbies and sports", 5);

  assert(lexicalOnly[0]?.issueNumber === 22, "expected lexical-only search to be distracted by the obvious wording match");
  assert(found.length >= 1, "expected hybrid recall to return at least one semantically relevant memory");
  assert(found[0]?.issueNumber === 21, "expected hybrid recall to rank the semantically matching memory first");
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
  const store = new MemoryStore(client as never, {} as never, { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000 } as never);
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
  const store = new MemoryStore(client as never, {} as never, { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000 } as never);
  const exact = await store.get("4");
  const recalled = await store.search("F1 Dota 2", 5);

  assert(exact?.issueNumber === 4, "expected legacy memory without session/date to be readable");
  assert(exact?.sessionId === "legacy", "expected missing session label to fall back to legacy");
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
  const store = new MemoryStore(client as never, {} as never, { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000 } as never);
  const updated = await store.update("4", {
    detail: "xiangz likes F1, watches Dota 2 as a viewer, and recently follows tennis.",
    topics: ["preferences", "sports"],
  });

  assert(updated?.issueNumber === 4, "expected memory_update to modify the same issue");
  assert(updated?.detail.includes("tennis"), "expected updated detail to be returned");
  assert(JSON.stringify(updated?.topics) === JSON.stringify(["preferences", "sports"]), "expected topics to be replaced");
  assert(updatedIssues.length === 1, "expected a single issue update");
  assert(updatedIssues[0]?.title !== "Memory: xiangz preferences", "expected title to refresh from updated detail");
  assert(ensured[0]?.includes("topic:sports"), "expected new topic label to be ensured");
  assert(syncedLabels[0]?.labels.includes("kind:core-fact"), "expected existing kind label to be preserved");
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
  const store = new MemoryStore(client as never, {} as never, { memoryRecallLimit: 5, turnCommentDelayMs: 1000, summaryWaitTimeoutMs: 120000 } as never);
  const forgotten = await store.forget("12");

  assert(forgotten?.status === "stale", "expected forgotten memory to be returned as stale");
  assert(updatedIssues[0]?.state === "closed", "expected memory_forget to close the issue");
  assert(syncedLabels[0]?.labels.every((label) => !label.startsWith("memory-status:")), "expected memory_forget to stop writing lifecycle labels");
}

async function main(): Promise<void> {
  await testSearchRanking();
  testCjkScoring();
  await testStructuredStoreAndSchema();
  await testHybridSemanticRecallRescuesLexicalMiss();
  await testGetAndListMemories();
  await testLegacyMemoriesWithoutSessionOrDate();
  await testUpdateMemoryInPlace();
  await testForgetClosesMemoryIssue();
  console.log("memory tests passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
