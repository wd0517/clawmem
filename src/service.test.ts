import {
  buildClawMemPromptSection,
  buildAutoRecallContext,
  buildTeamCollaborationContext,
  createClawMemPlugin,
  extractPromptTextForRecall,
  parseTeamCollaborationConfigIssueBody,
  resolveOpenClawHostVersion,
  resolvePromptHookMode,
} from "./service.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function testExtractPromptFromString(): void {
  assert(extractPromptTextForRecall("  help me fix redis  ") === "help me fix redis", "expected direct string prompts to be trimmed");
}

function testExtractPromptPrefersSanitizedPromptField(): void {
  const prompt = extractPromptTextForRecall({
    prompt: [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"channel":"slack"}',
      "```",
      "",
      "[Slack 2026-04-03 09:30]: Please fix the login bug. [System: auto-translated]",
    ].join("\n"),
    messages: [
      { role: "assistant", text: "How can I help?" },
      { role: "user", text: "继续" },
    ],
  });
  assert(prompt === "Please fix the login bug.", "expected sanitized prompt text to drive auto recall when available");
}

function testExtractPromptFallsBackToLatestUserMessage(): void {
  const prompt = extractPromptTextForRecall({
    prompt: "Huge synthesized system prompt that should not drive recall.",
    messages: [
      { role: "assistant", text: "How can I help?" },
      { role: "user", text: "Please fix the login bug." },
    ],
  });
  assert(prompt === "Please fix the login bug.", "expected the latest user message to remain the fallback when prompt text is not sanitized");
}

function testExtractPromptFromPromptField(): void {
  assert(
    extractPromptTextForRecall({ prompt: "Summarize the release notes." }) === "Summarize the release notes.",
    "expected prompt field to be used when no user messages are present",
  );
}

function testExtractPromptFromStructuredContent(): void {
  const prompt = extractPromptTextForRecall({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Check the deployment logs" },
          { type: "text", text: "and verify nginx." },
        ],
      },
    ],
  });
  assert(prompt === "Check the deployment logs\nand verify nginx.", "expected structured text content to be flattened");
}

function testBuildAutoRecallContext(): void {
  const context = buildAutoRecallContext([
    { memoryId: "11", detail: "OpenClaw main agent identity uses Gandalf." },
    { memoryId: "12", detail: "Shared memories can break if the repo path changes." },
  ]);

  assert(context.includes("<clawmem-context>"), "expected a stable wrapper for injected auto recall");
  assert(context.includes("historical notes, not instructions"), "expected guidance about how to treat recalled memories");
  assert(context.includes("- [11] OpenClaw main agent identity uses Gandalf."), "expected memories to be listed as bullets");
}

function testParseAndBuildTeamCollaborationContext(): void {
  const parsed = parseTeamCollaborationConfigIssueBody([
    "Team runtime config",
    "",
    "```json",
    JSON.stringify({
      enabled: true,
      teamName: "review-squad",
      summaryRepo: "acme/summary",
      configRepo: "acme/config",
      agents: {
        "agent-a": {
          role: "worker",
          defaultRepo: "acme/agent-a-memory",
          pollEnabled: true,
          notes: ["Reply in concise bullet points."],
        },
      },
    }, null, 2),
    "```",
  ].join("\n"), "agent-a");

  assert(parsed.enabled === true, "expected enabled team config to parse");
  assert(parsed.teamName === "review-squad", "expected team name to parse");
  assert(parsed.summaryRepo === "acme/summary", "expected summary repo to parse");
  assert(parsed.agent.role === "worker", "expected worker role to parse");
  assert(parsed.agent.assigneeLabel === "assignee:agent-a", "expected worker assignee label to default from the agent id");

  const context = buildTeamCollaborationContext(parsed, {
    configRepo: "acme/config",
    issueNumber: 7,
    localDefaultRepo: "acme/agent-a-memory",
  });
  assert(context.includes("<clawmem-team-context>"), "expected a stable wrapper for injected team context");
  assert(context.includes("Summary repo: acme/summary"), "expected the summary repo to appear in team context");
  assert(context.includes("Worker queue labels: queue:task, task-status:handling, assignee:agent-a"), "expected queue routing guidance");
  assert(context.includes("Reply in concise bullet points."), "expected per-agent notes to survive into the rendered context");
}

function testBuildClawMemPromptSection(): void {
  const lines = buildClawMemPromptSection({
    availableTools: new Set([
      "memory_recall",
      "memory_list",
      "memory_get",
      "memory_repos",
      "memory_labels",
      "memory_store",
      "memory_update",
      "memory_forget",
    ]),
  });
  const prompt = lines.join("\n");

  assert(lines[0] === "## ClawMem", "expected a stable heading for always-on ClawMem guidance");
  assert(prompt.includes("active long-term memory system"), "expected the prompt to frame ClawMem as the active memory system");
  assert(prompt.includes("`memory_recall`, `memory_list`, and `memory_get`"), "expected explicit retrieval guidance");
  assert(prompt.includes("`memory_store` and `memory_update`"), "expected explicit save guidance");
  assert(prompt.includes("`memory_forget`"), "expected explicit stale-memory guidance");
  assert(prompt.includes("Store one durable fact per memory."), "expected one-fact-per-memory guidance");
  assert(prompt.includes("Skip temporary requests, tool chatter"), "expected anti-noise write guardrails");
  assert(prompt.includes("explicit short `title` plus a fuller `detail`"), "expected explicit title guidance");
  assert(prompt.includes("user's current language"), "expected language guidance for new memories");
  assert(prompt.includes("`memory_labels`"), "expected schema reuse guidance to mention memory_labels");
  assert(prompt.includes("translated or near-duplicate variant"), "expected anti-duplication schema guidance");
  assert(prompt.includes("<clawmem-team-context>"), "expected prompt guidance to mention the auto-injected team context block");
}

function createFakePluginApi(options?: {
  slot?: string;
  exposeCapability?: boolean;
  exposePromptSection?: boolean;
  runtimeVersion?: string;
  pluginConfig?: Record<string, unknown>;
}) {
  let registeredCapability: { promptBuilder?: typeof buildClawMemPromptSection } | undefined;
  let registeredPromptSection: typeof buildClawMemPromptSection | undefined;
  const registeredTools = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const warnings: string[] = [];
  const infos: string[] = [];
  const pluginConfig = options?.pluginConfig ?? {
    agents: {
      main: {
        token: "test-token",
        defaultRepo: "acme/memory",
      },
    },
  };
  let configRoot: Record<string, unknown> = {
    plugins: {
      entries: {
        clawmem: {
          config: pluginConfig,
        },
      },
      slots: {
        memory: options?.slot ?? "clawmem",
      },
    },
  };
  const api = {
    id: "clawmem",
    name: "ClawMem",
    source: "test",
    registrationMode: "test",
    config: {},
    pluginConfig,
    logger: {
      info: (message: string) => { infos.push(message); },
      warn: (message: string) => { warnings.push(message); },
    },
    runtime: {
      version: options?.runtimeVersion ?? "2026.4.9",
      config: {
        loadConfig: () => configRoot,
        writeConfigFile: async (next: Record<string, unknown>) => {
          configRoot = next;
        },
      },
      events: {
        onSessionTranscriptUpdate: () => () => {},
      },
      subagent: {},
    },
    on: (event: string, handler: (...args: any[]) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool: (tool: Record<string, unknown>) => {
      const name = typeof tool.name === "string" ? tool.name : "";
      if (name) registeredTools.set(name, tool);
    },
    registerService: () => {},
    ...(options?.exposeCapability === false
      ? {}
      : {
          registerMemoryCapability: (capability: { promptBuilder?: typeof buildClawMemPromptSection }) => {
            registeredCapability = capability;
          },
        }),
    ...(options?.exposePromptSection === false
      ? {}
      : {
          registerMemoryPromptSection: (builder: typeof buildClawMemPromptSection) => {
            registeredPromptSection = builder;
          },
        }),
  };

  return {
    api,
    getRegisteredCapability: () => registeredCapability,
    getRegisteredPromptSection: () => registeredPromptSection,
    getWarnings: () => warnings,
    getInfos: () => infos,
    getHandler: (event: string) => handlers.get(event)?.[0],
    getTool: (name: string) => registeredTools.get(name),
    getConfigRoot: () => configRoot,
  };
}

function testRegistersAlwaysOnMemoryPromptCapability(): void {
  const fake = createFakePluginApi();
  createClawMemPlugin(fake.api as never);

  const capability = fake.getRegisteredCapability();
  assert(Boolean(capability?.promptBuilder), "expected ClawMem to register a memory prompt builder");
  const prompt = capability?.promptBuilder?.({ availableTools: new Set(["memory_recall", "memory_store"]) }).join("\n") ?? "";
  assert(prompt.includes("## ClawMem"), "expected the registered prompt builder to emit ClawMem guidance");
}

function testFallsBackToLegacyMemoryPromptSectionRegistration(): void {
  const fake = createFakePluginApi({ exposeCapability: false });
  createClawMemPlugin(fake.api as never);

  assert(!fake.getRegisteredCapability(), "expected no memory capability registration when the host lacks that API");
  const builder = fake.getRegisteredPromptSection();
  assert(Boolean(builder), "expected fallback registration through registerMemoryPromptSection");
  const prompt = builder?.({ availableTools: new Set(["memory_recall"]) }).join("\n") ?? "";
  assert(prompt.includes("## ClawMem"), "expected the fallback builder to emit ClawMem guidance");
}

function testOlderHostWithoutPromptRegistrationDoesNotWarn(): void {
  const fake = createFakePluginApi({
    exposeCapability: false,
    exposePromptSection: false,
    runtimeVersion: "2026.3.13",
  });
  createClawMemPlugin(fake.api as never);

  assert(fake.getWarnings().length === 0, "expected older hosts without prompt registration to avoid warnings");
  assert(
    fake.getInfos().some((message) => message.includes("falling back to before_prompt_build prependSystemContext")),
    "expected older hosts to log an informational compatibility note",
  );
}

function testModernHostWithoutPromptRegistrationWarns(): void {
  const fake = createFakePluginApi({
    exposeCapability: false,
    exposePromptSection: false,
    runtimeVersion: "2026.3.22",
  });
  createClawMemPlugin(fake.api as never);

  assert(
    fake.getWarnings().some((message) => message.includes("falling back to before_prompt_build prependSystemContext")),
    "expected warning when a new-enough host is missing prompt registration",
  );
}

async function testOlderModernHostInjectsPromptGuidanceViaPrependSystemContext(): Promise<void> {
  const fake = createFakePluginApi({
    exposeCapability: false,
    exposePromptSection: false,
    runtimeVersion: "2026.3.13",
  });
  createClawMemPlugin(fake.api as never);

  const handler = fake.getHandler("before_prompt_build");
  assert(typeof handler === "function", "expected before_prompt_build handler to be registered for modern hosts");
  const result = await handler?.({ prompt: "hi" }, { agentId: "main" }) as { prependContext?: string; prependSystemContext?: string } | void;
  assert(Boolean(result && result.prependSystemContext?.includes("## ClawMem")), "expected static ClawMem guidance to use prependSystemContext fallback");
  assert(!result || !result.prependContext, "expected no dynamic recall context when the prompt is too short for auto-recall");
}

async function testBeforePromptBuildInjectsTeamCollaborationContext(): Promise<void> {
  const fake = createFakePluginApi({
    pluginConfig: {
      agents: {
        main: {
          token: "test-token",
          defaultRepo: "acme/memory",
          teamConfigRepo: "acme/config",
          teamConfigIssueNumber: 7,
        },
      },
    },
  });
  createClawMemPlugin(fake.api as never);

  const handler = fake.getHandler("before_prompt_build");
  assert(typeof handler === "function", "expected before_prompt_build handler to be registered");

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/config/issues/7" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({
        number: 7,
        body: [
          "```json",
          JSON.stringify({
            enabled: true,
            teamName: "review-squad",
            summaryRepo: "acme/summary",
            configRepo: "acme/config",
            agents: {
              main: {
                role: "main",
                defaultRepo: "acme/memory",
              },
            },
          }, null, 2),
          "```",
        ].join("\n"),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await handler?.({ prompt: "hi" }, { agentId: "main" }) as { prependContext?: string; prependSystemContext?: string } | void;
    assert(Boolean(result?.prependContext?.includes("<clawmem-team-context>")), "expected team collaboration context to be injected");
    assert(Boolean(result?.prependContext?.includes("Role: main")), "expected injected team context to describe the current role");
    assert(Boolean(result?.prependContext?.includes("Summary repo: acme/summary")), "expected the configured summary repo to be injected");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function testSkipsAlwaysOnPromptWhenClawMemIsNotSelectedMemoryPlugin(): void {
  const fake = createFakePluginApi({ slot: "other-memory" });
  createClawMemPlugin(fake.api as never);

  assert(!fake.getRegisteredCapability(), "expected no memory prompt registration when ClawMem is not the selected memory plugin");
  assert(!fake.getRegisteredPromptSection(), "expected no legacy prompt registration when ClawMem is not selected");
}

async function testRepoTransferAutoRetargetsDefaultRepo(): Promise<void> {
  const fake = createFakePluginApi();
  createClawMemPlugin(fake.api as never);
  const transferTool = fake.getTool("collaboration_repo_transfer");
  const transferExecute = transferTool?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  assert(typeof transferExecute === "function", "expected collaboration_repo_transfer tool to be registered");

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/memory/transfer") {
      return new Response(JSON.stringify({ full_name: "test-org/memory", name: "memory", owner: { login: "test-org" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://git.clawmem.ai/api/v3/repos/test-org/memory" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ full_name: "test-org/memory", name: "memory", owner: { login: "test-org" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await transferExecute?.("tool", { newOwner: "test-org", confirmed: true, agentId: "main" });
    const text = result?.content?.[0]?.text ?? "";
    assert(text.includes('retargeted agent "main" defaultRepo to test-org/memory'), "expected transfer tool to report automatic defaultRepo retarget");

    const root = fake.getConfigRoot();
    const nextRepo = ((root.plugins as any)?.entries?.clawmem?.config?.agents?.main?.defaultRepo) as string | undefined;
    assert(nextRepo === "test-org/memory", "expected persisted config to update defaultRepo after transfer");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function testMemoryRepoSetDefaultToolPersistsConfig(): Promise<void> {
  const fake = createFakePluginApi();
  createClawMemPlugin(fake.api as never);
  const tool = fake.getTool("memory_repo_set_default");
  const execute = tool?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  assert(typeof execute === "function", "expected memory_repo_set_default tool to be registered");

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://git.clawmem.ai/api/v3/repos/test-org/shared-memory") {
      return new Response(JSON.stringify({ full_name: "test-org/shared-memory", name: "shared-memory", owner: { login: "test-org" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await execute?.("tool", { repo: "test-org/shared-memory", confirmed: true, agentId: "main" });
    const text = result?.content?.[0]?.text ?? "";
    assert(text.includes('Set defaultRepo for agent "main" to test-org/shared-memory.'), "expected repo-set tool to confirm the new defaultRepo");

    const root = fake.getConfigRoot();
    const nextRepo = ((root.plugins as any)?.entries?.clawmem?.config?.agents?.main?.defaultRepo) as string | undefined;
    assert(nextRepo === "test-org/shared-memory", "expected memory_repo_set_default to persist the new defaultRepo");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function testTeamCollaborationConfigToolsPersistConfig(): Promise<void> {
  const fake = createFakePluginApi();
  createClawMemPlugin(fake.api as never);
  const setTool = fake.getTool("team_collaboration_config_set");
  const clearTool = fake.getTool("team_collaboration_config_clear");
  const setExecute = setTool?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  const clearExecute = clearTool?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  assert(typeof setExecute === "function", "expected team_collaboration_config_set tool to be registered");
  assert(typeof clearExecute === "function", "expected team_collaboration_config_clear tool to be registered");

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/config/issues/7" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ number: 7, body: "{}" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const setResult = await setExecute?.("tool", { repo: "acme/config", issueNumber: 7, confirmed: true, agentId: "main" });
    const setText = setResult?.content?.[0]?.text ?? "";
    assert(setText.includes('Set team collaboration config for agent "main" to acme/config#7.'), "expected the set tool to confirm the saved pointer");

    let root = fake.getConfigRoot();
    let savedRepo = ((root.plugins as any)?.entries?.clawmem?.config?.agents?.main?.teamConfigRepo) as string | undefined;
    let savedIssue = ((root.plugins as any)?.entries?.clawmem?.config?.agents?.main?.teamConfigIssueNumber) as number | undefined;
    assert(savedRepo === "acme/config", "expected the team config repo to be persisted");
    assert(savedIssue === 7, "expected the team config issue number to be persisted");

    const clearResult = await clearExecute?.("tool", { confirmed: true, agentId: "main" });
    const clearText = clearResult?.content?.[0]?.text ?? "";
    assert(clearText.includes('Cleared team collaboration config for agent "main".'), "expected the clear tool to confirm the removal");

    root = fake.getConfigRoot();
    savedRepo = ((root.plugins as any)?.entries?.clawmem?.config?.agents?.main?.teamConfigRepo) as string | undefined;
    savedIssue = ((root.plugins as any)?.entries?.clawmem?.config?.agents?.main?.teamConfigIssueNumber) as number | undefined;
    assert(savedRepo === undefined, "expected the clear tool to remove the team config repo");
    assert(savedIssue === undefined, "expected the clear tool to remove the team config issue number");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function testOrgRepoCreateAndIssueCommentWorkflowTools(): Promise<void> {
  const fake = createFakePluginApi();
  createClawMemPlugin(fake.api as never);

  const orgRepoCreate = fake.getTool("collaboration_org_repo_create")?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  const issueCreate = fake.getTool("issue_create")?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  const issueUpdate = fake.getTool("issue_update")?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  const issueCommentAdd = fake.getTool("issue_comment_add")?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;
  const issueCommentsList = fake.getTool("issue_comments_list")?.execute as ((id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }>) | undefined;

  assert(typeof orgRepoCreate === "function", "expected collaboration_org_repo_create tool to be registered");
  assert(typeof issueCreate === "function", "expected issue_create tool to be registered");
  assert(typeof issueUpdate === "function", "expected issue_update tool to be registered");
  assert(typeof issueCommentAdd === "function", "expected issue_comment_add tool to be registered");
  assert(typeof issueCommentsList === "function", "expected issue_comments_list tool to be registered");

  type FetchCall = { url: string; init: RequestInit | undefined };
  const calls: FetchCall[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url === "https://git.clawmem.ai/api/v3/orgs/test-org/repos" && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ full_name: "test-org/team-workspace", name: "team-workspace", owner: { login: "test-org" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/memory/labels" && (init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
      return new Response(JSON.stringify({ name: body.name }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/memory/issues" && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({
        number: 42,
        title: "Review gh-server backlog",
        body: "List issues that can be closed.",
        state: "open",
        labels: [{ name: "queue:task" }, { name: "task-status:handling" }, { name: "assignee:agent-a" }],
        comments: 0,
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/memory/issues/42" && (init?.method ?? "GET") === "PATCH") {
      return new Response(JSON.stringify({
        number: 42,
        title: "Review gh-server backlog",
        body: "List issues that can be closed.",
        state: "open",
        labels: [{ name: "queue:task" }, { name: "task-status:done" }, { name: "assignee:agent-a" }],
        comments: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/memory/issues/42/comments" && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({
        id: 501,
        body: "Done. Safe-to-close issues: #7 and #19.",
        user: { login: "agent-a" },
        created_at: "2026-04-13T10:00:00Z",
        updated_at: "2026-04-13T10:00:00Z",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://git.clawmem.ai/api/v3/repos/acme/memory/issues/42/comments?page=1&per_page=1&sort=updated&direction=desc" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify([{
        id: 501,
        body: "Done. Safe-to-close issues: #7 and #19.",
        user: { login: "agent-a" },
        created_at: "2026-04-13T10:00:00Z",
        updated_at: "2026-04-13T10:00:00Z",
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const createdRepo = await orgRepoCreate?.("tool", {
      org: "test-org",
      name: "team-workspace",
      description: "Shared task queue",
      hasIssues: true,
      hasWiki: false,
      confirmed: true,
      agentId: "main",
    });
    assert((createdRepo?.content?.[0]?.text ?? "").includes("Created org repo test-org/team-workspace."), "expected org repo tool to confirm the created repo");

    const createdIssue = await issueCreate?.("tool", {
      title: "Review gh-server backlog",
      body: "List issues that can be closed.",
      labels: ["queue:task", "task-status:handling", "assignee:agent-a"],
      agentId: "main",
    });
    const createdIssueText = createdIssue?.content?.[0]?.text ?? "";
    assert(createdIssueText.includes("Created issue in acme/memory."), "expected issue_create to report the target repo");
    assert(createdIssueText.includes("Issue Number: 42"), "expected issue_create to render the created issue");

    const updatedIssue = await issueUpdate?.("tool", {
      issueNumber: 42,
      labels: ["queue:task", "task-status:done", "assignee:agent-a"],
      agentId: "main",
    });
    const updatedIssueText = updatedIssue?.content?.[0]?.text ?? "";
    assert(updatedIssueText.includes("Updated issue in acme/memory."), "expected issue_update to report the target repo");
    assert(updatedIssueText.includes("task-status:done"), "expected issue_update to surface the new queue status");

    const addedComment = await issueCommentAdd?.("tool", {
      issueNumber: 42,
      body: "Done. Safe-to-close issues: #7 and #19.",
      agentId: "main",
    });
    const addedCommentText = addedComment?.content?.[0]?.text ?? "";
    assert(addedCommentText.includes("Added comment to issue #42 in acme/memory."), "expected issue_comment_add to report the target issue");
    assert(addedCommentText.includes("Done. Safe-to-close issues: #7 and #19."), "expected issue_comment_add to echo the stored result");

    const listedComments = await issueCommentsList?.("tool", {
      issueNumber: 42,
      sort: "updated",
      direction: "desc",
      limit: 1,
      agentId: "main",
    });
    const listedCommentsText = listedComments?.content?.[0]?.text ?? "";
    assert(listedCommentsText.includes("Found 1 comment on issue #42 in acme/memory:"), "expected issue_comments_list to report the target issue");
    assert(listedCommentsText.includes("Done. Safe-to-close issues: #7 and #19."), "expected issue_comments_list to surface the latest result comment");

    const labelCreateCalls = calls.filter((call) => call.url === "https://git.clawmem.ai/api/v3/repos/acme/memory/labels" && (call.init?.method ?? "GET") === "POST");
    assert(labelCreateCalls.length === 6, "expected create/update flows to ensure all queue labels exist");
    assert(calls.some((call) => call.url === "https://git.clawmem.ai/api/v3/orgs/test-org/repos" && (call.init?.method ?? "GET") === "POST"), "expected org repo create request to hit the org repo endpoint");
    assert(calls.some((call) => call.url === "https://git.clawmem.ai/api/v3/repos/acme/memory/issues/42/comments?page=1&per_page=1&sort=updated&direction=desc" && (call.init?.method ?? "GET") === "GET"), "expected issue_comments_list to request the latest comment");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function testResolveHostVersionFromRuntime(): void {
  const version = resolveOpenClawHostVersion({ runtime: { version: "2026.3.28" } } as never);
  assert(version === "2026.3.28", "expected runtime.version to take precedence");
}

function testResolveHostVersionFromEnvFallback(): void {
  const previous = {
    OPENCLAW_VERSION: process.env.OPENCLAW_VERSION,
    OPENCLAW_SERVICE_VERSION: process.env.OPENCLAW_SERVICE_VERSION,
    npm_package_version: process.env.npm_package_version,
  };
  try {
    delete process.env.OPENCLAW_VERSION;
    process.env.OPENCLAW_SERVICE_VERSION = "2026.3.6";
    delete process.env.npm_package_version;
    const version = resolveOpenClawHostVersion({ runtime: {} } as never);
    assert(version === "2026.3.6", "expected OPENCLAW_SERVICE_VERSION fallback");
  } finally {
    process.env.OPENCLAW_VERSION = previous.OPENCLAW_VERSION;
    process.env.OPENCLAW_SERVICE_VERSION = previous.OPENCLAW_SERVICE_VERSION;
    process.env.npm_package_version = previous.npm_package_version;
  }
}

function testIgnoresNpmPackageVersionFallback(): void {
  const previous = {
    OPENCLAW_VERSION: process.env.OPENCLAW_VERSION,
    OPENCLAW_SERVICE_VERSION: process.env.OPENCLAW_SERVICE_VERSION,
    npm_package_version: process.env.npm_package_version,
  };
  try {
    delete process.env.OPENCLAW_VERSION;
    delete process.env.OPENCLAW_SERVICE_VERSION;
    process.env.npm_package_version = "2026.3.99";
    const version = resolveOpenClawHostVersion({ runtime: {} } as never);
    assert(version === undefined, "expected npm_package_version to be ignored for host detection");
  } finally {
    process.env.OPENCLAW_VERSION = previous.OPENCLAW_VERSION;
    process.env.OPENCLAW_SERVICE_VERSION = previous.OPENCLAW_SERVICE_VERSION;
    process.env.npm_package_version = previous.npm_package_version;
  }
}

function testResolvePromptHookModeModern(): void {
  const mode = resolvePromptHookMode({ runtime: { version: "2026.3.28" } } as never);
  assert(mode === "modern", "expected modern hook mode for OpenClaw 2026.3.28");
}

function testResolvePromptHookModeLegacy(): void {
  const mode = resolvePromptHookMode({ runtime: { version: "2026.3.6" } } as never);
  assert(mode === "legacy", "expected legacy hook mode before 2026.3.7");
}

function testResolvePromptHookModeLegacyForUnknownVersion(): void {
  const mode = resolvePromptHookMode({ runtime: {} } as never);
  assert(mode === "legacy", "expected unknown host versions to fall back to legacy mode");
}

testExtractPromptFromString();
testExtractPromptPrefersSanitizedPromptField();
testExtractPromptFallsBackToLatestUserMessage();
testExtractPromptFromPromptField();
testExtractPromptFromStructuredContent();
testBuildAutoRecallContext();
testParseAndBuildTeamCollaborationContext();
testBuildClawMemPromptSection();
testResolveHostVersionFromRuntime();
testResolveHostVersionFromEnvFallback();
testIgnoresNpmPackageVersionFallback();
testResolvePromptHookModeModern();
testResolvePromptHookModeLegacy();
testResolvePromptHookModeLegacyForUnknownVersion();
testRegistersAlwaysOnMemoryPromptCapability();
testFallsBackToLegacyMemoryPromptSectionRegistration();
testOlderHostWithoutPromptRegistrationDoesNotWarn();
testModernHostWithoutPromptRegistrationWarns();
testSkipsAlwaysOnPromptWhenClawMemIsNotSelectedMemoryPlugin();
await testOlderModernHostInjectsPromptGuidanceViaPrependSystemContext();
await testBeforePromptBuildInjectsTeamCollaborationContext();
await testRepoTransferAutoRetargetsDefaultRepo();
await testMemoryRepoSetDefaultToolPersistsConfig();
await testTeamCollaborationConfigToolsPersistConfig();
await testOrgRepoCreateAndIssueCommentWorkflowTools();

console.log("service tests passed");
