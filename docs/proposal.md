
# Proposal: Using GitHub Issues and Labels to Manage OpenClaw Conversations and Memory

## 1. Goal

This proposal describes how to use **GitHub Issues** and **Issue Labels** as the storage backend for OpenClaw:

- conversation transcripts
- reusable memory

The design goal is to provide a simple, persistent, and searchable backend while **hiding GitHub-specific storage details from OpenClaw**.

This document focuses on the **data model and design boundaries**. It does not yet define detailed OpenClaw interaction flows or plugin API behavior.

---

## 2. Design Principles

### 2.1 Hide storage details from OpenClaw

Although the backend uses GitHub Issues and Labels, OpenClaw should only see semantic capabilities such as:

- `save_memory`
- `search_memory`
- `retrieve_memory`

OpenClaw should **not** be exposed to:

- issues
- comments
- labels
- GitHub API details

In other words:

> OpenClaw should program against conversation/memory capabilities, not against GitHub Issues.

---

### 2.2 Separate conversation from memory

The design distinguishes two different data types:

- **conversation**: the original session transcript
- **memory**: reusable information extracted from a conversation

They serve different purposes and should not be mixed.

---

### 2.3 Use Labels for indexing, Body/Comments for content

Responsibilities are divided as follows:

- **Issue Labels**: classification, filtering, and fast association
- **Issue Body**: summary and structured core information
- **Issue Comments**: append-only transcript timeline for conversations

---

## 3. Data Model

This proposal defines only two issue types in the initial version:

- `type:conversation`
- `type:memory`

No additional top-level types are introduced at this stage.

---

## 4. Conversation Issue Design

### 4.1 Purpose

A `type:conversation` issue represents one OpenClaw session.

Its responsibilities are:

- store the full transcript of the session
- store basic metadata for the session
- store a brief final summary
- act as the source container for extracted memory

---

### 4.2 Labels

Recommended labels:

- `type:conversation`
- `session:<session_id>`

Optional extensions:
- `agent:<agent_id>`

These labels serve the following roles:

- `type:conversation`: identify the issue type
- `session:<session_id>`: directly associate related memory with the conversation
- `agent:<agent_id>`: identify the OpenClaw route or persona that owned the session

---

### 4.3 Body

The conversation issue body stores:

- structured metadata
- the final brief summary

Recommended minimum fields:

- `type`
- `session_id`
- `date`
- `started_at`
- `ended_at`
- `summary`

The summary should be stored in the **issue body**, not appended later as a separate summary comment.

This makes the conversation issue body the “cover page” for the session.

---

### 4.4 Comments

Conversation issue comments are used only for the append-only transcript timeline, only the user and assistant messages should be stored,
other messages like tool_calls, tool_results, heartbeat, system messages, etc. should be ignored.

These comments should be treated as:

- append-only
- not rewritten
- not modified after being written

This keeps the conversation timeline as the original audit record.

---

## 5. Memory Issue Design

### 5.1 Purpose

A `type:memory` issue represents one reusable memory extracted from a conversation.

Its responsibilities are:

- store long-term reusable information
- serve as a basic unit for future retrieval
- associate back to the source conversation through shared session labeling

---

### 5.2 Labels

Recommended labels:

- `type:memory`
- `session:<session_id>`
- `kind:*`
- `topic:*`

These labels serve the following roles:

- `type:memory`: identify the issue type
- `session:<session_id>`: identify the source session
- `kind:*`: classify the type of memory
- `topic:*`: represent AI-extracted keywords

`topic:*` should usually be limited to **2–3 labels** to avoid excessive label noise.

---

### 5.3 Body

The memory issue body should remain minimal and contain only a short `summary`.

That means:

- labels handle indexing, classification, and source association
- the body contains the actual memory content

This keeps each memory issue lightweight and easy to manage.

---

## 6. Association Between Conversation and Memory

The proposal uses a shared `session:<session_id>` label to directly associate a conversation issue with related memory issues.

Example:

- one conversation issue has `session:abc123`
- memory issues extracted from that conversation also have `session:abc123`

This allows simple and direct traversal in both directions:

- from a conversation to its extracted memories
- from a memory back to its source conversation

At the same time, `session_id` should also be stored in the issue body, so the design does not rely only on a high-cardinality label.

Therefore, `session_id` exists in both places:

- **label**: for fast association and retrieval
- **body**: for formal structured storage

---

## 7. Abstraction Boundary

### 7.1 External abstraction

To OpenClaw and plugin callers, the system should expose only conversation/memory capabilities, such as:

- saving a memory
- searching memory
- retrieving memory

These are logical capabilities and should not expose the GitHub Issue model directly.

---

### 7.2 Internal mapping

Inside the plugin, these capabilities are mapped onto GitHub Issues:

- conversation -> `type:conversation` issue
- memory -> `type:memory` issue
- transcript timeline -> comments
- metadata and summary -> body
- index fields -> labels

GitHub Issues are therefore treated only as a **storage backend adapter**.

---

## 8. Why This Design

### 8.1 Simple

GitHub Issues already provide:

- persistence
- timeline comments
- labels
- searchability
- human readability

This makes them a practical backend for an initial memory system.

---

### 8.2 Auditable

Because conversation comments are append-only, they are naturally suitable for:

- audit
- replay
- human inspection

---

### 8.3 Easy association

Using `session:<session_id>` provides a low-cost way to connect conversation and memory.

---

### 8.4 Replaceable

Since OpenClaw does not directly depend on GitHub Issues, the backend can later be replaced with:

- Gitea Issues
- SQLite
- PostgreSQL
- vector database
- other storage systems

without changing the upper-layer abstraction.

---

## 9. Scope and Non-Goals

This proposal currently defines only:

- the two issue types: conversation and memory
- the responsibilities of issue body, comments, and labels
- the basic association method between conversation and memory
- the abstraction boundary that hides GitHub details from OpenClaw

This proposal does **not** yet define:

- detailed OpenClaw plugin interaction protocol
- memory retrieval ranking
- memory extraction triggers
- memory update, deduplication, or merge strategy
- issue title conventions
- GitHub API calling details
- permissions, rate limiting, or recovery mechanisms

These should be defined later in an implementation design.

---

## 10. Summary

This proposal recommends using GitHub Issues as the storage backend for OpenClaw conversations and memory with the following minimal model:

### `type:conversation`
- **body**: metadata + summary
- **comments**: append-only transcript timeline
- **labels**: `type:conversation`, `session:<id>`

### `type:memory`
- **body**: summary only
- **labels**: `type:memory`, `session:<id>`, `kind:*`, `topic:*`

At the same time, the plugin should expose only semantic conversation/memory capabilities to OpenClaw, rather than exposing GitHub Issue details directly.

The key idea is not to make OpenClaw operate on issues, but to:

> use GitHub Issues to implement a conversation/memory backend, while keeping that storage model encapsulated inside the plugin.
