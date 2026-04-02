---
name: clawmem
description: Durable memory workflows for the ClawMem OpenClaw plugin. Use when ClawMem is installed and you need to recall prior preferences, project history, facts, decisions, lessons, workflows, active tasks, or shared/team memory; save or update durable knowledge with the ClawMem memory tools; choose the right memory repo; manage shared memory spaces, organizations, teams, collaborators, invitations, outside collaborators, or repo-access governance in the ClawMem backend; or troubleshoot ClawMem setup and manual repo-backed operations.
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
- Best-effort automatic memory recall before each turn
- Best-effort durable memory extraction during later request-scoped maintenance
- Mid-session memory tools: `memory_repos`, `memory_repo_create`, `memory_list`, `memory_get`, `memory_labels`, `memory_recall`, `memory_store`, `memory_update`, and `memory_forget`

## Mandatory turn loop

On every user turn, run this loop:

1. Before answering, ask: could ClawMem improve this answer?
   - Default to yes for user preferences, project history, prior decisions, lessons, conventions, terminology, recurring problems, and active tasks.
   - Auto-recall may already inject useful context from the current agent's `defaultRepo`, but it is only a hint. Do not treat missing auto-recall context as proof that no relevant memory exists.
   - If the injected context already answers the question, you do not need to immediately call `memory_recall` again.
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
   - Prefer one durable fact per memory. If a turn contains several independent facts, save them separately instead of bundling them into one summary memory.
   - Use `memory_update` when the same canonical fact or ongoing task should keep evolving as one node.
   - When updating an existing memory, preserve that node's current language unless the user explicitly asks for a rewrite.
   - Use `memory_store` when this is a genuinely new memory.
   - When using `memory_store`, pass both `title` and `detail` when you can. Keep the title concise and human-readable, and keep `detail` as the full durable fact.
   - When using `memory_update`, pass `title` as well if the existing title is too short, outdated, or less precise than the current canonical fact.
   - For new memories, write the memory title and body in the user's current language by default.
   - Use `memory_forget` when a memory is stale, superseded, or harmful if reused.
3. Keep the user posted.
   - If a retrieved memory materially shaped the answer, briefly surface that fact in the user's current language.
   - Include the memory id and title only when they help with debugging, traceability, or an explicit user request.
   - After creating or updating a memory, give a short confirmation in the user's current language instead of forcing fixed English phrasing.

Bias toward saving, and use explicit retrieval whenever auto-recall is absent, weak, cross-repo, or too ambiguous to trust on its own.

## Retrieval and storage rules

- Before inventing a new `kind` or `topic`, call `memory_labels` and reuse the existing schema when possible.
- If the current schema does not fit and a new label would improve future retrieval or reuse, extend the schema intentionally within `kind:*` and `topic:*`.
- Reuse stable labels over one-off labels.
- Private personal memory usually belongs in the agent's `defaultRepo`.
- Project memory belongs in the relevant project repo.
- Shared or team knowledge belongs in the shared repo for that group.
- Memory titles and bodies default to the user's current language for new memories.
- Prefer a short standalone title plus a fuller `detail` body instead of stuffing the whole memory into the title.
- If you omit `title`, the plugin may derive it from `detail`, but providing an explicit title is preferred for readability in the Console.
- When updating an existing memory, keep that node in its current language unless the user explicitly asks to rewrite it.
- Keep schema labels and machine-oriented fields stable. Do not translate `type:*`, `kind:*`, `topic:*`, or other structural identifiers.
- If the user is asking about collaboration, organizations, teams, invitations, collaborators, shared repo access, or why someone can or cannot access a memory repo, switch from normal memory reasoning to the collaboration workflow in `references/collaboration.md`.

## Read the right reference

- For user-facing runtime messaging, memory console links, and post-save confirmations, read [references/communication.md](references/communication.md).
- For activation repair, route verification, tool-path verification, and compatibility-file reminders after install, read [references/repair.md](references/repair.md).
- For shared repos, team memory, organizations, teams, invitations, collaborators, and collaboration routing, read [references/collaboration.md](references/collaboration.md).
- For memory kinds, labels, curated versus plugin-managed nodes, and when to use each shape, read [references/schema.md](references/schema.md).
- For raw `gh` or `curl` flows, route resolution, troubleshooting, and `git push` to ClawMem, read [references/manual-ops.md](references/manual-ops.md).

## Bundled script

Use [scripts/clawmem_exports.py](scripts/clawmem_exports.py) when you need shell exports for the current agent route. It resolves `CLAWMEM_BASE_URL`, `CLAWMEM_HOST`, `CLAWMEM_DEFAULT_REPO`, `CLAWMEM_REPO`, and `CLAWMEM_TOKEN` from the current OpenClaw config.
