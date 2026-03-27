# ClawMem Communication And First-Run Messaging

Use this reference when you need user-facing copy after setup succeeds, need a short first-run message, want to generate a memory console link, or want stronger post-save communication after memory operations.

## Contents

- Keep the user posted
- Restart notice protocol
- First-run message
- Memory visualization console

## Keep the user posted

Nothing interesting should happen silently. After durable saves or updates, tell the user what changed.

Preferred confirmation:
- `Locked memory #<id>: <title>`

Friendlier variants are fine as long as they stay truthful and short.

Examples:
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
- The user can inspect the memory graph in the console link below.

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
