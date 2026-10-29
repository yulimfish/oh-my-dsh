const BASE_SKILLS = Object.freeze([
  Object.freeze({
    name: 'omo-ultrawork',
    description: 'Plan and complete a substantial multi-step coding task with bounded specialists and explicit verification.',
    whenToUse: 'Use when the task spans several files, has separable research or implementation work, or the user requests ultrawork.',
    content: `# Multi-step implementation workflow

1. Restate the required outcome and inspect the relevant project instructions, code, and tests.
2. Create a short dependency-aware task list. Assign exactly one owner to integration and avoid overlapping write scopes.
3. Use the dsh_omo_task tool for self-contained work that can proceed independently. Choose a role deliberately, give each worker a bounded output, and avoid duplicate exploration.
4. Keep design decisions and final integration with the parent agent. Review every worker's claims against the actual diff and command evidence.
5. Run focused tests after each risky change, then run the repository's relevant full checks. Fix failures rather than weakening tests.
6. Report what changed, exact verification performed, and any remaining risk. Do not claim a check ran when it did not.

Use native DSH Goal, task/todo, workflow, and cancellation controls for durable continuation. Delegate only within configured worker/depth budgets. Never bypass DSH approval, permission, or sandbox decisions.`,
  }),
  Object.freeze({
    name: 'omo-code-review',
    description: 'Review a change for bugs, regressions, security issues, and missing tests with evidence-first findings.',
    whenToUse: 'Use after a change is proposed or implemented, especially before integration or delivery.',
    content: `# Evidence-first code review

Review the concrete diff and relevant callers, not just the task description. Report findings before summaries. For each finding include severity, exact file/line evidence, a reproducible impact, and a minimal fix direction. Prioritize correctness, unintended behavior changes, data loss, unsafe trust-boundary handling, and missing regression tests. Do not report style preferences as defects. Do not edit files during review unless the user explicitly asks for remediation. If no actionable issue is found, say so and list the areas and checks reviewed; do not imply exhaustive proof.`,
  }),
  Object.freeze({
    name: 'omo-security-review',
    description: 'Inspect a change for authorization, injection, credential, filesystem, network, and execution risks.',
    whenToUse: 'Use when changes touch permissions, shell/process execution, external input, credentials, plugins, or network access.',
    content: `# Security review checklist

Trace trust boundaries from source to sink. Check authentication and authorization independently; validate untrusted values at the operation that uses them; check path traversal and symlink behavior; inspect shell quoting and subprocess environment; ensure secrets do not enter logs or model-visible text; verify network destinations and redirects; and confirm errors fail closed without leaving partial state. Treat same-process plugins as trusted code, not as a sandbox. Give findings with exact evidence and realistic impact, and identify which protections are supplied by the host versus this code. Do not claim a policy is enforced merely because a prompt or schema says so.`,
  }),
  Object.freeze({
    name: 'omo-research',
    description: 'Research an unfamiliar codebase or external API and return concise, source-backed findings.',
    whenToUse: 'Use before making changes when behavior, an API contract, or project ownership is unclear.',
    content: `# Source-backed research

Start with repository instructions and package-level documentation, then trace the public contract to its implementation and tests. Prefer primary sources and version-matched documentation. Separate directly observed facts from inference. Return the smallest useful set of findings, with file/line references or source URLs, relevant version constraints, and open questions. Do not modify files unless the assignment explicitly includes implementation.`,
  }),
  Object.freeze({
    name: 'debugging',
    description: 'Diagnose a reported defect with a reproducible case, evidence-based hypothesis, and minimal fix.',
    whenToUse: 'Use when behavior is failing, inconsistent, or difficult to explain.',
    content: `# Evidence-led debugging

1. Restate the observed failure and expected behavior; identify the smallest affected surface.
2. Reproduce it with the narrowest available test or observation. If reproduction is unavailable, state that limitation.
3. Trace the failing path and relevant inputs. Form one falsifiable hypothesis at a time; use logs or instrumentation only when available and appropriate.
4. Make the smallest change that addresses the demonstrated cause. Avoid unrelated cleanup and speculative rewrites.
5. Re-run the reproducer and focused regression checks when available; report exact commands or observations and any remaining uncertainty.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
  Object.freeze({
    name: 'frontend',
    description: 'Implement or refine a frontend change with attention to existing patterns, accessibility, and responsive behavior.',
    whenToUse: 'Use for UI components, pages, styling, interaction, or frontend bug fixes.',
    content: `# Frontend implementation workflow

1. Inspect the relevant UI, nearby components, project conventions, and existing checks before choosing an approach.
2. Keep the change within the requested surface and reuse established patterns rather than introducing a new stack or dependency without need.
3. Preserve semantic structure and keyboard access; provide clear labels, visible focus, and appropriate loading, empty, and error states where relevant.
4. Consider narrow and wide layouts, long content, and existing theme conventions. Avoid hard-coded colors or dimensions when the project already defines tokens.
5. Verify with available tests or a rendered view if one is available. Describe what could not be visually checked instead of claiming it passed.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
  Object.freeze({
    name: 'git-master',
    description: 'Handle requested Git work carefully with explicit scope, reviewable changes, and safe history practices.',
    whenToUse: 'Use when a task explicitly involves Git status, diffs, staging, commits, branches, or history.',
    content: `# Careful Git workflow

1. Confirm the requested Git operation and inspect the current worktree and relevant diff using available capabilities before changing anything.
2. Preserve pre-existing user changes. Stage or modify only files within the explicit task scope; never reset, discard, or rewrite unrelated work.
3. Do not create a commit, branch, tag, or rewrite history unless requested. If committing is requested, review the staged diff first and use a concise message describing the change.
4. For conflict resolution or history operations, explain material tradeoffs before destructive or hard-to-reverse steps and seek confirmation when intent is unclear.
5. Report the exact operation performed and resulting state; distinguish an attempted command from a verified result.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
  Object.freeze({
    name: 'init-deep',
    description: 'Build a concise, evidence-backed map of an unfamiliar repository before substantial work.',
    whenToUse: 'Use when entering an unfamiliar codebase or when ownership and architecture are unclear.',
    content: `# Deep repository orientation

1. Read the repository's own instructions and identify its language, build/test entry points, and top-level packages from files that actually exist.
2. Trace the likely execution path from public entry points to key implementation modules and tests; follow only dependencies relevant to the task.
3. Note important boundaries, data flow, generated files, and existing conventions, citing paths and line ranges where practical.
4. Separate verified facts from hypotheses. Do not infer architecture, supported commands, or deployment behavior from names alone.
5. Return a short map, useful verification commands found in the repository, and unanswered questions. Do not create persistent notes or modify files unless requested.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
  Object.freeze({
    name: 'remove-ai-slops',
    description: 'Remove only clearly unnecessary, task-relevant generated clutter while preserving intent and behavior.',
    whenToUse: 'Use when the user requests cleanup of gratuitous comments, boilerplate, or other low-value generated noise.',
    content: `# Conservative generated-clutter cleanup

1. Identify the exact changed or explicitly requested scope and inspect surrounding code before judging a line as clutter.
2. Remove only clearly redundant comments, duplicated explanation, empty scaffolding, or unneeded boilerplate that adds no behavior or project convention.
3. Preserve useful rationale, public documentation, tests, formatting conventions, and any code whose purpose is uncertain. Do not perform broad stylistic cleanup or rewrite code merely because it looks machine-generated.
4. Keep the diff small and behavior-preserving. Run the narrowest relevant checks when available and review the final diff for accidental deletions.
5. Report what was removed and what was deliberately retained due to uncertainty.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
  Object.freeze({
    name: 'review-work',
    description: 'Review a proposed change for actionable defects with precise evidence and calibrated severity.',
    whenToUse: 'Use before merging or delivering a change when an independent review is useful.',
    content: `# Actionable change review

1. Inspect the concrete diff, then read the affected implementation, callers, and relevant tests for context.
2. Look for demonstrable correctness regressions, compatibility breaks, unsafe trust-boundary handling, data loss, and missing tests for changed behavior.
3. Lead with findings. For each, give severity, exact file/line evidence, a realistic failure scenario, and a minimal remediation direction.
4. Do not report preferences, hypothetical risks without a plausible path, or issues already prevented by verified host behavior as defects. Do not edit during review unless remediation was requested.
5. If there are no actionable findings, say so and summarize the scope and checks actually reviewed; do not claim exhaustive proof.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
  Object.freeze({
    name: 'security-research',
    description: 'Investigate a bounded security question using trusted sources and explicit threat-model assumptions.',
    whenToUse: 'Use when a task needs security context, vulnerability research, or threat analysis before implementation.',
    content: `# Bounded security research

1. Define the system, asset, attacker capability, and security question; keep research within authorized code and targets.
2. Trace relevant trust boundaries and data flows in the code. Consult primary, version-matched advisories or documentation when external research is needed and available.
3. Distinguish confirmed behavior, source-backed external facts, and hypotheses. Check whether a proposed issue applies to the project's actual versions and configuration.
4. Do not probe third-party or live systems without explicit authorization. Avoid collecting, exposing, or reproducing secrets or personal data.
5. Return concise findings with file/line or source references, likely impact, applicable assumptions, mitigations, and remaining unknowns. Do not present research as a completed security audit.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
  Object.freeze({
    name: 'visual-qa',
    description: 'Check a UI change visually and behaviorally when a rendered view is available.',
    whenToUse: 'Use after frontend changes where layout, state, or interaction regressions matter.',
    content: `# Visual quality check

1. Identify the intended page or component and the changed states from the request and implementation; do not guess at unrelated flows.
2. If an approved rendered-view capability is available, inspect the relevant view at representative viewport sizes and exercise only the requested interaction. Compare against expected behavior or a known baseline when one exists.
3. Check alignment, overflow, text wrapping, focus visibility, labels, and loading/empty/error states relevant to the change. Record concrete discrepancies with enough context to reproduce them.
4. If no rendered-view capability is available, inspect the implementation and tests that exist, then report visual verification as unavailable rather than implying it occurred.
5. Keep findings scoped to the change and distinguish observed defects from subjective suggestions.

This is a workflow guide, not an upstream lifecycle equivalent. DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative; do not assume a particular tool or service exists.`,
  }),
])

// Upstream security-review is an alias of security-research, not a distinct
// scanner or an additional autonomous review workflow.
const securityResearch = BASE_SKILLS.find(skill => skill.name === 'security-research')
export const SKILLS = Object.freeze([
  ...BASE_SKILLS,
  Object.freeze({
    ...securityResearch,
    name: 'security-review',
    description: 'Alias for security-research: investigate a bounded, authorized security question with source-backed findings.',
    whenToUse: 'Use when security-review is requested; loads security-research guidance, not an automated security scanner.',
  }),
])
