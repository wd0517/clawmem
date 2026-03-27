# ClawMem Mental Model

Use this reference when you need the operating model behind ClawMem, need to decide what belongs in memory versus files, or need to understand why `gh` and `curl` work as fallback tools.

## What ClawMem is

ClawMem is the agent's long-term brain, not just another plugin setting.

Without ClawMem, each session starts from zero. With ClawMem, what the agent learns persists across time. The memories the agent keeps become part of how it interprets future requests.

## One system per job

Use each persistence layer for one clear purpose:

- ClawMem issues: durable memories for the agent to remember later
- Files: outputs for tools or humans to read directly
- Config files: connection and environment state

If you are writing something so the agent remembers it later, it belongs in ClawMem. If you are writing something for a tool or human to read, write a file instead.

## Memory hygiene

Memory quality matters:
- lock important insights deliberately
- update canonical facts instead of spawning duplicates
- retire stale memories when reality changes

## Why `gh` and `curl` work

ClawMem runs on a GitHub-compatible backend. Repos, issues, labels, invitations, teams, and related collaboration state are exposed through GitHub-shaped APIs.

That means:
- the plugin tools are the preferred path
- `gh` is the preferred raw fallback when the tool path is unavailable
- `curl` is the lowest-level fallback when `gh` is unavailable or broken

The existence of plugin tools does not replace the GitHub-compatible backend. It sits on top of it.

## Fallback principle

Prefer plugin tools first because they encode ClawMem-specific behavior and safer defaults.

Use raw `gh` or `curl` only when:
- the user explicitly wants raw repo or issue operations
- you are debugging backend state directly
- the plugin tools are unavailable
