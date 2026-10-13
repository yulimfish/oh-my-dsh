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

test('adds trimmed multiline role guidance before fixed worker instructions', () => {
  const role = getRole('plan-consultant')
  const task = 'Complete the migration plan'
  const promptAppend = ' \tFirst line\r\nSecond line\nThird line \t '

  const prompt = buildWorkerPrompt('plan-consultant', task, promptAppend)
  const expected = [
    `You are acting as the ${role.title} for a delegated DeepSeek Harness task.`,
    role.focus,
    '',
    '## Additional role guidance',
    'First line\r\nSecond line\nThird line',
    'Work only on the assigned task. Do not widen the request or claim completion without evidence.',
    'The parent agent owns final integration and verification. Report changed files, commands, findings, and any blockers.',
    '',
    '## Assigned task',
    task,
  ].join('\n')

  assert.equal(prompt, expected)
})

test('omits undefined and whitespace-only role guidance without changing the prompt', () => {
  const defaultPrompt = buildWorkerPrompt('plan-reviewer', 'Review the proposal')

  for (const promptAppend of [undefined, '', ' \t\r\n  ']) {
    assert.equal(
      buildWorkerPrompt('plan-reviewer', 'Review the proposal', promptAppend),
      defaultPrompt,
    )
  }
})

test('rejects NUL and disallowed C0/C1 controls in role guidance', () => {
  const disallowedControls = [
    ...Array.from({ length: 0x09 }, (_, index) => String.fromCodePoint(index)),
    '\u000B',
    '\u000C',
    ...Array.from({ length: 0x12 }, (_, index) => String.fromCodePoint(index + 0x0E)),
    ...Array.from({ length: 0x21 }, (_, index) => String.fromCodePoint(index + 0x7F)),
  ]

  for (const control of disallowedControls) {
    assert.throws(
      () => buildWorkerPrompt('plan-consultant', 'Do the work', `before${control}after`),
      `rejects control U+${control.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    )
  }

  const allowedControls = 'before\tmiddle\r\nnext\nlast\t'
  assert.doesNotThrow(() => buildWorkerPrompt('plan-consultant', 'Do the work', allowedControls))
})

test('limits role guidance by UTF-8 byte length', () => {
  const maximumAppend = 'é'.repeat(2048)
  const overLimitAppend = 'é'.repeat(2049)

  assert.ok(
    buildWorkerPrompt('plan-consultant', 'Do the work', maximumAppend)
      .includes(`## Additional role guidance\n${maximumAppend}\nWork only on the assigned task.`),
  )
  assert.throws(() => buildWorkerPrompt('plan-consultant', 'Do the work', overLimitAppend))
  assert.throws(() => buildWorkerPrompt('plan-consultant', 'Do the work', ' '.repeat(4097)), /4096 UTF-8 bytes/u)
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
