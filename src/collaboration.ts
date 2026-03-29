export type CollaborationPermission = "read" | "write" | "admin";
export type CollaborationOrgInvitationRole = "member" | "owner";

type PermissionMap = Record<string, boolean | undefined>;

export type CollaborationRepoSummary = {
  full_name?: string;
  owner?: { login?: string };
  name?: string;
  permissions?: PermissionMap;
  role_name?: string;
};

export type CollaborationTeamSummary = {
  id?: number;
  slug?: string;
  name?: string;
  description?: string;
  privacy?: string;
  permission?: string;
  role_name?: string;
  permissions?: PermissionMap;
};

export type CollaborationCollaboratorSummary = {
  id?: number;
  login?: string;
  name?: string;
  permissions?: PermissionMap;
  role_name?: string;
  organization_member?: boolean;
  outside_collaborator?: boolean;
  type?: string;
};

type RepoAccessTeamClient = {
  listOrgTeams(org: string): Promise<CollaborationTeamSummary[]>;
  listTeamRepos(org: string, teamSlug: string): Promise<CollaborationRepoSummary[]>;
};

export function normalizePermissionAlias(value: unknown): "none" | CollaborationPermission | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "none") return "none";
  if (normalized === "read" || normalized === "pull" || normalized === "triage") return "read";
  if (normalized === "write" || normalized === "push" || normalized === "maintain") return "write";
  if (normalized === "admin") return "admin";
  return undefined;
}

export function resolveOrgInvitationRole(
  value: unknown,
  fallback: CollaborationOrgInvitationRole,
): { role: CollaborationOrgInvitationRole } | { error: string } {
  if (value === undefined || value === null || value === "") return { role: fallback };
  if (typeof value !== "string") return { error: "role must be member or owner." };
  const normalized = value.trim().toLowerCase();
  if (normalized === "member" || normalized === "owner") return { role: normalized };
  return { error: `Unsupported role "${value}". Use member or owner.` };
}

export function repoSummaryFullName(repo?: CollaborationRepoSummary): string | undefined {
  const fullName = repo?.full_name?.trim();
  if (fullName) return fullName;
  const owner = repo?.owner?.login?.trim();
  const name = repo?.name?.trim();
  if (owner && name) return `${owner}/${name}`;
  return name || undefined;
}

export function filterDirectCollaborators(
  collaborators: CollaborationCollaboratorSummary[],
  ownerLogin: string,
): CollaborationCollaboratorSummary[] {
  const owner = ownerLogin.trim().toLowerCase();
  if (!owner) return collaborators;
  return collaborators.filter((collaborator) => (collaborator.login?.trim().toLowerCase() || "") !== owner);
}

export async function listRepoAccessTeams(
  client: RepoAccessTeamClient,
  org: string,
  fullName: string,
): Promise<{ teams: CollaborationTeamSummary[]; notes: string[] }> {
  const notes: string[] = [];
  const teams = await client.listOrgTeams(org);
  const withAccess: CollaborationTeamSummary[] = [];
  for (const team of teams) {
    const teamSlug = team.slug?.trim() || team.name?.trim();
    if (!teamSlug) {
      notes.push(`Skipped a team in org "${org}" because it had no slug or name.`);
      continue;
    }
    try {
      const repos = await client.listTeamRepos(org, teamSlug);
      const matchingRepo = repos.find((repo) => repoSummaryFullName(repo) === fullName);
      if (!matchingRepo) continue;
      withAccess.push({
        ...team,
        ...(matchingRepo.permissions ? { permissions: matchingRepo.permissions } : {}),
        ...(matchingRepo.role_name ? { role_name: matchingRepo.role_name } : {}),
      });
    } catch (error) {
      notes.push(`Team repo lookup failed for ${org}/${teamSlug}: ${String(error)}`);
    }
  }
  return { teams: withAccess, notes };
}
