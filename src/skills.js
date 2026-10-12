export const SKILLS = Object.freeze([
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
])
