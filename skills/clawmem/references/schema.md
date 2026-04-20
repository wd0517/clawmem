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

## Update vs new: the node-evolution rule

Durable knowledge evolves by updating canonical nodes, not by spawning near-duplicates.

- Before `memory_store`, `memory_recall` the same topic. If an open memory already covers the same fact, decision, workflow, or policy, use `memory_update` instead. Only open a new node when the new fact is semantically orthogonal to every existing canonical node.
- When updating, preserve the node's original language unless the user explicitly asks for a rewrite. Refine the `detail` in place, tighten `title`, and add topic labels as coverage expands.
- When a memory is contradicted by the current turn, choose one of:
  - `memory_update` to record the new canonical truth on the existing node,
  - `memory_forget` (close the issue) if the fact is simply no longer true and has no replacement,
  - or open a new node and close the old one with a body note `superseded-by: #<new-id>` when the semantics are now different enough that one node cannot carry both.
- Lesson → Skill promotion: when two or more active `kind:lesson` nodes point at the same corrective direction on the same topic, write one `kind:skill` that captures the positive behavior and close the lessons with `superseded-by: #<new-skill-id>`. Keep a single lesson open only if it captures a specific failure worth remembering on its own.
- Re-validation: when `memory_recall` surfaces a `kind:skill` or `kind:convention` and the current turn re-confirms or re-applies it, `memory_update` to bump the `last_validated` date in the body (see template below) and append the turn's conversation id to `evidence`. Silent success erodes confidence in old nodes.

## Skill body template (`kind:skill`)

`kind:skill` memories are playbooks and are meant to be re-used and re-updated many times. Give them a stable YAML-on-top body so they remain readable and mergeable:

```yaml
trigger: When this skill applies — the user request shape or situation that should cue it.
steps:
  - First action, concrete enough to follow without re-deriving.
  - Next action.
  - Final action.
checks:
  - Signals that the skill succeeded.
  - Signals that the skill is the wrong fit and you should stop.
last_validated: 2026-04-20
evidence:
  - "#42"   # conversation issue or memory id that supports this skill
  - "#77"
```

Narrative prose, caveats, and references can follow the YAML block in the same body. The YAML block itself stays flat (no nested maps beyond lists), which matches ClawMem's body parser.

When a `kind:skill` is re-used successfully, `memory_update` to:
- bump `last_validated` to today's date,
- append the latest supporting id to `evidence`,
- refine `steps` or `checks` only if the turn produced a clearly better formulation.

When a `kind:skill` fails in use, either fix `steps` / `checks` in place or close the node and open a replacement that references the old id with `superseded-by`.

## Storage language

- For new memory nodes, write the human-readable title and body in the user's current language by default.
- When using plugin tools, prefer passing an explicit short `title` plus a fuller `detail` body.
- Do not treat the title as the only durable content. The body detail should still contain the full reusable fact.
- When updating an existing memory node, preserve that node's current language unless the user explicitly asks for a rewrite.
- Do not translate schema or routing markers such as `type:*`, `kind:*`, `topic:*`, or other machine-oriented field names.

## Storage rule

If you are writing something so the agent remembers it later, store it in ClawMem. If you are writing something for a tool or human to read directly, write a file instead.
