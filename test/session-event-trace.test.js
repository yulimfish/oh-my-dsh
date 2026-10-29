import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionEventTraceTool, registerSessionEventTraceTool } from '../src/session-event-trace.js'

function observation(sessionId = 'session-1', seq = 12) {
  return {
    session: { id: sessionId, cwd: '/private/path', parentSession: 'private-parent' },
    target: { sessionId, seq, type: 'tool/result', time: 123, surface: 'shadowed', eventText: 'must never escape' },
    replacedBy: 17,
    replacementChain: [12, 17],
    replacedEventSeqs: [11],
    sourceEventSeqs: [3, 5],
    derivedEventSeqs: [22, 23],
    privatePayload: 'must never escape',
  }
}

function execute(tool, args = { seq: 12 }, agent = { id: 'session-1' }, signal = new AbortController().signal) {
  return tool.execute(args, { agent, signal })
}

test('traces only the exact current Agent event and projects sequence metadata', async () => {
  const calls = []
  const signal = new AbortController().signal
  const tool = createSessionEventTraceTool({
    traceEvent: async (request, receivedSignal) => {
      calls.push({ request, signal: receivedSignal })
      return observation()
    },
  })

  const result = await execute(tool, { seq: 12 }, { id: 'session-1' }, signal)
  assert.deepEqual(calls, [{ request: { sessionId: 'session-1', seq: 12 }, signal }])
  assert.deepEqual(result, {
    target: { seq: 12, surface: 'shadowed' },
    replacedBy: 17,
    replacementChain: [12, 17],
    replacedEventSeqs: [11],
    sourceEventSeqs: [3, 5],
    derivedEventSeqs: [22, 23],
    truncated: {
      replacementChain: false,
      replacedEventSeqs: false,
      sourceEventSeqs: false,
      derivedEventSeqs: false,
    },
  })
  assert.equal('session' in result, false, 'the returned Host header is never exposed')
  assert.equal(JSON.stringify(result).includes('must never escape'), false, 'event text and unprojected Host fields are discarded')
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /Read-only DSH event provenance/u)
  assert.match(rendered, /#12 \(shadowed\)/u)
  assert.equal('type' in result.target, false, 'Host event types are not model-facing')
  assert.doesNotMatch(rendered, /tool\/result|private-parent|private\/path|must never escape/u)
})

test('never exposes arbitrary Host event types and requires finite target time', async () => {
  const privateType = observation()
  privateType.target.type = 'private event/body text'
  const tool = createSessionEventTraceTool({ traceEvent: async () => privateType })
  const result = await execute(tool)
  const rendered = tool.output.render({}, result)[0].text
  assert.equal('type' in result.target, false)
  assert.doesNotMatch(JSON.stringify(result), /private event\/body text/u)
  assert.doesNotMatch(rendered, /private event\/body text/u)

  const missingTime = observation()
  delete missingTime.target.time
  const nonFiniteTime = observation()
  nonFiniteTime.target.time = Number.POSITIVE_INFINITY
  for (const response of [missingTime, nonFiniteTime]) {
    const invalidTool = createSessionEventTraceTool({ traceEvent: async () => response })
    await assert.rejects(execute(invalidTool), /invalid event trace metadata/u)
  }
})

test('caps each returned relationship list and marks truncation per list', async () => {
  const sequences = Array.from({ length: 70 }, (_value, index) => index)
  const tool = createSessionEventTraceTool({
    traceEvent: async () => ({
      session: { id: 'session-1' },
      target: { sessionId: 'session-1', seq: 12, type: 'user/message', time: 123, surface: 'current' },
      replacementChain: sequences,
      replacedEventSeqs: sequences,
      sourceEventSeqs: sequences,
      derivedEventSeqs: sequences,
    }),
  })

  const result = await execute(tool)
  for (const relation of ['replacementChain', 'replacedEventSeqs', 'sourceEventSeqs', 'derivedEventSeqs']) {
    assert.equal(result[relation].length, 64)
    assert.equal(result.truncated[relation], true)
    assert.equal(result[relation][63], 63)
  }
  assert.equal(result.replacedBy, undefined)
})

test('rejects arbitrary targets, invalid sequences, missing Agents, and pre-cancelled requests before lookup', async () => {
  let calls = 0
  const tool = createSessionEventTraceTool({ traceEvent: async () => { calls += 1; return observation() } })
  for (const seq of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(execute(tool, { seq }))
  }
  await assert.rejects(execute(tool, { seq: 12, sessionId: 'other-session' }))
  await assert.rejects(execute(tool, { seq: 12 }, null), /requires a valid current Agent/u)
  await assert.rejects(execute(tool, { seq: 12 }, { id: `bad\n${'x'.repeat(260)}` }), /requires a valid current Agent/u)

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(execute(tool, { seq: 12 }, { id: 'session-1' }, aborted.signal), /was cancelled/u)
  assert.equal(calls, 0)
})

test('forwards caller cancellation to the Host trace and reports no returned event data', async () => {
  const controller = new AbortController()
  let receivedSignal
  const tool = createSessionEventTraceTool({
    traceEvent: async (_request, signal) => {
      receivedSignal = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private cancellation reason')), { once: true }))
    },
  })
  const pending = execute(tool, { seq: 12 }, { id: 'session-1' }, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => {
    assert.match(error.message, /was cancelled/u)
    assert.equal(error.message.includes('private cancellation reason'), false)
    return true
  })
  assert.strictEqual(receivedSignal, controller.signal)
})

test('fails closed on Host failures and mismatched or malformed trace metadata', async () => {
  const secret = 'provider details must not escape'
  const tool = createSessionEventTraceTool({ traceEvent: async () => { throw new Error(secret) } })
  await assert.rejects(execute(tool), error => {
    assert.match(error.message, /Could not trace event provenance/u)
    assert.equal(error.message.includes(secret), false)
    return true
  })

  const invalidResponses = [
    observation('another-session'),
    { ...observation(), session: { id: 'session-1' }, target: { ...observation().target, sessionId: 'another-session' } },
    { ...observation(), target: { ...observation().target, seq: 13 } },
    { ...observation(), target: { ...observation().target, surface: 'unknown' } },
    { ...observation(), sourceEventSeqs: [1, -2] },
  ]
  for (const response of invalidResponses) {
    const invalidTool = createSessionEventTraceTool({ traceEvent: async () => response })
    await assert.rejects(execute(invalidTool), /invalid event trace metadata/u)
  }

  const hostileResponse = new Proxy(observation(), {
    get(target, key, receiver) {
      if (key === 'session') throw new Error(secret)
      return Reflect.get(target, key, receiver)
    },
  })
  const hostileTool = createSessionEventTraceTool({ traceEvent: async () => hostileResponse })
  await assert.rejects(execute(hostileTool), error => {
    assert.match(error.message, /invalid event trace metadata/u)
    assert.equal(error.message.includes(secret), false)
    return true
  })
})

test('registration returns a disposer that removes the model-facing Tool', () => {
  const tools = new Map()
  const ctx = { tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
  const dispose = registerSessionEventTraceTool(ctx, { traceEvent: async () => observation() })
  assert.ok(tools.has('dsh_omo_session_trace_event'))
  dispose()
  assert.equal(tools.has('dsh_omo_session_trace_event'), false)
  assert.throws(() => createSessionEventTraceTool({}), /requires DSH sessionQuery\.traceEvent/u)
})
