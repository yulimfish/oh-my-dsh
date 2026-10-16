import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createJsonErrorRecoveryListener,
  JSON_ERROR_PATTERNS,
  JSON_ERROR_REMINDER,
  JSON_ERROR_TOOL_EXCLUDE_LIST,
} from '../src/json-error-recovery.js'

function makeExec(overrides = {}) {
  return {
    name: 'custom_parser',
    arguments: { input: '{broken' },
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

test('adds one fixed advisory context for each pinned JSON parse-error pattern', async () => {
  const messages = [
    'JSON parse error: expected a closing brace',
    'Failed to parse JSON request body',
    'Invalid JSON payload',
    'Malformed JSON document',
    'Unexpected end of JSON input',
    'SyntaxError: Unexpected token x in JSON at position 0',
    "JSON expected '}' after the final property",
    'JSON unexpected EOF while reading value',
  ]
  assert.equal(messages.length, JSON_ERROR_PATTERNS.length)
  const listener = createJsonErrorRecoveryListener()

  for (const message of messages) {
    assert.ok(JSON_ERROR_PATTERNS.some(pattern => pattern.test(message)), `expected pinned pattern to match: ${message}`)
    const value = { unchanged: true }
    const previousContext = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'prior context' }] }
    const result = makeFailure(message)
    const downstreamDecision = Object.freeze({ kind: 'accept', value, additionalContexts: Object.freeze([previousContext]) })
    let nextCalls = 0

    const decision = await listener(makeExec(), result, async () => {
      nextCalls += 1
      return downstreamDecision
    })

    assert.equal(nextCalls, 1, 'the waterfall continues exactly once')
    assert.equal(decision.kind, 'accept')
    assert.strictEqual(decision.value, value)
    assert.strictEqual(decision.additionalContexts[0], previousContext)
    assert.equal(decision.additionalContexts.length, 2)
    assert.equal(decision.additionalContexts[1].role, 'user')
    assert.equal(decision.additionalContexts[1].content[0].text, JSON_ERROR_REMINDER)
    assert.ok(!decision.additionalContexts[1].content[0].text.includes(message))
    assert.strictEqual(result.error.message, message, 'the normalized Tool error is not rewritten')
  }
})

test('preserves content-only acceptance and existing contexts', async () => {
  const content = [{ type: 'text', text: 'native error content' }]
  const previous = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'existing' }] }
  const downstreamDecision = Object.freeze({ kind: 'accept', content, additionalContexts: Object.freeze([previous]) })
  const listener = createJsonErrorRecoveryListener()
  let nextCalls = 0

  const decision = await listener(makeExec({ name: 'Edit' }), makeFailure('Invalid JSON arguments'), async () => {
    nextCalls += 1
    return downstreamDecision
  })

  assert.equal(nextCalls, 1)
  assert.strictEqual(decision.content, content)
  assert.strictEqual(decision.additionalContexts[0], previous)
  assert.equal(decision.additionalContexts[1].content[0].text, JSON_ERROR_REMINDER)
})

test('skips success, unrelated/oversized errors, duplicate markers, malformed names, and excluded tools', async () => {
  const listener = createJsonErrorRecoveryListener()
  const cases = [
    [makeExec(), { isError: false, value: {}, content: [] }],
    [makeExec(), makeFailure('Template error: expected a closing brace')],
    [makeExec(), makeFailure(`Invalid JSON${'x'.repeat(4_100)}`)],
    [makeExec(), makeFailure(`Invalid JSON\n${JSON_ERROR_REMINDER}`)],
    [makeExec({ name: 17 }), makeFailure('Invalid JSON')],
    [makeExec({ name: 'x'.repeat(129) }), makeFailure('Invalid JSON')],
    ...JSON_ERROR_TOOL_EXCLUDE_LIST.map(name => [makeExec({ name: name.toUpperCase() }), makeFailure('Invalid JSON')]),
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

test('does not add guidance after downstream blocks or cancellation', async () => {
  const listener = createJsonErrorRecoveryListener()
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
  let nextCalls = 0
  const blockDecision = await listener(makeExec(), makeFailure('Invalid JSON'), async () => {
    nextCalls += 1
    return blocked
  })
  assert.equal(nextCalls, 1)
  assert.strictEqual(blockDecision, blocked)

  const controller = new AbortController()
  const accepted = { kind: 'accept', value: { unchanged: true } }
  const cancelledDecision = await listener(makeExec({ signal: controller.signal }), makeFailure('Invalid JSON'), async () => {
    nextCalls += 1
    controller.abort()
    return accepted
  })
  assert.equal(nextCalls, 2)
  assert.strictEqual(cancelledDecision, accepted)
  assert.equal(cancelledDecision.additionalContexts, undefined)
})
