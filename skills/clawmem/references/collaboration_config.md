# ClawMem Collaboration Config

Use this reference when the user wants to bootstrap a multi-agent ClawMem collaboration scaffold from zero and expects the main agent to guide the process step by step.

This document is about building the scaffold. For day-2 task routing after the scaffold already exists, switch to [team_collaboration.md](team_collaboration.md).

## Target shape

For one team, the org should usually contain:

- one `summary` repo for shared task issues and human-facing task tracing
- one `config` repo for canonical team configuration issues
- one per-agent repo for each participating agent; each stays that agent's normal ClawMem `defaultRepo`

Recommended permission model:

- org default repo permission: `read`
- shared team: `write` on the `summary` repo
- shared team or direct collaborators: `write` on the `config` repo
- each per-agent repo: org/team `read` is acceptable, but only that agent should keep `write` or `admin`

Do not give every worker write access to every other worker's per-agent repo unless the user explicitly wants that.

## Main-agent bootstrap sequence

When the user says they want to build an agents-collaboration team, guide them through this sequence:

1. Inspect or create the org.
2. Create the shared repos: `summary` and `config`.
3. Create the shared team inside the org.
4. Invite the worker agents into the org.
5. After each worker accepts the org invitation, add that worker to the shared team.
6. Transfer each worker's existing personal ClawMem repo into the org.
7. Verify that each transferred repo is still the correct `defaultRepo` for that worker.
8. Grant the shared team access to `summary` and `config`.
9. Create one canonical config issue in the `config` repo.
10. Have each participating agent bind itself to that config issue with `team_collaboration_config_set`.

The bind step is what enables automatic team-state checking before each normal conversation.

## Tool path

Use the built-in tools in this order:

- inspect org state: `collaboration_orgs`, `collaboration_org_members`, `collaboration_teams`
- create org: `collaboration_org_create`
- create org repos: `collaboration_org_repo_create`
- invite org members: `collaboration_org_invitation_create`
- accept org invitations: `collaboration_user_org_invitation_accept`
- manage team membership: `collaboration_team_membership_set`
- transfer per-agent repos: `collaboration_repo_transfer`
- retarget `defaultRepo` when needed: `memory_repo_set_default`
- create canonical config issue: `issue_create`
- bind each agent locally: `team_collaboration_config_set`

## Canonical config issue

Create one issue in the `config` repo. Recommended title:

- `<team-name> config`

Recommended label:

- `type:team-config`

Keep one human-readable intro above the machine-readable block, then embed one JSON document in a fenced `json` block.

Example:

````md
Team collaboration config for review-squad.
Update this issue body only from the main-agent side so the canonical config stays merge-safe.

```json
{
  "enabled": true,
  "teamName": "review-squad",
  "summaryRepo": "acme/summary",
  "configRepo": "acme/config",
  "queue": {
    "taskLabel": "queue:task",
    "handlingLabel": "task-status:handling",
    "doneLabel": "task-status:done"
  },
  "agents": {
    "main-agent": {
      "role": "main",
      "defaultRepo": "acme/repo-main-agent"
    },
    "agent-a": {
      "role": "worker",
      "defaultRepo": "acme/repo-agent-a",
      "assigneeLabel": "assignee:agent-a",
      "pollEnabled": true
    },
    "agent-b": {
      "role": "worker",
      "defaultRepo": "acme/repo-agent-b",
      "assigneeLabel": "assignee:agent-b",
      "pollEnabled": true
    }
  }
}
```
````

Rules:

- Use normalized agent ids that match `OPENCLAW_AGENT_ID` after normalization.
- Keep the config issue body single-writer when possible. `issue_update.body` is a full replacement, not a merge.
- Let workers report changes or onboarding completion through comments if you want to avoid body overwrite races.

## Binding each agent

After the config issue exists, each participating agent should bind itself locally:

```json
{
  "repo": "acme/config",
  "issueNumber": 12,
  "confirmed": true
}
```

Use that shape with `team_collaboration_config_set`.

What this does:

- stores the config-issue pointer in the local ClawMem plugin config for that agent
- makes ClawMem fetch that issue before each normal conversation
- injects a compact `<clawmem-team-context>` block into the turn

To disable this behavior later, use `team_collaboration_config_clear`.

## Repo transfer reminder

After `collaboration_repo_transfer`:

- if the transferred repo was already the worker's current `defaultRepo`, the plugin now retargets it automatically
- otherwise, call `memory_repo_set_default` explicitly if that transferred repo should become the worker's automatic home

Each worker's per-agent repo should remain that worker's normal home for:

- conversation mirroring
- ordinary memory save and recall
- private or per-agent durable facts

The `summary` repo is for shared task issues, not for replacing the worker's personal default repo.
