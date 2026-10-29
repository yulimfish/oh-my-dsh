# Long-horizon task mechanisms: Cline and Goose

> Research snapshot: 2026-10-30. This document records source-backed ideas and a DSH-native implementation sequence. It does not claim feature parity with either project.

## Local baseline and selection criteria

The repository already has persistent DSH Goals and automatic continuation (`src/goal-tools.js`, `src/goals.js`), model/task todo guidance, specialist delegation, terminal-result persistence, tool-output pruning, pressure compaction, context-overflow recovery, and a fixed compact-resume advisory. The missing high-value behavior is not another task database: it is keeping the current objective and progress visible **within one long turn**, detecting no-new-information loops, and restoring orientation after compaction.

Features are selected when they satisfy all of these constraints:

1. Address goal drift, repeated ineffective exploration, context loss, or unbounded delegation.
2. Reuse DSH's session log and exact live-Agent identity instead of creating a second source of truth.
3. Start with advisory behavior; do not silently block legitimate polling, watches, builds, or repeated state-changing operations.
4. Bound prompt size, retained state, concurrency, and output; make optional behavior default-off.
5. Verify each phase independently and commit it before starting the next.

## Cline: what the implementation actually does

The historical Cline implementation snapshot is pinned to [`9ee618111d58630fea30b27439216448225458e0`](https://github.com/cline/cline/tree/9ee618111d58630fea30b27439216448225458e0) (v3.85.0-era, immediately before its VS Code tree move). This preserves stable paths for the Focus Chain mechanism reviewed here rather than pretending it is a current API.

**Current-status follow-up:** Cline's [deprecations page](https://github.com/cline/cline/blob/178c774eca75a548debc7137f94ae42e7617cb68/docs/resources/deprecations.mdx) marks Focus Chain **Deprecated — no direct replacement**, saying the separate feature no longer provided enough additional benefit over the current harness. [PR #14861](https://github.com/cline/cline/pull/14861), merged as `5dea21ab89f7d5a719a532a07f7d13db37a68bd8`, removed its remaining VS Code plumbing; legacy history is filtered without deleting old checklist files. The sections below are therefore a historical mechanism study, not a recommendation to recreate Cline's exact layer. My implementation keeps only independently useful DSH-native properties, all default-off and separately testable.

### Historical Focus Chain is a progress loop, not merely a reminder

- [`focus-chain/index.ts`](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/core/task/focus-chain/index.ts) stores a Markdown checklist per task, accepts model-provided `task_progress`, reloads external edits through a debounced file watcher, and derives completion counts.
- Its reminder decision is event/state driven: first request, missing list after multiple requests, plan/act transition, user edit, or a configured number of API requests since the last progress update. Existing-list reminders include the checklist and progress percentage; they do not depend only on a static system prompt.
- [`focus-chain/prompts.ts`](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/core/task/focus-chain/prompts.ts) asks for implementation, test, documentation, and final-verification items. On completion it distinguishes “all checklist items checked” from “the user's task is proven complete” and permits more work when verification is incomplete.
- [`focus-chain/file-utils.ts`](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/core/task/focus-chain/file-utils.ts) keeps the list in a user-editable task file. The useful property is a shared, inspectable progress artifact, not the exact filename or Markdown grammar.

**DSH adaptation:** retain native `todo_write` for task state and native Goal for the durable objective. Add a small, dynamically refreshed Goal context instead of duplicating Cline's file and UI. A separate checklist file is deferred until a real recovery/use-case gap is demonstrated.

### Soft loop detection precedes escalation

- [`loop-detection.ts`](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/core/task/loop-detection.ts) compares consecutive calls by exact tool name plus a key-sorted argument signature. It ignores the frequently changing `task_progress` metadata field, emits a soft warning at three identical calls, and reaches a hard-escalation condition at five.
- [`ToolExecutor.ts`](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/core/task/ToolExecutor.ts) performs this check after tool execution and before replacing the previous-call signature. The warning is additional model context; the hard path uses Cline's consecutive-mistake mechanism.
- [`loop-detection.test.ts`](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/core/task/__tests__/loop-detection.test.ts) verifies key-order independence, reset on changed name/arguments, thresholds, re-arming after reset, and metadata exclusion.

**DSH adaptation:** implement only the soft warning first. DSH Tool arguments can be nested JSON rather than Cline's flat strings, so signature generation needs a separate bounded recursive canonicalizer. A generic hard stop is unsafe: identical terminal reads, job follows, watches, and screenshots can be intentional.

### Context handoff is distinct from compaction

Current Cline documentation describes [`/newtask` and `/smol`](https://docs.cline.bot/core-workflows/using-commands): `/newtask` distills the overall plan, completed work, relevant files, and next steps into a fresh task; `/smol` compacts the current conversation. The useful distinction is “clean handoff” versus “same-task compression.”

**DSH adaptation:** do not add another handoff command yet. Existing Goal continuation, compaction, and specialist result boundaries cover part of this need. Reassess after Goal anchoring and compaction recovery are measured.

## Goose: what the implementation actually does

Goose has moved to `aaif-goose/goose`; the source snapshot is pinned to [`361003ea3263587f4241a0f906affdcc0d5c9c1f`](https://github.com/aaif-goose/goose/tree/361003ea3263587f4241a0f906affdcc0d5c9c1f).

### MOIM puts fresh operational state near the current turn

- [`agents/moim.rs`](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose/src/agents/moim.rs) constructs an agent-only turn-context message containing current time, working directory, extension context, and—after half the budget is used—a turn-budget signal. It keeps bytes stable within a turn, marks the block as turn context, and skips it for small context windows.
- [Persistent Instructions documentation](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/documentation/docs/guides/context-engineering/using-persistent-instructions.md) says this context is refreshed each turn, includes the todo list, and is intended for concise critical reminders. It explicitly notes the recurring token cost and a 64 KiB cap.
- [`platform_extensions/todo.rs`](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose/src/agents/platform_extensions/todo.rs) replaces the complete planning-note content, persists it as session extension state, enforces a configurable character limit, and returns the current notes from `get_moim` for automatic context injection. Its prompt explicitly says not to redo or re-verify completed work merely because notes exist.
- [`session/extension_data.rs`](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose/src/session/extension_data.rs) stores independent JSON values under versioned keys such as `todo.v0` and `goal.v0`. This is a side-channel persistence contract: current planning state can be re-read without reconstructing it from a lossy summary.
- [`state_machine/ops_retry.rs`](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose/src/agents/state_machine/ops_retry.rs) gives `/goal` a one-pass “check before finishing” nudge and `/grind` repeated continuation; it also runs deterministic recipe success checks, optional failure commands, and bounded retries by resetting to the kickoff. These mechanisms are distinct: model self-assessment is not proof of completion, while shell checks are deterministic evidence.

**DSH adaptation:** a scoped `systemPrompt.context` provider can re-read the exact Agent's native Goal during each prompt assembly. It should emit nothing without an active Goal, keep the objective bounded, identify it as user task data rather than higher-priority policy, and be re-registered when compaction creates a new Agent scope. Unlike a static session-start prompt, this survives both long turns and summary loss.

### Compaction preserves orientation outside the summary

- [`context_mgmt/mod.rs`](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose/src/context_mgmt/mod.rs) hides original messages from the model, adds a structured summary and continuation message, then preserves the latest eligible text-only user message separately. It also carries the current turn-context block, excludes stale turn context from summarizer input, and uses a distinct continuation when compaction happened in a tool loop.
- The [compaction prompt schema](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose-context-management/src/prompts/compaction.md) is a goal-oriented checkpoint, not opaque prose: it retains `user_intent`, files and key code, exact errors and fixes, decisions, `pending_tasks`, `current_work`, and an optional `next_step`. Summaries remain model-generated and lossy, so the separately replayed request and durable state stay authoritative.
- The same file's tests cover preservation of the user request, audience projection, current-versus-stale turn context, reload ordering, and protected recent tool pairs. Goose also caps automatic compaction by both a ratio and an absolute token limit, and summarizes older tool request/response pairs in batches; that background pair summarization is default-off in the pinned source.

**DSH adaptation:** do not reimplement the Host summarizer. Re-registering the native Goal context on `agent/created` supplies an independent factual anchor even if a summary omits it. Keep the existing compact-resume advisory complementary. Pressure and overflow compaction remain delegated to DSH, which owns safe balanced ranges and persistence.

### Repetition inspection and isolated subagents are complementary

- [`tool_monitor.rs`](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose/src/tool_monitor.rs) compares consecutive tool name/argument pairs and can deny calls beyond a configured repetition maximum. This independently supports the same signal as Cline, though DSH should begin with Cline's softer self-correction step.
- [Subagent documentation](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/documentation/docs/guides/context-engineering/subagents.mdx) emphasizes bounded parallel/sequential work, context preservation, summary-only return, concurrency/turn/time limits, and no recursive subagent spawning by default.
- [`platform_extensions/summon.rs`](https://github.com/aaif-goose/goose/blob/361003ea3263587f4241a0f906affdcc0d5c9c1f/crates/goose/src/agents/platform_extensions/summon.rs) supports explicit reference context and working-directory/model/turn constraints, adds a `{summary: string}` result schema when a child recipe lacks one, persists child configuration, and resumes only failed or cancelled children—not completed ones. Children receive selected context, not an automatic full parent transcript; parallel writers still require disjoint scopes.

**DSH adaptation:** keep the existing specialist launcher, route caps, bounded result, and depth limit. Do not build a second delegation framework in this tranche. Progress reminders should encourage delegating genuinely independent exploration, not delegate automatically.

## Implementation sequence and acceptance gates

### Phase 1 — Native Goal Focus Chain

**Implemented in this phase:** default-off `enableFocusChain` adds `dsh-omo:focus-chain` runtime context in every exact live Agent scope. Its provider re-reads only `goals.get(agent)` at prompt assembly, renders an active Goal as bounded JSON-quoted task data, and returns an empty string for missing, inactive, or malformed Goal data. Agent creation, compaction, same-ID replacement, capacity, and dual-scope disposal are covered by unit and real DSH prompt-assembly tests. It neither creates a second objective store nor changes Goal lifecycle authority.

- Add default-off `enableFocusChain` scoped prompt context for exact live Agents.
- Re-read `goals.get(agent)` on every assembly; show only an active Goal, with bounded sanitized objective and concise anti-drift guidance.
- Re-register for fresh/resumed/compacted Agent scopes; isolate same-ID replacements; cap registrations; dispose with both Agent and plugin scopes.
- Unit tests plus real DSH prompt-assembly coverage: no Goal, active/paused/complete Goal, updates, malformed Host data, exact identity, compaction recreation, and cleanup.
- Gate: focused tests, full syntax/tests, reviewed diff, standalone commit.

### Phase 2 — Bounded repeated-call soft warning

**Implemented in this phase:** default-off `enableRepeatedCallAdvisory` captures bounded SHA-256 signatures at pre-execution and counts accepted top-level completions in their actual completion order. It warns once at the third consecutive identical call, including accepted Tool-error outcomes (completion is not semantic success), while preserving the call and downstream result. Unsupported/over-budget arguments and missing pre/post identity reset the run instead of being truncated into collisions. Argument text is never included in the warning or persisted; pending calls and per-Agent state are process-local, bounded, cancellation-fenced, and cleared on exact Agent/plugin disposal. Unit and real ToolRuntime tests cover nested canonicalization, parallel completion, same-ID replacement, and the absence of a hard stop.

- Canonicalize Tool name plus nested arguments without key-order false negatives; bound depth, nodes, string bytes, and total signature size.
- Count only consecutive completed top-level calls for the exact live Agent. Reset on a different signature, disposal, or ambiguous identity; do not persist argument signatures or echo them into prompts.
- Warn once at the third consecutive identical call; preserve downstream decisions and existing additional contexts. Do not deny, mutate arguments, count retries as successes, or claim semantic proof of “no progress.”
- Tests include key order, nested input, malformed/cyclic objects, caps, parallel calls, same-ID replacement, cancellation/disposal, and legitimate non-consecutive repeats.
- Gate: focused tests, full syntax/tests/output-contract tests, reviewed diff, standalone commit.

### Phase 3 — Session-log progress context

**Implemented in this phase:** default-off `enableProgressContext` adds `dsh-omo:progress-context` in each exact live Agent scope. It incrementally folds the DSH session log and shows only the latest successful `todo_write`, directly adapting Cline's checklist continuity and Goose's MOIM planning notes without a second task store. Pending/failed writes leave the last valid list intact; an accepted empty list clears it; malformed or skipped windows emit no stale list. Content is bounded, sanitized, and JSON-quoted. The provider replaces its projection when a compacted or restored Session has a new identity or resets its sequence cursor. Real `SessionStore` plus prompt-assembly tests verify the durable event shape and scoped cleanup.

- Use accepted Tool events rather than wall-clock polling or a parallel todo database.
- Keep current progress near the Goal, while warning that checked items are not proof of user-task completion.
- Reuse the existing Focus Chain and repeated-call advisory independently; no additional per-outcome reminder is needed.

### Deferred / intentionally not copied

- Cline's exact `task_progress` parameter, task-file watcher, percentage UI, and five-call hard escalation.
- Goose's MOIM filename/environment configuration, exact XML schema, summarizer, subagent engine, and hard repetition denial.
- Any new session event type or plugin-owned objective store. DSH's session log and native Goal remain authoritative.

### Follow-up candidates, gated by a demonstrated local gap

1. **Structured compaction checkpoint:** compare the installed Host summary contract with Goose's `user_intent` / `pending_tasks` / `current_work` / `next_step` fields. Do not add a second summarizer merely to imitate the schema; the current Goal and recovered todo already provide independent anchors.
2. **Resumable failed specialists:** Goose permits resume only for failed/cancelled children. Our current Host exposes one-shot activation, not `startContinuable`, so this needs either a verified Host continuation API or an explicitly bounded new-task handoff containing child ID, objective, evidence, and next step. Do not claim transparent resume.
3. **Deterministic phase checks:** recipe-style success commands could verify a phase before commit, but arbitrary model-authored shell checks are not a safe default. Prefer the repository's existing test commands and explicit configuration if this is later implemented.

## Research limitations

These are source-reading findings at pinned commits, not benchmark evidence that a reminder improves a particular model. Cline's deprecation rationale is especially important: adding a separate progress layer is not inherently beneficial. The DSH adaptations therefore reuse native Goal/todo/session state, remain opt-in, and should be evaluated for prompt cost and actual behavior rather than adopted as parity features. No upstream code is copied; the implementation uses independently designed DSH-native contracts and conservative limits.
