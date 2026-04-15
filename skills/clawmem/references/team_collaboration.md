# ClawMem Team Collaboration

Use this reference when the scaffold already exists and the current agent needs to operate inside that scaffold.

This workflow assumes the current agent can discover one or more canonical team config issues by scanning visible org-owned `config` or `clawmem-config` repos for open `type:team-config` issues.

## Automatic team-state check

Before each normal conversation, ClawMem now does one extra step:

1. list visible orgs for the current agent identity
2. look for `<org>/config` first and then `<org>/clawmem-config`
3. scan open `type:team-config` issues in that repo
4. keep only the issues whose `agents` map contains the current backend login
5. fall back to legacy agent-id matching when needed
6. inject discovered team state into the turn

Injected state is live runtime state, not historical memory.

If one team matches:

- inject one focused `<clawmem-team-context>` block

If multiple teams match:

- inject a `<clawmem-team-index>` block listing the discovered teams
- inject one focused `<clawmem-team-context>` only when the current request uniquely identifies a team by `teamId`, `teamName`, `summaryRepo`, or another unambiguous hint

Important compatibility rule:

- ordinary ClawMem memory recall still uses the current agent's `defaultRepo`
- ordinary conversation mirroring still writes to the current agent's `defaultRepo`
- the discovered team state only helps the agent decide when to use a shared `summary` repo or another explicit repo for collaboration work

So this is additive. It does not replace the normal ClawMem flow.

## Role split

Main agent:

- talks to the human
- translates delegation requests into issues in the `summary` repo
- tracks task status from the `summary` repo
- if a task is done, reads the latest result comment and returns that result to the human

Worker agent:

- does ordinary ClawMem work in its own per-agent `defaultRepo`
- polls the `summary` repo for issues addressed to its own `assignee:<login>` label
- reads the task issue body
- performs the task
- posts the result as an issue comment
- switches the task status label from `task-status:handling` to `task-status:done`

Human:

- usually talks only to the main agent
- does not need to browse each worker's conversation repo just to know task status

## Shared queue contract

Use the `summary` repo for queue issues.

Required labels:

- `queue:task`
- `task-status:handling`
- `task-status:done`
- `assignee:<login>`

State meaning:

- open issue + `task-status:handling`: queued or in progress
- open issue + `task-status:done`: finished, result should already exist as a comment
- closed issue: archived record, no longer polled

## Main-agent workflow

When the human asks the main agent to delegate work:

1. read the injected team context
   - if only a `<clawmem-team-index>` is present, select the target team first
2. confirm the `summary` repo and the target worker
3. create an issue in the `summary` repo with:
   - a precise title
   - the full task body
   - labels `queue:task`, `task-status:handling`, `assignee:<worker-login>`
4. tell the human the task has been queued

When the human later asks whether it is finished:

1. `issue_get` the task issue from the `summary` repo
2. inspect the labels
3. if the issue still has `task-status:handling`, say it is still running
4. if the issue has `task-status:done`, call `issue_comments_list` with:
   - `sort=updated`
   - `direction=desc`
   - `limit=1`
5. return that latest result comment to the human

Do not rewrite the worker result into the issue body just to relay it. Keep the issue body stable and the result in comments.

## Worker workflow

Worker polling is outside the plugin. The host or operator provides cron or another scheduler.

Each polling cycle should:

1. discover all team configs that list this worker
2. keep the bindings where `role=worker`
3. for each discovered worker team:
   - resolve that team's `summary` repo
   - resolve that worker's own `assignee:<login>` label
   - call `issue_list` for open issues matching `queue:task`, `task-status:handling`, and that assignee label
4. if nothing matches in a given team, continue to the next team
5. for each matching issue:
   - `issue_get`
   - do the work
   - `issue_comment_add` with the result
   - `issue_update` and replace the labels so the issue becomes `task-status:done`

## Config issue discipline

Use the config repo for relatively static team configuration such as:

- team name
- `summary` repo name
- `config` repo name
- which agents belong to the team
- each agent's role
- each agent's declared per-agent repo
- whether worker polling is enabled

Do not use the config issue as the runtime task ledger. Runtime tasks belong in the `summary` repo.

## What to do on mismatch

If the injected team context says:

- this agent is not listed in the config
- the `summary` repo is missing
- the local `defaultRepo` does not match the team-declared default repo

then do not silently guess. Prefer ordinary ClawMem behavior plus a short note that the team config needs repair.

If only a team index is injected and the request could belong to more than one team, do not guess a `summary` repo. Ask a short clarification question or wait for the operator to select the team explicitly.

## Related references

- Scaffold building and config issue creation: [collaboration_config.md](collaboration_config.md)
- Shared repo/org/team mechanics: [collaboration.md](collaboration.md)
- Queue labels and issue/comment flow: [task-queue.md](task-queue.md)
