# clawmem

`clawmem` is a GitHub-backed conversation and memory plugin for OpenClaw.

**What it does:**
- Creates one `type:conversation` issue per session, mirrors the full transcript as comments.
- During request-scoped hooks: best-effort extracts durable memories and stores each as a `type:memory` issue.
- On session start: searches active memories by relevance and injects them into context.
- Lets agents inspect memory indexes and schema, fetch exact memories, update canonical facts in place, and write structured memories with `kind:*` and `topic:*` labels through plugin tools.

---

## Install

```bash
openclaw plugins install @clawmem-ai/clawmem
openclaw plugins enable clawmem
openclaw config set plugins.slots.memory clawmem
openclaw config validate
openclaw gateway restart
```

After restart, confirm OpenClaw shows ClawMem as the active memory plugin. On first use, clawmem bootstraps each agent identity by calling `POST /api/v3/agents` on `git.clawmem.ai`, then writes the returned `token` plus `repo_full_name` back into your config under `plugins.entries.clawmem.config.agents.<agentId>` as that agent's `defaultRepo`. Automatic flows use that `defaultRepo`, while explicit memory tool calls may target other repos. When talking to an older backend that does not expose `POST /api/v3/agents`, the plugin falls back to the deprecated anonymous bootstrap path.

The package now also ships a bundled `clawmem` skill for runtime memory behavior:
- core recall and save loop
- post-install repair and verification guidance
- mental model, user-facing communication, and console-link guidance
- schema and manual-ops references
- collaboration routing for shared repos

The website `SKILL.md` should stay bootstrap-focused. Once the plugin is installed, rely on the bundled plugin skill for day-to-day memory behavior.

---

## Publishing

This repo publishes `@clawmem-ai/clawmem` through GitHub Actions using npm trusted publishing.

Before the workflow can publish successfully, configure the package on npmjs.com with this trusted publisher:

- Organization or user: `clawmem-ai`
- Repository: `clawmem-openclaw-plugin`
- Workflow filename: `release.yml`

Release flow:

1. Bump `package.json` to the version you want to ship.
2. Create and push a matching tag such as `0.1.6`.
3. GitHub Actions runs `.github/workflows/release.yml` and publishes with OIDC. No long-lived `NPM_TOKEN` secret is required.

The workflow intentionally publishes from a tag push instead of `workflow_dispatch`, because npm validates the workflow filename exactly when using trusted publishing.

---

## Runtime Model

ClawMem is OpenClaw's durable memory system.

- Durable facts, preferences, decisions, workflows, and active-task state belong in ClawMem memory issues.
- Files remain for tools or humans to read directly.
- Memory routing is per agent identity: `plugins.entries.clawmem.config.agents.<agentId>.defaultRepo` is the default space, and explicit tool calls may target other repos.
- Shared or team memory should live in a shared repo, not in one agent's private default repo.
- Use plugin tools first. Raw `gh` or `curl` are fallback tools for explicit repo operations, backend debugging, or tool outages.

## Bundled Skill And Docs

The plugin package is now the runtime source of truth:

- Bundled runtime skill: [`skills/clawmem/SKILL.md`](skills/clawmem/SKILL.md)
- Runtime references: [`skills/clawmem/references/`](skills/clawmem/references/)
- Setup/bootstrap guide: the website `SKILL.md`

That bundled skill covers:
- recall and save behavior
- schema discipline and deliberate self-evolution
- shared-memory and collaboration routing
- repair and verification guidance
- raw `gh` / `curl` fallback flows

If your environment still relies on file-injected reminders such as `SOUL.md`, `AGENTS.md`, or `TOOLS.md`, treat them as optional compatibility snippets rather than the primary runtime source of truth.

---

## Config Reference

Minimal config (after auto-provisioning):

```json5
{
  plugins: {
    entries: {
      clawmem: {
        enabled: true,
        config: {
          baseUrl: "https://git.clawmem.ai/api/v3",
          authScheme: "token",
          agents: {
            main: {
              baseUrl: "https://git.clawmem.ai/api/v3",
              defaultRepo: "owner/main-memory",
              token: "<token>",
              authScheme: "token"
            }
          }
        }
      }
    }
  }
}
```

`repo` is still accepted as a legacy alias, but new installs should use `defaultRepo`.

Full config with all options:

```json5
{
  plugins: {
    entries: {
      clawmem: {
        enabled: true,
        config: {
          baseUrl: "https://git.clawmem.ai/api/v3",
          authScheme: "token",
          agents: {
            main: {
              baseUrl: "https://git.clawmem.ai/api/v3",
              defaultRepo: "owner/main-memory",
              token: "<token>",
              authScheme: "token"
            },
            coder: {
              defaultRepo: "owner/coder-memory",
              token: "<token>"
            }
          },
          turnCommentDelayMs: 1000,
          summaryWaitTimeoutMs: 120000,
          memoryRecallLimit: 5
        }
      }
    }
  }
}
```

---

## Notes

- Conversation comments exclude tool calls, tool results, system messages, and heartbeat noise.
- Summary failures do not block finalization; the `summary` field is written as `failed: ...`.
- Memory search and auto-injection only return open `type:memory` issues. Closed memory issues are treated as stale.
- `memory_recall` now prefers the backend `/api/v3/search/issues` endpoint scoped to the current repo plus `label:"type:memory"`; if backend search fails, clawmem falls back to local lexical ranking.
- Durable memories are extracted best-effort during later request-scoped maintenance, not by background subagent work after a request has already ended.
- The plugin exposes `memory_repos`, `memory_repo_create`, `memory_list`, `memory_get`, `memory_labels`, `memory_recall`, `memory_store`, `memory_update`, and `memory_forget` for mid-session use.
- Route resolution is now: agent identity supplies credentials, `defaultRepo` is the fallback memory space, and explicit tool calls may override repo per operation.
- `memory_store` accepts optional schema hints such as kind and topics; the plugin normalizes them into managed `kind:*` and `topic:*` labels.
- Memory issues no longer use `session:*` labels. Session linkage remains a conversation concern, not part of the durable memory schema.
- `memory_update` updates one existing memory issue in place; use it for evolving canonical facts or active tasks instead of creating a duplicate node.
- Conversation lifecycle is stored in native issue state (`open` while live, `closed` after finalize); memory lifecycle uses native issue state too (`open` active, `closed` stale).
- Memory issue bodies store the durable detail plus flat metadata such as `memory_hash` and logical `date`; labels are reserved for schema and routing.
