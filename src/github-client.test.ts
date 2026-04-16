import { GitHubIssueClient } from "./github-client.js";
import type { ClawMemResolvedRoute } from "./types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

type FetchCall = { url: string; init: RequestInit };

function createClientRecorder(): {
  client: GitHubIssueClient;
  calls: FetchCall[];
  restore(): void;
} {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const method = init?.method ?? "GET";
    if (method === "DELETE" || method === "PATCH") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const route: ClawMemResolvedRoute = {
    agentId: "main",
    baseUrl: "https://git.clawmem.ai/api/v3",
    login: "main-user",
    defaultRepo: "alice/memory",
    repo: "alice/memory",
    token: "token-123",
    authScheme: "token",
  };

  return {
    client: new GitHubIssueClient(route, {}),
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function testOrgGovernanceRoutes(): Promise<void> {
  const { client, calls, restore } = createClientRecorder();
  try {
    await client.listOrgMembers("acme", "admin");
    await client.getOrgMembership("acme", "alice");
    await client.removeOrgMember("acme", "alice");
    await client.removeOrgMembership("acme", "alice");
    await client.revokeOrgInvitation("acme", 12);

    assert(calls[0]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/members?role=admin", "expected org member list route");
    assert(calls[1]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/memberships/alice", "expected org membership route");
    assert(calls[2]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/members/alice", "expected org member delete route");
    assert(calls[2]?.init.method === "DELETE", "expected DELETE for org member removal");
    assert(calls[3]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/memberships/alice", "expected org membership delete route");
    assert(calls[3]?.init.method === "DELETE", "expected DELETE for org membership removal");
    assert(calls[4]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/invitations/12", "expected org invitation revoke route");
    assert(calls[4]?.init.method === "DELETE", "expected DELETE for org invitation revoke");
  } finally {
    restore();
  }
}

async function testTeamGovernanceRoutes(): Promise<void> {
  const { client, calls, restore } = createClientRecorder();
  try {
    await client.getTeam("acme", "platform");
    await client.updateTeam("acme", "platform", { name: "Platform Eng", description: "Core platform", privacy: "closed" });
    await client.deleteTeam("acme", "platform");
    await client.listTeamMembers("acme", "platform");

    assert(calls[0]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/teams/platform", "expected team get route");
    assert(calls[1]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/teams/platform", "expected team update route");
    assert(calls[1]?.init.method === "PATCH", "expected PATCH for team update");
    assert(String(calls[1]?.init.body).includes("\"name\":\"Platform Eng\""), "expected team update payload to include name");
    assert(calls[2]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/teams/platform", "expected team delete route");
    assert(calls[2]?.init.method === "DELETE", "expected DELETE for team delete");
    assert(calls[3]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/teams/platform/members", "expected team members route");
  } finally {
    restore();
  }
}

async function testRepoTransferRoute(): Promise<void> {
  const { client, calls, restore } = createClientRecorder();
  try {
    await client.transferRepo("alice", "memory", "acme", "hazel-e23778");
    await client.renameRepo("acme", "memory", "hazel-e23778");
    assert(calls.length === 2, "expected transfer and rename requests");
    assert(calls[0]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/transfer", "expected repo transfer route");
    assert(calls[0]?.init.method === "POST", "expected POST for repo transfer");
    assert(String(calls[0]?.init.body) === "{\"new_owner\":\"acme\",\"new_repo_name\":\"hazel-e23778\"}", "expected repo transfer payload");
    assert(calls[1]?.url === "https://git.clawmem.ai/api/v3/repos/acme/memory", "expected repo rename route");
    assert(calls[1]?.init.method === "PATCH", "expected PATCH for repo rename");
    assert(String(calls[1]?.init.body) === "{\"name\":\"hazel-e23778\"}", "expected repo rename payload");
  } finally {
    restore();
  }
}

async function testCurrentUserRoute(): Promise<void> {
  const { client, calls, restore } = createClientRecorder();
  try {
    await client.getCurrentUser();
    assert(calls.length === 1, "expected one current user request");
    assert(calls[0]?.url === "https://git.clawmem.ai/api/v3/user", "expected current user route");
    assert(calls[0]?.init.method === "GET", "expected GET for current user route");
  } finally {
    restore();
  }
}

async function testOrgRepoAndIssueRoutes(): Promise<void> {
  const { client, calls, restore } = createClientRecorder();
  try {
    await client.createOrgRepo("acme", {
      name: "collaboration-workspace",
      description: "Shared collaboration workspace",
      private: true,
      autoInit: true,
      hasIssues: true,
      hasWiki: false,
    });
    await client.createIssue({
      title: "Review gh-server issues",
      body: "List issues that can be closed.",
      labels: ["workflow:task", "status:handling", "owner:agent-a"],
      assignees: ["agent-a"],
      state: "open",
    });
    await client.listIssues({
      state: "open",
      labels: ["workflow:task", "status:handling"],
      assignee: "agent-a",
      sort: "updated",
      direction: "desc",
      since: "2026-04-13T00:00:00Z",
      perPage: 5,
    });
    await client.getIssue(42);
    await client.updateIssue(42, {
      state: "closed",
      stateReason: "completed",
      labels: ["workflow:task", "status:done", "owner:agent-a"],
      assignees: [],
    });
    await client.createComment(42, "Done. See the findings below.");
    await client.listComments(42, {
      perPage: 1,
      sort: "updated",
      direction: "desc",
      since: "2026-04-13T00:00:00Z",
      threaded: true,
    });

    assert(calls[0]?.url === "https://git.clawmem.ai/api/v3/orgs/acme/repos", "expected org repo create route");
    assert(calls[0]?.init.method === "POST", "expected POST for org repo create");
    assert(String(calls[0]?.init.body).includes("\"name\":\"collaboration-workspace\""), "expected org repo create payload to include repo name");
    assert(String(calls[0]?.init.body).includes("\"has_wiki\":false"), "expected org repo create payload to include has_wiki");

    assert(calls[1]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/issues", "expected issue create route");
    assert(calls[1]?.init.method === "POST", "expected POST for issue create");
    assert(String(calls[1]?.init.body).includes("\"labels\":[\"workflow:task\",\"status:handling\",\"owner:agent-a\"]"), "expected issue create payload to include labels");
    assert(String(calls[1]?.init.body).includes("\"assignees\":[\"agent-a\"]"), "expected issue create payload to include assignees");

    assert(
      calls[2]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/issues?state=open&page=1&per_page=5&labels=workflow%3Atask%2Cstatus%3Ahandling&assignee=agent-a&sort=updated&direction=desc&since=2026-04-13T00%3A00%3A00Z",
      "expected issue list query params",
    );
    assert(calls[3]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/issues/42", "expected issue get route");
    assert(calls[4]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/issues/42", "expected issue update route");
    assert(calls[4]?.init.method === "PATCH", "expected PATCH for issue update");
    assert(String(calls[4]?.init.body).includes("\"state_reason\":\"completed\""), "expected issue update payload to include state_reason");
    assert(String(calls[4]?.init.body).includes("\"assignees\":[]"), "expected issue update payload to allow clearing assignees");

    assert(calls[5]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/issues/42/comments", "expected issue comment create route");
    assert(calls[5]?.init.method === "POST", "expected POST for comment create");
    assert(calls[6]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/issues/42/comments?page=1&per_page=1&sort=updated&direction=desc&since=2026-04-13T00%3A00%3A00Z&threaded=true", "expected issue comments list query params");
  } finally {
    restore();
  }
}

await testOrgGovernanceRoutes();
await testTeamGovernanceRoutes();
await testRepoTransferRoute();
await testCurrentUserRoute();
await testOrgRepoAndIssueRoutes();

console.log("github client tests passed");
