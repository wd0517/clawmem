# ClawMem Task Queue

Use this reference for the low-level queue contract: labels, issue-tool payload shapes, state transitions, and fallback rules.

This is not the primary collaboration walkthrough anymore:

- For scaffold setup, org/team/config bootstrapping, and config-issue binding, read [collaboration_config.md](collaboration_config.md).
- For runtime main-agent and worker-agent behavior after the scaffold already exists, read [team_collaboration.md](team_collaboration.md).

Task queue issues are ordinary issues in a shared repo such as `summary` or `team-workspace`, not structured memory nodes.

## Preconditions

Before using the queue contract:

- the shared `summary` repo already exists
- each worker that should execute tasks can read and write that repo
- each worker still keeps its own per-agent repo as its normal `defaultRepo`
- if you want automatic team-state checks before ordinary conversations, place the canonical `type:team-config` issue in the org-owned `config` repo so ClawMem can discover it at runtime
- polling is provided by the host or operator; ClawMem does not run background cron itself

## Queue labels

Use this exact label set:

- `queue:task`
- `task-status:handling`
- `task-status:done`
- `assignee:<agent-name>`

Meaning:

- `queue:task`: this issue belongs to the shared task queue
- `task-status:handling`: queued or in progress
- `task-status:done`: completed and expected to have a result comment
- `assignee:<agent-name>`: intended worker identity

Keep these labels machine-readable and stable. Do not translate them.

## Payload cookbook

### Queue one task

Use `issue_create` against the shared repo.

```json
{
  "repo": "ClawMem-Project/team-workspace",
  "title": "Review gh-server issue backlog",
  "body": "Review the current issue list in gh-server and identify issues that can be closed with a short reason for each.",
  "labels": ["queue:task", "task-status:handling", "assignee:agent-a"]
}
```

The issue body should contain:

- the exact task request
- scope and success criteria
- any project or repo targets the worker needs
- any deadlines or follow-up instructions

### Poll for one worker's tasks

Use `issue_list` against the shared repo.

```json
{
  "repo": "ClawMem-Project/team-workspace",
  "state": "open",
  "labels": ["queue:task", "task-status:handling", "assignee:agent-a"]
}
```

### Fetch one task record

Use `issue_get` before execution or before answering a status question.

```json
{
  "repo": "ClawMem-Project/team-workspace",
  "issueNumber": 42
}
```

### Write the task result

Use `issue_comment_add` for the actual worker output. Keep the issue body stable.

```json
{
  "repo": "ClawMem-Project/team-workspace",
  "issueNumber": 42,
  "body": "Done. The issues that look safe to close are: ..."
}
```

### Mark the task done

Use `issue_update` and replace the full label set.

```json
{
  "repo": "ClawMem-Project/team-workspace",
  "issueNumber": 42,
  "labels": ["queue:task", "task-status:done", "assignee:agent-a"]
}
```

`issue_update.labels` is a full replacement set. Preserve the labels you still want.

### Read the latest result comment

Use `issue_comments_list` when the task issue is already labeled `task-status:done`.

```json
{
  "repo": "ClawMem-Project/team-workspace",
  "issueNumber": 42,
  "sort": "updated",
  "direction": "desc",
  "limit": 1
}
```

## State model

Keep queue labels and native issue state separate:

- open issue + `task-status:handling` = active queued or running task
- open issue + `task-status:done` = completed task still visible in queue history
- closed issue = archived task record that should no longer be polled

Do not overload native close state to mean both "done" and "archived".

## Fallback mode

If the issue tools are unavailable, use raw `gh` or `curl` against the same repo and keep the same label scheme.

Use [manual-ops.md](manual-ops.md) for route resolution and raw-auth guidance.
