import { MemoryStore } from "./memory.js";
import type { ClawMemPluginConfig, ParsedMemoryIssue } from "./types.js";
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
    ...(overrides.sourceRole ? { sourceRole: overrides.sourceRole } : {}),
    ...(overrides.entities ? { entities: overrides.entities } : {}),
    ...(overrides.factType ? { factType: overrides.factType } : {}),
    ...(overrides.eventDate ? { eventDate: overrides.eventDate } : {}),
    ...(overrides.timeAnchor ? { timeAnchor: overrides.timeAnchor } : {}),
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
      ["source_role", m.sourceRole],
      ["fact_type", m.factType],
      ["event_date", m.eventDate],
      ["time_anchor", m.timeAnchor],
      ["entities_json", m.entities && m.entities.length > 0 ? JSON.stringify(m.entities) : undefined],
    ].filter(([, value]) => value !== undefined) as Array<[string, string]>),
    state: m.status === "stale" ? "closed" : "open",
    labels: [
      "type:memory",
      ...(m.kind ? [`kind:${m.kind}`] : []),
      ...(m.topics ?? []).map((topic) => `topic:${topic}`),
      ...(m.sourceRole ? [`source:${m.sourceRole}`] : []),
    ],
  };
}

function testConfig(overrides: Partial<ClawMemPluginConfig> = {}): ClawMemPluginConfig {
  return {
    baseUrl: "https://git.clawmem.ai/api/v3",
    authScheme: "token",
    agents: {},
    memoryRecallLimit: 5,
    memoryAutoRecallLimit: 5,
    turnCommentDelayMs: 1000,
    summaryWaitTimeoutMs: 120000,
    ...overrides,
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
      entities: ["Redis", "Lua scripts"],
      factType: "decision",
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
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const found = await store.search("redis rate limiting", 5);
  assert(found.length >= 1, "expected at least one strong match");
  assert(found[0]?.issueNumber === 1, "expected the more specific Redis rate limiting memory to rank first");
}

async function testBackendSearchPreferredForRecall(): Promise<void> {
  const listed = [
    issueFromMemory(memory({
      issueNumber: 1,
      title: "Memory: lexical decoy",
      detail: "redis rate limiting checklist",
      kind: "lesson",
    })),
  ];
  const searched = [
    issueFromMemory(memory({
      issueNumber: 2,
      title: "Memory: semantic winner",
      detail: "Use Lua scripts to keep Redis rate limiting atomic.",
      kind: "lesson",
      topics: ["redis"],
      entities: ["Redis", "Lua scripts"],
    })),
  ];
  const queries: string[] = [];
  const client = {
    repo: () => "owner/main-memory",
    listIssues: async () => listed,
    searchIssues: async (query: string) => {
      queries.push(query);
      return searched;
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const found = await store.search("redis rate limiting", 5);

  assert(queries.length >= 1, "expected backend search to be called");
  assert(queries.some((query) => query.includes("repo:owner/main-memory")), "expected backend queries to scope to the current repo");
  assert(queries.some((query) => query.includes('label:\"type:memory\"') || query.includes('label:"type:memory"')), "expected backend queries to filter memory issues");
  assert(found.length >= 1 && found[0]?.issueNumber === 2, "expected backend search results to influence the top result");
}

async function testBackendSearchFallsBackToLocalLexical(): Promise<void> {
  const issues = [
    issueFromMemory(memory({
      issueNumber: 3,
      title: "Memory: Redis rate limit tuning",
      detail: "Distributed Redis rate limiting must use Lua scripts to stay atomic.",
      kind: "lesson",
      topics: ["redis"],
      entities: ["Redis"],
    })),
  ];
  const client = {
    repo: () => "owner/main-memory",
    listIssues: async () => issues,
    searchIssues: async () => { throw new Error("search unavailable"); },
  };
  const store = new MemoryStore(client as never, { logger: { warn: () => {} } } as never, testConfig());
  const found = await store.search("redis rate limiting", 5);

  assert(found.length === 1 && found[0]?.issueNumber === 3, "expected lexical fallback when backend search fails");
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
  const result = await store.store({
    detail: "Redis Lua scripts are required for atomic rate limiting.",
    kind: "Lesson",
    topics: ["Redis Ops", "rate_limit"],
    sourceRole: "assistant",
    entities: ["Redis", "Lua scripts"],
    factType: "Assistant Knowledge",
    eventDate: "2026-03-27",
    timeAnchor: "during rollout",
  });
  const schema = await store.listSchema();

  assert(result.created === true, "expected a new structured memory to be created");
  assert(result.memory.kind === "lesson", "expected kind to be normalized");
  assert(result.memory.factType === "assistant-knowledge", "expected factType to be normalized");
  assert(result.memory.sourceRole === "assistant", "expected source role to be retained");
  assert(JSON.stringify(result.memory.topics) === JSON.stringify(["rate-limit", "redis-ops"]), "expected topics to be normalized and sorted");
  assert(JSON.stringify(result.memory.entities) === JSON.stringify(["Redis", "Lua scripts"]), "expected entities to be retained");
  assert(created.length === 1, "expected a single issue creation");
  assert(created[0]?.labels.includes("kind:lesson"), "expected created labels to include normalized kind");
  assert(created[0]?.labels.includes("topic:redis-ops"), "expected created labels to include normalized topic");
  assert(created[0]?.labels.includes("topic:rate-limit"), "expected created labels to include normalized topic");
  assert(created[0]?.labels.includes("source:assistant"), "expected created labels to include source role");
  assert(!created[0]?.labels.some((label) => label.startsWith("session:")), "expected manual memory_store writes to omit synthetic session labels");
  assert(!created[0]?.labels.some((label) => label.startsWith("date:")), "expected new memory labels to omit date labels");
  assert(created[0]?.body.includes(`date: ${result.memory.date}`), "expected new memory body to retain logical date metadata");
  assert(created[0]?.body.includes("entities_json"), "expected new memory body to retain entity metadata");
  assert(ensured[0]?.includes("kind:lesson"), "expected ensureLabels to include kind label");
  assert(schema.kinds.includes("lesson"), "expected schema to expose existing kind labels");
  assert(schema.topics.includes("redis"), "expected schema to expose existing topic labels");
}

async function testGetAndListMemories(): Promise<void> {
  const issues = [
    issueFromMemory(memory({
      issueNumber: 4,
      title: "Memory: xiangz preferences",
      detail: "xiangz likes F1 and watches Dota 2 as a viewer.",
      kind: "core-fact",
      topics: ["preferences", "hobbies"],
      sourceRole: "user",
      factType: "preference",
    })),
    issueFromMemory(memory({
      issueNumber: 10,
      title: "Memory: fruit preference",
      detail: "xiangz likes mango.",
      kind: "core-fact",
      topics: ["food"],
      sourceRole: "user",
      factType: "preference",
    })),
    issueFromMemory(memory({
      issueNumber: 11,
      title: "Memory: old sports note",
      detail: "xiangz follows F1.",
      kind: "lesson",
      status: "stale",
      topics: ["sports"],
      sourceRole: "assistant",
      factType: "assistant-knowledge",
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
  const assistantFacts = await store.listMemories({ status: "all", sourceRole: "assistant", limit: 10 });
  const preferenceFacts = await store.listMemories({ status: "active", factType: "preference", limit: 10 });

  assert(exact?.issueNumber === 4, "expected direct memory lookup to find issue #4");
  assert(activeFacts.length === 2, "expected listMemories to filter active core facts");
  assert(activeFacts[0]?.issueNumber === 10, "expected listMemories to sort newest-first");
  assert(assistantFacts.length === 1 && assistantFacts[0]?.issueNumber === 11, "expected listMemories to filter by source role");
  assert(preferenceFacts.length === 2, "expected listMemories to filter by fact type");
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
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const exact = await store.get("4");
  const recalled = await store.search("xiangz likes F1 and Dota 2", 5);

  assert(exact?.issueNumber === 4, "expected legacy memory without session/date to be readable");
  assert(exact?.date === "1970-01-01", "expected missing date label to fall back to a placeholder");
  assert(recalled.some((entry) => entry.issueNumber === 4), "expected legacy memory to participate in recall");
}

async function testUpdateMemoryInPlace(): Promise<void> {
  const issues: IssueRecord[] = [
    issueFromMemory(memory({
      issueNumber: 4,
      title: "Memory: xiangz preferences",
      detail: "xiangz likes F1 and watches Dota 2 as a viewer.",
      kind: "core-fact",
      topics: ["preferences"],
      sourceRole: "user",
      factType: "preference",
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
    entities: ["F1", "Dota 2", "tennis"],
    eventDate: "2026-03-29",
    timeAnchor: "recently",
  });

  assert(updated?.issueNumber === 4, "expected memory_update to modify the same issue");
  assert(updated?.detail.includes("tennis"), "expected updated detail to be returned");
  assert(JSON.stringify(updated?.topics) === JSON.stringify(["preferences", "sports"]), "expected topics to be replaced");
  assert(JSON.stringify(updated?.entities) === JSON.stringify(["F1", "Dota 2", "tennis"]), "expected entity metadata to be updated");
  assert(updated?.eventDate === "2026-03-29", "expected eventDate metadata to be updated");
  assert(updatedIssues.length === 1, "expected a single issue update");
  assert(updatedIssues[0]?.title !== "Memory: xiangz preferences", "expected title to refresh from updated detail");
  assert(ensured[0]?.includes("topic:sports"), "expected new topic label to be ensured");
  assert(syncedLabels[0]?.labels.includes("kind:core-fact"), "expected existing kind label to be preserved");
}

async function testDuplicateStoreMergesMetadata(): Promise<void> {
  const issues: IssueRecord[] = [
    issueFromMemory(memory({
      issueNumber: 7,
      title: "Memory: Redis Lua scripts are required",
      detail: "Redis Lua scripts are required for atomic rate limiting.",
      kind: "lesson",
      topics: ["redis"],
      sourceRole: "assistant",
      entities: ["Redis"],
    })),
  ];
  const syncedLabels: Array<{ number: number; labels: string[] }> = [];
  const updatedIssues: Array<{ number: number; body?: string }> = [];
  const client = {
    listIssues: async () => issues,
    ensureLabels: async () => {},
    updateIssue: async (number: number, patch: { body?: string }) => {
      updatedIssues.push({ number, body: patch.body });
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) throw new Error("issue missing");
      if (patch.body) issue.body = patch.body;
      return issue;
    },
    syncManagedLabels: async (number: number, labels: string[]) => {
      syncedLabels.push({ number, labels });
    },
  };
  const store = new MemoryStore(client as never, {} as never, testConfig());
  const result = await store.store({
    detail: "Redis Lua scripts are required for atomic rate limiting.",
    topics: ["rate-limit"],
    entities: ["Lua scripts"],
    factType: "assistant-knowledge",
  });

  assert(result.created === false, "expected duplicate detail to merge instead of creating a new memory");
  assert(result.memory.memoryId === "7", "expected the existing memory to be returned");
  assert(JSON.stringify(result.memory.entities) === JSON.stringify(["Redis", "Lua scripts"]), "expected duplicate merge to enrich entities");
  assert(updatedIssues.length === 1, "expected duplicate merge to rewrite the body with enriched metadata");
  assert(syncedLabels[0]?.labels.includes("topic:rate-limit"), "expected duplicate merge to extend topic labels");
}

async function testForgetClosesMemoryIssue(): Promise<void> {
  const issues: IssueRecord[] = [
    issueFromMemory(memory({
      issueNumber: 12,
      title: "Memory: outdated deployment rule",
      detail: "Always restart the full cluster after deploy.",
      kind: "convention",
      topics: ["deploy"],
      sourceRole: "assistant",
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
  await testSearchRanking();
  await testBackendSearchPreferredForRecall();
  await testBackendSearchFallsBackToLocalLexical();
  await testStructuredStoreAndSchema();
  await testGetAndListMemories();
  await testLegacyMemoriesWithoutSessionOrDate();
  await testUpdateMemoryInPlace();
  await testDuplicateStoreMergesMetadata();
  await testForgetClosesMemoryIssue();
  console.log("memory tests passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
