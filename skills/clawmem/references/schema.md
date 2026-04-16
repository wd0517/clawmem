# ClawMem Memory Schema

Use this reference when deciding how to label or shape a memory, or when you need to explain the ClawMem graph model to another agent or user.

## The memory graph

Issues are nodes. Labels are schema. `#ID` references are edges.

When one memory depends on, refines, supersedes, or generalizes another memory, mention the related `#ID` in the issue body so the relationship stays explicit in the graph.

There are two valid memory shapes:
- Plugin-managed structured memories: created through `memory_store` or `memory_update`; the plugin manages core labels and may also persist agent-selected `kind:*` and `topic:*` labels
- Curated graph memories: created manually through `gh` or `curl` when you explicitly need raw issue control

## Labels

Plugin-managed memories always include:
- `type:memory`

Plugin-managed memories may also include:
- one `kind:*` label
- optional `topic:*` labels

Lifecycle is carried by native issue state:
- open issue = active memory
- closed issue = stale or superseded memory

If you create a curated memory manually, include:
- `type:memory`
- one `kind:*` label
- optional `topic:*` labels, usually no more than two or three

## Kinds

| Kind | Label | Use it for |
|---|---|---|
| Core fact | `kind:core-fact` | Stable truths that should update in place as reality changes |
| Convention | `kind:convention` | Agreed rules or policies |
| Lesson learned | `kind:lesson` | Corrections, postmortems, or mistakes worth preserving |
| Skill blueprint | `kind:skill` | Repeatable workflows or playbooks |
| Active task | `kind:task` | Ongoing work that should stay visible and update over time |

## When to create which kind

| Trigger | Kind |
|---|---|
| User corrects a wrong assumption | `kind:lesson` |
| You and the user agree on a rule | `kind:convention` |
| A stable fact about the user or project | `kind:core-fact` |
| A repeatable workflow you figured out | `kind:skill` |
| Ongoing work to track | `kind:task` |

## Disciplined self-evolution

- Before inventing a new `kind` or `topic`, call `memory_labels`.
- Reuse current schema when it already fits.
- If the current schema does not fit and a new label would help future retrieval, coordination, or reuse, create one deliberate new machine-readable label.
- Do not create translated variants or near-duplicate synonyms of an existing label. Prefer reuse first, then one canonical new label if needed.
- New labels should be short, general, and likely to apply again across future memories or agents.
- For plugin-managed memory schema, do not invent random label prefixes. Memory schema evolution must stay within `kind:*` and `topic:*`.
## Storage language

- For new memory nodes, write the human-readable title and body in the user's current language by default.
- When using plugin tools, prefer passing an explicit short `title` plus a fuller `detail` body.
- Do not treat the title as the only durable content. The body detail should still contain the full reusable fact.
- When updating an existing memory node, preserve that node's current language unless the user explicitly asks for a rewrite.
- Do not translate schema or routing markers such as `type:*`, `kind:*`, `topic:*`, or other machine-oriented field names.

## Storage rule

If you are writing something so the agent remembers it later, store it in ClawMem. If you are writing something for a tool or human to read directly, write a file instead.
