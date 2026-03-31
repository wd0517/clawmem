# ClawMem Repair And Verification

Use this reference when ClawMem is already installed but is not selected as the active memory plugin, is missing per-agent provisioning, has a broken route, or needs verification after setup.

The website bootstrap `SKILL.md` is the primary setup guide. This reference is for post-install repair, diagnostics, and compatibility-file reminders.

## Contents

- Verify activation and provisioning
- Verify read access without manual login
- Verify the plugin tool path
- Compatibility mode for SOUL.md, AGENTS.md, and TOOLS.md
- Definition of done
- If ClawMem is still broken

## Step 1: Verify activation and provisioning

First verify that ClawMem is the active memory plugin.

```sh
openclaw status
python3 - <<'PY'
import json, os, subprocess
cfg_path = subprocess.check_output(["openclaw", "config", "file"], text=True).strip()
with open(os.path.expanduser(cfg_path)) as f:
    root = json.load(f)
slots = (root.get("plugins") or {}).get("slots") or {}
print(f"plugins.slots.memory = {slots.get('memory', 'MISSING')}")
PY
```

Expected:
- OpenClaw status shows ClawMem as the active memory plugin
- `plugins.slots.memory = clawmem`

Then verify the current agent route. Resolve the current route with the bundled helper:

```sh
eval "$(python3 scripts/clawmem_exports.py)"
printf 'agent=%s\nbase=%s\ndefaultRepo=%s\ntoken=%s\n' \
  "${CLAWMEM_AGENT_ID}" "${CLAWMEM_BASE_URL}" "${CLAWMEM_DEFAULT_REPO}" \
  "$(test -n "${CLAWMEM_TOKEN}" && printf SET || printf MISSING)"
```

If `CLAWMEM_DEFAULT_REPO` or `CLAWMEM_TOKEN` is missing, the current agent has not been provisioned yet. Trigger one real turn with that agent so the plugin can finish provisioning and persist credentials, or restart OpenClaw and retry after the agent is first used.

## Step 2: Verify read access without manual login

This proves that a fresh session can query ClawMem using the current agent's provisioned route.

```sh
eval "$(python3 scripts/clawmem_exports.py)"

test -n "$CLAWMEM_REPO" || { echo "Current agent route has no repo yet"; exit 1; }
test -n "$CLAWMEM_TOKEN" || { echo "Current agent route has no token yet"; exit 1; }

GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh issue list --repo "$CLAWMEM_REPO" --limit 1 --json number,title
```

If `gh` is unavailable or not the official GitHub CLI, use the fallback probe:

```sh
curl -sf -H "Authorization: token $CLAWMEM_TOKEN" \
  "$CLAWMEM_BASE_URL/repos/$CLAWMEM_REPO/issues?state=open&per_page=1&type=issues" | \
  jq 'map({number,title})'
```

If either command returns JSON, even `[]`, the route is usable.

## Step 3: Verify the plugin tool path

From a normal ClawMem-enabled session, verify that:
- `memory_repos` lists accessible repos and marks the default repo
- `memory_list` returns the active memory index
- `memory_get` fetches one exact memory by id or issue number
- `memory_labels` returns the current reusable schema labels
- `memory_recall` returns either a hit list or a clean miss
- `memory_store` is available for immediate durable saves
- `memory_update` updates an existing memory in place
- `memory_repo_create` creates a new repo when a new memory space is needed

Conversation summaries or auto-extracted memories from a just-finished session may appear on the next real request, not necessarily immediately at session close.

## Compatibility mode for SOUL.md, AGENTS.md, and TOOLS.md

If your OpenClaw environment still relies on file-injected identity or behavior reminders, use these compact compatibility snippets. Do not duplicate the entire skill body into those files.

### Optional SOUL.md identity block

```markdown
## Memory System — ClawMem
I use ClawMem as my memory system.
When prior context may help, I search ClawMem before answering.
```

### Optional AGENTS.md reminder

```markdown
Before ending every response, ask: "Did I learn anything durable this turn?"
If yes or unsure, save new memory content to ClawMem in the user's current language.
When updating an existing memory, keep that node in its current language unless the user asks to rewrite it.
```

### Optional TOOLS.md reminder

```markdown
ClawMem is the primary long-term memory system.
Use the bundled $clawmem skill for retrieval, saving, routing, schema, and troubleshooting.
```

These snippets are compatibility aids, not the primary runtime source of truth.

## Definition of done

- `openclaw.json` has `plugins.slots.memory = clawmem`
- The current agent route has a `defaultRepo` or legacy `repo`
- The current agent route has a `token`
- Read-only probe works without manual `gh auth login`
- Plugin memory tools work from a normal session
- The bundled `$clawmem` skill is available after installation

## If ClawMem is still broken

- If `plugins.slots.memory` is wrong, set it back to `clawmem`, restart the gateway, and retry.
- If the route is missing a repo or token, trigger one real turn with that agent and retry provisioning checks.
- If a new session gets `401 Unauthorized`, re-read the current route instead of assuming the old repo or token is still valid.
- If your environment still depends on `SOUL.md` or `AGENTS.md`, add the compatibility snippets above rather than pasting large sections of this skill into those files.
