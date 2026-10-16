import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASH_FILE_READ_GUIDANCE,
  createBashFileReadGuidanceListener,
  isSimpleBashFileRead,
} from '../src/bash-file-read-guidance.js'

const BASH_SCHEMA = Object.freeze({
  name: 'bash',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      command: Object.freeze({ type: 'string' }),
      description: Object.freeze({ type: 'string' }),
    }),
    required: Object.freeze(['command', 'description']),
  }),
})

function makeExec(overrides = {}) {
  return {
    name: 'bash',
    schema: BASH_SCHEMA,
    arguments: { command: 'cat src/index.js', description: 'Read source file' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function makeSuccess(value = { unchanged: true }) {
  return { isError: false, value, content: [{ type: 'text', text: 'file contents' }] }
}

test('recognizes only pinned simple cat/head/tail file-read commands', () => {
  for (const command of [
    'cat README.md',
    '\tcat\tREADME.md  ',
    'head README.md',
    'head -n 12 README.md',
    'tail README.md',
    'tail -n 4 README.md',
  ]) {
    assert.equal(isSimpleBashFileRead(makeExec({ arguments: { command } })), true, command)
  }

  for (const command of [
    'cat',
    'cat -n README.md',
    'cat -- README.md',
    'cat README.md | head',
    'cat README.md && echo done',
    'head -n README.md',
    'tail -n 4 -- README.md',
    'sed -n 1,4p README.md',
    `cat ${'x'.repeat(1_025)}`,
  ]) {
    assert.equal(isSimpleBashFileRead(makeExec({ arguments: { command } })), false, command)
  }
})

test('adds fixed advisory context after a successful matched call and preserves downstream fields', async () => {
  const listener = createBashFileReadGuidanceListener()
  const value = Object.freeze({ unchanged: true })
  const priorContext = Object.freeze({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'prior' }] })
  const decision = Object.freeze({ kind: 'accept', value, additionalContexts: Object.freeze([priorContext]) })
  const result = Object.freeze(makeSuccess(value))
  const exec = makeExec({ arguments: { command: 'head -n 12 README.md', description: 'Read file' } })
  let nextCalls = 0

  const accepted = await listener(exec, result, async () => {
    nextCalls += 1
    return decision
  })

  assert.equal(nextCalls, 1, 'the waterfall continues exactly once')
  assert.equal(accepted.kind, 'accept')
  assert.strictEqual(accepted.value, value)
  assert.strictEqual(accepted.additionalContexts[0], priorContext)
  assert.equal(accepted.additionalContexts.length, 2)
  assert.equal(accepted.additionalContexts[1].role, 'user')
  assert.equal(accepted.additionalContexts[1].content[0].text, BASH_FILE_READ_GUIDANCE)
  assert.strictEqual(result.value, value, 'the native result is not rewritten')
  assert.equal(result.content[0].text, 'file contents')
})

test('preserves content-only downstream acceptance and existing contexts', async () => {
  const content = [{ type: 'text', text: 'native output' }]
  const prior = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'existing' }] }
  const downstream = Object.freeze({ kind: 'accept', content, additionalContexts: Object.freeze([prior]) })
  const listener = createBashFileReadGuidanceListener()
  let nextCalls = 0

  const accepted = await listener(makeExec(), makeSuccess(), async () => {
    nextCalls += 1
    return downstream
  })

  assert.equal(nextCalls, 1)
  assert.strictEqual(accepted.content, content)
  assert.strictEqual(accepted.additionalContexts[0], prior)
  assert.equal(accepted.additionalContexts[1].content[0].text, BASH_FILE_READ_GUIDANCE)
})

test('skips non-bash calls, schema/argument mismatches, and failed results', async () => {
  const listener = createBashFileReadGuidanceListener()
  const cases = [
    [makeExec({ name: 'read' }), makeSuccess()],
    [makeExec({ schema: undefined }), makeSuccess()],
    [makeExec({ schema: { ...BASH_SCHEMA, name: 'custom' } }), makeSuccess()],
    [makeExec({ schema: { ...BASH_SCHEMA, parameters: { ...BASH_SCHEMA.parameters, required: ['description'] } } }), makeSuccess()],
    [makeExec({ arguments: { command: 7 } }), makeSuccess()],
    [makeExec(), { isError: true, error: { message: 'command failed' }, content: [] }],
  ]

  for (const [exec, result] of cases) {
    const downstream = { kind: 'accept', value: { unchanged: true } }
    let nextCalls = 0
    const accepted = await listener(exec, result, async () => {
      nextCalls += 1
      return downstream
    })
    assert.equal(nextCalls, 1)
    assert.strictEqual(accepted, downstream)
    assert.equal(accepted.additionalContexts, undefined)
  }
})

test('does not add context after downstream blocks or cancellation', async () => {
  const listener = createBashFileReadGuidanceListener()
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
  let nextCalls = 0
  const blockedDecision = await listener(makeExec(), makeSuccess(), async () => {
    nextCalls += 1
    return blocked
  })
  assert.equal(nextCalls, 1)
  assert.strictEqual(blockedDecision, blocked)

  const controller = new AbortController()
  const accepted = { kind: 'accept', value: { unchanged: true } }
  const cancelledDecision = await listener(makeExec({ signal: controller.signal }), makeSuccess(), async () => {
    nextCalls += 1
    controller.abort()
    return accepted
  })
  assert.equal(nextCalls, 2)
  assert.strictEqual(cancelledDecision, accepted)
  assert.equal(cancelledDecision.additionalContexts, undefined)
})
