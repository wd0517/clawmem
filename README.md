# clawmem

`clawmem` is a GitHub-backed conversation and memory plugin for OpenClaw.

**What it does:**
- Creates one `type:conversation` issue per session, mirrors the full transcript as comments.
- On session start: searches active memories by relevance and injects them into context.
- Before normal conversations, can also discover live team-collaboration state from org-owned config repos and inject it as team context.
- On session reset/end: best-effort writes a final conversation summary/title and stores durable memory candidates as `type:memory` issues.
- Lets agents inspect memory indexes and schema, fetch exact memories, update canonical facts in place, and write structured memories with `kind:*` and `topic:*` labels through plugin tools.
- Adds collaboration, discovery-first team workflow, generic issue, and issue-comment tools so teams can run shared org repos and task queues through the same backend.

---

## Install

```bash
openclaw plugins install @clawmem-ai/clawmem
openclaw plugins enable clawmem
openclaw config set plugins.slots.memory clawmem
openclaw config validate
openclaw gateway restart
```

After restart, confirm OpenClaw shows ClawMem as the active memory plugin. On first use, clawmem bootstraps each agent identity by calling `POST /api/v3/agents` on `git.clawmem.ai`, then writes the returned `token`, backend `login`, and `repo_full_name` back into your config under `plugins.entries.clawmem.config.agents.<agentId>` as that agent's `defaultRepo`. Automatic flows use that `defaultRepo`, while explicit memory tool calls may target other repos. When talking to an older backend that does not expose `POST /api/v3/agents`, the plugin falls back to the deprecated anonymous bootstrap path.

For team collaboration, ClawMem now auto-discovers org-owned config repos at runtime. It checks visible orgs for `<org>/config` first and then `<org>/clawmem-config`, scans open `type:team-config` issues, and selects the ones that list the current backend login. If exactly one team matches, ClawMem injects a focused `<clawmem-team-context>` block. If multiple teams match, it injects a `<clawmem-team-index>` block and only adds one focused team context when the current request uniquely identifies the target team. Legacy `teamConfigRepo` plus `teamConfigIssueNumber` overrides and agent-id keyed configs are still accepted as compatibility fallbacks, but they are no longer the recommended setup.

The package now also ships a bundled `clawmem` skill for runtime memory behavior:
- core recall and save loop
- post-install repair and verification guidance
- mental model, user-facing communication, and console-link guidance
- schema and manual-ops references
- collaboration routing for shared repos
- team-collaboration bootstrap and runtime docs
- shared task-queue workflow guidance for org-backed multi-agent teams

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
- team-collaboration scaffold setup plus runtime behavior
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
              login: "main-b54ea6",
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
              login: "main-b54ea6",
              defaultRepo: "owner/main-memory",
              token: "<token>",
              authScheme: "token"
            },
            coder: {
              login: "hazel-e23778",
              defaultRepo: "owner/coder-memory",
              token: "<token>"
            }
          },
          summaryWaitTimeoutMs: 120000,
          memoryExtractWaitTimeoutMs: 45000,
          memoryRecallLimit: 5,
          memoryAutoRecallLimit: 3
        }
      }
    }
  }
}
```

Team collaboration no longer requires `openclaw.json` pointers. The normal path is org/config discovery at runtime. Legacy `teamConfigRepo` plus `teamConfigIssueNumber` fields are still accepted as a compatibility override when discovery is unavailable or you need to force one specific config issue, but they are deprecated for day-to-day setup.

---

## Notes

- Conversation comments exclude tool calls, tool results, system messages, and heartbeat noise.
- Each `agent_end` mirrors conversation comments only; no background subagent-derived memory work runs after turns.
- Finalization performs one request-scoped summarize-and-capture pass: generate the final issue summary/title plus durable memory candidates, then store exact-deduplicated memories.
- Summary or memory-capture failures do not block finalization; the conversation issue still closes, and the mirrored transcript remains the durable source of truth for manual follow-up.
- Memory search and auto-recall only return open `type:memory` issues. Closed memory issues are treated as stale.
- ClawMem automatically injects a small set of relevant memories before each turn using the agent's default repo and the backend recall API. Auto-recall is best-effort and quietly skips injection when backend recall is unavailable.
- Always-on ClawMem prompt guidance uses the dedicated memory prompt-registration API on OpenClaw `2026.3.22+`. On `2026.3.7` through `2026.3.21`, ClawMem falls back to `before_prompt_build` `prependSystemContext`. Older hosts still support auto-recall, tools, and conversation mirroring, but they cannot inject the static always-on guidance.
- `memory_recall` uses the backend `/api/v3/search/issues` endpoint scoped to the current repo plus `label:"type:memory"`. When backend recall is unavailable, use `memory_list` or `memory_get` to inspect memories explicitly.
- Automatic durable capture happens when the session resets or ends. If a fact must be available immediately for later turns, use `memory_store` or `memory_update` explicitly instead of waiting for finalization.
- The plugin exposes memory tools, collaboration tools, a default-repo retarget tool, legacy team-config override tools, and generic issue/comment tools for mid-session use.
- Route resolution is now: agent identity supplies credentials, `defaultRepo` is the fallback memory space, and explicit tool calls may override repo per operation.
- `memory_store` accepts optional schema hints such as kind and topics; the plugin normalizes them into managed `kind:*` and `topic:*` labels.
- Memory issues no longer use `session:*` labels. Session linkage remains a conversation concern, not part of the durable memory schema.
- `memory_update` updates one existing memory issue in place; use it for evolving canonical facts or active tasks instead of creating a duplicate node.
- Conversation lifecycle is stored in native issue state (`open` while live, `closed` after finalize); memory lifecycle uses native issue state too (`open` active, `closed` stale).
- Memory extraction now prefers one atomic fact per memory item instead of bundling whole sessions into a single node.
- Memory issue bodies store the durable detail in a YAML `detail` field plus flat metadata such as `memory_hash` and logical `date`; this matches the current Console parser in `agent-git-service/web`.
- Shared task queues use ordinary issues plus reserved labels such as `queue:task`, `task-status:handling`, `task-status:done`, and `assignee:<login>`.
- `team_collaboration_config_set` and `team_collaboration_config_clear` remain available as legacy compatibility overrides, but normal team collaboration should rely on runtime org/config discovery instead of `openclaw.json` pointers.
