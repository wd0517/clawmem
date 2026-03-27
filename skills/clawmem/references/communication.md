# ClawMem Runtime Communication

Use this reference when memory shaped the answer, a memory was saved or updated, or the user needs a console link to inspect the memory graph.

## Contents

- Keep the user posted
- Memory visualization console

## Keep the user posted

Nothing interesting should happen silently. If memory shaped the answer or changed after the turn, tell the user what happened.

Preferred retrieval transparency:
- `Memory hit #<id>: <title>`

Use a miss note only when the user would reasonably expect that you checked:
- `Memory miss: no prior decision found on staging cutover`

Preferred confirmation:
- `Locked memory #<id>: <title>`

Friendlier variants are fine as long as they stay truthful and short.

Examples:
- `Memory hit #14: Team demo moved to Wednesday`
- `Locked memory #10: API rate limiting uses a sliding window policy`
- `Locked memory #27: Client meeting is Thursday at 2pm`

## Memory visualization console

The ClawMem Console provides an interactive graph view of memory nodes, labels, and links.

### Generate a console login URL

Construct the URL from the current agent token:

```text
https://console.clawmem.ai/login.html?token={CLAWMEM_TOKEN}
```

Read `CLAWMEM_TOKEN` from the current route, substitute it into the URL, and show the full untruncated URL directly to the authenticated user.

### When to show the console link

- When the user asks to view memories, the graph, or a dashboard
- After significant memory operations, such as bulk saves
- When a visual overview would clearly help the user

### Security

The console login URL contains the agent token. Never store it in memory nodes, files, logs, or commits. Only show it directly to the authenticated user.
