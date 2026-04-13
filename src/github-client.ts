// GitHub Issues API client for clawmem. No label caching — idempotent create-if-absent.
import { resolveLabelColor, labelDescription, extractLabelNames, isManagedLabel } from "./config.js";
import type { AgentRegistrationResponse, AnonymousSessionResponse, ClawMemResolvedRoute } from "./types.js";

export type IssueResponse = {
  id?: number;
  number: number;
  title?: string;
  body?: string;
  state?: string;
  state_reason?: string | null;
  locked?: boolean;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string; name?: string }>;
  user?: { login?: string; name?: string };
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  html_url?: string;
  url?: string;
};
type SearchIssuesResponse = { items?: IssueResponse[]; total_count?: number; incomplete_results?: boolean };
export type CommentResponse = {
  id?: number;
  body?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  url?: string;
  in_reply_to_id?: number | null;
  user?: { login?: string; name?: string };
};
type LabelResponse = { name?: string; color?: string; description?: string };
type PermissionMap = Record<string, boolean | undefined>;
export type RepoResponse = {
  name?: string;
  full_name?: string;
  description?: string;
  private?: boolean;
  owner?: { login?: string };
  permissions?: PermissionMap;
  role_name?: string;
};
type OrgResponse = {
  id?: number;
  login?: string;
  name?: string;
  description?: string;
  default_repository_permission?: string;
};
type TeamResponse = {
  id?: number;
  slug?: string;
  name?: string;
  description?: string;
  privacy?: string;
  permission?: string;
  role_name?: string;
  permissions?: PermissionMap;
};
type CollaboratorResponse = {
  id?: number;
  login?: string;
  name?: string;
  permissions?: PermissionMap;
  role_name?: string;
  organization_member?: boolean;
  outside_collaborator?: boolean;
  type?: string;
};
type RepositoryInvitationResponse = {
  id?: number;
  created_at?: string;
  permissions?: string;
  repository?: RepoResponse;
  invitee?: { login?: string; name?: string };
  inviter?: { login?: string; name?: string };
};
type TeamMembershipResponse = { state?: string; role?: string };
type OrganizationMembershipResponse = {
  state?: string;
  role?: string;
  organization?: OrgResponse;
  user?: CollaboratorResponse;
};
type InvitationResponse = {
  id?: number;
  role?: string;
  created_at?: string;
  expires_at?: string | null;
  email?: string;
  login?: string;
  organization?: OrgResponse;
  invitee?: { login?: string };
  inviter?: { login?: string };
  team_ids?: number[];
  teams?: TeamResponse[];
};
type ReqOpts = { allowNotFound?: boolean; allowValidationError?: boolean; omitAuth?: boolean };

export class GitHubIssueClient {
  constructor(private readonly config: ClawMemResolvedRoute, private readonly log: { warn?: (msg: string) => void }) {}

  repo(): string | undefined {
    return this.config.repo?.trim() || undefined;
  }
  defaultRepo(): string | undefined {
    return this.config.defaultRepo?.trim() || undefined;
  }

  async createIssue(params: {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    assignee?: string;
    state?: "open" | "closed";
    stateReason?: string;
  }): Promise<IssueResponse> {
    return this.req<IssueResponse>(this.repoPath("issues"), {
      method: "POST",
      body: JSON.stringify({
        title: params.title,
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(params.labels && params.labels.length > 0 ? { labels: params.labels } : {}),
        ...(params.assignees && params.assignees.length > 0 ? { assignees: params.assignees } : {}),
        ...(params.assignee ? { assignee: params.assignee } : {}),
        ...(params.state ? { state: params.state } : {}),
        ...(params.stateReason ? { state_reason: params.stateReason } : {}),
      }),
    });
  }
  async updateIssue(n: number, params: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: string;
    labels?: string[];
    assignees?: string[];
    locked?: boolean;
  }): Promise<IssueResponse> {
    return this.req<IssueResponse>(this.repoPath(`issues/${n}`), {
      method: "PATCH",
      body: JSON.stringify({
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(params.state !== undefined ? { state: params.state } : {}),
        ...(params.stateReason !== undefined ? { state_reason: params.stateReason } : {}),
        ...(params.labels !== undefined ? { labels: params.labels } : {}),
        ...(params.assignees !== undefined ? { assignees: params.assignees } : {}),
        ...(params.locked !== undefined ? { locked: params.locked } : {}),
      }),
    });
  }
  async getIssue(n: number): Promise<IssueResponse> {
    return this.req<IssueResponse>(this.repoPath(`issues/${n}`), { method: "GET" });
  }
  async createComment(issueNumber: number, body: string, params?: { inReplyTo?: number }): Promise<CommentResponse> {
    return this.req<CommentResponse>(this.repoPath(`issues/${issueNumber}/comments`), {
      method: "POST",
      body: JSON.stringify({
        body,
        ...(typeof params?.inReplyTo === "number" ? { in_reply_to: params.inReplyTo } : {}),
      }),
    });
  }
  async listComments(issueNumber: number, params?: {
    page?: number;
    perPage?: number;
    sort?: "created" | "updated";
    direction?: "asc" | "desc";
    since?: string;
    threaded?: boolean;
  }): Promise<CommentResponse[]> {
    const q = new URLSearchParams();
    q.set("page", String(params?.page ?? 1));
    q.set("per_page", String(params?.perPage ?? 100));
    if (params?.sort) q.set("sort", params.sort);
    if (params?.direction) q.set("direction", params.direction);
    if (params?.since) q.set("since", params.since);
    if (params?.threaded) q.set("threaded", "true");
    return this.req<CommentResponse[]>(`${this.repoPath(`issues/${issueNumber}/comments`)}?${q}`, { method: "GET" });
  }
  async listIssues(params: {
    labels?: string[];
    state?: "open" | "closed" | "all";
    assignee?: string;
    creator?: string;
    mentioned?: string;
    sort?: "created" | "updated" | "comments";
    direction?: "asc" | "desc";
    since?: string;
    page?: number;
    perPage?: number;
  }): Promise<IssueResponse[]> {
    const q = new URLSearchParams();
    q.set("state", params.state ?? "open"); q.set("page", String(params.page ?? 1)); q.set("per_page", String(params.perPage ?? 100));
    if (params.labels?.length) q.set("labels", params.labels.join(","));
    if (params.assignee) q.set("assignee", params.assignee);
    if (params.creator) q.set("creator", params.creator);
    if (params.mentioned) q.set("mentioned", params.mentioned);
    if (params.sort) q.set("sort", params.sort);
    if (params.direction) q.set("direction", params.direction);
    if (params.since) q.set("since", params.since);
    return this.req<IssueResponse[]>(`${this.repoPath("issues")}?${q}`, { method: "GET" });
  }
  async searchIssues(query: string, params?: { page?: number; perPage?: number }): Promise<IssueResponse[]> {
    const q = new URLSearchParams();
    q.set("q", query);
    q.set("page", String(params?.page ?? 1));
    q.set("per_page", String(params?.perPage ?? 100));
    const res = await this.req<SearchIssuesResponse>(`search/issues?${q}`, { method: "GET" });
    return Array.isArray(res?.items) ? res.items : [];
  }
  async listLabels(params?: { page?: number; perPage?: number }): Promise<LabelResponse[]> {
    const q = new URLSearchParams();
    q.set("page", String(params?.page ?? 1));
    q.set("per_page", String(params?.perPage ?? 100));
    return this.req<LabelResponse[]>(`${this.repoPath("labels")}?${q}`, { method: "GET" });
  }
  async listUserRepos(): Promise<RepoResponse[]> {
    return this.req<RepoResponse[]>("user/repos", { method: "GET" });
  }
  async createUserRepo(params: { name: string; description?: string; private?: boolean; autoInit?: boolean }): Promise<RepoResponse> {
    return this.req<RepoResponse>("user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: params.name,
        ...(params.description ? { description: params.description } : {}),
        private: params.private ?? true,
        auto_init: params.autoInit ?? false,
      }),
    });
  }
  async createOrgRepo(
    org: string,
    params: { name: string; description?: string; private?: boolean; autoInit?: boolean; hasIssues?: boolean; hasWiki?: boolean },
  ): Promise<RepoResponse> {
    return this.req<RepoResponse>(`orgs/${encodeURIComponent(org)}/repos`, {
      method: "POST",
      body: JSON.stringify({
        name: params.name,
        ...(params.description ? { description: params.description } : {}),
        private: params.private ?? true,
        auto_init: params.autoInit ?? false,
        ...(params.hasIssues !== undefined ? { has_issues: params.hasIssues } : {}),
        ...(params.hasWiki !== undefined ? { has_wiki: params.hasWiki } : {}),
      }),
    });
  }
  async listUserOrgs(): Promise<OrgResponse[]> {
    return this.req<OrgResponse[]>("user/orgs", { method: "GET" });
  }
  async createUserOrg(params: { login: string; name?: string; defaultRepositoryPermission?: string }): Promise<OrgResponse> {
    return this.req<OrgResponse>("user/orgs", {
      method: "POST",
      body: JSON.stringify({
        login: params.login,
        ...(params.name ? { name: params.name } : {}),
        ...(params.defaultRepositoryPermission ? { default_repository_permission: params.defaultRepositoryPermission } : {}),
      }),
    });
  }
  async getOrg(org: string): Promise<OrgResponse> {
    return this.req<OrgResponse>(`orgs/${encodeURIComponent(org)}`, { method: "GET" });
  }
  async listOrgMembers(org: string, role?: "admin"): Promise<CollaboratorResponse[]> {
    const q = new URLSearchParams();
    if (role) q.set("role", role);
    const suffix = q.toString();
    return this.req<CollaboratorResponse[]>(`orgs/${encodeURIComponent(org)}/members${suffix ? `?${suffix}` : ""}`, { method: "GET" });
  }
  async getOrgMembership(org: string, username: string): Promise<OrganizationMembershipResponse> {
    return this.req<OrganizationMembershipResponse>(
      `orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`,
      { method: "GET" },
    );
  }
  async removeOrgMember(org: string, username: string): Promise<void> {
    await this.req(`orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`, { method: "DELETE" });
  }
  async removeOrgMembership(org: string, username: string): Promise<void> {
    await this.req(`orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`, { method: "DELETE" });
  }
  async listOrgTeams(org: string): Promise<TeamResponse[]> {
    return this.req<TeamResponse[]>(`orgs/${encodeURIComponent(org)}/teams`, { method: "GET" });
  }
  async getTeam(org: string, teamSlug: string): Promise<TeamResponse> {
    return this.req<TeamResponse>(`orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`, { method: "GET" });
  }
  async createOrgTeam(org: string, params: { name: string; description?: string; privacy?: "closed" | "secret" }): Promise<TeamResponse> {
    return this.req<TeamResponse>(`orgs/${encodeURIComponent(org)}/teams`, {
      method: "POST",
      body: JSON.stringify({
        name: params.name,
        ...(params.description ? { description: params.description } : {}),
        privacy: params.privacy ?? "closed",
      }),
    });
  }
  async updateTeam(
    org: string,
    teamSlug: string,
    params: { name?: string; description?: string; privacy?: "closed" | "secret" },
  ): Promise<TeamResponse> {
    return this.req<TeamResponse>(`orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(params.name ? { name: params.name } : {}),
        ...(params.description ? { description: params.description } : {}),
        ...(params.privacy ? { privacy: params.privacy } : {}),
      }),
    });
  }
  async deleteTeam(org: string, teamSlug: string): Promise<void> {
    await this.req(`orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`, { method: "DELETE" });
  }
  async listTeamMembers(org: string, teamSlug: string): Promise<CollaboratorResponse[]> {
    return this.req<CollaboratorResponse[]>(
      `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/members`,
      { method: "GET" },
    );
  }
  async setTeamMembership(org: string, teamSlug: string, username: string, role: "member" | "maintainer"): Promise<TeamMembershipResponse> {
    return this.req<TeamMembershipResponse>(
      `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`,
      { method: "PUT", body: JSON.stringify({ role }) },
    );
  }
  async removeTeamMembership(org: string, teamSlug: string, username: string): Promise<void> {
    await this.req(
      `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`,
      { method: "DELETE" },
    );
  }
  async listTeamRepos(org: string, teamSlug: string): Promise<RepoResponse[]> {
    return this.req<RepoResponse[]>(`orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/repos`, { method: "GET" });
  }
  async setTeamRepoAccess(org: string, teamSlug: string, owner: string, repo: string, permission: "read" | "write" | "admin"): Promise<void> {
    await this.req(
      `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: "PUT", body: JSON.stringify({ permission }) },
    );
  }
  async removeTeamRepoAccess(org: string, teamSlug: string, owner: string, repo: string): Promise<void> {
    await this.req(
      `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: "DELETE" },
    );
  }
  async listRepoCollaborators(owner: string, repo: string): Promise<CollaboratorResponse[]> {
    return this.req<CollaboratorResponse[]>(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators`,
      { method: "GET" },
    );
  }
  async listRepoInvitations(owner: string, repo: string): Promise<RepositoryInvitationResponse[]> {
    return this.req<RepositoryInvitationResponse[]>(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/invitations`,
      { method: "GET" },
    );
  }
  async setRepoCollaborator(owner: string, repo: string, username: string, permission: "read" | "write" | "admin"): Promise<RepositoryInvitationResponse | undefined> {
    return this.req<RepositoryInvitationResponse>(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
      { method: "PUT", body: JSON.stringify({ permission }) },
    );
  }
  async removeRepoCollaborator(owner: string, repo: string, username: string): Promise<void> {
    await this.req(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
      { method: "DELETE" },
    );
  }
  async getRepo(owner: string, repo: string): Promise<RepoResponse> {
    return this.req<RepoResponse>(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { method: "GET" });
  }
  async listUserRepoInvitations(): Promise<RepositoryInvitationResponse[]> {
    return this.req<RepositoryInvitationResponse[]>("user/repository_invitations", { method: "GET" });
  }
  async acceptUserRepoInvitation(invitationId: number): Promise<void> {
    await this.req(`user/repository_invitations/${invitationId}`, { method: "PATCH" });
  }
  async declineUserRepoInvitation(invitationId: number): Promise<void> {
    await this.req(`user/repository_invitations/${invitationId}`, { method: "DELETE" });
  }
  async listOrgInvitations(org: string): Promise<InvitationResponse[]> {
    return this.req<InvitationResponse[]>(`orgs/${encodeURIComponent(org)}/invitations`, { method: "GET" });
  }
  async createOrgInvitation(
    org: string,
    params: { inviteeLogin: string; role?: "member" | "owner"; teamIds?: number[]; expiresInDays?: number },
  ): Promise<InvitationResponse> {
    return this.req<InvitationResponse>(`orgs/${encodeURIComponent(org)}/invitations`, {
      method: "POST",
      body: JSON.stringify({
        invitee_login: params.inviteeLogin,
        role: params.role ?? "member",
        ...(params.teamIds && params.teamIds.length > 0 ? { team_ids: params.teamIds } : {}),
        ...(typeof params.expiresInDays === "number" ? { expires_in_days: params.expiresInDays } : {}),
      }),
    });
  }
  async revokeOrgInvitation(org: string, invitationId: number): Promise<void> {
    await this.req(`orgs/${encodeURIComponent(org)}/invitations/${invitationId}`, { method: "DELETE" });
  }
  async listOrgOutsideCollaborators(org: string): Promise<CollaboratorResponse[]> {
    return this.req<CollaboratorResponse[]>(`orgs/${encodeURIComponent(org)}/outside_collaborators`, { method: "GET" });
  }
  async listUserOrgInvitations(): Promise<InvitationResponse[]> {
    return this.req<InvitationResponse[]>("user/organization_invitations", { method: "GET" });
  }
  async acceptUserOrgInvitation(invitationId: number): Promise<void> {
    await this.req(`user/organization_invitations/${invitationId}`, { method: "PATCH" });
  }
  async declineUserOrgInvitation(invitationId: number): Promise<void> {
    await this.req(`user/organization_invitations/${invitationId}`, { method: "DELETE" });
  }
  async transferRepo(owner: string, repo: string, newOwner: string): Promise<RepoResponse> {
    return this.req<RepoResponse>(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/transfer`, {
      method: "POST",
      body: JSON.stringify({ new_owner: newOwner }),
    });
  }
  async ensureLabels(labels: string[]): Promise<void> {
    for (const label of labels) {
      if (!label.trim()) continue;
      await this.req(this.repoPath("labels"), { method: "POST",
        body: JSON.stringify({ name: label, color: resolveLabelColor(label), description: labelDescription(label) }) }, { allowValidationError: true });
    }
  }
  async syncManagedLabels(issueNumber: number, desired: string[]): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    const unmanaged = extractLabelNames(issue.labels).filter((l) => !isManagedLabel(l));
    await this.updateIssue(issueNumber, { labels: [...new Set([...unmanaged, ...desired])] });
  }
  async getRepoInfo(): Promise<{ description?: string; name?: string }> {
    return this.req<{ description?: string; name?: string }>(this.repoPath("").replace(/\/$/, ""), { method: "GET" });
  }
  async updateRepoDescription(description: string): Promise<void> {
    await this.req(this.repoPath("").replace(/\/$/, ""), { method: "PATCH", body: JSON.stringify({ description }) });
  }
  async registerAgent(prefixLogin: string, defaultRepoName: string): Promise<AgentRegistrationResponse> {
    return this.req<AgentRegistrationResponse>("agents", {
      method: "POST",
      body: JSON.stringify({
        prefix_login: prefixLogin,
        default_repo_name: defaultRepoName,
      }),
    }, { omitAuth: true });
  }
  async createAnonymousSession(locale?: string): Promise<AnonymousSessionResponse> {
    const body = locale ? JSON.stringify({ locale }) : undefined;
    return this.req<AnonymousSessionResponse>("anonymous/session", { method: "POST", ...(body ? { body } : {}) }, { omitAuth: true });
  }

  private repoPath(suffix: string): string {
    if (!this.config.repo) throw new Error("clawmem repository is not configured");
    return `repos/${this.config.repo}/${suffix}`;
  }
  private async req<T = void>(pathname: string, init: RequestInit, opts: ReqOpts = {}): Promise<T> {
    if (!this.config.baseUrl) throw new Error("clawmem baseUrl is not configured");
    if (!opts.omitAuth && !this.config.token) throw new Error("clawmem token is not configured");
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "Content-Type": "application/json" };
    if (!opts.omitAuth) headers.Authorization = this.config.authScheme === "bearer" ? `Bearer ${this.config.token}` : `token ${this.config.token}`;
    const res = await fetch(new URL(pathname, `${base}/`), { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (res.status === 404 && opts.allowNotFound) return undefined as T;
    if (res.status === 422 && opts.allowValidationError) return undefined as T;
    if (!res.ok) { const d = await res.text(); throw new Error(`HTTP ${res.status}: ${d || res.statusText}`); }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text.trim()) return undefined as T;
    try { return JSON.parse(text) as T; } catch (e) { this.log.warn?.(`clawmem: failed to parse API response: ${String(e)}`); return undefined as T; }
  }
}
