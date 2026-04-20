# ClawMem Review Protocol

This reference describes the periodic self-review loop that keeps ClawMem memory from drifting. The normal turn loop in [SKILL.md](../SKILL.md) is reactive; review is deliberate. Run it so that lessons, conventions, and skills actually accumulate instead of being silently dropped at session boundaries.

## When to run a review

Run a review when any of the following is true:

- You have completed roughly 8–10 user turns since the last review, or since the start of the session.
- You just finished a multi-step task, a non-trivial tool chain, or a workflow the user validated.
- The user signaled satisfaction ("yes exactly", "perfect", "这就是我要的") or issued a correction ("no", "don't", "下次不要这样").
- The plugin injected a review nudge via `<clawmem-review-nudge>` in the prompt context.
- You are about to return control to the user at the end of a session, or a `before_reset` / `session_end` is imminent.
- The agent has the `memory_review` tool available and the user explicitly asks for a memory or skill review.

Running once more than needed is fine. Skipping it for a session is not.

## Running the review

A review has two independent tracks. Run both.

### Track A — Memory review

Ask yourself, about the conversation since the last review:

1. **User signals** — Did the user reveal identity, role, preferences, habits, goals, or constraints I have not yet stored?
2. **Expectations** — Did the user express how they want me to behave, communicate, format output, choose tools, or avoid specific pitfalls?
3. **Corrections** — Did the user push back on an answer or an approach? What should I never repeat? What should I do instead next time?
4. **Validations** — Did the user confirm that a non-obvious choice was the right one? That is also worth saving, because corrections alone make you timid.
5. **Stale beliefs** — Did this turn invalidate a memory I recalled or would have recalled? Candidates for `memory_forget` or `memory_update`.
6. **Cross-repo hints** — Did anything belong in a project repo or a shared team repo rather than `defaultRepo`?

For each positive answer, pick one of:
- `memory_update` on an existing canonical node if one already covers the topic.
- `memory_store` with a deliberate `kind` (and topics) if it is a genuinely new fact.
- `memory_forget` to retire the stale one.

Prefer one atomic fact per write. Do not bundle.

### Track B — Skill review

Ask yourself:

1. Was a non-trivial approach used to finish a task — one that required trial and error, changing course, or recovering from errors?
2. Did a specific sequence of tool calls or decisions lead to a good result that would have been hard to derive from scratch?
3. Did the user describe a procedure I should follow in the future?
4. Is there an existing `kind:skill` memory that this turn either confirmed, refined, or contradicted?

If yes on 1–3 and no matching `kind:skill` exists, write a new one using the canonical YAML shape in [schema.md § Skill body template](schema.md#skill-body-template-kindskill).

If yes on 4, `memory_update` the existing skill:
- Bump `last_validated` to today's date.
- Append the new supporting conversation or memory id to `evidence`.
- Refine `steps` / `checks` if the turn produced a better formulation.
- If the turn contradicted the skill, either fix it in place or close the memory and create a replacement that references the old id with `superseded-by`.

### Lesson → Skill promotion

If you find two or more active `kind:lesson` memories pointing at the same corrective direction on the same topic, promote them:

1. Write one `kind:skill` that captures the positive behavior (what to do), not just the prohibitions.
2. Close the source lessons with a body note like `superseded-by: #<new-skill-id>`.
3. Leave one lesson open if it captures a specific failure worth remembering on its own.

## After the review

- Give a short confirmation to the user in their current language, naming what was saved, updated, or retired. Example: "已沉淀 1 条 skill、更新 1 条 convention、归档 1 条过期 lesson。"
- If nothing was worth writing, say so briefly rather than saying nothing — the user needs to know the review ran.
- Reset your internal "turns since last review" counter.

## Review anti-patterns

- Saving a play-by-play of the session. That belongs in the `type:conversation` issue, not in durable memory.
- Saving every tool invocation as a skill. Skills are for non-trivial, reusable procedures.
- Creating a new `kind:lesson` every time the user nudges phrasing. Trivial style tweaks usually belong in an existing `kind:convention` via `memory_update`.
- Rewriting a memory from scratch when a small `memory_update` would do.
- Running only the memory track and skipping the skill track because "nothing seemed worth a skill". Ask the question; do not skip it.
