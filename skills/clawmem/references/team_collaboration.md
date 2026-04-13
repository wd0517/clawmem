# ClawMem Team Collaboration

Use this reference when the scaffold already exists and the current agent needs to operate inside that scaffold.

This workflow assumes the current agent already has a local binding to a canonical team config issue through `team_collaboration_config_set`.

## Automatic team-state check

When the current agent config contains:

- `teamConfigRepo`
- `teamConfigIssueNumber`

ClawMem now does one extra step before each normal conversation:

1. fetch the configured issue from the config repo
2. parse the JSON document in that issue body
3. inject a compact `<clawmem-team-context>` block into the turn

That injected block is live runtime state, not historical memory.

Important compatibility rule:

- ordinary ClawMem memory recall still uses the current agent's `defaultRepo`
- ordinary conversation mirroring still writes to the current agent's `defaultRepo`
- the team context only helps the agent decide when to use the shared `summary` repo or another explicit repo for collaboration work

So this is additive. It does not replace the normal ClawMem flow.

## Role split

Main agent:

- talks to the human
- translates delegation requests into issues in the `summary` repo
- tracks task status from the `summary` repo
- if a task is done, reads the latest result comment and returns that result to the human

Worker agent:

- does ordinary ClawMem work in its own per-agent `defaultRepo`
- polls the `summary` repo for issues addressed to its own `assignee:<agent-name>` label
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
- `assignee:<agent-name>`

State meaning:

- open issue + `task-status:handling`: queued or in progress
- open issue + `task-status:done`: finished, result should already exist as a comment
- closed issue: archived record, no longer polled

## Main-agent workflow

When the human asks the main agent to delegate work:

1. read the injected team context
2. confirm the `summary` repo and the target worker
3. create an issue in the `summary` repo with:
   - a precise title
   - the full task body
   - labels `queue:task`, `task-status:handling`, `assignee:<worker>`
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

1. read the injected team context or the canonical config issue directly
2. resolve the `summary` repo and the worker's own `assignee:<agent-name>` label
3. call `issue_list` for open issues matching:
   - `queue:task`
   - `task-status:handling`
   - that worker's `assignee:<agent-name>`
4. if nothing matches, exit
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

## Related references

- Scaffold building and config issue creation: [collaboration_config.md](collaboration_config.md)
- Shared repo/org/team mechanics: [collaboration.md](collaboration.md)
- Queue labels and issue/comment flow: [task-queue.md](task-queue.md)
