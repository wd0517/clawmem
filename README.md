# clawmem

`clawmem` is a GitHub-backed conversation and memory plugin for OpenClaw.

Current behavior:

- Creates one `type:conversation` issue per session.
- Stores the conversation issue body as YAML metadata plus final summary.
- Appends one issue comment per mirrored `user` or `assistant` message.
- Uses an OpenClaw subagent to generate the final conversation summary on finalize.
- Uses an OpenClaw subagent to extract durable memories on finalize and store them as memory issues.
- Exposes memory tools: `save_memory`, `search_memory`, `retrieve_memory`, `delete_memory`.
- Stores each memory as a separate `type:memory` issue with `memory-status:active` or `memory-status:stale`.
- Injects relevant active memories into context before agent start.

## Install

```bash
openclaw plugins install -l /home/wangdi/project/ai/clawmem
openclaw plugins enable clawmem
```

## Example Config

By default, `clawmem` targets `https://git.staging.clawmem.ai`.

- `baseUrl`: `https://git.staging.clawmem.ai/api/v3`
- `authScheme`: `token`

If `repo` or `token` is missing, `clawmem` will create an account session on first start and
write the resolved `token` and `repo` back into `plugins.entries.clawmem.config` in the main
OpenClaw config file. You can override either field later with your own manually managed
credentials.

```json5
{
  plugins: {
    entries: {
      clawmem: {
        enabled: true,
        config: {
          baseUrl: "https://git.staging.clawmem.ai/api/v3",
          authScheme: "token",
          issueTitlePrefix: "Session: ",
          memoryTitlePrefix: "Memory: ",
          defaultLabels: ["source:openclaw"],
          agentLabelPrefix: "agent:",
          activeStatusLabel: "status:active",
          closedStatusLabel: "status:closed",
          memoryActiveStatusLabel: "memory-status:active",
          memoryStaleStatusLabel: "memory-status:stale",
          autoCreateLabels: true,
          closeIssueOnReset: true,
          turnCommentDelayMs: 1000,
          summaryWaitTimeoutMs: 120000,
          memoryRecallLimit: 5
        }
      }
    }
  }
}
```

Example after automatic provisioning:

```json5
{
  plugins: {
    entries: {
      clawmem: {
        enabled: true,
        config: {
          baseUrl: "https://git.staging.clawmem.ai/api/v3",
          repo: "owner/repo",
          token: "<token>",
          authScheme: "token"
        }
      }
    }
  }
}
```

## Memory Tools

- `save_memory`: create a new active memory tied to the current session, with optional `topic:*` labels.
- `search_memory`: search only active memories.
- `retrieve_memory`: fetch a memory by `memoryId`.
- `delete_memory`: soft-delete by changing the memory label from active to stale.

## Notes

- Conversation issue comments ignore tool calls, tool results, system messages, and heartbeat noise because transcript normalization keeps only `user` and `assistant` content.
- Conversation summary failures do not block issue finalization; the YAML `summary` field is written as `failed: ...`.
- Conversation issue bodies store `date` as `YYYY-MM-DD`, and `start_at` / `end_at` as local `YYYY-MM-DDTHH:mm:ss`.
- Memory search and auto-injection only return `memory-status:active` issues.
- Durable memories are auto-captured on session finalize; manual memory tools remain available for explicit save/search/delete.
- Memory issue bodies store only the memory detail text itself; metadata comes from labels and the issue number.
