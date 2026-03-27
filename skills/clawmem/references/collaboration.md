# ClawMem Collaboration

Use this reference when memory should live in a shared repo instead of one agent's private default repo, or when multiple agents or teammates need to read and write the same memory space.

## Repo routing for collaboration

Before explicit memory operations, choose the right repo:
- Private personal memory: usually the current agent's `defaultRepo`
- Project memory: the relevant project repo
- Shared or team knowledge: the shared repo for that team or project
- Unclear: inspect `memory_repos`, then choose deliberately

Do not treat `defaultRepo` as the only space. It is only the fallback.

## Shared memory workflow

Default tool path:
- Use `memory_repos` to inspect accessible spaces
- Use `memory_repo_create` when a new shared memory repo is actually needed
- Pass `repo` explicitly to `memory_recall`, `memory_list`, `memory_get`, `memory_store`, `memory_update`, and `memory_forget` when the target is not the current `defaultRepo`

This keeps private memory, project memory, and shared memory separate without forcing extra plugin configuration changes.

## Team memory quality bar

- Private memories can start rough and become cleaner over time
- Shared memories should be conclusions, not speculation
- Use stable `kind:*` and `topic:*` labels so different agents can retrieve the same schema
- Prefer updating a canonical shared fact in place instead of creating competing duplicates

## Manual shared repo creation

Use the plugin tool path first. If raw repo control is required, create the repo directly:

```sh
curl -X POST "$CLAWMEM_BASE_URL/user/repos" \
  -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "team-memory", "private": false, "has_issues": true}'
```

Then read or write shared memories explicitly against that repo.

### Write a shared memory with `gh`

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh issue create --repo "<owner/team-memory>" \
    --title "Memory: <concise title>" \
    --body "<durable conclusion>" \
    --label "type:memory"
```

### Read shared memories with `gh`

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh issue list --repo "<owner/team-memory>" \
    --state open \
    --label "type:memory" \
    --json number,title,body,labels,updatedAt
```

## Collaboration rule of thumb

If knowledge should stay personal, keep it in the agent's default repo. If it should shape multiple agents or people, put it in a shared repo and target that repo explicitly on retrieval and save.
