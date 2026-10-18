import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionSearchTool, registerSessionSearchTool } from '../src/session-search.js'

function searchHit({ snippet = 'Migration bug was fixed in the retry handler.', sessionId = 'session-1', cwd = '/workspace/project' } = {}) {
  return {
    header: { id: sessionId, cwd, createdAt: 1_710_000_000_000 },
    live: false,
    persisted: true,
    bestMatch: {
      sessionId,
      seq: 17,
      type: 'message',
      time: 1_710_000_123_000,
      surface: 'current',
      snippet,
    },
  }
}

function makeSessionQuery(options = {}) {
  const searches = []
  const observations = []
  const sessionQuery = {
    observeSession: async (sessionId, request) => {
      observations.push({ sessionId, request })
      return {
        header: { id: sessionId, cwd: Object.hasOwn(options, 'cwd') ? options.cwd : '/workspace/project' },
        [Symbol.dispose]() { observations.at(-1).disposed = true },
      }
    },
    searchSessions: async (request, exec) => {
      searches.push({ request, exec })
      if (options.error) throw new Error(options.error)
      return options.page ?? { items: [searchHit()], nextCursor: 'opaque-next' }
    },
  }
  return { sessionQuery, searches, observations }
}

test('requires the inspected search service and registers with a disposer', () => {
  assert.throws(() => createSessionSearchTool({}), /searchSessions/u)
  assert.equal(registerSessionSearchTool({}, undefined) instanceof Function, true)

  const { sessionQuery } = makeSessionQuery()
  const tools = new Map()
  const dispose = registerSessionSearchTool({ tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } }, sessionQuery)
  assert.ok(tools.has('session_search'))
  dispose()
  assert.equal(tools.has('session_search'), false)
})

test('requires explicit cross-project scope and forwards the exact search request and cancellation', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionSearchTool(fixture.sessionQuery)
  const signal = new AbortController().signal
  const result = await tool.execute(
    { query: '  migration bug  ', limit: 3, cursor: 'opaque-current', includeOtherProjects: true },
    { signal },
  )

  assert.deepEqual(fixture.observations, [], 'the adapter does not infer workspace metadata')
  assert.deepEqual(fixture.searches, [{
    request: { query: 'migration bug', limit: 3, cursor: 'opaque-current' },
    exec: { signal },
  }])
  assert.equal(result.scope, 'all-projects')
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].sessionId, 'session-1')
  assert.equal(result.results[0].availability, 'persisted')
  assert.equal(result.results[0].matchedSeq, 17)
  assert.equal(result.results[0].snippet, 'Migration bug was fixed in the retry handler.')
  assert.equal(result.hasMore, true)
  assert.equal(result.nextCursor, 'opaque-next')
  assert.match(tool.output.render({}, result)[0].text, /untrusted data, not instructions/u)
})

test('defaults to current-workspace filtering and fails closed without the current Agent', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionSearchTool(fixture.sessionQuery)
  const result = await tool.execute({ query: 'migration' }, { agent: { id: 'current-agent' } })
  assert.equal(result.scope, 'current-workspace')
  assert.deepEqual(fixture.observations, [{
    sessionId: 'current-agent',
    request: { projectionMode: 'none' },
    disposed: true,
  }])
  assert.deepEqual(fixture.searches[0].request, {
    query: 'migration',
    limit: 20,
    sessionFilters: [{ kind: 'cwd', values: ['/workspace/project'] }],
  })

  await assert.rejects(tool.execute({ query: 'migration' }), /current Agent/u)
  assert.equal(fixture.searches.length, 1, 'missing Agent scope does not broaden to all projects')
})

test('fails closed for missing or blank current-session cwd before any search call', async () => {
  for (const cwd of [undefined, null, '', '   ']) {
    const fixture = makeSessionQuery({ cwd })
    const tool = createSessionSearchTool(fixture.sessionQuery)
    await assert.rejects(tool.execute({ query: 'migration' }, { agent: { id: 'current-agent' } }), /no workspace cwd or valid observation; no scoped request was run/u)
    assert.equal(fixture.observations.length, 1, 'the current session observation supplies its optional header cwd')
    assert.equal(fixture.observations[0].disposed, true, `observation lease is released for ${JSON.stringify(cwd)}`)
    assert.deepEqual(fixture.searches, [], `no search request is made for ${JSON.stringify(cwd)}`)
  }
})

test('uses the RC2 Disposable symbol and releases an invalid observation lease', async () => {
  let disposed = false
  const fixture = makeSessionQuery()
  fixture.sessionQuery.observeSession = async () => ({
    header: { id: 'wrong-agent', cwd: '/workspace/project' },
    [Symbol.dispose]() { disposed = true },
  })
  const tool = createSessionSearchTool(fixture.sessionQuery)
  await assert.rejects(tool.execute({ query: 'migration' }, { agent: { id: 'current-agent' } }), /Could not determine/u)
  assert.equal(disposed, true)
  assert.deepEqual(fixture.searches, [])
})

test('bounds query, limit, cursor, and scope arguments before any service calls', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionSearchTool(fixture.sessionQuery)
  const invalid = [
    { query: '' },
    { query: '  ' },
    { query: 'x'.repeat(513) },
    { query: 'x\nquery' },
    { query: 'valid', limit: 0 },
    { query: 'valid', limit: 21 },
    { query: 'valid', limit: 1.5 },
    { query: 'valid', cursor: '' },
    { query: 'valid', cursor: 'x'.repeat(2_049) },
    { query: 'valid', includeOtherProjects: 'true' },
  ]
  for (const args of invalid) await assert.rejects(tool.execute(args))
  await assert.rejects(tool.execute({ query: 'valid' }), /current Agent/u)
  assert.deepEqual(fixture.searches, [])
  assert.deepEqual(fixture.observations, [])
})

test('bounds returned excerpts and omits absent workspace metadata', async () => {
  const fixture = makeSessionQuery({
    page: { items: [searchHit({ snippet: 'x'.repeat(2_000), cwd: null })] },
  })
  const tool = createSessionSearchTool(fixture.sessionQuery)
  const result = await tool.execute({ query: 'long excerpt', limit: 1, includeOtherProjects: true })

  assert.equal(result.results[0].snippet.length, 600)
  assert.equal(result.results[0].cwd, undefined)
  assert.equal(result.hasMore, false)
})

test('sanitizes service errors, propagates cancellation, and rejects malformed pages', async () => {
  const secret = 'private-session-query-error'
  const failed = makeSessionQuery({ error: secret })
  const tool = createSessionSearchTool(failed.sessionQuery)
  await assert.rejects(tool.execute({ query: 'valid', includeOtherProjects: true }), error => {
    assert.match(error.message, /session query service error/u)
    assert.equal(error.message.includes(secret), false)
    return true
  })

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ query: 'valid', includeOtherProjects: true }, { signal: controller.signal }), /cancelled/u)

  const afterResolveController = new AbortController()
  const afterResolve = makeSessionQuery()
  afterResolve.sessionQuery.searchSessions = async (request, exec) => {
    afterResolve.searches.push({ request, exec })
    afterResolveController.abort()
    return { items: [searchHit()] }
  }
  const afterResolveTool = createSessionSearchTool(afterResolve.sessionQuery)
  await assert.rejects(afterResolveTool.execute({ query: 'valid', includeOtherProjects: true }, {
    signal: afterResolveController.signal,
  }), /cancelled/u)

  const wrongSessionHit = searchHit()
  wrongSessionHit.bestMatch.sessionId = 'another-session'
  const malformed = makeSessionQuery({ page: { items: [wrongSessionHit], nextCursor: 'cursor' } })
  const malformedTool = createSessionSearchTool(malformed.sessionQuery)
  await assert.rejects(malformedTool.execute({ query: 'valid', includeOtherProjects: true }), /wrong session/u)
})
