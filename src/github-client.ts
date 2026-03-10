import type { ClawMemPluginConfig } from "./types.js";

type IssueResponse = {
  number: number;
  title?: string;
  body?: string;
  state?: string;
  labels?: Array<{ name?: string } | string>;
};

type RequestOptions = {
  allowNotFound?: boolean;
  allowValidationError?: boolean;
};

export class GitHubIssueClient {
  private readonly ensuredLabels = new Set<string>();

  constructor(
    private readonly config: ClawMemPluginConfig,
    private readonly log: {
      info?: (message: string) => void;
      warn?: (message: string) => void;
      error?: (message: string) => void;
      debug?: (message: string) => void;
    },
  ) {}

  async createIssue(params: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<IssueResponse> {
    return this.request<IssueResponse>(this.repoPath("issues"), {
      method: "POST",
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        labels: params.labels,
      }),
    });
  }

  async updateIssue(
    issueNumber: number,
    params: {
      title?: string;
      body?: string;
      state?: "open" | "closed";
      labels?: string[];
    },
  ): Promise<IssueResponse> {
    return this.request<IssueResponse>(this.repoPath(`issues/${issueNumber}`), {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  async getIssue(issueNumber: number): Promise<IssueResponse> {
    return this.request<IssueResponse>(this.repoPath(`issues/${issueNumber}`), {
      method: "GET",
    });
  }

  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.request(this.repoPath(`issues/${issueNumber}/comments`), {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.request(this.repoPath(`issues/${issueNumber}/labels`), {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }

  async listIssues(params: {
    labels?: string[];
    state?: "open" | "closed" | "all";
    page?: number;
    perPage?: number;
  }): Promise<IssueResponse[]> {
    const query = new URLSearchParams();
    query.set("state", params.state ?? "open");
    query.set("page", String(params.page ?? 1));
    query.set("per_page", String(params.perPage ?? 100));
    if (params.labels && params.labels.length > 0) {
      query.set("labels", params.labels.join(","));
    }
    return this.request<IssueResponse[]>(`${this.repoPath("issues")}?${query.toString()}`, {
      method: "GET",
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    await this.request(this.repoPath(`issues/${issueNumber}/labels/${encodeURIComponent(label)}`), {
      method: "DELETE",
    }, { allowNotFound: true });
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    if (!name.trim() || this.ensuredLabels.has(name)) {
      return;
    }
    await this.request(
      this.repoPath("labels"),
      {
        method: "POST",
        body: JSON.stringify({
          name,
          color,
          description,
        }),
      },
      { allowValidationError: true },
    );
    this.ensuredLabels.add(name);
  }

  private repoPath(suffix: string): string {
    return `repos/${this.config.repo}/${suffix}`;
  }

  private async request<T = void>(
    pathname: string,
    init: RequestInit,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.config.baseUrl || !this.config.token) {
      throw new Error("clawmem is not configured");
    }
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const response = await fetch(new URL(pathname, `${baseUrl}/`), {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization:
          this.config.authScheme === "bearer"
            ? `Bearer ${this.config.token}`
            : `token ${this.config.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 404 && options.allowNotFound) {
      return undefined as T;
    }
    if (response.status === 422 && options.allowValidationError) {
      return undefined as T;
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      this.log.warn?.(`clawmem: failed to parse API response: ${String(error)}`);
      return undefined as T;
    }
  }
}
