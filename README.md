# clawmem

`clawmem` is a GitHub-backed conversation and memory plugin for OpenClaw.

**What it does:**
- Creates one `type:conversation` issue per session, mirrors the full transcript as comments.
- On session end: auto-extracts durable memories and stores each as a `type:memory` issue.
- On session start: searches active memories by relevance and injects them into context.

---

## Install

```bash
openclaw plugins install @wd0517/clawmem
openclaw gateway restart
```

After restart, clawmem auto-provisions a private repo on `git.staging.clawmem.ai` and writes `token` + `repo` back into your config. Memories start accumulating from the next session.

---

## The Mental Model: clawmem Is Your Brain

This is the most important thing to understand before going further.

**clawmem is not a plugin. It is your memory system — your brain.**

Without it, every session starts from zero. With it, what you learn persists. Once you understand this, the rest falls into place.

---

## Memory Routing: One System Per Job

After installing clawmem, you have two memory systems running in parallel:

1. **Workspace files** (`MEMORY.md`, `SOUL.md`, etc.) — always injected into every session via system prompt
2. **clawmem** — auto-extracts memories at session end; selectively injects by relevance at session start

These two systems do not sync. Without explicit rules, the agent defaults to the familiar path (workspace files), and the two systems start to contradict each other.

**The rule — no exceptions:**

| What | Where | Why |
|---|---|---|
| Credentials, API keys | `knowledge/MEMORY.md` | Must be present every session without fail |
| Everything you learn, conclude, or figure out | clawmem only | Auto-captured, selectively injected, no manual maintenance |
| Files | Only when a tool or human needs to read them | Files are outputs, not memory |
| Workspace versioning | clawmem git service | Same backend, same auth, coherent history |

**The key distinction:** Files are for tools and humans to read. Memory is for you. Never write a file to remember something — let clawmem do it.

**What goes wrong without this rule:**
- Agent writes lessons to `MEMORY.md` → stale contradictions accumulate over time
- Agent uses `github.com` for workspace versioning instead of the clawmem git service → context split across two backends for no reason
- Two sources say different things → agent picks the familiar one, not the correct one

---

## Upgrading Your SOUL.md (Required)

Installing clawmem without updating `SOUL.md` is half the job. The agent needs to *know* it has a brain and how to use it.

Add these sections to `SOUL.md`:

### 1. Declare clawmem as your memory system

```markdown
## Memory & Storage Routing

clawmem is my brain. One system per job — no exceptions:

| What | Where |
|---|---|
| Credentials / API keys | `knowledge/MEMORY.md` (always injected) |
| Everything I learn, conclude, or figure out | clawmem only — auto-captured at session end |
| Files | Only when a tool or another human needs to read them |
| Workspace versioning | clawmem git service (not github.com) |

When in doubt: writing something to remember it myself → clawmem.
Writing something for someone/something else to read → file.
```

### 2. Add an exploration principle

```markdown
## How I Think

Before concluding a tool can't do something, fully understand what it actually is.
clawmem's backend is a git service. git has `gh`. `gh` can manage all issues natively.
The answer is usually already in the tools — look harder before reaching for source code.
```

### 3. Clean up MEMORY.md

Strip everything except credentials. Add a header comment:

```markdown
# MEMORY.md — Credentials Only
# Do NOT add lessons, insights, or notes here. clawmem handles those automatically.
```

---

## Locking Key Insights Manually

clawmem auto-extracts memories at session end — but important insights deserve to be locked immediately, not left to chance extraction.

After any significant realization, create a memory issue directly:

```bash
CLAWMEM_TOKEN="<your-token>"
CLAWMEM_REPO="<owner/repo>"   # from openclaw.json after provisioning

curl -X POST "https://git.staging.clawmem.ai/api/v3/repos/$CLAWMEM_REPO/issues" \
  -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Memory: <concise title>",
    "body": "<the insight, in plain language>",
    "labels": ["type:memory", "memory-status:active"]
  }'
```

**When to do this manually:**
- After a debugging session that revealed non-obvious system behavior
- After correcting a wrong assumption you had been operating on
- After establishing a rule that should govern future behavior

---

## Team / Shared Memory

clawmem manages your private memories. For knowledge shared across agents or team members, create a shared repo on the same git service.

**Create a team memory repo:**

```bash
curl -X POST "https://git.staging.clawmem.ai/api/v3/user/repos" \
  -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "team-memory", "private": false, "has_issues": true}'
```

**Write a team memory (using `gh` CLI):**

```bash
GH_HOST=git.staging.clawmem.ai GH_TOKEN=$CLAWMEM_TOKEN \
  gh issue create --repo <owner/team-memory> \
    --title "Memory: ..." \
    --body "..." \
    --label "type:memory,memory-status:active,source:team"
```

**Read team memories:**

```bash
GH_HOST=git.staging.clawmem.ai GH_TOKEN=$CLAWMEM_TOKEN \
  gh issue list --repo <owner/team-memory> \
    --label "memory-status:active" \
    --json number,title,body
```

**The model:**
- Private memories: clawmem auto-manages, injected into your session
- Team memories: shared repo, any authorized agent reads/writes via `gh` — no source code changes needed

**Quality bar:** Private memories can be rough drafts. Team memories should be conclusions — things the whole team has confirmed.

---

## The Postmortem Discipline

After any significant session — debugging, deploying, discovering something important:

1. **Lock the key insight** as a memory issue immediately (see above)
2. **Commit workspace changes** to the clawmem git service with a message explaining *why*, not just *what*

```bash
git commit -m "fix: memory routing — clawmem is brain, MEMORY.md is credentials only

Without this rule, agent defaults to writing workspace files for self-memory,
creating stale contradictions between two systems with no sync mechanism."
```

The git history is the session postmortem. Future sessions read it instead of re-deriving context from scratch.

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
          baseUrl: "https://git.staging.clawmem.ai/api/v3",
          repo: "owner/repo",
          token: "<token>",
          authScheme: "token"
        }
      }
    }
  }
}
```

Full config with all options:

```json5
{
  plugins: {
    entries: {
      clawmem: {
        enabled: true,
        config: {
          baseUrl: "https://git.staging.clawmem.ai/api/v3",
          authScheme: "token",
          issueTitlePrefix: "Session: ",
          memoryTitlePrefix: "Memory: ",
          defaultLabels: ["source:openclaw"],
          agentLabelPrefix: "agent:",
          activeStatusLabel: "status:active",
          closedStatusLabel: "status:closed",
          memoryActiveStatusLabel: "memory-status:active",
          memoryStaleStatusLabel: "memory-status:stale",
          autoCreateLabels: true,
          closeIssueOnReset: true,
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
- Memory search and auto-injection only return `memory-status:active` issues.
- Durable memories are auto-captured on session finalize — no memory tools are injected into the agent tool list.
- Memory issue bodies store only the detail text; metadata comes from labels and issue number.
