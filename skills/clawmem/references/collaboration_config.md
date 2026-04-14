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
10. Verify that each participating agent can read the org's `config` repo and the canonical config issue.

The discovery step is what enables automatic team-state checking before each normal conversation. No `openclaw.json` team pointer is required on the normal path.

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
- inspect the created config issue: `issue_get`

## Canonical config issue

Runtime discovery rule:

- for each visible org, ClawMem first checks `<org>/config`
- if that repo does not exist or is not visible, it then checks `<org>/clawmem-config`
- inside the discovered config repo, ClawMem scans open issues labeled `type:team-config`
- any config issue whose `agents` map contains the current normalized agent id becomes a discovered team binding

So the config issue is still the canonical team truth, but the pointer lives in the org config repo instead of `openclaw.json`.

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
  "teamId": "review-squad",
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

- Include a stable machine-readable `teamId`. This is how ClawMem disambiguates teams when one agent belongs to more than one team.
- Use normalized agent ids that match `OPENCLAW_AGENT_ID` after normalization.
- Keep the config issue body single-writer when possible. `issue_update.body` is a full replacement, not a merge.
- Let workers report changes or onboarding completion through comments if you want to avoid body overwrite races.

## Discovery behavior

After the config issue exists, no local team-binding step is required.

What ClawMem does at runtime:

- lists visible orgs for the current agent identity
- looks for the org-owned `config` repo, then `clawmem-config` as a fallback
- scans open `type:team-config` issues in that repo
- keeps only the issues whose `agents` map contains the current agent id

Injection behavior:

- if one team matches, ClawMem injects one focused `<clawmem-team-context>` block
- if multiple teams match, ClawMem injects a `<clawmem-team-index>` block and adds a focused team context only when the current request uniquely identifies one team

Legacy note:

- `team_collaboration_config_set` and `team_collaboration_config_clear` still exist as compatibility overrides, but normal setup should not require them

## Repo transfer reminder

After `collaboration_repo_transfer`:

- if the transferred repo was already the worker's current `defaultRepo`, the plugin now retargets it automatically
- otherwise, call `memory_repo_set_default` explicitly if that transferred repo should become the worker's automatic home

Each worker's per-agent repo should remain that worker's normal home for:

- conversation mirroring
- ordinary memory save and recall
- private or per-agent durable facts

The `summary` repo is for shared task issues, not for replacing the worker's personal default repo.
