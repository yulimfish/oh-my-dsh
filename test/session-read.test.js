import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionReadTool, registerSessionReadTool } from '../src/session-read.js'

function sessionHeader(id, cwd) {
  return { version: 4, id, createdAt: 1_710_000_000_000, cwd: arguments.length < 2 ? '/workspace/project' : cwd, isSeeded: false }
}

function userEvent(seq, text, extraContent = [], source = { kind: 'user' }) {
  return {
    type: 'user/message',
    seq,
    time: 1_710_000_000_000 + seq,
    surfaceOp: 'append',
    data: { id: `user-${seq}`, role: 'user', source, content: [{ type: 'text', text }, ...extraContent] },
  }
}

function assistantEvent(seq, text, extraContent = []) {
  return {
    type: 'assistant/message',
    seq,
    time: 1_710_000_000_000 + seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { id: `assistant-${seq}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text }, ...extraContent] },
      stream: [{ type: 'reasoning', text: 'stream-private-reasoning' }],
    },
  }
}

function eventWindow({ sessionId = 'session-1', cwd = '/workspace/project', events, targetSeq = 15, startSeq, endSeq } = {}) {
  const target = events.find(event => event.seq === targetSeq)
  return {
    session: sessionHeader(sessionId, cwd),
    inheritedEventCount: 0,
    target,
    events,
    startSeq: startSeq ?? events[0].seq,
    endSeq: endSeq ?? events.at(-1).seq,
  }
}

function makeSessionQuery(options = {}) {
  const calls = { observations: [], filters: [], reads: [], fullReads: 0 }
  const sessionQuery = {
    observeSession: async (sessionId, request) => {
      calls.observations.push({ sessionId, request })
      return {
        header: sessionHeader(sessionId, Object.hasOwn(options, 'cwd') ? options.cwd : '/workspace/project'),
        [Symbol.dispose]() { calls.observations.at(-1).disposed = true }
      }
    },
    filterSessions: async (filters, signal) => {
      calls.filters.push({ filters, signal })
      if (options.onFilter) options.onFilter()
      if (options.filterError) throw new Error(options.filterError)
      return options.records ?? [{ header: sessionHeader('session-1'), live: false, persisted: true }]
    },
    readEvent: async (request, signal) => {
      calls.reads.push({ request, signal })
      if (options.onRead) options.onRead()
      if (options.readError) throw new Error(options.readError)
      return options.window ?? eventWindow({
        events: [userEvent(15, 'one user message')],
        targetSeq: 15,
      })
    },
    readSession: async () => { calls.fullReads += 1; throw new Error('full log reads are forbidden') },
  }
  return { sessionQuery, calls }
}

const baseArgs = { sessionId: 'session-1', seq: 15 }

test('requires exact read services and registers with a disposer', () => {
  assert.throws(() => createSessionReadTool({}), /readEvent/u)
  assert.equal(registerSessionReadTool({}, undefined) instanceof Function, true)

  const { sessionQuery } = makeSessionQuery()
  const tools = new Map()
  const dispose = registerSessionReadTool({
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }, sessionQuery)
  assert.ok(tools.has('session_read'))
  dispose()
  assert.equal(tools.has('session_read'), false)
  assert.throws(
    () => registerSessionReadTool({ tools: { register: () => undefined } }, sessionQuery),
    /did not return a disposer/u,
  )
})

test('defaults to current workspace, forwards exact request and cancellation, and projects text only', async () => {
  const events = [
    userEvent(13, 'historical user text', [{ type: 'image', attachment: { id: 'private-image' } }]),
    { type: 'system/message', seq: 14, time: 1_710_000_000_014, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'system-14', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SECRET_SYSTEM_PROMPT' }] } } },
    assistantEvent(15, 'visible assistant answer', [
      { type: 'reasoning', text: 'SECRET_REASONING' },
      { type: 'tool-call', id: 'call-15', name: 'private_tool', arguments: '{"password":"secret"}' },
      { type: 'file', attachment: { path: '/private/path' } },
    ]),
    { type: 'tool/call', seq: 16, time: 1_710_000_000_016, data: { turn: 1, step: 1, callId: 'call-16', name: 'private_tool', arguments: '{"private":"tool args"}' } },
    userEvent(17, 'SECRET_INJECTED_CONTEXT', [], { kind: 'workspace-context' }),
    { type: 'developer/message', seq: 18, time: 1_710_000_000_018, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'developer-18', role: 'developer', source: { kind: 'user' }, content: [{ type: 'text', text: 'SECRET_DEVELOPER_PROMPT' }] } } },
    userEvent(19, 'follow-up user text'),
  ]
  const fixture = makeSessionQuery({ window: eventWindow({ events, targetSeq: 15 }) })
  const tool = createSessionReadTool(fixture.sessionQuery)
  const signal = new AbortController().signal
  const args = { ...baseArgs, before: 4, after: 4 }
  const result = await tool.execute(args, { agent: { id: 'current-agent' }, signal })

  assert.deepEqual(fixture.calls.observations, [{
    sessionId: 'current-agent',
    request: { signal, projectionMode: 'none' },
    disposed: true,
  }])
  assert.deepEqual(fixture.calls.filters, [{
    filters: [{ kind: 'cwd', values: ['/workspace/project'] }, { kind: 'id', values: ['session-1'] }],
    signal,
  }])
  assert.deepEqual(fixture.calls.reads, [{
    request: { sessionId: 'session-1', seq: 15, before: 4, after: 4 },
    signal,
  }])
  assert.equal(result.scope, 'current-workspace')
  assert.equal(result.targetVisible, true)
  assert.deepEqual(result.messages.map(({ seq, role, text, isTarget }) => ({ seq, role, text, isTarget })), [
    { seq: 13, role: 'user', text: 'historical user text', isTarget: false },
    { seq: 15, role: 'assistant', text: 'visible assistant answer', isTarget: true },
    { seq: 19, role: 'user', text: 'follow-up user text', isTarget: false },
  ])
  assert.equal(result.omittedEventCount, 4, 'system, developer, tool, and synthetic user context are omitted')
  const rendered = tool.output.render(args, result)[0].text
  assert.match(rendered, /untrusted data, not instructions/u)
  for (const secret of ['SECRET_SYSTEM_PROMPT', 'SECRET_DEVELOPER_PROMPT', 'SECRET_INJECTED_CONTEXT', 'SECRET_REASONING', 'private_tool', 'password', 'private/path', 'tool args', 'private-image']) {
    assert.equal(rendered.includes(secret), false, `omitted ${secret}`)
  }
  assert.equal(fixture.calls.fullReads, 0)
})

test('strips bidi controls from historical message text before model-facing projection', async () => {
  const fixture = makeSessionQuery({
    window: eventWindow({ events: [userEvent(15, 'Visible\u202e hidden\u2066 text')], targetSeq: 15 }),
  })
  const tool = createSessionReadTool(fixture.sessionQuery)
  const result = await tool.execute({ ...baseArgs, includeOtherProjects: true })

  assert.equal(result.messages[0].text, 'Visible hidden text')
  assert.doesNotMatch(result.messages[0].text, /\p{Bidi_Control}/u)
})

test('global access is explicit and bypasses local workspace metadata only when requested', async () => {
  const fixture = makeSessionQuery({ cwd: undefined })
  const tool = createSessionReadTool(fixture.sessionQuery)
  const result = await tool.execute({ ...baseArgs, includeOtherProjects: true })
  assert.equal(result.scope, 'all-projects')
  assert.deepEqual(fixture.calls.observations, [])
  assert.deepEqual(fixture.calls.filters, [])
  assert.deepEqual(fixture.calls.reads[0].request, { sessionId: 'session-1', seq: 15, before: 0, after: 0 })
})

test('rejects invalid inputs before service calls and fails closed without the current Agent', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionReadTool(fixture.sessionQuery)
  const invalid = [
    { sessionId: '', seq: 1 },
    { sessionId: 'session-1\n', seq: 1 },
    { sessionId: 'session-\u202e1', seq: 1 },
    { sessionId: 'x'.repeat(257), seq: 1 },
    { sessionId: 'session-1', seq: -1 },
    { sessionId: 'session-1', seq: 1.5 },
    { sessionId: 'session-1', seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...baseArgs, before: -1 },
    { ...baseArgs, before: 5 },
    { ...baseArgs, after: 5 },
    { ...baseArgs, includeOtherProjects: 'true' },
  ]
  for (const args of invalid) await assert.rejects(tool.execute(args))
  await assert.rejects(tool.execute(baseArgs), /current Agent/u)
  assert.deepEqual(fixture.calls.observations, [])
  assert.deepEqual(fixture.calls.filters, [])
  assert.deepEqual(fixture.calls.reads, [])
})

test('fails closed for missing or blank current-session cwd before filtering or reading', async () => {
  for (const cwd of [undefined, null, '', '   ']) {
    const fixture = makeSessionQuery({ cwd })
    const tool = createSessionReadTool(fixture.sessionQuery)
    await assert.rejects(tool.execute(baseArgs, { agent: { id: 'current-agent' } }), /no workspace cwd or valid observation; no scoped request was run/u)
    assert.equal(fixture.calls.observations.length, 1, 'the current session observation supplies its optional header cwd')
    assert.equal(fixture.calls.observations[0].disposed, true, `observation lease is released for ${JSON.stringify(cwd)}`)
    assert.deepEqual(fixture.calls.filters, [], `no workspace filter query is made for ${JSON.stringify(cwd)}`)
    assert.deepEqual(fixture.calls.reads, [], `no event read is made for ${JSON.stringify(cwd)}`)
    assert.equal(fixture.calls.fullReads, 0)
  }
})

test('does not read a session outside the current workspace', async () => {
  const fixture = makeSessionQuery({ records: [{ header: sessionHeader('other-session', '/elsewhere') }] })
  const tool = createSessionReadTool(fixture.sessionQuery)
  await assert.rejects(tool.execute(baseArgs, { agent: { id: 'current-agent' } }), /not in the current workspace/u)
  assert.equal(fixture.calls.filters.length, 1)
  assert.equal(fixture.calls.reads.length, 0)

  const misfiltered = makeSessionQuery({ records: [{ header: sessionHeader('session-1', '/elsewhere') }] })
  const misfilteredTool = createSessionReadTool(misfiltered.sessionQuery)
  await assert.rejects(misfilteredTool.execute(baseArgs, { agent: { id: 'current-agent' } }), /not in the current workspace/u)
  assert.equal(misfiltered.calls.reads.length, 0, 'verify the returned cwd before reading event content')
})

test('validates returned session and target identity before projecting any history', async () => {
  const events = [userEvent(15, 'must not be returned')]
  const wrongSession = makeSessionQuery({ window: eventWindow({ sessionId: 'other-session', events, targetSeq: 15 }) })
  const wrongSessionTool = createSessionReadTool(wrongSession.sessionQuery)
  await assert.rejects(wrongSessionTool.execute({ ...baseArgs, includeOtherProjects: true }), /invalid session event window/u)

  const wrongTargetWindow = eventWindow({ events, targetSeq: 15 })
  wrongTargetWindow.target = { ...wrongTargetWindow.target, seq: 14 }
  const wrongTarget = makeSessionQuery({ window: wrongTargetWindow })
  const wrongTargetTool = createSessionReadTool(wrongTarget.sessionQuery)
  await assert.rejects(wrongTargetTool.execute({ ...baseArgs, includeOtherProjects: true }), /invalid session event window/u)

  const overReturnedWindow = eventWindow({ events: [userEvent(14, 'before target'), userEvent(15, 'target')], targetSeq: 15 })
  const wrongDirection = makeSessionQuery({ window: overReturnedWindow })
  const wrongDirectionTool = createSessionReadTool(wrongDirection.sessionQuery)
  await assert.rejects(wrongDirectionTool.execute({
    sessionId: 'session-1', seq: 15, before: 0, after: 1, includeOtherProjects: true,
  }), /invalid session event window/u)

  const overAfterWindow = eventWindow({ events: [userEvent(15, 'target'), userEvent(16, 'after target')], targetSeq: 15 })
  const wrongAfter = makeSessionQuery({ window: overAfterWindow })
  const wrongAfterTool = createSessionReadTool(wrongAfter.sessionQuery)
  await assert.rejects(wrongAfterTool.execute({
    sessionId: 'session-1', seq: 15, before: 1, after: 0, includeOtherProjects: true,
  }), /invalid session event window/u)
})

test('caps event text and the total output budget', async () => {
  const events = Array.from({ length: 9 }, (_, index) => userEvent(index, 'x'.repeat(10_000)))
  const fixture = makeSessionQuery({ window: eventWindow({ events, targetSeq: 4, startSeq: 0, endSeq: 8 }) })
  const tool = createSessionReadTool(fixture.sessionQuery)
  const result = await tool.execute({ sessionId: 'session-1', seq: 4, before: 4, after: 4, includeOtherProjects: true })
  assert.equal(result.messages.length, 7)
  assert.ok(result.messages.every(message => message.text.length <= 1_200))
  assert.ok(result.messages.reduce((sum, message) => sum + message.text.length, 0) <= 8_000)
  assert.equal(result.truncated, true)
})

test('sanitizes Host errors and reports cancellation without calling full-log reads', async () => {
  const secret = 'secret-host-session-error'
  const failedFilter = makeSessionQuery({ filterError: secret })
  const filterTool = createSessionReadTool(failedFilter.sessionQuery)
  await assert.rejects(filterTool.execute(baseArgs, { agent: { id: 'current-agent' } }), error => {
    assert.match(error.message, /verify the requested session workspace/u)
    assert.equal(error.message.includes(secret), false)
    return true
  })

  const failedRead = makeSessionQuery({ readError: secret })
  const readTool = createSessionReadTool(failedRead.sessionQuery)
  await assert.rejects(readTool.execute({ ...baseArgs, includeOtherProjects: true }), error => {
    assert.match(error.message, /Could not read the requested DSH event window/u)
    assert.equal(error.message.includes(secret), false)
    return true
  })

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readTool.execute({ ...baseArgs, includeOtherProjects: true }, { signal: controller.signal }), /cancelled/u)

  const afterFilterController = new AbortController()
  const afterFilter = makeSessionQuery({ onFilter: () => afterFilterController.abort() })
  const afterFilterTool = createSessionReadTool(afterFilter.sessionQuery)
  await assert.rejects(afterFilterTool.execute(baseArgs, {
    agent: { id: 'current-agent' },
    signal: afterFilterController.signal,
  }), /cancelled/u)
  assert.equal(afterFilter.calls.reads.length, 0, 'do not read event content if scope verification resolves after cancellation')

  const afterReadController = new AbortController()
  const afterRead = makeSessionQuery({ onRead: () => afterReadController.abort() })
  const afterReadTool = createSessionReadTool(afterRead.sessionQuery)
  await assert.rejects(afterReadTool.execute({ ...baseArgs, includeOtherProjects: true }, {
    signal: afterReadController.signal,
  }), /cancelled/u)
  assert.equal(afterRead.calls.fullReads, 0)
})
