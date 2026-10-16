import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditErrorRecoveryListener, EDIT_ERROR_RECOVERY_REMINDER } from '../src/edit-error-recovery.js'

const EDIT_SCHEMA = Object.freeze({
  name: 'edit',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      file_path: Object.freeze({ type: 'string' }),
      old_string: Object.freeze({ type: 'string' }),
      new_string: Object.freeze({ type: 'string' }),
      replace_all: Object.freeze({ type: 'boolean' }),
    }),
    required: Object.freeze(['file_path', 'old_string', 'new_string']),
  }),
})

function makeExec(overrides = {}) {
  return {
    name: 'edit',
    schema: EDIT_SCHEMA,
    arguments: { file_path: '/repo/file.js', old_string: 'before', new_string: 'after' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function makeFailure(message) {
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: message }],
  }
}

test('adds bounded advisory context for each pinned Edit failure pattern', async () => {
  const patterns = [
    'oldString and newString must be different',
    'oldString not found',
    'oldString found multiple times',
  ]
  const listener = createEditErrorRecoveryListener()

  for (const pattern of patterns) {
    const value = { unchanged: true }
    const previousContext = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'existing context' }] }
    const downstreamDecision = Object.freeze({ kind: 'accept', value, additionalContexts: Object.freeze([previousContext]) })
    const result = makeFailure(`Error: ${pattern}`)
    let nextCalls = 0

    const decision = await listener(makeExec(), result, async () => {
      nextCalls += 1
      return downstreamDecision
    })

    assert.equal(nextCalls, 1, 'the waterfall continues exactly once')
    assert.equal(decision.kind, 'accept')
    assert.strictEqual(decision.value, value, 'the structured Tool value is preserved')
    assert.strictEqual(decision.additionalContexts[0], previousContext)
    assert.equal(decision.additionalContexts.length, 2)
    assert.equal(decision.additionalContexts[1].role, 'user')
    assert.equal(decision.additionalContexts[1].content[0].text, EDIT_ERROR_RECOVERY_REMINDER)
    assert.equal(result.error.message, `Error: ${pattern}`, 'the frozen Tool failure is not rewritten')
  }
})

test('preserves downstream content-only acceptance and existing contexts', async () => {
  const content = [{ type: 'text', text: 'native edit error' }]
  const previous = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'prior' }] }
  const downstreamDecision = Object.freeze({ kind: 'accept', content, additionalContexts: Object.freeze([previous]) })
  const listener = createEditErrorRecoveryListener()
  let nextCalls = 0

  const decision = await listener(makeExec(), makeFailure('oldString not found'), async () => {
    nextCalls += 1
    return downstreamDecision
  })

  assert.equal(nextCalls, 1)
  assert.strictEqual(decision.content, content)
  assert.deepEqual(decision.additionalContexts[0], previous)
  assert.equal(decision.additionalContexts[1].content[0].text, EDIT_ERROR_RECOVERY_REMINDER)
})

test('does not add context for non-edit calls, schema/argument mismatches, unrelated errors, or success', async () => {
  const listener = createEditErrorRecoveryListener()
  const cases = [
    [makeExec({ name: 'read' }), makeFailure('oldString not found')],
    [makeExec({ schema: undefined }), makeFailure('oldString not found')],
    [makeExec({ schema: { ...EDIT_SCHEMA, name: 'write' } }), makeFailure('oldString not found')],
    [makeExec({ schema: { ...EDIT_SCHEMA, parameters: { ...EDIT_SCHEMA.parameters, required: ['file_path'] } } }), makeFailure('oldString not found')],
    [makeExec({ arguments: { file_path: '/repo/file.js', old_string: 'before' } }), makeFailure('oldString not found')],
    [makeExec(), makeFailure('permission denied')],
    [makeExec(), { isError: false, value: {}, content: [] }],
    [makeExec(), makeFailure(`oldString not found${'x'.repeat(4_100)}`)],
  ]

  for (const [exec, result] of cases) {
    const downstreamDecision = { kind: 'accept', value: { unchanged: true } }
    let nextCalls = 0
    const decision = await listener(exec, result, async () => {
      nextCalls += 1
      return downstreamDecision
    })
    assert.equal(nextCalls, 1)
    assert.strictEqual(decision, downstreamDecision)
    assert.equal(decision.additionalContexts, undefined)
  }
})

test('does not inject after downstream blocks or cancellation', async () => {
  const listener = createEditErrorRecoveryListener()
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
  let nextCalls = 0
  const blockDecision = await listener(makeExec(), makeFailure('oldString not found'), async () => {
    nextCalls += 1
    return blocked
  })
  assert.equal(nextCalls, 1)
  assert.strictEqual(blockDecision, blocked)

  const controller = new AbortController()
  const abortedExec = makeExec({ signal: controller.signal })
  const accepted = { kind: 'accept', value: { unchanged: true } }
  const cancelledDecision = await listener(abortedExec, makeFailure('oldString not found'), async () => {
    nextCalls += 1
    controller.abort()
    return accepted
  })
  assert.equal(nextCalls, 2)
  assert.strictEqual(cancelledDecision, accepted)
  assert.equal(cancelledDecision.additionalContexts, undefined)
})
