# ClawMem Collaboration

Use this reference when memory should live in a shared repo instead of one agent's private default repo, or when multiple agents or teammates need to read and write the same memory space. Use it for both `collaboration` and `collabration` requests.

## Contents

- When to use
- Default operating style
- Repo routing for collaboration
- Collaboration model
- Choose the right mechanism
- Pre-mutation checklist
- Prompt-to-tool mapping
- Recommended workflow
- Manual shared repo creation
- Fallback mode

## When to use

Use this reference when the user asks to:

- create or manage an organization
- invite someone into an organization
- inspect, accept, or decline an invitation sent to the current user
- create or manage a team
- add or remove a repository collaborator
- grant a team access to a repo
- inspect outside collaborators
- create a shared team memory repo or org-owned memory space
- debug why a user can or cannot access a repo

Do not use this workflow for ordinary memory recall or save actions unless the user is specifically asking to change who can access a memory repo.

## Default operating style

- Prefer the built-in ClawMem collaboration tools first.
- Fall back to `gh api` or `curl` only when plugin tools are unavailable or when debugging backend behavior directly.
- Reuse the main `clawmem` skill's route-resolution helper when raw shell access is required.
- Think in canonical runtime permissions: `read`, `write`, `admin`.
- Treat GitHub-compatible aliases such as `pull`, `triage`, `push`, and `maintain` as transport compatibility only.

Tool-first rule:
- Read-only inspection:
  - `collaboration_orgs`
  - `collaboration_teams`
  - `collaboration_team_repos`
  - `collaboration_repo_collaborators`
  - `collaboration_repo_invitations`
  - `collaboration_user_repo_invitations`
  - `collaboration_org_invitations`
  - `collaboration_user_org_invitations`
  - `collaboration_outside_collaborators`
  - `collaboration_repo_access_inspect`
- Mutations:
  - `collaboration_org_create`
  - `collaboration_team_create`
  - `collaboration_team_membership_set`
  - `collaboration_team_membership_remove`
  - `collaboration_team_repo_set`
  - `collaboration_team_repo_remove`
  - `collaboration_repo_collaborator_set`
  - `collaboration_repo_collaborator_remove`
  - `collaboration_user_repo_invitation_accept`
  - `collaboration_user_repo_invitation_decline`
  - `collaboration_org_invitation_create`
  - `collaboration_user_org_invitation_accept`
  - `collaboration_user_org_invitation_decline`

All write tools require `confirmed=true`. Do not set `confirmed=true` until the user has approved the exact org, team, repo, invitation, or permission change.

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

## Collaboration model

Reason with these rules before every collaboration action:

- An organization is an explicit governance boundary.
- Org membership is explicit and separate from team membership.
- Teams are org-scoped authorization groups, not social groups.
- Effective repo access is `max(org base permission, direct collaborator grant, team grant)` after owner or admin shortcuts.
- Runtime permissions are only `none`, `read`, `write`, and `admin`.
- `memory_repos` only shows repos that are already accessible now; it does not prove there are no pending invitations.
- A repo collaborator grant may create a pending repository invitation instead of immediate access when the target user is not already a collaborator.
- Accepting a repository invitation is what turns a pending share into visible repo access for the invitee.
- Outside collaborators are non-members who still have direct collaborator access to at least one org-owned repo.
- Accepting an org invitation creates org membership, joins invited teams as `member`, and removes the pending invitation.
- If a user becomes an org member, any outside-collaborator row for that org should disappear.
- The system-managed `admins` team is an implementation mechanism, not a user-facing product primitive.

## Choose the right mechanism

Use this decision map:

| Goal | Use |
|---|---|
| Give one user access to one repo without org membership | Direct collaborator |
| Bring one user into the org | Org invitation |
| Grant a group access to selected repos | Team + team-repo grant |
| Create a shared team memory space | Org-owned repo + team-repo grant |
| Inspect non-members who still have repo access | Outside collaborator listing |

Hard rules:
- Never assume team membership creates org membership.
- Never use team membership as a side-door org bootstrap.
- Never assume a repo share should become org membership; choose intentionally.
- If the task is org-scoped, ensure the org already exists or create it explicitly first.

## Pre-mutation checklist

Before any write action:

1. Identify the acting identity, target org, target repo, target user, target team, and desired permission.
2. Normalize the user's requested permission mentally to `read`, `write`, or `admin` before reasoning.
3. Inspect current state first when the request is ambiguous.
4. If the action changes governance, permissions, membership, or invitations, require explicit user intent or confirmation.
5. Never paste raw tokens into chat or files.

Read-only checks can run without confirmation.

## Prompt-to-tool mapping

Translate user intent like this:

- `Create a shared memory repo for team X`
  - inspect orgs or teams first
  - create the repo with `memory_repo_create` or raw repo tooling if needed
  - grant the team access with `collaboration_team_repo_set`
- `Give Alice access to this one memory repo`
  - inspect direct collaborators first with `collaboration_repo_collaborators`
  - then use `collaboration_repo_collaborator_set`
  - if the user was not already a collaborator, expect a pending repo invitation and verify with `collaboration_repo_invitations`
- `Bring Alice into the org and platform team`
  - inspect teams first with `collaboration_teams`
  - then use `collaboration_org_invitation_create`
- `Someone shared a memory repo with me; can you see it and accept it?`
  - start with `collaboration_user_repo_invitations`
  - do not treat a `memory_repos` miss as proof that no share exists
  - if the correct pending invite is visible and the user asked to accept it, use `collaboration_user_repo_invitation_accept`
- `I still cannot see the shared memory repo`
  - inspect `collaboration_user_repo_invitations` first
  - if needed, have the repo owner inspect `collaboration_repo_invitations`
- `Why can Bob still see this repo?`
  - start with `collaboration_repo_access_inspect`
  - then drill into `collaboration_repo_collaborators`, `collaboration_repo_invitations`, `collaboration_team_repos`, `collaboration_outside_collaborators`, and `collaboration_org_invitations` as needed
- `Remove Carol from org-shared memory access`
  - identify whether access comes from a direct collaborator grant, a team repo grant, or a pending invitation
  - remove the actual source of access rather than guessing

## Recommended workflow

For read-only analysis:

1. Identify the target org, repo, or team.
2. Use the relevant read-only collaboration tools.
3. Summarize the current state in canonical terms: org membership, team grants, direct collaborator grants, pending repo invitations, outside collaborators, and pending org invitations.

For write actions:

1. Inspect current state first.
2. Tell the user exactly what will change.
3. Wait for explicit approval.
4. Re-run the write tool with `confirmed=true`.
5. Summarize the result and name the affected org, team, and repo explicitly.

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

## Fallback mode

If the collaboration tools are unavailable, use `gh api` against the ClawMem host; fall back to `curl` only when `gh` is unavailable or broken.

Command pattern:

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh api "/user"
```

If `gh` cannot be used:

```sh
curl -sf -H "Authorization: token $CLAWMEM_TOKEN" \
  "$CLAWMEM_BASE_URL/user"
```
