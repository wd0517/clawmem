// GitHub Issues API client for clawmem. No label caching — idempotent create-if-absent.
import { resolveLabelColor, labelDescription, extractLabelNames, isManagedLabel } from "./config.js";
import type { AnonymousSessionResponse, ClawMemResolvedRoute } from "./types.js";

type IssueResponse = { number: number; title?: string; body?: string; state?: string; labels?: Array<{ name?: string } | string> };
type SearchIssuesResponse = { items?: IssueResponse[]; total_count?: number; incomplete_results?: boolean };
type CommentResponse = { id?: number; body?: string; created_at?: string };
type LabelResponse = { name?: string; color?: string; description?: string };
type ReqOpts = { allowNotFound?: boolean; allowValidationError?: boolean; omitAuth?: boolean };

export class GitHubIssueClient {
  constructor(private readonly config: ClawMemResolvedRoute, private readonly log: { warn?: (msg: string) => void }) {}

  repo(): string | undefined {
    return this.config.repo?.trim() || undefined;
  }

  async createIssue(params: { title: string; body: string; labels: string[] }): Promise<IssueResponse> {
    return this.req<IssueResponse>(this.repoPath("issues"), { method: "POST", body: JSON.stringify(params) });
  }
  async updateIssue(n: number, params: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] }): Promise<IssueResponse> {
    return this.req<IssueResponse>(this.repoPath(`issues/${n}`), { method: "PATCH", body: JSON.stringify(params) });
  }
  async getIssue(n: number): Promise<IssueResponse> {
    return this.req<IssueResponse>(this.repoPath(`issues/${n}`), { method: "GET" });
  }
  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.req(this.repoPath(`issues/${issueNumber}/comments`), { method: "POST", body: JSON.stringify({ body }) });
  }
  async listComments(issueNumber: number, params?: { page?: number; perPage?: number }): Promise<CommentResponse[]> {
    const q = new URLSearchParams();
    q.set("page", String(params?.page ?? 1));
    q.set("per_page", String(params?.perPage ?? 100));
    return this.req<CommentResponse[]>(`${this.repoPath(`issues/${issueNumber}/comments`)}?${q}`, { method: "GET" });
  }
  async listIssues(params: { labels?: string[]; state?: "open" | "closed" | "all"; page?: number; perPage?: number }): Promise<IssueResponse[]> {
    const q = new URLSearchParams();
    q.set("state", params.state ?? "open"); q.set("page", String(params.page ?? 1)); q.set("per_page", String(params.perPage ?? 100));
    if (params.labels?.length) q.set("labels", params.labels.join(","));
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
