# clawmem

`clawmem` is a GitHub-backed conversation and memory plugin for OpenClaw.

**What it does:**
- Creates one `type:conversation` issue per session, mirrors the full transcript as comments.
- On session start: searches active memories by relevance and injects them into context.
- On session reset/end: best-effort writes a final conversation summary/title and stores durable memory candidates as `type:memory` issues.
- Lets agents inspect memory indexes and schema, fetch exact memories, update canonical facts in place, and write structured memories with `kind:*` and `topic:*` labels through plugin tools.
- Adds atomic collaboration tools for organizations, repos, teams, invitations, access, issues, and comments.
- Does not ship any built-in Team workflow or Team template.

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

ClawMem installs only the core memory plugin and its core runtime skill. If you want Team setup or Team workflow templates, install an external ClawMem Team skill pack such as `clawmem-team-skills`.

Earlier ClawMem versions bundled Team workflow guidance. That guidance has moved to an external ClawMem Team skill repository such as `clawmem-team-skills`. If you are upgrading from an older setup, install the external Team skill pack before following any Team-related docs.

The package ships a bundled `clawmem` skill for core runtime memory behavior:
- core recall and save loop
- post-install repair and verification guidance
- mental model, user-facing communication, and console-link guidance
- schema and manual-ops references
- collaboration routing for shared repos and access primitives

The website `SKILL.md` should stay bootstrap-focused. Once the plugin is installed, rely on the bundled plugin skill for day-to-day memory behavior.

## Optional Team Skills

ClawMem plugin = memory + atomic collaboration capability.

external ClawMem Team skill pack = Team design + Team bootstrap + Team templates.

If you want a Team, install that repository separately and use one of its entry skills. The plugin package is not the source of truth for Team workflows.

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
- Shared memory can live in shared repos instead of one agent's private default repo.
- How multiple agents organize around those repos is defined by external skills, not by the plugin.
- Use plugin tools first. Raw `gh` or `curl` are fallback tools for explicit repo operations, backend debugging, or tool outages.

## Bundled Skill And Docs

The plugin package is the runtime source of truth for ClawMem core behavior:

- Bundled runtime skill: [`skills/clawmem/SKILL.md`](skills/clawmem/SKILL.md)
- Runtime references: [`skills/clawmem/references/`](skills/clawmem/references/)
- Setup/bootstrap guide: the website `SKILL.md`

That bundled skill covers:
- recall and save behavior
- schema discipline and deliberate self-evolution
- shared-memory and collaboration primitives
- repair and verification guidance
- raw `gh` / `curl` fallback flows

Team setup guides, Team workflow guides, and Team templates live in an external ClawMem Team skill pack such as `clawmem-team-skills`.

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
- The plugin exposes memory tools, collaboration tools, a default-repo retarget tool, and generic issue/comment tools for mid-session use.
- Route resolution is now: agent identity supplies credentials, `defaultRepo` is the fallback memory space, and explicit tool calls may override repo per operation.
- `memory_store` accepts optional schema hints such as kind and topics; the plugin normalizes them into managed `kind:*` and `topic:*` labels.
- Memory issues no longer use `session:*` labels. Session linkage remains a conversation concern, not part of the durable memory schema.
- `memory_update` updates one existing memory issue in place; use it for evolving canonical facts or active tasks instead of creating a duplicate node.
- Conversation lifecycle is stored in native issue state (`open` while live, `closed` after finalize); memory lifecycle uses native issue state too (`open` active, `closed` stale).
- Memory extraction now prefers one atomic fact per memory item instead of bundling whole sessions into a single node.
- Memory issue bodies store the durable detail in a YAML `detail` field plus flat metadata such as `memory_hash` and logical `date`; this matches the current Console parser in `agent-git-service/web`.
- If your environment still exposes older Team-specific reminders from the plugin package, treat them as deprecated compatibility content and follow your external ClawMem Team skill pack for current Team setup guidance.
