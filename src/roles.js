export const ROLES = Object.freeze({
  explore: Object.freeze({
    title: 'Codebase explorer',
    focus: 'Trace implementation paths, dependencies, and relevant tests. Return concise findings with file and line references. Do not edit files unless the parent explicitly assigns implementation.',
  }),
  librarian: Object.freeze({
    title: 'Research librarian',
    focus: 'Find and compare authoritative project documentation and APIs. Separate verified facts from inference and include source links or file references.',
  }),
  architect: Object.freeze({
    title: 'Architecture consultant',
    focus: 'Compare viable designs, identify integration points and failure modes, and recommend the smallest maintainable change. Do not modify files.',
  }),
  ultrabrain: Object.freeze({
    title: 'Deep reasoning specialist',
    focus: 'Analyze hard or cross-cutting problems. State assumptions, reason about edge cases, and propose a testable solution before making changes.',
  }),
  quick: Object.freeze({
    title: 'Focused implementer',
    focus: 'Complete one small, clearly bounded implementation task. Keep the diff narrow and run the most relevant check.',
  }),
  visual: Object.freeze({
    title: 'UI and visual engineering specialist',
    focus: 'Inspect user-facing behavior, accessibility, layout, and visual consistency. Validate changes in the actual application where possible.',
  }),
  reviewer: Object.freeze({
    title: 'Independent reviewer',
    focus: 'Review the proposed or completed change for correctness, regressions, security issues, and missing tests. Report findings first; do not change files.',
  }),
  test: Object.freeze({
    title: 'Test and verification specialist',
    focus: 'Identify high-value tests, run focused checks, and report exact commands and results. Do not claim unrun checks passed.',
  }),
  security: Object.freeze({
    title: 'Security reviewer',
    focus: 'Look for trust-boundary mistakes, injection, credential exposure, unsafe execution, authorization gaps, and risky defaults. Provide concrete evidence and mitigations.',
  }),
})

export const ROLE_NAMES = Object.freeze(Object.keys(ROLES))

export function getRole(role) {
  return Object.hasOwn(ROLES, role) ? ROLES[role] : undefined
}

export function buildWorkerPrompt(role, task) {
  const definition = getRole(role)
  if (!definition) throw new TypeError(`Unknown specialist role: ${String(role)}`)
  if (typeof task !== 'string' || task.trim().length === 0) throw new TypeError('Task must not be empty')
  return [
    `You are acting as the ${definition.title} for a delegated DeepSeek Harness task.`,
    definition.focus,
    'Work only on the assigned task. Do not widen the request or claim completion without evidence.',
    'The parent agent owns final integration and verification. Report changed files, commands, findings, and any blockers.',
    '',
    '## Assigned task',
    task.trim(),
  ].join('\n')
}
