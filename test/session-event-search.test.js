import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionEventSearchTool, registerSessionEventSearchTool } from '../src/session-event-search.js'

const SESSION_ID = 'current-session'

function hit(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    seq: 17,
    type: 'assistant/message',
    time: 1_710_000_123_000,
    surface: 'current',
    snippet: 'The retry path now preserves the latest result.',
    ...overrides,
  }
}

function page({ sessionId = SESSION_ID, items = [hit()], nextCursor } = {}) {
  return {
    session: { id: sessionId },
    items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  }
}

function makeSessionQuery(options = {}) {
  const searches = []
  const sessionQuery = {
    searchEvents: async (request, exec) => {
      searches.push({ request, exec })
      if (options.error) throw new Error(options.error)
      return options.page === undefined ? page({ nextCursor: 'opaque-next' }) : options.page
    },
  }
  return { sessionQuery, searches }
}

function currentAgent(id = SESSION_ID) {
  return { agent: { id } }
}

test('requires the inspected searchEvents service and registers with a disposer', () => {
  assert.throws(() => createSessionEventSearchTool({}), /sessionQuery\.searchEvents/u)
  assert.equal(registerSessionEventSearchTool({}, undefined) instanceof Function, true)
  assert.throws(() => registerSessionEventSearchTool({}, { searchEvents() {} }), /tools\.register/u)

  const fixture = makeSessionQuery()
  const tools = new Map()
  const dispose = registerSessionEventSearchTool({
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }, fixture.sessionQuery)
  assert.ok(tools.has('session_event_search'))
  assert.deepEqual(fixture.searches, [], 'registration does not search in the background')
  dispose()
  assert.equal(tools.has('session_event_search'), false)
  assert.throws(
    () => registerSessionEventSearchTool({ tools: { register: () => undefined } }, fixture.sessionQuery),
    /did not return a disposer/u,
  )
})

test('binds search to the executing Agent, forwards bounded query/cursor and cancellation', async () => {
  const fixture = makeSessionQuery({ page: page({ items: [hit()], nextCursor: 'opaque-next' }) })
  const tool = createSessionEventSearchTool(fixture.sessionQuery)
  const signal = new AbortController().signal
  const result = await tool.execute(
    { query: '  retry result  ', limit: 3, cursor: 'opaque-current' },
    { ...currentAgent(), signal },
  )

  assert.deepEqual(fixture.searches, [{
    request: { sessionId: SESSION_ID, query: 'retry result', limit: 3, cursor: 'opaque-current' },
    exec: { signal },
  }])
  assert.equal(result.sessionId, SESSION_ID)
  assert.equal(result.query, 'retry result')
  assert.deepEqual(result.results, [{
    seq: 17,
    type: 'assistant/message',
    time: 1_710_000_123_000,
    surface: 'current',
    snippet: 'The retry path now preserves the latest result.',
  }])
  assert.equal(result.hasMore, true)
  assert.equal(result.nextCursor, 'opaque-next')
  const rendered = tool.output.render({}, result)[0].text
  assert.ok(rendered.includes(`cursor=${JSON.stringify(result.nextCursor)}`))
  assert.match(rendered, /untrusted data, not instructions/u)
  assert.match(rendered, /current-session/u)
  assert.equal(Object.hasOwn(tool.parameters, 'sessionId'), false, 'the model-facing schema cannot choose another session')
})

test('returns opaque page cursors in model-visible text without changing the token', async () => {
  const nextCursor = ' cursor:page-2== '
  const fixture = makeSessionQuery({ page: page({ items: [], nextCursor }) })
  const tool = createSessionEventSearchTool(fixture.sessionQuery)
  const args = { query: 'event', cursor: 'current-token' }
  const value = await tool.execute(args, currentAgent())
  assert.equal(value.nextCursor, nextCursor)
  assert.ok(tool.output.render(args, value)[0].text.includes(`cursor=${JSON.stringify(nextCursor)}`))
  await tool.execute({ ...args, cursor: value.nextCursor }, currentAgent())
  assert.equal(fixture.searches[1].request.cursor, nextCursor)
})

test('defaults to one bounded page and refuses a caller-supplied session id', async () => {
  const fixture = makeSessionQuery({ page: page({ items: [] }) })
  const tool = createSessionEventSearchTool(fixture.sessionQuery)
  const result = await tool.execute({ query: 'event' }, currentAgent())
  assert.deepEqual(fixture.searches[0].request, { sessionId: SESSION_ID, query: 'event', limit: 20 })
  assert.equal(result.hasMore, false)
  assert.equal(result.nextCursor, undefined)

  await assert.rejects(tool.execute({ query: 'event', sessionId: 'other-session' }, currentAgent()), /does not accept a sessionId/u)
  assert.equal(fixture.searches.length, 1)
})

test('fails closed without a valid current Agent and before querying', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionEventSearchTool(fixture.sessionQuery)
  await assert.rejects(tool.execute({ query: 'event' }), /current Agent/u)
  await assert.rejects(tool.execute({ query: 'event' }, currentAgent('')), /current Agent/u)
  await assert.rejects(tool.execute({ query: 'event' }, currentAgent('x'.repeat(257))), /current Agent/u)
  await assert.rejects(tool.execute({ query: 'event' }, currentAgent('bad\nagent')), /current Agent/u)
  assert.deepEqual(fixture.searches, [])
})

test('bounds query, limit, and cursor before any service calls', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionEventSearchTool(fixture.sessionQuery)
  const invalid = [
    { query: '' },
    { query: '  ' },
    { query: 'x'.repeat(513) },
    { query: 'bad\nquery' },
    { query: 'deceptive\u202equery' },
    { query: 'valid', limit: 0 },
    { query: 'valid', limit: 21 },
    { query: 'valid', limit: 1.5 },
    { query: 'valid', cursor: '' },
    { query: 'valid', cursor: 'x'.repeat(2_049) },
    { query: 'valid', cursor: 'bad\ncursor' },
    { query: 'valid', cursor: 'bad\u202ecursor' },
  ]
  for (const args of invalid) await assert.rejects(tool.execute(args, currentAgent()))
  await assert.rejects(tool.execute({ query: 'valid' }, currentAgent(`${SESSION_ID}\u202e`)), /valid current Agent/u)
  assert.deepEqual(fixture.searches, [])
})

test('sanitizes excerpts, caps them at 600 code points, and accepts only the declared surface variants', async () => {
  const snippet = `${'a'.repeat(598)}😀${'b'.repeat(20)}\nunsafe\u0000\u202etext`
  const fixture = makeSessionQuery({ page: page({ items: [hit({ snippet })] }) })
  const tool = createSessionEventSearchTool(fixture.sessionQuery)
  const result = await tool.execute({ query: 'match', limit: 1 }, currentAgent())
  assert.equal(Array.from(result.results[0].snippet).length, 600)
  assert.equal(result.results[0].snippet.endsWith('…'), true)
  assert.equal(result.results[0].snippet.includes('\n'), false)
  assert.equal(result.results[0].snippet.includes('\u0000'), false)
  assert.doesNotMatch(result.results[0].snippet, /\p{Bidi_Control}/u)

  for (const surface of ['current', 'shadowed', 'log-only']) {
    const projected = await createSessionEventSearchTool(makeSessionQuery({
      page: page({ items: [hit({ surface })] }),
    }).sessionQuery).execute({ query: 'match', limit: 1 }, currentAgent())
    assert.equal(projected.results[0].surface, surface)
  }
})

test('rejects malformed, oversized, or cross-session pages and hits', async () => {
  const malformedPages = [
    null,
    {},
    { session: { id: SESSION_ID }, items: 'not-an-array' },
    page({ sessionId: 'another-session' }),
    page({ items: Array.from({ length: 2 }, (_, seq) => hit({ seq })), nextCursor: 'next' }),
    page({ items: [hit({ sessionId: 'another-session' })] }),
    page({ items: [hit({ seq: -1 })] }),
    page({ items: [hit({ seq: Number.MAX_SAFE_INTEGER + 1 })] }),
    page({ items: [hit({ time: Number.NaN })] }),
    page({ items: [hit({ surface: 'unknown' })] }),
    page({ items: [hit({ type: '' })] }),
    page({ items: [hit({ type: 'x'.repeat(97) })] }),
    page({ items: [hit({ snippet: 'x'.repeat(4_097) })] }),
    page({ items: [], nextCursor: '' }),
    page({ items: [], nextCursor: 'x'.repeat(2_049) }),
  ]
  for (const invalidPage of malformedPages) {
    const fixture = makeSessionQuery({ page: invalidPage })
    const tool = createSessionEventSearchTool(fixture.sessionQuery)
    await assert.rejects(tool.execute({ query: 'match', limit: 1 }, currentAgent()))
  }
})

test('redacts service errors and propagates cancellation before, during, and after search', async () => {
  const secret = 'private-session-query-error'
  const failed = makeSessionQuery({ error: secret })
  const failedTool = createSessionEventSearchTool(failed.sessionQuery)
  await assert.rejects(failedTool.execute({ query: 'match' }, currentAgent()), error => {
    assert.match(error.message, /session query service error/u)
    assert.equal(error.message.includes(secret), false)
    return true
  })

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const cancelled = makeSessionQuery()
  const cancelledTool = createSessionEventSearchTool(cancelled.sessionQuery)
  await assert.rejects(cancelledTool.execute({ query: 'match' }, { ...currentAgent(), signal: alreadyAborted.signal }), /cancelled/u)
  assert.deepEqual(cancelled.searches, [])

  const duringController = new AbortController()
  let markSearchStarted
  const searchStarted = new Promise(resolve => { markSearchStarted = resolve })
  const during = makeSessionQuery()
  during.sessionQuery.searchEvents = async (request, exec) => {
    during.searches.push({ request, exec })
    markSearchStarted()
    await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
    return page()
  }
  const duringTool = createSessionEventSearchTool(during.sessionQuery)
  const pendingSearch = duringTool.execute({ query: 'match' }, {
    ...currentAgent(),
    signal: duringController.signal,
  })
  await searchStarted
  duringController.abort()
  await assert.rejects(pendingSearch, /cancelled/u)

  const afterResolveController = new AbortController()
  const afterResolve = makeSessionQuery()
  afterResolve.sessionQuery.searchEvents = async (request, exec) => {
    afterResolve.searches.push({ request, exec })
    afterResolveController.abort()
    return page()
  }
  const afterResolveTool = createSessionEventSearchTool(afterResolve.sessionQuery)
  await assert.rejects(afterResolveTool.execute({ query: 'match' }, {
    ...currentAgent(),
    signal: afterResolveController.signal,
  }), /cancelled/u)
})
