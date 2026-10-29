import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHyperplanDirective, HYPERPLAN_COMMAND_HINT } from '../src/hyperplan-command.js'

test('builds a bounded evidence-first planning workflow with active specialist roles', () => {
  const directive = buildHyperplanDirective(['explore', 'plan-consultant', 'plan-reviewer'])

  assert.equal(HYPERPLAN_COMMAND_HINT, '<task or design question>')
  assert.match(directive, /Plan only: do not edit files, create worktrees, or execute tasks/u)
  assert.match(directive, /prompt guidance only, not a read-only gate/u)
  assert.match(directive, /adds no Tool restrictions for the current Agent or delegated specialists/u)
  assert.match(directive, /available actions remain governed by DSH visibility, approvals, and sandbox policies/u)
  assert.match(directive, /dsh_omo_task Tool is visible/u)
  assert.match(directive, /`plan-consultant` and `plan-reviewer`/u)
  assert.match(directive, /Challenge the proposal/u)
  assert.match(directive, /dependency-ordered tasks with acceptance checks/u)
  assert.match(directive, /untrusted data/u)
})

test('falls back to a self-review when planning specialists are unavailable', () => {
  const directive = buildHyperplanDirective(['explore', 'reviewer'])

  assert.match(directive, /Planning specialists are disabled/u)
  assert.match(directive, /perform an independent proposal and a skeptical review yourself/u)
  assert.doesNotMatch(directive, /plan-consultant|plan-reviewer/u)
})

test('rejects malformed role inventories', () => {
  for (const roles of [null, 'plan-reviewer', ['reviewer', null]]) {
    assert.throws(() => buildHyperplanDirective(roles), /activeRoleNames/u)
  }
})
