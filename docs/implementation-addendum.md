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

Plugin-managed memory issues store the human-readable memory detail in a YAML `detail` field.

For new memories, the human-readable memory title and body should default to the user's current language. When updating an existing memory, preserve that memory node's current language unless the user explicitly requests a rewrite.

Metadata such as type and schema are carried by labels and issue metadata. Plugin-managed compatibility metadata such as logical date or hash may also be stored as additional flat YAML fields in the issue body.

Example:

```text
memory_hash: abc123
date: 2026-03-10
detail: User prefers storing conversation issue bodies as full YAML instead of markdown plus front matter.
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

## 4. Memory Lifecycle

The current implementation does not inject any memory tools into the agent tool list.

Memory creation, recall, and staling remain internal plugin behaviors.

### 4.1 Creation

New durable memories are created during the finalize pipeline.

Default behavior:

- create a `type:memory` issue
- write the human-readable memory title and body in the user's current language by default
- apply `session:<session_id>`
- apply `date:YYYY-MM-DD`
- optionally apply one or more `topic:*` labels
- apply `memory-status:active`

### 4.2 Recall

Relevant active memories may still be injected into prompt context before agent start.

Default filter:

- `type:memory`
- `memory-status:active`

### 4.3 Staling

Memories are not hard-deleted.

When the finalize-time memory decision determines an existing memory is outdated, the plugin changes its state from:

- `memory-status:active`

to:

- `memory-status:stale`

This keeps memory removal as a logical state transition rather than a hard delete.

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
