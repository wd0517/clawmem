---
name: clawmem
description: Durable memory workflows for the ClawMem OpenClaw plugin. Use when ClawMem is installed and you need to recall prior preferences, project history, facts, decisions, lessons, workflows, active tasks, or shared memory; save or update durable knowledge with the ClawMem memory tools; choose the right memory repo; manage shared memory spaces, organizations, teams, collaborators, invitations, outside collaborators, or repo-access governance in the ClawMem backend; or troubleshoot ClawMem setup and manual repo-backed operations.
---

# ClawMem

ClawMem is the active long-term memory system for this OpenClaw installation. It runs on a GitHub-compatible repo and issue backend, so plugin tools are the default path and raw `gh` or `curl` are only fallbacks for explicit repo operations, backend debugging, or tool outages.

## Operating model

Without ClawMem, each session starts from zero. With it, what the agent learns persists across time and shapes future requests.

Use each persistence layer for one clear purpose:
- ClawMem issues: durable memories for the agent to remember later
- Files: outputs for tools or humans to read directly
- Config files: connection and environment state

If you are writing something so the agent remembers it later, it belongs in ClawMem. If you are writing something for a tool or human to read, write a file instead.

Memory hygiene matters: lock important insights deliberately, update canonical facts instead of spawning duplicates, and retire stale memories when reality changes.

## What the plugin already does

The ClawMem plugin automatically handles:
- Per-agent provisioning of credentials plus a default memory repo
- Session mirroring into `type:conversation` issues
- Best-effort automatic memory recall before each turn, scoped to the current agent's `defaultRepo`
- A best-effort final issue summary/title plus durable memory capture when the session resets or ends normally
- Mid-session memory tools: `memory_repos`, `memory_repo_create`, `memory_list`, `memory_get`, `memory_labels`, `memory_recall`, `memory_store`, `memory_update`, and `memory_forget`
- Shared-workflow tools for collaboration routing, default repo retargeting, generic issues, and issue comments

## Mandatory turn loop

On every user turn, run this loop:

1. Before answering, ask: could ClawMem improve this answer?
   - Default to yes for user preferences, project history, prior decisions, lessons, conventions, terminology, recurring problems, and active tasks.
   - Auto-recall may already inject useful context from the current agent's `defaultRepo`, but it is only a hint. Do not treat missing auto-recall context as proof that no relevant memory exists.
   - Auto-recall does not currently fan out across every accessible repo. Shared organization memory and project memory outside the current `defaultRepo` will not be recalled automatically.
   - Before explicit memory work, choose the right repo. If unclear, inspect `memory_repos` and fall back to the agent's `defaultRepo`. If the likely memory lives outside the default repo, use explicit repo selection instead of relying on auto-recall.
   - Use `memory_recall` when injected context is missing, weak, cross-repo, high-stakes, or when you need an explicit retrieval trace.
   - Write `memory_recall.query` as a short natural-language intent. Do not paste long code blocks, full logs, tool chatter, or system prompt text unless the exact wording is necessary.
   - When the question spans more than one angle, run more than one recall query across keywords, topics, synonyms, and likely project phrasing.
   - If `memory_recall` is weak or empty and the answer depends on whether a memory exists, cross-check with `memory_list`.
   - If the first recall pass is weak, broaden with shorter terms, adjacent topics, or alternate phrasing before concluding a miss.
   - If a specific memory id or issue number is mentioned, use `memory_get`.
   - Never treat a `memory_recall` miss by itself as proof that no relevant memory exists.
2. After answering, ask: did this turn create durable knowledge?
   - Default to yes for corrections, preferences, decisions, workflows, lessons, and status changes.
   - Automatic capture happens at session finalization and is best-effort. If a fact must be durable immediately, or the next turn will depend on it, write it explicitly with `memory_store` or `memory_update` instead of waiting for session end.
   - Prefer one durable fact per memory. If a turn contains several independent facts, save them separately instead of bundling them into one summary memory.
   - Use `memory_update` when the same canonical fact or ongoing task should keep evolving as one node.
   - When updating an existing memory, preserve that node's current language unless the user explicitly asks for a rewrite.
   - Use `memory_store` when this is a genuinely new memory.
   - When using `memory_store`, pass both `title` and `detail` when you can. Keep the title concise and human-readable, and keep `detail` as the full durable fact.
   - When using `memory_update`, pass `title` as well if the existing title is too short, outdated, or less precise than the current canonical fact.
   - Keep one durable fact per memory. Do not bundle unrelated facts, temporary requests, tool chatter, or startup boilerplate into one saved node.
   - For new memories, write the memory title and body in the user's current language by default.
   - Use `memory_forget` when a memory is stale, superseded, or harmful if reused.
   - Trigger-phrase reflex: when the user's message contains one of the signals below, writing memory is not optional — pick the indicated kind and save, or `memory_update` the canonical node if one already exists.

     | Signal from the user | Kind to save |
     |---|---|
     | "no", "don't", "stop doing that", "下次不要这样", "别这样", an explicit correction, an apology accepted after a mistake | `kind:lesson` |
     | "yes exactly", "perfect, keep doing that", "这就是我要的", validation of a non-obvious choice you made | `kind:lesson` (what worked and why) or `kind:skill` if it was a multi-step procedure |
     | "always / never", "from now on", "as a rule", naming/style/tool preferences, agreed policies | `kind:convention` |
     | Identity, role, long-term goal, team, stable project fact, unchanging constraint | `kind:core-fact` |
     | A non-trivial procedure that succeeded (several tool calls, trial and error, course changes) or one the user explicitly asks you to remember | `kind:skill` |
     | Ongoing work that will be referenced across turns or sessions | `kind:task` |

     If two or more `kind:lesson` memories start pointing at the same corrective direction, promote them to one `kind:skill` and close the originals with `superseded-by: #N` in the body — see [references/review.md](references/review.md).
   - "Skill" in this skill always means a ClawMem `kind:skill` memory — an issue written through `memory_store` / `memory_update` using the YAML body template in [references/schema.md § Skill body template](references/schema.md#skill-body-template-kindskill). When the user says "沉淀成 skill", "存成 skill", "记住这个流程", "remember this procedure", or similar, they mean a `kind:skill` memory, not a file-based skill package. Do not invoke the file-based `skill-creator` or write `skills/<name>/SKILL.md` in response to these phrases. Only generate a file-based skill package when the user explicitly asks for one ("打包成 skill 文件", "make a skill package", naming an on-disk path).
   - Before your first `memory_store` with `kind:skill` in a session, read [references/schema.md § Skill body template](references/schema.md#skill-body-template-kindskill) and write the initial `detail` body using that YAML skeleton (`trigger` / `steps` / `checks` / `last_validated` / `evidence`). Do not save the skill as free-form prose and plan to "clean it up later" — the first save should already be in the canonical shape so future `memory_update` calls can refine it in place.
3. Periodically self-review.
   - Every ~8–10 user turns, after a completed task, or when a `<clawmem-review-nudge>` block appears in context, run the review protocol in [references/review.md](references/review.md) before the next turn completes.
   - The `memory_review` tool returns the latest review checklist. Call it when you want a compact reminder of what to look for, or when the user explicitly asks for a memory or skill review.
   - Review is where `kind:skill` and `kind:lesson` actually accumulate; do not rely on session finalization alone.
4. Keep the user posted.
   - If a retrieved memory materially shaped the answer, briefly surface that fact in the user's current language.
   - Include the memory id and title only when they help with debugging, traceability, or an explicit user request.
   - After creating or updating a memory, give a short confirmation in the user's current language instead of forcing fixed English phrasing.

Bias toward saving, and use explicit retrieval whenever auto-recall is absent, weak, cross-repo, or too ambiguous to trust on its own. Do not assume a just-finished turn has already been captured as durable memory unless you explicitly wrote it or later verified it after the session finalized.

## Retrieval and storage rules

- Before inventing a new `kind` or `topic`, call `memory_labels` and reuse the existing schema when possible.
- If no current label fits, create one new stable machine-readable label within `kind:*` or `topic:*`. Do not create translated variants or near-duplicate synonyms of an existing label.
- Reuse stable labels over one-off labels.
- Private personal memory usually belongs in the agent's `defaultRepo`.
- Project memory belongs in the relevant project repo.
- Shared or team knowledge belongs in the shared repo for that group.
- Shared or team knowledge in another repo is not part of default auto-recall today. To use it, select that repo explicitly with `memory_recall`, `memory_list`, or `memory_get`.
- Memory titles and bodies default to the user's current language for new memories.
- Prefer a short standalone title plus a fuller `detail` body instead of stuffing the whole memory into the title.
- If you omit `title`, the plugin may derive it from `detail`, but providing an explicit title is preferred for readability in the Console.
- When updating an existing memory, keep that node in its current language unless the user explicitly asks to rewrite it.
- Keep schema labels and machine-oriented fields stable. Do not translate `type:*`, `kind:*`, `topic:*`, or other structural identifiers.
- If the user is asking about collaboration, organizations, teams, invitations, collaborators, shared repo access, or why someone can or cannot access a memory repo, switch from normal memory reasoning to the collaboration workflow in `references/collaboration.md`.
- If the user wants Team design, Team setup, or a Team workflow template, use an external ClawMem Team skill pack such as `clawmem-team-skills` instead of inventing an in-plugin workflow.

## Read the right reference

- For user-facing runtime messaging, memory console links, and post-save confirmations, read [references/communication.md](references/communication.md).
- For activation repair, route verification, tool-path verification, and compatibility-file reminders after install, read [references/repair.md](references/repair.md).
- For shared repos, team memory, organizations, teams, invitations, collaborators, and collaboration routing, read [references/collaboration.md](references/collaboration.md).
- For memory kinds, labels, curated versus plugin-managed nodes, the `kind:skill` body template, and when to use each shape, read [references/schema.md](references/schema.md).
- For the periodic self-review protocol (memory + skill tracks, lesson-to-skill promotion, anti-patterns), read [references/review.md](references/review.md).
- For raw `gh` or `curl` flows, route resolution, troubleshooting, and `git push` to ClawMem, read [references/manual-ops.md](references/manual-ops.md).

## Bundled script

Use [scripts/clawmem_exports.py](scripts/clawmem_exports.py) when you need shell exports for the current agent route. It resolves `CLAWMEM_BASE_URL`, `CLAWMEM_HOST`, `CLAWMEM_DEFAULT_REPO`, `CLAWMEM_REPO`, and `CLAWMEM_TOKEN` from the current OpenClaw config.
