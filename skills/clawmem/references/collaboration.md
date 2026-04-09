# ClawMem Collaboration

Use this reference when memory should live in a shared repo instead of one agent's private default repo, or when multiple agents or teammates need to read and write the same memory space. Use it for both `collaboration` and `collabration` requests.

## Contents

- When to use
- Default operating style
- Repo routing and shared spaces
- Collaboration model
- Choose the right mechanism
- Pre-mutation checklist
- Prompt-to-tool mapping
- Team memory quality bar
- Collaboration rule of thumb
- Manual org-owned shared repo creation
- Fallback mode

## When to use

Use this reference when the user asks to:

- create or manage an organization
- invite someone into an organization
- inspect, accept, or decline an invitation sent to the current user
- create or manage a team
- inspect or remove organization members or membership state
- revoke a pending organization invitation from the org side
- add or remove a repository collaborator
- grant a team access to a repo
- rename or delete a team, or inspect team members
- move an existing memory repo into an organization
- inspect outside collaborators
- create a shared team memory repo or org-owned memory space
- debug why a user can or cannot access a repo

Do not use this workflow for ordinary memory recall or save actions unless the user is specifically asking to change who can access a memory repo.

## Default operating style

- Prefer the built-in ClawMem collaboration tools first.
- Inspect current state before mutating anything.
- Set `confirmed=true` only after the user has approved the exact org, team, repo, invitation, or permission change.
- Fall back to `gh api` or `curl` only when plugin tools are unavailable, when debugging backend behavior directly, or when you must create an org-owned repo because the plugin does not expose an org-repo creation tool yet.
- Reuse the main `clawmem` skill's route-resolution helper when raw shell access is required.
- Think in canonical runtime permissions: `read`, `write`, `admin`.
- Treat GitHub-compatible aliases such as `pull`, `triage`, `push`, and `maintain` as transport compatibility only.

Tool-first rule:
- Read-only inspection:
  - `collaboration_orgs`
  - `collaboration_org_members`
  - `collaboration_org_membership`
  - `collaboration_teams`
  - `collaboration_team`
  - `collaboration_team_members`
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
  - `collaboration_org_member_remove`
  - `collaboration_org_membership_remove`
  - `collaboration_team_create`
  - `collaboration_team_update`
  - `collaboration_team_delete`
  - `collaboration_team_membership_set`
  - `collaboration_team_membership_remove`
  - `collaboration_team_repo_set`
  - `collaboration_team_repo_remove`
  - `collaboration_repo_transfer`
  - `collaboration_repo_collaborator_set`
  - `collaboration_repo_collaborator_remove`
  - `collaboration_user_repo_invitation_accept`
  - `collaboration_user_repo_invitation_decline`
  - `collaboration_org_invitation_create`
  - `collaboration_org_invitation_revoke`
  - `collaboration_user_org_invitation_accept`
  - `collaboration_user_org_invitation_decline`

## Repo routing and shared spaces

Before explicit memory operations, choose the right repo:
- Private personal memory: usually the current agent's `defaultRepo`
- Project memory: the relevant project repo
- Shared or team knowledge: the shared repo for that team or project
- Unclear: inspect `memory_repos`, then choose deliberately

Do not treat `defaultRepo` as the only space. It is only the fallback.

Default tool path:
- Use `memory_repos` to inspect accessible spaces
- Use `memory_repo_create` when a new repo should be owned by the current agent identity
- Create an org-owned repo with raw `gh api` or `curl` when the memory space must be governed by an organization team
- Pass `repo` explicitly to `memory_recall`, `memory_list`, `memory_get`, `memory_store`, `memory_update`, and `memory_forget` when the target is not the current `defaultRepo`

This keeps private memory, project memory, and shared memory separate without forcing extra plugin configuration changes.

## Collaboration model

Reason with these rules before every collaboration action:

- An organization is an explicit governance boundary.
- Org membership is explicit and separate from team membership.
- Teams are org-scoped authorization groups, not social groups.
- Effective repo access is `max(org base permission, direct collaborator grant, team grant)` after owner or admin shortcuts.
- Runtime permissions are only `none`, `read`, `write`, and `admin`.
- Organization invitation roles are `member` and `owner`.
- `memory_repos` only shows repos that are already accessible now; it does not prove there are no pending invitations.
- The repo collaborators API includes the repository owner row; reason about direct collaborators as explicit non-owner shares.
- A repo collaborator grant may create a pending repository invitation instead of immediate access when the target user is not already a collaborator.
- Accepting a repository invitation is what turns a pending share into visible repo access for the invitee.
- Outside collaborators are non-members who still have direct collaborator access to at least one org-owned repo.
- Accepting an org invitation creates org membership, joins invited teams as `member`, and removes the pending invitation.
- Org default repository permission can still grant repo access to active org members even after direct collaborator or team grants are removed.
- If a user becomes an org member, any outside-collaborator row for that org should disappear.
- The system-managed `admins` team is an implementation mechanism, not a user-facing product primitive.

## Choose the right mechanism

Use this decision map:

| Goal | Use |
|---|---|
| Give one user access to one repo without org membership | Direct collaborator |
| Bring one user into the org | Org invitation |
| Inspect whether a user already has org membership or only a pending org invite | Org membership inspection |
| Grant a group access to selected repos | Team + team-repo grant |
| Create a shared team memory space | Org-owned repo + team-repo grant |
| Move an existing memory repo under org governance | Repo transfer into org |
| Create another memory space under the current agent identity | `memory_repo_create` |
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
  - inspect or create the org and team first
  - if the repo should be team-governed, create an org-owned repo with raw `gh api` or `curl`; `memory_repo_create` only creates repos under the current agent identity
  - grant the team access with `collaboration_team_repo_set`
- `Give Alice access to this one memory repo`
  - inspect direct collaborators first with `collaboration_repo_collaborators`
  - then use `collaboration_repo_collaborator_set`
  - if the user was not already a collaborator, expect a pending repo invitation and verify with `collaboration_repo_invitations`
- `Bring Alice into the org and platform team`
  - inspect teams first with `collaboration_teams`
  - then use `collaboration_org_invitation_create`
- `Show me who is in this org`
  - use `collaboration_org_members`
  - if you need one person's exact state, use `collaboration_org_membership`
- `Remove Alice from the org`
  - inspect `collaboration_org_membership` first
  - if Alice is an active org member, use `collaboration_org_member_remove`
  - if you want one command that also handles pending invites, use `collaboration_org_membership_remove`
- `Revoke the pending org invite for Alice`
  - inspect `collaboration_org_invitations` to get the invitation id
  - then use `collaboration_org_invitation_revoke`
- `Rename or delete this team`
  - inspect the team with `collaboration_team`
  - use `collaboration_team_update` or `collaboration_team_delete`
- `Who is in team platform?`
  - use `collaboration_team_members`
- `Move this repo into org acme so team access can govern it`
  - ensure the target org already exists and the actor has org admin rights
  - then use `collaboration_repo_transfer`
- `Someone shared a memory repo with me; can you see it and accept it?`
  - start with `collaboration_user_repo_invitations`
  - do not treat a `memory_repos` miss as proof that no share exists
  - if the correct pending invite is visible and the user asked to accept it, use `collaboration_user_repo_invitation_accept`
- `I still cannot see the shared memory repo`
  - inspect `collaboration_user_repo_invitations` first
  - if needed, have the repo owner inspect `collaboration_repo_invitations`
- `Why can Bob still see this repo?`
  - start with `collaboration_repo_access_inspect`
  - if you know the username, pass it so the tool can check org membership and org-base access explicitly
  - then drill into `collaboration_repo_collaborators`, `collaboration_repo_invitations`, `collaboration_team_repos`, `collaboration_outside_collaborators`, and `collaboration_org_invitations` as needed
- `Remove Carol from org-shared memory access`
  - identify whether access comes from org default permission, a direct collaborator grant, a team repo grant, or a pending invitation
  - inspect `collaboration_org_membership` when the repo is org-owned
  - if org default permission still applies, remove org membership with `collaboration_org_member_remove` or `collaboration_org_membership_remove`
  - remove the actual source of access rather than guessing

## Team memory quality bar

- Private memories can start rough and become cleaner over time
- Shared memories should be conclusions, not speculation
- When access is governed by teams or org policy, prefer org-owned repos over one user's private space
- Use stable `kind:*` and `topic:*` labels so different agents can retrieve the same schema
- Prefer updating a canonical shared fact in place instead of creating competing duplicates

## Collaboration rule of thumb

If knowledge should stay personal, keep it in the agent's default repo. If it should shape multiple agents or people, put it in a shared repo and target that repo explicitly on retrieval and save.

## Manual org-owned shared repo creation

Use the plugin tool path first. If the memory space must be org-governed, create an org-owned repo directly because `memory_repo_create` only creates repos under the current agent identity.

### With `gh api`

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh api -X POST "/orgs/<org>/repos" \
    -f name='team-memory' \
    -F private=true \
    -F has_issues=true
```

### With `curl`

```sh
curl -sf -X POST "$CLAWMEM_BASE_URL/orgs/<org>/repos" \
  -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "team-memory", "private": true, "has_issues": true}'
```

After the repo exists:
- grant the team access with `collaboration_team_repo_set`
- use the main memory tools with explicit `repo` targeting for read and write flows
- reuse [manual-ops.md](manual-ops.md) only if you need raw memory issue control after the repo already exists

If the repo already exists under a personal owner and should become org-governed instead of creating a fresh repo:
- use `collaboration_repo_transfer`
- then continue with team grants and explicit `repo` targeting against the new org-owned full name

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
