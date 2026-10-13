import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWorkerPrompt, getRole, ROLE_NAMES, ROLES } from '../src/roles.js'

const parityRoles = ['plan-consultant', 'plan-reviewer']

test('exports the missing planning specialist roles immutably', () => {
  assert.ok(Object.isFrozen(ROLES))
  assert.ok(Object.isFrozen(ROLE_NAMES))
  assert.ok(ROLE_NAMES.includes('plan-consultant'))
  assert.ok(ROLE_NAMES.includes('plan-reviewer'))

  for (const name of parityRoles) {
    const role = getRole(name)
    assert.ok(role, `${name} is available through getRole`)
    assert.ok(Object.isFrozen(role), `${name} definition is frozen`)
    assert.equal(typeof role.title, 'string')
    assert.ok(role.title.trim().length > 0, `${name} has a title`)
    assert.equal(typeof role.focus, 'string')
    assert.ok(role.focus.trim().length > 0, `${name} has a focus`)
  }
})

test('builds focused, usable prompts for both planning specialists', () => {
  const task = '  Create a migration plan for the settings API.  '

  for (const name of parityRoles) {
    const role = getRole(name)
    const prompt = buildWorkerPrompt(name, task)
    assert.ok(prompt.includes(role.title), `${name} prompt identifies its title`)
    assert.ok(prompt.includes(role.focus), `${name} prompt contains its focus`)
    assert.ok(prompt.includes('Work only on the assigned task.'))
    assert.ok(prompt.includes('## Assigned task\nCreate a migration plan for the settings API.'))
    assert.ok(!prompt.includes('  Create a migration plan'), 'prompt trims task whitespace')
  }

  const consultantFocus = getRole('plan-consultant').focus
  const reviewerFocus = getRole('plan-reviewer').focus
  assert.match(consultantFocus, /acceptance criteria/i)
  assert.match(consultantFocus, /Do not implement the plan/i)
  assert.match(reviewerFocus, /completeness.*feasibility/i)
  assert.match(reviewerFocus, /Lead with concrete gaps or blockers/i)
  assert.match(reviewerFocus, /do not implement the plan/i)
})

test('validates role and task inputs when building worker prompts', () => {
  assert.throws(
    () => buildWorkerPrompt('unknown-role', 'Do the work'),
    { name: 'TypeError', message: 'Unknown specialist role: unknown-role' },
  )
  assert.throws(
    () => buildWorkerPrompt('plan-consultant', '  '),
    { name: 'TypeError', message: 'Task must not be empty' },
  )

  for (const invalidTask of [undefined, null, 42, {}]) {
    assert.throws(
      () => buildWorkerPrompt('plan-reviewer', invalidTask),
      { name: 'TypeError', message: 'Task must not be empty' },
    )
  }
})
