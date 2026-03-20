---
name: clawmem
description: "CLAWMEM OPERATION MANUAL — Read this on EVERY turn and EVERY session after ClawMem is installed. Use it for daily memory recall, startup/heartbeat policy retrieval, route resolution, safe manual memory operations, repo/route interpretation, console access, and troubleshooting."
metadata: { "openclaw": { "emoji": "🧠" } }
---

# ClawMem — Self-Evolving Memory

> **⚠️ READ THIS ON EVERY TURN AND EVERY SESSION.**
> This is your daily operation manual.
> Search before answering. Save durable knowledge after learning.
> After ClawMem installation, treat ClawMem as primary memory and local files as secondary reference material.

---

## 📖 Table of Contents

These section titles may be referenced by the separate `clawmem-install` skill and by injected blocks in `SOUL.md`, `AGENTS.md`, and `TOOLS.md`. Keep them stable; if you rename them, update the install guide at the same time.

**Part 1: Core Concepts**
- [What ClawMem is](#what-clawmem-is)
- [What the plugin does automatically](#what-the-plugin-does-automatically)

**Part 2: Daily Operations — Mandatory for every turn**
- [Turn loop (mandatory)](#turn-loop-mandatory)
- [Runtime route resolution (mandatory)](#runtime-route-resolution-mandatory)
- [Repo inventory vs current route (mandatory)](#repo-inventory-vs-current-route-mandatory)
- [Local files after install (mandatory)](#local-files-after-install-mandatory)
- [Memory routing policy (mandatory)](#memory-routing-policy-mandatory)

**Part 3: Search & Save**
- [Pre-answer retrieval](#pre-answer-retrieval) — **Must read before searching**
- [Manual memory operations](#manual-memory-operations) — **Must check before saving memory**
- [Create vs update decision (mandatory)](#create-vs-update-decision-mandatory)
- [The memory graph](#the-memory-graph)

**Part 4: Session Management**
- [Session startup checklist (mandatory)](#session-startup-checklist-mandatory)
- [Session end checklist (mandatory)](#session-end-checklist-mandatory)
- [Heartbeat behavior (mandatory)](#heartbeat-behavior-mandatory)
- [What if something fails?](#what-if-something-fails)

**Part 5: Reference**
- [Memory Visualization Console](#memory-visualization-console)
- [Known pitfalls](#known-pitfalls)

---

## Part 1: Core Concepts

---

## What ClawMem is

ClawMem is your external long-term memory system. Things worth remembering live as a semantic graph in GitHub-compatible Issues — transparent, auditable, and human-inspectable.

Two layers are always in play:
- **The graph** — semantic memory, lives in issues, survives across sessions
- **The workspace** — local files, tools, archives, and active project reality

After installation, **ClawMem is the primary memory system**. Local files may still matter, but they are no longer the primary place the agent should rely on for durable memory.

## What the plugin does automatically

The clawmem plugin handles these without agent involvement:
- **Per-agent route provisioning** — auto-creates or assigns a repo for each agent and writes route credentials to `plugins.entries.clawmem.config.agents.<agentId>`
- **Session mirroring** — one `type:conversation` issue per session, transcript as comments
- **Memory extraction** — after sessions, extraction can turn durable facts into `type:memory` issues
- **Bootstrap recall** — recent relevant memory may be injected at session start

Important boundaries:
- The plugin config stores the **current/default route for this agent**
- The plugin config does **not** necessarily represent the full set of repos the user can access
- OpenClaw identifies this skill by the frontmatter name `clawmem`, not by its folder path
- Automatic recall at session start is only a bootstrap; the agent must still retrieve before answering and save after learning

---

## Part 2: Daily Operations — Mandatory for every turn

---

## Turn loop (mandatory)

On every user turn, run this loop:

1. **Before answering:** ask `Could ClawMem improve this answer?`
   - Default to **yes** for user preferences, project history, prior decisions, conventions, lessons, active tasks, recurring problems, terminology, or anything that may have been learned before.
   - If the answer is not obviously memory-free, or you are unsure, retrieve first.
2. **After answering:** ask `Did this turn create or change durable knowledge?`
   - Default to **yes** for corrections, new preferences, decisions, workflows, lessons, task-state changes, and behavior-policy changes.
   - If yes or unsure, decide whether to **update** an existing memory or **create** a new one before ending the turn.

Bias toward retrieving and preserving important knowledge — but do **not** blindly create duplicate memories every time.

---

## Runtime route resolution (mandatory)

ClawMem is routed **per agent**, not through one global `repo` / `token`.

Every shell snippet that talks to ClawMem should begin by resolving the **current agent route** from config.

**Preferred config path:**
- `~/.openclaw/openclaw.json`

**Compatibility fallback (environment-specific only):**
- `~/workspace/agent/openclaw.json`

Use this helper:

```sh
clawmem_exports() {
  local agent_id="${1:-${OPENCLAW_AGENT_ID:-main}}"
  python3 - "$agent_id" <<'PY'
import json, os, shlex, sys

agent_id = sys.argv[1]
paths = [
    "~/.openclaw/openclaw.json",
    "~/workspace/agent/openclaw.json",
]

root = None
for raw in paths:
    p = os.path.expanduser(raw)
    if os.path.exists(p):
        with open(p) as f:
            root = json.load(f)
        break

if root is None:
    print("openclaw.json not found", file=sys.stderr)
    sys.exit(1)

plugins = (root.get("plugins") or {}).get("entries") or {}
entry = plugins.get("clawmem") or {}
cfg = entry.get("config") or {}
agents = cfg.get("agents") or {}
route = agents.get(agent_id) or {}

base_url = (route.get("baseUrl") or cfg.get("baseUrl") or "https://git.clawmem.ai/api/v3").rstrip("/")
if not base_url.endswith("/api/v3"):
    base_url = f"{base_url}/api/v3"

repo = route.get("repo") or ""
token = route.get("token") or ""
host = base_url.removesuffix("/api/v3").replace("https://", "").replace("http://", "")

pairs = {
    "CLAWMEM_AGENT_ID": agent_id,
    "CLAWMEM_BASE_URL": base_url,
    "CLAWMEM_HOST": host,
    "CLAWMEM_REPO": repo,
    "CLAWMEM_TOKEN": token,
    "GH_HOST": host,
    "GH_ENTERPRISE_TOKEN": token,
}

for k, v in pairs.items():
    print(f"export {k}={shlex.quote(v)}")
PY
}
```

Then load the route with:

```sh
eval "$(clawmem_exports)"
```

Rules:
- Never paste tokens into chat
- Never store tokens in local files or memory nodes
- If `CLAWMEM_REPO` or `CLAWMEM_TOKEN` is empty, the current agent route is not ready yet

---

## Repo inventory vs current route (mandatory)

This distinction is critical:

- `plugins.entries.clawmem.config.agents.<agentId>` tells you the **current/default route for this agent**
- It does **not** reliably tell you the **total set of accessible repos**

Therefore:
- Never answer **"how many repos do we have?"** from `openclaw.json` alone
- Never treat the configured current route as authoritative repo inventory
- If your environment provides a live ClawMem repo-list / inventory capability, use that for repo discovery
- If live inventory is unavailable, say so clearly:
  - you can confirm the current configured route
  - you cannot infer the full accessible repo count from config alone

Keep these concepts separate:
- **Current route** — where this agent currently defaults to reading/writing
- **Accessible repos** — repos the current identity/token can see
- **Search scope** — which repos current retrieval is allowed to search
- **Write target** — which repo new memory is currently written to

Future team-sharing behavior should be treated as **live inventory / permission data**, not as static config.

---

## Local files after install (mandatory)

After ClawMem installation:
- `MEMORY.md`
- `memory/*.md`
- `HEARTBEAT.md`
- local migration archives

are **secondary reference material**, not primary memory.

Use them for:
- human/tool reference
- migration/archive work
- explicit current checklists (especially `HEARTBEAT.md`)
- local workspace instructions the user intentionally preserved

Do **not** treat old local-memory workflows as the primary source of remembered truth unless the user explicitly preserved them that way.

---

## Memory routing policy (mandatory)

Before ending every turn, ask:

> **Did I learn or update something durable?**

If yes or unsure, save it to ClawMem — but first decide whether an existing memory should be **updated** instead of creating a duplicate.

Good candidates to preserve:
- user corrections → `kind:lesson`
- agreed rules → `kind:convention`
- stable facts → `kind:core-fact`
- workflows → `kind:skill`
- ongoing work → `kind:task`
- startup / heartbeat / quiet-hours / escalation preferences → usually `kind:convention` or `kind:core-fact`

For migrated or newly learned operating policy, prefer this label contract:
- default rule behavior → `kind:convention`
- stable user/environment fact → `kind:core-fact`
- plus:
  - `type:memory`
  - `status:active`
  - `date:YYYY-MM-DD`
  - 1–3 relevant topics, especially `topic:startup`, `topic:heartbeat`, `topic:quiet-hours`, `topic:notification-policy`, `topic:escalation`

Rule:
- Durable memory belongs in ClawMem Issues (`type:memory`)
- Local files are for humans, tools, archive, and explicit local checklists

---

## Part 3: Search & Save

---

## Pre-answer retrieval

Before every answer, ask:

> **Is there relevant memory that could improve this answer?**

If yes or unsure, search ClawMem first.

Typical triggers:
- preferences, habits, facts about the user
- prior decisions or conventions
- how something was fixed before
- repeatable workflows
- what's in progress
- startup / heartbeat / quiet-hours / escalation policy
- names, terminology, relationships, project context

### Retrieval strategy

1. Start with the most likely memory kind:
   - user facts → `kind:core-fact`
   - rules / policy / decisions → `kind:convention`
   - mistakes / corrections → `kind:lesson`
   - workflows → `kind:skill`
   - active work → `kind:task`
2. If the question touches policy or behavior, explicitly search startup/heartbeat-related memories.
3. If the first round is thin, broaden:
   - drop the kind filter
   - try synonyms
   - search related topics
4. If still thin, fallback to recent `type:conversation` issues for unextracted context.

If you find relevant memories, answer from them and synthesize carefully. If you do not, answer normally — then consider whether the turn created new durable knowledge.

**Important:** If the user asks about repo count, repo visibility, or sharing, first apply **Repo inventory vs current route (mandatory)**. Do not infer inventory from config.

---

## Manual memory operations

### Prerequisites: route + read-only probe

Default path: resolve the current agent route from config, then prove you can read the memory repo without interactive `gh auth login`.

```sh
eval "$(clawmem_exports)"

test -n "$CLAWMEM_REPO" || { echo "ClawMem repo missing for agent $CLAWMEM_AGENT_ID"; exit 1; }
test -n "$CLAWMEM_TOKEN" || { echo "ClawMem token missing for agent $CLAWMEM_AGENT_ID"; exit 1; }

gh issue list --repo "$CLAWMEM_REPO" --limit 1 >/dev/null || {
  echo "ClawMem probe failed (check current agent route in openclaw.json). Never paste tokens into chat."
  exit 1
}
```

Notes:
- `clawmem_exports` already sets `GH_HOST` and `GH_ENTERPRISE_TOKEN`
- For ClawMem operations, do not rely on interactive `gh auth login`
- For github.com operations unrelated to ClawMem, use normal github.com auth and keep the two hosts conceptually separate

### Save a memory

```sh
eval "$(clawmem_exports)"
DATE_LABEL="date:$(date +%F)"

gh issue create --repo "$CLAWMEM_REPO" \
  --title "Memory: <concise title>" \
  --body "<the durable insight in plain language>" \
  --label "type:memory" \
  --label "kind:lesson" \
  --label "status:active" \
  --label "$DATE_LABEL" \
  --label "topic:<topic-one>" \
  --label "topic:<topic-two>"
```

### Search memories

```sh
eval "$(clawmem_exports)"

gh issue list --repo "$CLAWMEM_REPO" \
  --label "type:memory" \
  --label "status:active" \
  --search "<keywords>" \
  --json number,title,body,labels,updatedAt
```

### Mark memory as stale

```sh
eval "$(clawmem_exports)"

gh issue edit <number> --repo "$CLAWMEM_REPO" \
  --remove-label "status:active" \
  --add-label "status:stale"
```

### Search recent conversations dynamically

```sh
eval "$(clawmem_exports)"
SINCE="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d'))
PY
)"

gh issue list --repo "$CLAWMEM_REPO" \
  --label "type:conversation" \
  --search "created:>=$SINCE" \
  --limit 5 \
  --json number,title,labels,updatedAt
```

### Link related memories

When a new node relates to an old one, mention `#ID` in the body to create cross-links.

---

## Create vs update decision (mandatory)

Manual save does **not** mean “always create a new issue.”

Before saving, decide whether to update an existing memory instead.

### Use these rules

- **`kind:core-fact`**
  - Prefer updating the existing issue for the same person / project / fact
  - Create a new one only if it is a meaningfully different fact

- **`kind:convention`**
  - Small clarifications or refinements → update the existing issue
  - Major rule change → create a new issue and mark the old one `status:stale`

- **`kind:lesson`**
  - Usually append-only and issue-per-lesson
  - New correction or distinct failure mode → create a new one

- **`kind:skill`**
  - Same workflow / SOP being refined → update
  - Truly different workflow → create new

- **`kind:task`**
  - Ongoing work should usually update one existing task or add progress comments
  - Do not open a brand-new task every turn for the same workstream

### Output convention after saving

- **New memory created:** `Locked memory #<n>: <title>`
- **Existing memory updated:** `Updated memory #<n>: <title>`

The user should know when something important was preserved.

---

## The memory graph

Issues are nodes. Labels are schema. `#ID` links are edges.

| Kind | `type:` | `kind:` | What it represents |
|---|---|---|---|
| Core-Fact | `type:memory` | `kind:core-fact` | Stable truth — update in place as reality changes |
| Convention | `type:memory` | `kind:convention` | Agreed rule — small changes update; major revisions create a new issue and stale the old one |
| Lesson-Learned | `type:memory` | `kind:lesson` | Correction or postmortem — usually append-only |
| Skill-Blueprint | `type:memory` | `kind:skill` | Repeatable workflow / SOP |
| Active-Task | `type:memory` | `kind:task` | Ongoing work — status in body/comments |

### Labels

Every manually created `type:memory` issue should include:
- `type:memory`
- one `kind:*` label
- `status:active` (or `status:stale`)
- `date:YYYY-MM-DD`
- `topic:*` labels (prefer 1–3 high-signal topics)

### When to create which kind

| Trigger | Kind |
|---------|------|
| User corrects a wrong assumption | `kind:lesson` |
| You and the user agree on a rule | `kind:convention` |
| Stable fact about user/project/environment | `kind:core-fact` |
| Repeatable workflow discovered | `kind:skill` |
| Ongoing work to track | `kind:task` |

---

## Part 4: Session Management

---

## Session startup checklist (mandatory)

Every new session, complete these steps in order.

### Step 1 — Resolve route and validate prerequisites

```sh
eval "$(clawmem_exports)"

test -n "$CLAWMEM_REPO" || { echo "ClawMem repo missing for agent $CLAWMEM_AGENT_ID"; exit 1; }
test -n "$CLAWMEM_TOKEN" || { echo "ClawMem token missing for agent $CLAWMEM_AGENT_ID"; exit 1; }
```

If repo or token is missing, stop and tell the user the current agent route is not provisioned correctly.

### Step 2 — Run a read-only probe

```sh
gh issue list --repo "$CLAWMEM_REPO" --limit 1 --json number,title >/dev/null
```

If this fails, stop and tell the user ClawMem connectivity failed. Do not bluff.

### Step 3 — Retrieve current durable context

Start with high-signal active memories and recent work:

```sh
gh issue list --repo "$CLAWMEM_REPO" \
  --label "type:memory" \
  --label "status:active" \
  --limit 30 \
  --json number,title,labels,updatedAt
```

Then run targeted searches for the current user, project, topic, or problem.

### Step 4 — Retrieve migrated operating policy

At session start, explicitly look for memories that define how you should operate, especially after migration from local files.

Prioritize memories about:
- startup behavior
- heartbeat behavior
- quiet hours
- escalation rules
- notification thresholds
- proactive-check policy

Typical search targets:
- `kind:convention`
- `kind:core-fact`
- `topic:startup`
- `topic:heartbeat`
- `topic:quiet-hours`
- `topic:notification-policy`
- `topic:escalation`

If these policies exist in ClawMem, treat them as the remembered behavioral source of truth. These memories are easiest to retrieve when they follow the expected `kind:*` + `topic:*` label contract.

### Step 5 — Retrieve recent conversation fallback

Use recent `type:conversation` issues to recover context that may not yet have been extracted into memory:

```sh
SINCE="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d'))
PY
)"

gh issue list --repo "$CLAWMEM_REPO" \
  --label "type:conversation" \
  --search "created:>=$SINCE" \
  --limit 5 \
  --json number,title,labels,updatedAt
```

### Step 6 — Proceed with the session

Only after route resolution, probe, memory retrieval, policy retrieval, and recent-conversation fallback should you proceed normally.

---

## Session end checklist (mandatory)

Before the session ends, run this scan:

Ask yourself:
1. Did I learn new facts about the user or project?
2. Did the user correct me on anything?
3. Did we agree on a rule or convention?
4. Did any ongoing task meaningfully change state?
5. Did I discover a repeatable workflow?
6. Did the user clarify startup / heartbeat / quiet-hours / notification preferences?

For each YES:
- decide **update vs create** first
- preserve the durable knowledge in ClawMem
- use the appropriate `kind:*` label
- include a `date:YYYY-MM-DD` label
- tell the user what happened:
  - `Locked memory #<n>: <title>` for new memories
  - `Updated memory #<n>: <title>` for updates

Do not wait for automatic extraction if the knowledge is clearly important.

---

## Heartbeat behavior (mandatory)

When you receive a heartbeat poll:

1. Read `HEARTBEAT.md` if it exists and follow its current checklist
2. Use ClawMem as the primary source for remembered context and migrated operating policy
3. Especially respect remembered memories about:
   - quiet hours
   - escalation rules
   - notification thresholds
   - proactive checks
   - when to stay silent vs when to alert
4. Do not resurrect old local-memory workflows from `MEMORY.md` / `memory/*.md` unless they were intentionally preserved as secondary reference material
5. If nothing needs attention, reply exactly `HEARTBEAT_OK`
6. If something needs attention, send a brief, clear alert

---

## What if something fails?

| Failure | Action |
|---------|--------|
| `openclaw.json` not found | Stop and tell the user route config could not be found |
| `CLAWMEM_REPO` / `CLAWMEM_TOKEN` missing | Stop and tell the user current agent route is not provisioned |
| Read-only probe fails | Stop and tell the user ClawMem connectivity failed |
| Repo inventory question but no live inventory capability exists | Do **not** infer total repo count from config; answer only with the current configured route plus the limitation |
| Local files conflict with migrated policy | Prefer ClawMem for remembered durable policy; treat local files as secondary unless explicitly preserved |

---

## Part 5: Reference

---

## Memory Visualization Console

The ClawMem Console at `console.clawmem.ai` provides an interactive knowledge-graph view of memory nodes, labels, and links.

### Generate a console login URL

```sh
eval "$(clawmem_exports)"
echo "https://console.clawmem.ai/login.html?token=${CLAWMEM_TOKEN}"
```

Present the resulting URL directly to the authenticated user.

### When to show the console link

- during onboarding
- when the user asks to view or visualize memory
- after significant memory operations
- when the user would benefit from a graph overview

### Security

The URL contains the agent token for auto-login. Only show it to the authenticated user. Never log it, store it in memory nodes, or include it in commits.

### Output convention

When users ask to view or explore their memory graph, generate the console login URL and present it cleanly.

---

## Known pitfalls

| Problem | Fix |
|---------|-----|
| `openclaw config get` returns redacted token | Read the route from config files and resolve env with `clawmem_exports` |
| Agent uses the wrong repo by reading top-level config | Always resolve `plugins.entries.clawmem.config.agents.<agentId>` for the current agent |
| Agent answers repo count from config alone | Do not do this. Config gives current/default route, not authoritative repo inventory |
| Local files are mistaken as primary memory after install | After installation, treat them as secondary/archive/reference unless explicitly preserved |
| Duplicate memories pile up | Use **Create vs update decision (mandatory)** before saving |
| `gh auth login` hostname typo causes confusion | Avoid manual login when possible; prefer `clawmem_exports`. If you must login, use the exact ClawMem host |
| Read-only probe fails with 401/404 | Confirm current route, repo, token, and host; do not keep operating on assumptions |
| Session startup relies on hard-coded SKILL paths | Do not hard-code path discovery in daily behavior; the skill itself is the daily manual |
| Team-sharing causes repo confusion | Treat sharing as live inventory/permission data, not as static config |

---

**Install / Repair Guide:** use the separate skill named `clawmem-install` during installation or repair  
**Daily Manual:** this `clawmem` skill  
**Console:** [console.clawmem.ai](https://console.clawmem.ai)

**REMEMBER: Read this skill on EVERY turn and EVERY session.**

