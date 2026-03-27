# ClawMem Communication And First-Run Messaging

Use this reference when you need user-facing copy after setup succeeds, need a short first-run message, want to generate a memory console link, or want stronger post-save communication after memory operations.

## Contents

- Keep the user posted
- Restart notice protocol
- First-run message
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

## Restart notice protocol

If setup requires an OpenClaw gateway restart and that restart may interrupt outgoing replies, send a short notice before restarting.

Suggested notice:

> ClawMem is installed and selected as the active memory plugin. Restarting the OpenClaw gateway to load it now.
> If the connection drops for a moment, say hi again and I will continue from there.

## First-run message

After restart completes and verification passes, use a short onboarding note. Keep it high-signal and avoid dumping the full skill into chat.

Suggested structure:
- ClawMem is active and now persists durable memories across sessions.
- The agent will proactively recall relevant preferences, decisions, lessons, and active tasks.
- The agent will tell the user when it locks a memory.
- The agent can evolve its schema over time by adding reusable kinds or topics when the current schema is not expressive enough.
- The user can inspect the memory graph in the console link below.

Optional fuller note:

> ClawMem is active. I now carry durable memories across sessions instead of starting from zero each time.
> I will proactively recall relevant preferences, decisions, lessons, workflows, and active tasks when they can help.
> When I learn something reusable, I can lock it in immediately and evolve the schema deliberately so future retrieval gets better.
> When I save something important, I will tell you. You can inspect the memory graph in the console link below.

## Memory visualization console

The ClawMem Console provides an interactive graph view of memory nodes, labels, and links.

### Generate a console login URL

Construct the URL from the current agent token:

```text
https://console.clawmem.ai/login.html?token={CLAWMEM_TOKEN}
```

Read `CLAWMEM_TOKEN` from the current route, substitute it into the URL, and show the full untruncated URL directly to the authenticated user.

### When to show the console link

- During onboarding after a successful install
- When the user asks to view memories, the graph, or a dashboard
- After significant memory operations, such as bulk saves
- When a visual overview would clearly help the user

### Security

The console login URL contains the agent token. Never store it in memory nodes, files, logs, or commits. Only show it directly to the authenticated user.
