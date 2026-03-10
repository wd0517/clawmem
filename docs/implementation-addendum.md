# Implementation Addendum for `proposal.md`

## 1. Purpose

This document records implementation decisions that were intentionally left open in [proposal.md](/home/wangdi/project/ai/clawmem/docs/proposal.md).

It should be treated as the current implementation contract for the first rewrite of the plugin.

---

## 2. Conversation Issue

### 2.1 Body Format

The entire conversation issue body must be YAML.

Recommended fields for the first implementation:

- `type`
- `session_id`
- `date`
- `start_at`
- `end_at`
- `status`
- `summary`

Example:

```yaml
type: conversation
session_id: abc123
date: 2026-03-10
start_at: 2026-03-10T09:30:12
end_at: 2026-03-10T09:42:48
status: closed
summary: User asked to redesign the plugin storage model and align issue updates with the proposal.
```

### 2.2 Summary Failure Behavior

Conversation summary generation is allowed to fail without blocking later tasks.

If summary generation fails:

- the conversation issue body should still be updated
- later memory-related processing should still continue
- the `summary` field should store the failure reason directly

Example:

```yaml
summary: "failed: upstream summarizer timeout"
```

### 2.3 Comments

Conversation comments store only transcript messages from:

- `user`
- `assistant`

Storage rule:

- one message maps to one issue comment

Each comment should make the source role explicit.

Recommended comment format:

```text
role: user

<message content>
```

or

```text
role: assistant

<message content>
```

The first implementation does not define chunking behavior for oversized comments.

### 2.4 Date Handling

Conversation time fields use a mixed format:

Rules:

- use machine local timezone
- `date` is formatted as `YYYY-MM-DD`
- `start_at` and `end_at` are formatted as `YYYY-MM-DDTHH:mm:ss`
- `date` is the conversation date used for labeling and body metadata
- `start_at` and `end_at` are precise to seconds

---

## 3. Memory Issue

### 3.1 Body Format

The first implementation keeps the memory issue body minimal and stores only the memory detail text itself.

Metadata such as type, session, date, and status are carried by labels and issue metadata, not repeated in the body.

Example:

```text
User prefers storing conversation issue bodies as full YAML instead of markdown plus front matter.
```

### 3.2 Labels

Each memory issue should include:

- `type:memory`
- `session:<session_id>`
- `date:YYYY-MM-DD`
- optional `topic:<topic>`
- `memory-status:active` or `memory-status:stale`

Memory search must return only issues labeled:

- `type:memory`
- `memory-status:active`

### 3.3 Memory Status Model

The first implementation uses a soft-delete model for memory.

Allowed memory status labels:

- `memory-status:active`
- `memory-status:stale`

Semantics:

- `active`: usable memory that can be returned by search
- `stale`: memory kept for audit/history but excluded from normal search results

---

## 4. Tool Semantics

### 4.1 `save_memory`

`save_memory` creates a new memory issue.

Default behavior:

- create a `type:memory` issue
- apply `session:<session_id>`
- apply `date:YYYY-MM-DD`
- optionally apply one or more `topic:*` labels
- apply `memory-status:active`

In addition to the explicit tool, the plugin may auto-capture memory on conversation finalization by running an AI extraction step over the finalized transcript.

### 4.2 `search_memory`

`search_memory` returns only active memory.

Default filter:

- `type:memory`
- `memory-status:active`

### 4.3 `retrieve_memory`

`retrieve_memory` retrieves a specific memory by `memory_id`.

For memory issues created by the current implementation, `memory_id` is the issue number rendered as a string.

Unlike search, exact retrieval is allowed to return either:

- `memory-status:active`
- `memory-status:stale`

### 4.4 `delete_memory`

The plugin must expose a `delete_memory` tool.

`delete_memory` does not physically delete an issue.

Instead it changes memory state from:

- `memory-status:active`

to:

- `memory-status:stale`

This makes deletion a logical state transition rather than a hard delete.

The decision to add or delete memory is left to AI policy.

In the current implementation, finalized conversations are passed through an AI extraction step that may:

- create new memory issues
- mark existing active memory issues as stale

---

## 5. Relationship to the Proposal

This addendum keeps the proposal's core model unchanged:

- conversation and memory remain separate issue types
- GitHub Issues remain an internal storage adapter
- conversation comments remain append-only transcript storage
- memory remains an extracted reusable unit

This document only fixes first-implementation details that were previously unspecified.
