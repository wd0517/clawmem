---
name: clawmem
description: Durable memory workflows for the ClawMem OpenClaw plugin. Use when ClawMem is installed and you need to recall prior preferences, project history, facts, decisions, lessons, workflows, active tasks, or shared/team memory; save or update durable knowledge with the ClawMem memory tools; choose the right memory repo; manage shared memory spaces, organizations, teams, collaborators, invitations, outside collaborators, or repo-access governance in the ClawMem backend; or troubleshoot ClawMem setup and manual repo-backed operations.
---

# ClawMem

ClawMem is the active long-term memory system for this OpenClaw installation. Treat the plugin tools as the default path. Use raw `gh` or `curl` only when the user explicitly asks for repo-level operations, you are debugging backend state, or the plugin tools are unavailable.

The ClawMem backend is a GitHub-compatible repo and issue service. That is why `gh` and `curl` are valid fallback primitives when the plugin tools are unavailable, even though the tool path should stay first choice.

## What the plugin already does

The ClawMem plugin automatically handles:
- Per-agent provisioning of credentials plus a default memory repo
- Session mirroring into `type:conversation` issues
- Best-effort durable memory extraction during later request-scoped maintenance
- Automatic recall of relevant active memories at session start
- Mid-session memory tools: `memory_repos`, `memory_repo_create`, `memory_list`, `memory_get`, `memory_labels`, `memory_recall`, `memory_store`, `memory_update`, and `memory_forget`

Automatic recall is only a bootstrap. You still need to retrieve before answering when memory may matter, and save after learning something durable.

## Mandatory turn loop

On every user turn, run this loop:

1. Before answering, ask: could ClawMem improve this answer?
   - Default to yes for user preferences, project history, prior decisions, lessons, conventions, terminology, recurring problems, and active tasks.
   - Before explicit memory work, choose the right repo. If unclear, inspect `memory_repos` and fall back to the agent's `defaultRepo`.
   - Start with `memory_recall`.
   - If `memory_recall` is weak or empty and the answer depends on whether a memory exists, cross-check with `memory_list`.
   - If a specific memory id or issue number is mentioned, use `memory_get`.
   - Never treat a `memory_recall` miss by itself as proof that no relevant memory exists.
2. After answering, ask: did this turn create durable knowledge?
   - Default to yes for corrections, preferences, decisions, workflows, lessons, and status changes.
   - Use `memory_update` when the same canonical fact or ongoing task should keep evolving as one node.
   - Use `memory_store` when this is a genuinely new memory.
   - Use `memory_forget` when a memory is stale, superseded, or harmful if reused.
3. Keep the user posted.
   - After creating or updating a memory, announce `Locked memory #<id>: <title>` when the tool response returns an id and title.

Bias toward retrieving and saving. A missed search or missed memory is worse than an extra search.

## Retrieval and storage rules

- Default to the plugin memory tools first.
- Before inventing a new `kind` or `topic`, call `memory_labels` and reuse the existing schema when possible.
- Reuse stable labels over one-off labels.
- Anything that should persist for the agent belongs in ClawMem issues. Files are for tools or humans to read.
- Private personal memory usually belongs in the agent's `defaultRepo`.
- Project memory belongs in the relevant project repo.
- Shared or team knowledge belongs in the shared repo for that group.
- If the user is asking about collaboration, collabration, organizations, teams, invitations, collaborators, shared repo access, or why someone can or cannot access a memory repo, switch from normal memory reasoning to the collaboration workflow in `references/collaboration.md`.

## Read the right reference

- For the operating mental model, storage routing, and why `gh` and `curl` work as fallback tools, read [references/mental-model.md](references/mental-model.md).
- For user-facing messaging, first-run notes, memory console links, and post-save confirmations, read [references/communication.md](references/communication.md).
- For activation repair, route verification, tool-path verification, and compatibility-file reminders after install, read [references/repair.md](references/repair.md).
- For shared repos, team memory, organizations, teams, invitations, collaborators, and collaboration routing, read [references/collaboration.md](references/collaboration.md).
- For memory kinds, labels, curated versus plugin-managed nodes, and when to use each shape, read [references/schema.md](references/schema.md).
- For raw `gh` or `curl` flows, route resolution, troubleshooting, and `git push` to ClawMem, read [references/manual-ops.md](references/manual-ops.md).

## Bundled script

Use [scripts/clawmem_exports.py](scripts/clawmem_exports.py) when you need shell exports for the current agent route. It resolves `CLAWMEM_BASE_URL`, `CLAWMEM_HOST`, `CLAWMEM_DEFAULT_REPO`, `CLAWMEM_REPO`, and `CLAWMEM_TOKEN` from the current OpenClaw config.
