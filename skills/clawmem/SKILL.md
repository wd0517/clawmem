---
name: clawmem
description: "ClawMem is OpenClaw's memory layer, backed by a GitHub-compatible git service. Two core directives: self-evolution (the graph gets smarter every session) and keeping the user posted (nothing interesting happens silently)."
metadata: { "openclaw": { "emoji": "🧠" } }
---

# ClawMem — Self-Evolving Memory

## What ClawMem is

ClawMem is OpenClaw's long-term brain. Everything worth remembering lives as a semantic graph in GitHub Issues — transparent, auditable, and human-inspectable at any time.

The backing service is a GitHub-compatible git service: repos, issues, labels, milestones, and releases are all available. The agent uses `gh` CLI to manage memory — no source code changes needed.

Two layers always in play:
- *The graph* — semantic memory, lives in Issues, grows across every session
- *The workspace* — project reality, lives in repos, milestones, releases

## What the plugin does automatically

The clawmem plugin handles these without agent involvement:
- **Account & repo provisioning** — auto-creates on first start, writes credentials to openclaw config
- **Session mirroring** — one `type:conversation` issue per session, transcript as comments
- **Memory extraction** — at session end, a subagent extracts durable facts into `type:memory` issues
- **Memory recall** — at session start, searches active memories by relevance and injects them into context

**You do NOT need to manage these manually.** The sections below cover what the agent should do *in addition* to the plugin's automatic behavior.

---

## Storage routing: three layers

After clawmem is installed, three persistence layers exist. Each has one job:

| Layer | What goes here | Changes how often | Setup |
|---|---|---|---|
| **SOUL.md** | Identity — "I have clawmem" + pointer to skill.md | Once | Onboarding Step 3 |
| **MEMORY.md** | Connection info — baseUrl, repo (fallback if plugin fails) | Once | Onboarding Step 2 |
| **ClawMem Issues** | Everything else — lessons, conventions, facts, skills, tasks | Every session | Automatic + manual |

**Rule:** If you're writing something so *you* remember it later → clawmem issue. If a tool or human needs to read it → file.

---

## First-run onboarding (mandatory)

This task is NOT complete until all steps below are done. Do not skip any.

### Step 0 — Install plugin

If `clawmem` is not yet in `openclaw.json` under `plugins.entries`, the plugin must be installed first. Ask the user how they installed clawmem and confirm it appears in the config before proceeding.

### Step 1 — Verify provisioning

The plugin auto-provisions an account and repo on first start. Read the provisioned config:

```sh
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
cfg = d['plugins']['entries']['clawmem']['config']
print(f\"baseUrl: {cfg.get('baseUrl', 'MISSING')}\")
print(f\"repo:    {cfg.get('repo', 'MISSING')}\")
print(f\"token:   {'SET' if cfg.get('token') else 'MISSING'}\")
"
```

If any value is `MISSING`, the plugin has not provisioned yet. Restart OpenClaw and retry.

### Step 2 — Write connection info to MEMORY.md

Read `repo` from Step 1 and write it to MEMORY.md so every future session knows where clawmem lives — even if the plugin or skill fails to load:

```markdown
## ClawMem
- baseUrl: https://git.clawmem.ai/api/v3
- repo: <owner/repo from Step 1>
- token: managed by plugin (do NOT paste here)
```

This is the **minimum viable fallback**. Without it, a session that doesn't load the skill has zero way to find the memory repo.

### Step 3 — Write identity block to SOUL.md

Add the following block so every future agent session knows it has a memory system:

```markdown
## Memory System — ClawMem 🧠

I have a superpower: long-term memory across sessions, powered by ClawMem (git.clawmem.ai).

The plugin handles the plumbing — session mirroring, auto-extraction, recall injection.
But to truly become the **strongest brain**, read the full playbook:

👉 `cat ~/.openclaw/clawmem/skill.md`

That file is my field manual: graph schema, manual `gh` operations, pre-answer retrieval,
and the two core directives that make memory *alive* instead of just *stored*.
```

### Step 4 — Save skill.md locally

Copy the skill file to a stable path so the SOUL.md pointer always resolves:

```sh
mkdir -p ~/.openclaw/clawmem
cp <plugin-install-path>/skill.md ~/.openclaw/clawmem/skill.md
```

### Step 5 — Verify

```sh
GH_HOST=git.clawmem.ai \
GH_TOKEN=$(cat ~/.openclaw/openclaw.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['plugins']['entries']['clawmem']['config']['token'])") \
  gh issue list --repo <owner/repo> --limit 1 --json number,title
```

If this returns a JSON array (even empty `[]`), the setup is complete.

### Definition of Done

- [ ] `openclaw.json` has `baseUrl`, `repo`, `token`
- [ ] MEMORY.md has `baseUrl` and `repo`
- [ ] SOUL.md has identity block with skill.md pointer
- [ ] `~/.openclaw/clawmem/skill.md` exists
- [ ] `gh issue list` against the repo succeeds

---

## The two core directives

### Self-evolution

The graph is a living knowledge base. After every turn and session, ask: _what did I learn? what changed? what can I make better?_

Promote patterns and preferences to the graph without waiting to be asked. Update stale nodes when reality has moved on. Link related issues — a dense graph retrieves better. Detect recurring problems and file a `Lesson-Learned`. Retire superseded conventions.

**Enforcement:** If something durable happened during a turn and you did not create or update a memory node, you are not done.

### Keep the user posted — and make it fun

Nothing interesting happens silently. The agent notices things the user doesn't — and says so.

- ❌ "Memory updated." → ✅ "Saved! 🧠 That decision is now immortalized — future you will be very grateful."
- ❌ "Lesson-Learned created." → ✅ "Filed that one under 'won't do that again' 😄 — #10 is live."
- ❌ "Core-Fact updated." → ✅ "Got it locked in ✅ — your brain now knows Max = ngaut = CEO."

**Rule:** After creating any memory node, announce in chat: "Locked memory #<n>: <title>"

---

## The memory graph

*Issues are nodes. Labels are schema. `#ID` cross-links are edges.*

| Kind | `type:` | `kind:` | What it represents |
|---|---|---|---|
| Core-Fact | `type:memory` | `kind:core-fact` | A stable truth — update in place as reality changes |
| Convention | `type:memory` | `kind:convention` | An agreed rule — major revisions create a new issue, old gets `memory-status:stale` |
| Lesson-Learned | `type:memory` | `kind:lesson` | A correction or postmortem — append-only, never updated |
| Skill-Blueprint | `type:memory` | `kind:skill` | A repeatable workflow — deterministic SOP |
| Active-Task | `type:memory` | `kind:task` | Work in progress — checklist body, progress in comments |

### Labels

Every manually created `type:memory` issue MUST include:
- `type:memory`
- One `kind:*` label
- `memory-status:active` (or `memory-status:stale`)
- `date:YYYY-MM-DD`
- Optional: `topic:*` (limit to 2-3 for retrieval quality)

### When to create which kind

| Trigger | Kind |
|---------|------|
| User corrects a wrong assumption | `kind:lesson` |
| You and user agree on a rule | `kind:convention` |
| A stable fact about the user/project | `kind:core-fact` |
| A repeatable workflow you figured out | `kind:skill` |
| Ongoing work to track | `kind:task` |

---

## Manual memory operations

### Prerequisites: `gh` CLI authentication

ClawMem and github.com are separate hosts. For ClawMem operations, every `gh` call needs:

```sh
export GH_HOST=git.clawmem.ai
export GH_TOKEN=$(cat ~/.openclaw/openclaw.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['plugins']['entries']['clawmem']['config']['token'])")
```

For github.com — use `gh` normally, no env overrides. Never mix the two.

### Save a memory

```sh
GH_HOST=git.clawmem.ai GH_TOKEN=$CLAWMEM_TOKEN \
  gh issue create --repo <owner/repo> \
    --title "Memory: <concise title>" \
    --body "<the insight, in plain language>" \
    --label "type:memory,kind:lesson,memory-status:active,date:2026-03-16"
```

### Search memories

```sh
GH_HOST=git.clawmem.ai GH_TOKEN=$CLAWMEM_TOKEN \
  gh issue list --repo <owner/repo> \
    --label "type:memory,memory-status:active" \
    --search "<keywords>" \
    --json number,title,body,labels
```

### Mark memory as stale

```sh
GH_HOST=git.clawmem.ai GH_TOKEN=$CLAWMEM_TOKEN \
  gh issue edit <number> --repo <owner/repo> \
    --remove-label "memory-status:active" \
    --add-label "memory-status:stale"
```

### Link related memories

When a new node relates to an old one, mention `#ID` in the body to create bidirectional links.

---

## Pre-answer retrieval

Before answering questions about past decisions, user preferences, or project history, search clawmem first:

| User asks about | Search filter |
|----------------|---------------|
| Preferences, facts about themselves | `kind:core-fact` |
| Rules, decisions | `kind:convention` |
| Past problems, how X was fixed | `kind:lesson` |
| How to do X | `kind:skill` |
| What's in progress | `kind:task` |

If found → answer based on memory (cite issue #). If not found → answer normally, consider creating a memory node.

---

## Session startup checklist

Every new session:
1. Confirm SOUL.md mentions clawmem and MEMORY.md has connection info — if either is missing, run the **First-run onboarding** above
2. Plugin auto-injects relevant memories — no manual action needed

---

## `git push` to ClawMem

`GH_HOST`/`GH_TOKEN` env vars only affect `gh` CLI, not `git push`. To push code to ClawMem repos, register the token once:

```sh
TOKEN=$(cat ~/.openclaw/openclaw.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['plugins']['entries']['clawmem']['config']['token'])")
echo "$TOKEN" | gh auth login -h git.clawmem.ai --with-token
```

After that, `git push` to `https://git.clawmem.ai/...` just works.

---

## Autonomy

*Without confirmation:* memory nodes, comments, labels, closing tasks, creating repos, linking and superseding nodes.

*Requires confirmation:* OpenClaw config changes, service restarts, deletions.

---

## Known pitfalls

| Problem | Fix |
|---------|-----|
| Labels don't update via PATCH on some backends | Use `PUT /repos/{owner}/{repo}/issues/{n}/labels` to set labels reliably |
| `openclaw config get` returns `__OPENCLAW_REDACTED__` for token | Read directly from `~/.openclaw/openclaw.json` |
| Conversation mirror returns 404 | Cached issue was deleted — plugin will recreate on next session |
