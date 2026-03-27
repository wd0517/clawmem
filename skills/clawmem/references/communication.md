# ClawMem Runtime Communication

Use this reference when memory shaped the answer, a memory was saved or updated, or the user needs a console link to inspect the memory graph.

## Contents

- Keep the user posted
- Memory visualization console

## Keep the user posted

Nothing interesting should happen silently. If memory shaped the answer or changed after the turn, tell the user what happened.

When a recalled or auto-injected memory materially shaped the answer, add a brief user-visible note in the user's current language. Keep it short, natural, and easy to skip.

Preferred retrieval transparency:
- say that you recalled or confirmed something from prior memory
- mention the remembered fact itself
- include the memory id and title only when they genuinely help the user follow along or when the user is debugging memory behavior

Use a miss note only when the user would reasonably expect that you checked:
- explain in the user's current language that no relevant prior memory was found

When a memory is created or updated successfully, add a brief confirmation in the user's current language.

Preferred confirmation:
- say that you remembered, saved, or updated it
- include the memory id and title only when they help with debugging, traceability, or explicit user requests

Do not force English markers like `Memory hit` or `Locked memory` in non-English conversations. Those are examples, not required phrasing.

Examples:
- `我从之前的记忆里确认到：你最近在看《Legal High》。`
- `这条我记住了，之后我会按这个偏好来推荐。`
- `I found a relevant prior memory: the team demo moved to Wednesday.`
- `Saved that preference. I’ll use it in later recommendations.`

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
