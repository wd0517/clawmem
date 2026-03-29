import {
  filterDirectCollaborators,
  listRepoAccessTeams,
  repoSummaryFullName,
  resolveOrgInvitationRole,
} from "./collaboration.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function testOrgInvitationRoleValidation(): void {
  const fallback = resolveOrgInvitationRole(undefined, "member");
  assert("role" in fallback && fallback.role === "member", "expected undefined role to fall back to member");

  const owner = resolveOrgInvitationRole("owner", "member");
  assert("role" in owner && owner.role === "owner", "expected owner role to pass through");

  const invalid = resolveOrgInvitationRole("admin", "member");
  assert("error" in invalid, "expected admin to be rejected because backend expects owner");
}

function testDirectCollaboratorFiltering(): void {
  const collaborators = filterDirectCollaborators([
    { login: "Acme" },
    { login: "alice", outside_collaborator: true },
    { login: "bob", organization_member: true },
  ], "acme");

  assert(collaborators.length === 2, "expected owner row to be excluded from explicit collaborators");
  assert(collaborators[0]?.login === "alice", "expected alice to remain after owner filtering");
  assert(collaborators[1]?.login === "bob", "expected bob to remain after owner filtering");
}

function testRepoSummaryFallback(): void {
  assert(repoSummaryFullName({ full_name: "acme/project" }) === "acme/project", "expected explicit full_name to win");
  assert(repoSummaryFullName({ owner: { login: "acme" }, name: "project" }) === "acme/project", "expected owner/name fallback to work");
}

async function testRepoAccessTeamsDerivation(): Promise<void> {
  const result = await listRepoAccessTeams({
    async listOrgTeams() {
      return [
        { slug: "admins", name: "admins" },
        { slug: "writers", name: "writers" },
        { slug: "broken", name: "broken" },
      ];
    },
    async listTeamRepos(_org: string, teamSlug: string) {
      if (teamSlug === "admins") return [{ full_name: "acme/project", role_name: "admin" }];
      if (teamSlug === "writers") return [{ owner: { login: "acme" }, name: "project", role_name: "write" }];
      if (teamSlug === "broken") throw new Error("boom");
      return [];
    },
  }, "acme", "acme/project");

  assert(result.teams.length === 2, "expected two teams with access to be discovered via org->team->repo traversal");
  assert(result.teams[0]?.slug === "admins", "expected admins team to be included");
  assert(result.teams[1]?.slug === "writers", "expected writers team to be included");
  assert(result.notes.length === 1 && result.notes[0]?.includes("broken"), "expected per-team lookup failures to be recorded as notes");
}

async function main(): Promise<void> {
  testOrgInvitationRoleValidation();
  testDirectCollaboratorFiltering();
  testRepoSummaryFallback();
  await testRepoAccessTeamsDerivation();
  console.log("collaboration tests passed");
}

await main();
