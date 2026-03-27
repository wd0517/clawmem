# ClawMem Manual Operations And Troubleshooting

Use this reference only when:
- the user explicitly wants raw GitHub-style repo or issue operations
- you are debugging backend state or labels
- the plugin memory tools are unavailable

## Contents

- Route resolution
- Preflight
- Save a memory manually
- Search memories manually
- Mark memory as stale manually
- `git push` to ClawMem
- Known pitfalls
- Autonomy

If the plugin tools are available, prefer:
- `memory_repos` to inspect available repos
- `memory_list` to inspect the current active-memory index
- `memory_get` to verify one exact memory
- `memory_labels` to inspect current schema
- `memory_repo_create` to create a new memory repo
- `memory_store` to save
- `memory_update` to evolve one canonical memory in place
- `memory_recall` to search
- `memory_forget` to retire stale memories

## Route resolution

ClawMem is routed per agent identity, not through one global repo or token.

Resolve the current route with the bundled helper:

```sh
eval "$(python3 scripts/clawmem_exports.py)"
```

That exports:
- `CLAWMEM_AGENT_ID`
- `CLAWMEM_BASE_URL`
- `CLAWMEM_HOST`
- `CLAWMEM_DEFAULT_REPO`
- `CLAWMEM_REPO`
- `CLAWMEM_TOKEN`

Rules:
- Never store tokens in files or chat
- `CLAWMEM_DEFAULT_REPO` is the fallback memory space for automatic flows
- `CLAWMEM_REPO` is the repo chosen for the current operation
- If `CLAWMEM_TOKEN` is empty, this agent identity has not been provisioned yet

## Preflight

```sh
eval "$(python3 scripts/clawmem_exports.py)"

test -n "$CLAWMEM_REPO" || { echo "ClawMem repo missing for agent $CLAWMEM_AGENT_ID"; exit 1; }
test -n "$CLAWMEM_TOKEN" || { echo "ClawMem token missing for agent $CLAWMEM_AGENT_ID"; exit 1; }
case "$CLAWMEM_REPO" in
  */*) ;;
  *) echo "Invalid CLAWMEM_REPO='$CLAWMEM_REPO' (expected owner/repo)"; exit 1 ;;
esac
```

For ClawMem, always pass `--repo "$CLAWMEM_REPO"` to `gh` or use `$CLAWMEM_BASE_URL/repos/$CLAWMEM_REPO/...` with `curl` explicitly.

Do not export `GH_HOST` or `GH_ENTERPRISE_TOKEN` globally for unrelated github.com work. Use per-command env prefixes if you need isolation.

## Save a memory manually

Use the tool path first. If raw issue control is required:

### With `gh`

```sh
for lbl in "type:memory" "kind:core-fact" "kind:convention" "kind:lesson" "kind:skill" "kind:task"; do
  GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
    gh label create "$lbl" --repo "$CLAWMEM_REPO" --color "5319e7" 2>/dev/null || true
done

GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh issue create --repo "$CLAWMEM_REPO" \
    --title "Memory: <concise title>" \
    --body "<durable detail in plain language>" \
    --label "type:memory" \
    --label "kind:lesson"
```

### With `curl`

```sh
for lbl in "type:memory" "kind:core-fact" "kind:convention" "kind:lesson" "kind:skill" "kind:task"; do
  curl -sf -X POST -H "Authorization: token $CLAWMEM_TOKEN" \
    -H "Content-Type: application/json" \
    "$CLAWMEM_BASE_URL/repos/$CLAWMEM_REPO/labels" \
    -d "{\"name\":\"$lbl\",\"color\":\"5319e7\"}" >/dev/null 2>&1 || true
done

curl -sf -X POST -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Content-Type: application/json" \
  "$CLAWMEM_BASE_URL/repos/$CLAWMEM_REPO/issues" \
  -d "{
    \"title\": \"Memory: <concise title>\",
    \"body\": \"<durable detail in plain language>\",
    \"labels\": [\"type:memory\", \"kind:lesson\"]
  }" | jq '{number, title, url: .html_url}'
```

## Search memories manually

### With `gh`

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh issue list --repo "$CLAWMEM_REPO" \
    --state open \
    --label "type:memory" \
    --search "<keywords>" \
    --limit 100 \
    --json number,title,body,labels,updatedAt
```

### With `curl`

```sh
curl -sf -H "Authorization: token $CLAWMEM_TOKEN" \
  "$CLAWMEM_BASE_URL/repos/$CLAWMEM_REPO/issues?state=open&labels=type:memory&per_page=100&type=issues" | \
  jq --arg q "<keywords>" '
    ($q | ascii_downcase) as $needle
    | map(select(
        ((.title // "") + "\n" + (.body // "")) | ascii_downcase | contains($needle)
      ))
    | map({number, title, body, labels: [.labels[]?.name], updatedAt: .updated_at})
  '
```

## Mark memory as stale manually

If this is still the same canonical fact or task, prefer `memory_update` instead of retiring the old node.

### With `gh`

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh issue close <number> --repo "$CLAWMEM_REPO"
```

### With `curl`

```sh
curl -sf -X PATCH -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Content-Type: application/json" \
  "$CLAWMEM_BASE_URL/repos/$CLAWMEM_REPO/issues/<number>" \
  -d '{"state": "closed"}'
```

If a new memory replaces an old one, save the new memory first and mention the old `#ID` in the replacement body so the supersession is explicit.

## `git push` to ClawMem

`GH_HOST` and `GH_ENTERPRISE_TOKEN` affect `gh`, not `git push`. If you need to push code to a ClawMem git service repo:

```sh
echo "$CLAWMEM_TOKEN" | gh auth login -h "$CLAWMEM_HOST" --with-token
```

After that, `git push` to `https://git.clawmem.ai/...` works normally.

## Known pitfalls

| Problem | Fix |
|---|---|
| Labels do not update reliably via `PATCH` on some backends | Use `PUT /repos/{owner}/{repo}/issues/{n}/labels` when you need exact label replacement |
| `openclaw config get` returns redacted token values | Read the config file path via `openclaw config file`, then inspect the JSON directly |
| Conversation mirror returns `404` | The cached conversation issue was deleted; the plugin recreates it on the next session |
| New session gets `401 Unauthorized` | Re-read the current agent route. If this is first use, trigger one real turn so the plugin can finish provisioning |
| Agent uses the wrong memory repo | Resolve `config.agents.<agentId>` for the current agent; do not read only top-level legacy repo settings |
| `gh` is not the official GitHub CLI | Run `gh --version`; if it is the npm `gh` package instead of the official CLI, use `curl` or replace the CLI install |

## Autonomy

Without confirmation:
- creating or updating memory nodes
- adding comments
- reusing or creating labels
- closing stale memory nodes
- creating new memory repos when a new space is clearly needed

Requires confirmation:
- OpenClaw config changes
- service restarts
- deletions that go beyond ordinary memory retirement
