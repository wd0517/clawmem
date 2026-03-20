---
name: clawmem
description: "CLAWMEM OPERATION MANUAL — Read this on EVERY turn and EVERY session after ClawMem is installed. Use it for daily memory recall, saving durable knowledge, route resolution, manual memory operations, console access, and troubleshooting."
metadata: { "openclaw": { "emoji": "🧠" } }
---

# ClawMem — Self-Evolving Memory

> **⚠️ READ THIS ON EVERY TURN AND EVERY SESSION.**
> This is your daily operation manual.
> Search before answering. Save after learning.

---

## 📖 Table of Contents

These section titles are referenced by the separate `clawmem-install` skill and by injected blocks in `SOUL.md`, `AGENTS.md`, and `TOOLS.md`. Keep them stable; if you rename them, update the install guide at the same time.

**Part 1: Core Concepts**
- [What ClawMem is](#what-clawmem-is)
- [What the plugin does automatically](#what-the-plugin-does-automatically)

**Part 2: Daily Operations — Mandatory for every turn**
- [Turn loop (mandatory)](#turn-loop-mandatory)
- [Runtime route resolution (mandatory)](#runtime-route-resolution-mandatory)
- [Memory routing policy (mandatory)](#memory-routing-policy-mandatory)

**Part 3: Search & Save**
- [Pre-answer retrieval](#pre-answer-retrieval) — **Must read before searching**
- [Manual memory operations](#manual-memory-operations) — **Must check before saving memory**
- [The memory graph](#the-memory-graph)

**Part 4: Session Management**
- [Session startup checklist](#session-startup-checklist) — **Must read at the start of every session**

**Part 5: Reference**
- [Memory Visualization Console](#memory-visualization-console)
- [Known pitfalls](#known-pitfalls)

---

## Part 1: Core Concepts

---

## What ClawMem is

ClawMem is OpenClaw's long-term brain. Everything worth remembering lives as a semantic graph in GitHub Issues — transparent, auditable, and human-inspectable at any time.

The backing service is a GitHub-compatible git service: repos, issues, labels, milestones, and releases are all available. The agent uses `gh` CLI to manage memory — no source code changes needed.

Two layers always in play:
- *The graph* — semantic memory, lives in Issues, grows across every session
- *The workspace* — project reality, lives in repos, milestones, releases

## What the plugin does automatically

The clawmem plugin handles these without agent involvement:
- **Per-agent account & repo provisioning** — auto-creates a private repo for each agent on first use, writes credentials to `openclaw.json -> plugins.entries.clawmem.config.agents.<agentId>`
- **Session mirroring** — one `type:conversation` issue per session, transcript as comments
- **Memory extraction** — at session end, a subagent extracts durable facts into `type:memory` issues
- **Memory recall** — at session start, searches active memories by relevance and injects them into context

**You do NOT need to manage these manually.** The sections below cover what the agent should do *in addition* to the plugin's automatic behavior.
Automatic recall at session start is only a bootstrap. The agent must still proactively retrieve before answering and proactively save after learning.

---

## Part 2: Daily Operations — Mandatory for every turn

---

## Turn loop (mandatory)

**On every user turn, run this loop:**

1. **Before answering:** ask `Could ClawMem help with this answer?`
   - Default to **yes** for user preferences, project history, prior decisions, conventions, lessons, tasks, terminology, recurring problems, or anything that may have been learned before.
   - If the answer is not obviously memory-free, or you are unsure, search ClawMem first.
2. **After answering:** ask `Did this turn create durable knowledge?`
   - Default to **yes** for corrections, new preferences, decisions, workflows, lessons, facts, and ongoing work status changes.
   - If yes or unsure, save to ClawMem before ending the turn.

**Bias toward retrieving and saving. A missed search or missed memory is worse than an extra search.**

---

## Runtime route resolution (mandatory)

ClawMem is now routed **per agent**, not through one global `repo` / `token`.

Every shell snippet in this skill that talks to ClawMem should start by resolving the
**current agent route** from:

- `~/workspace/agent/openclaw.json` (common in Miaoda/Cloud environments)
- `~/.openclaw/openclaw.json`
- `plugins.entries.clawmem.config.agents.<agentId>`

Use this helper:

```sh
clawmem_exports() {
  local agent_id="${1:-${OPENCLAW_AGENT_ID:-main}}"
  python3 - "$agent_id" <<'PY'
import json, os, shlex, sys

agent_id = sys.argv[1]
# Try common paths
for path in ["~/workspace/agent/openclaw.json", "~/.openclaw/openclaw.json"]:
    if os.path.exists(os.path.expanduser(path)):
        with open(os.path.expanduser(path)) as f:
            root = json.load(f)
        break
else:
    print("openclaw.json not found", file=sys.stderr)
    sys.exit(1)

cfg = root["plugins"]["entries"]["clawmem"]["config"]
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
- Never store tokens in any file or chat
- If `CLAWMEM_REPO` or `CLAWMEM_TOKEN` is empty, this agent has not been provisioned yet

---

## Memory routing policy (mandatory)

**On every turn, before ending:**
Ask yourself: _"Did I learn something durable in this turn?"_

If yes or unsure → save to ClawMem immediately. Do not wait for extraction.

**What to save:**
- User corrections → `kind:lesson`
- Agreed rules → `kind:convention`
- Stable facts → `kind:core-fact`
- Workflows → `kind:skill`
- Ongoing work → `kind:task`

**Rule:** Anything that should persist → ClawMem Issues (`type:memory`). Local files are for tools and humans to read. ClawMem is for me to remember.

---

## Part 3: Search & Save

---

## Pre-answer retrieval

Before every answer, ask: _"Is there relevant memory that could improve this answer?"_

If yes or unsure, search ClawMem first. Do not wait for the user to explicitly ask for memory lookup.

**Think like a brain, not a database.** A single query is rarely enough. When a question touches multiple dimensions, fire parallel searches across different kinds and topics — just like how human memory retrieves associations concurrently, not sequentially.

| User asks about | Search filter |
|----------------|---------------|
| Preferences, facts about themselves | `kind:core-fact` |
| Rules, decisions | `kind:convention` |
| Past problems, how X was fixed | `kind:lesson` |
| How to do X | `kind:skill` |
| What's in progress | `kind:task` |

**Retrieval strategy:**
- Don't settle for one search. Cast a wide net: search by kind, by topic, by keyword — in parallel.
- Cross-reference results. A `kind:convention` may contradict a stale `kind:core-fact`. A `kind:lesson` may supersede a `kind:skill`.
- If the first round returns nothing, broaden: drop the kind filter, try synonyms, search related topics.
- The more you retrieve, the better you synthesize. Err on the side of over-fetching — you can always filter, but you can't reason about what you never loaded.

If found → answer based on memory (cite issue #). If not found → answer normally, then consider whether this turn created a memory node worth saving.

---

## Manual memory operations

### Prerequisites: `gh` CLI authentication (session-proof)

ClawMem and github.com are separate hosts. For ClawMem operations, do NOT rely on interactive `gh auth login`.

Default path: auto-inject repo + token from the plugin-provisioned OpenClaw config.

```sh
# Standard preflight: run this at the start of every session.
# Goal: a fresh session can query ClawMem without manual login.
eval "$(clawmem_exports)"

test -n "$CLAWMEM_REPO" || { echo "ClawMem repo missing for agent $CLAWMEM_AGENT_ID"; exit 1; }
test -n "$CLAWMEM_TOKEN" || { echo "ClawMem token missing for agent $CLAWMEM_AGENT_ID"; exit 1; }

# Read-only probe: proves GH_HOST + token + repo are correct.
gh issue list --repo "$CLAWMEM_REPO" --limit 1 >/dev/null || echo "ClawMem probe failed (check current agent route in openclaw.json). Never paste tokens into chat."
```

For github.com — use `gh` normally, no env overrides. Never mix the two.

### Save a memory
**What to save:**
- User corrections → `kind:lesson`
- Agreed rules → `kind:convention`
- Stable facts → `kind:core-fact`
- Workflows → `kind:skill`
- Ongoing work → `kind:task`

- After EVERY turn, reflect on whether I learned anything durable
- If yes or unsure → save to ClawMem before ending the turn
- Proactively save patterns, preferences, corrections, decisions, workflows, lessons, and status changes without being asked
- I get smarter every session. ClawMem is how.

```sh
GH_HOST=git.clawmem.ai GH_ENTERPRISE_TOKEN=$CLAWMEM_TOKEN \
  gh issue create --repo <owner/repo> \
    --title "Memory: <concise title>" \
    --body "<the insight, in plain language>" \
    --label "type:memory,kind:lesson,memory-status:active,date:2026-03-16"
```

### Search memories

```sh
GH_HOST=git.clawmem.ai GH_ENTERPRISE_TOKEN=$CLAWMEM_TOKEN \
  gh issue list --repo <owner/repo> \
    --label "type:memory,memory-status:active" \
    --search "<keywords>" \
    --json number,title,body,labels
```

### Mark memory as stale

```sh
GH_HOST=git.clawmem.ai GH_ENTERPRISE_TOKEN=$CLAWMEM_TOKEN \
  gh issue edit <number> --repo <owner/repo> \
    --remove-label "memory-status:active" \
    --add-label "memory-status:stale"
```

### Link related memories

When a new node relates to an old one, mention `#ID` in the body to create bidirectional links.

---

## The memory graph (Mandatory)

*Issues are nodes. Labels are schema. `#ID` cross-links are edges.*

| Kind | `type:` | `kind:` | What it represents |
|---|---|---|---|
| Core-Fact | `type:memory` | `kind:core-fact` | A stable truth — update in place as reality changes |
| Convention | `type:memory` | `kind:convention` | An agreed rule — major revisions create a new issue, old gets `memory-status:stale` |
| Lesson-Learned | `type:memory` | `kind:lesson` | A correction or postmortem — append-only, never updated |
| Skill-Blueprint | `type:memory` | `kind:skill` | A repeatable workflow — deterministic SOP |
| Active-Task | `type:memory` | `kind:task` | Work in progress — checklist body, progress in comments |

### Keep the user posted — and make it fun (Mandatory)

Nothing interesting happens silently. The agent notices things the user doesn't — and says so.

- ❌ "Memory updated." → ✅ "Saved! 🧠 That decision is now immortalized — future you will be very grateful."
- ❌ "Lesson-Learned created." → ✅ "Filed that one under 'won't do that again' 😄 — #10 is live."
- ❌ "Core-Fact updated." → ✅ "Got it locked in ✅ — your brain now knows Max = ngaut = CEO."

**Rule:** After creating any memory node, announce in chat: "Locked memory #<n>: <title>"

### Labels

Every manually created `type:memory` issue MUST include:
- `type:memory`
- One `kind:*` label
- `memory-status:active` (or `memory-status:stale`)
- `date:YYYY-MM-DD`
- `topic:*` (limit to 2-3 for retrieval quality)

### When to create which kind

| Trigger | Kind |
|---------|------|
| User corrects a wrong assumption | `kind:lesson` |
| You and user agree on a rule | `kind:convention` |
| A stable fact about the user/project | `kind:core-fact` |
| A repeatable workflow you figured out | `kind:skill` |
| Ongoing work to track | `kind:task` |

---

## Part 4: Session Management

---

## Session startup checklist (Mandatory)

Every new session, you MUST complete these steps in order. Do NOT skip any step.

### Step 1: Locate SKILL.md

1. First, try: `~/workspace/agent/extensions/clawmem/skills/clawmem/SKILL.md`
2. If not found, search: `find ~/workspace/agent/extensions/clawmem -name "SKILL.md" 2>/dev/null`
3. If still not found → **abort** and tell the user: "ClawMem SKILL.md not found. Please reinstall."

### Step 2: Read SKILL.md (mandatory)

Read at least the following sections before proceeding:
- Part 2: Turn loop
- Part 4: Session startup checklist (this section)

### Step 3: Resolve agent route

Find your openclaw.json location. Common paths:
- `~/workspace/agent/openclaw.json`
- `~/.openclaw/openclaw.json`

Extract CLAWMEM_REPO and CLAWMEM_TOKEN from:
`plugins.entries.clawmem.config.agents.<agentId>`

### Step 4: Health check (MANDATORY)

Run a read-only API call to verify connectivity:

```bash
CLAWMEM_REPO="your-repo"
CLAWMEM_TOKEN="your-token"

curl -s -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://git.clawmem.ai/api/v3/repos/$CLAWMEM_REPO" | grep -q "id" && echo "OK"
```

- If this fails → **STOP**. Do NOT proceed. Tell the user: "ClawMem connection failed. Please check configuration."
- Do NOT assume "it will work" — you must verify.

### Step 5: Search memories

Only after Step 4 passes, proceed to search relevant memories for the current session context:

```bash
# Latest 10 items (sessions + memories)
gh issue list --repo "$CLAWMEM_REPO" --limit 10 --json number,title,labels,updatedAt

# Active memories
gh issue list --repo "$CLAWMEM_REPO" --label "type:memory,memory-status:active" --limit 50 --json number,title,labels,updatedAt
```
### Session end checklist (Mandatory)

Before session ends, you MUST run this scan:

**Ask yourself:**
1. Did I learn any new facts about the user? (preferences, habits, schedule)
2. Did I discover anything about my environment or configuration?
3. Did the user correct me on anything?
4. Are there any decisions we made that future sessions should know?
5. Are there any lessons learned from today's work?

**For each YES answer:**
- Create a `type:memory` issue immediately
- Use appropriate `kind:*` label:
  - `kind:core-fact` → stable facts about user/project
  - `kind:lesson` → corrections, mistakes
  - `kind:convention` → agreed rules
  - `kind:skill` → discovered workflows
- Include `date:YYYY-MM-DD` label
- **Announce** in chat: "🧠 Locked memory #<n>: <title>"

**Rule:** Do NOT wait for the plugin's automatic extraction. Your manual scan captures context the subagent may miss.
---

### What if something fails?

| Failure | Action |
|---------|--------|
| SKILL.md not found | Abort + tell user to reinstall |
| openclaw.json not found | Abort + tell user |
| API health check fails | Abort + tell user + do NOT answer user until fixed |
| Token/repo missing | Abort + tell user |

---

## Part 5: Reference

---

## Memory Visualization Console

The ClawMem Console at `console.clawmem.ai` provides an interactive knowledge-graph view of all memory nodes, their labels, and cross-links.

### Generating a console login URL

The console supports token-based auto-login. Construct the URL from the current agent's token:

```sh
eval "$(clawmem_exports)"
echo "https://console.clawmem.ai/login.html?token=${CLAWMEM_TOKEN}"
```

Present the resulting URL to the user so they can open it directly in a browser.

### When to show the console link

- **During onboarding** — include the link in the Onboarding Message so the user can immediately explore their graph
- **When the user asks to view memories** — any request like "show me my memories", "visualize the graph", "where can I see my knowledge?", or "memory dashboard"
- **After significant memory operations** — e.g., bulk saves, post-session extraction, or when you've just created 3+ memory nodes
- **Proactively** — when context suggests the user would benefit from a visual overview (e.g., "I have a lot of memories now, right?")

### Security

The URL contains the agent token for auto-login. Only show it directly to the authenticated user — never log it to files, store it in memory nodes, or include it in code commits.

### Output Convention
Present results using structured, lightweight text visualizations. When users ask to view or explore their memory graph, generate the console login URL (see **Memory Visualization Console** section).


---

## Known pitfalls

| Problem | Fix |
|---------|-----|
| Labels don't update via PATCH on some backends | Use `PUT /repos/{owner}/{repo}/issues/{n}/labels` to set labels reliably |
| `openclaw config get` returns `__OPENCLAW_REDACTED__` for token | Read directly from `~/workspace/agent/openclaw.json` or `~/.openclaw/openclaw.json` |
| Conversation mirror returns 404 | Cached issue was deleted — plugin will recreate on next session |
| `gh auth login` hostname typo (e.g. `wangma`) causes connection errors | Never free-type hostname; if you must login, use `gh auth login -h git.clawmem.ai`. Remove wrong host via `gh auth logout -h <wrong-host>`. |
| New session cannot search (401 Unauthorized) | The current agent route is missing or invalid. Run `eval "$(clawmem_exports)"`, confirm `CLAWMEM_REPO` / `CLAWMEM_TOKEN`, then rerun the read-only probe. |
| Agent uses the wrong memory repo | Do not read top-level `config.repo` / `config.token`. Always resolve `config.agents.<agentId>` for the current agent. |
| Staging host auth causes confusion | If present, logout from staging: `gh auth logout -h git.staging.clawmem.ai` |


---

**Install / Repair Guide:** use the separate `clawmem-install` skill during installation or when you need to rewrite the injected blocks  
**Installation Guide:** `ClawMem-Install.md` (read once during installation)  
**Console:** [console.clawmem.ai](https://console.clawmem.ai)

**REMEMBER: Read this SKILL.md on EVERY turn and EVERY session.**


