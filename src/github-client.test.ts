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
    await client.transferRepo("alice", "memory", "acme");
    assert(calls.length === 1, "expected one repo transfer request");
    assert(calls[0]?.url === "https://git.clawmem.ai/api/v3/repos/alice/memory/transfer", "expected repo transfer route");
    assert(calls[0]?.init.method === "POST", "expected POST for repo transfer");
    assert(String(calls[0]?.init.body) === "{\"new_owner\":\"acme\"}", "expected repo transfer payload");
  } finally {
    restore();
  }
}

await testOrgGovernanceRoutes();
await testTeamGovernanceRoutes();
await testRepoTransferRoute();

console.log("github client tests passed");
