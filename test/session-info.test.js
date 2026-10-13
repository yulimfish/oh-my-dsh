import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionInfoTool, registerSessionInfoTool } from '../src/session-info.js'

const CWD = '/workspace/project'
const CREATED_AT = 1_710_000_000_000
const UPDATED_AT = CREATED_AT + 100

function header(id, cwd = CWD, createdAt = CREATED_AT) {
  return { version: 4, id, createdAt, cwd, isSeeded: false }
}

function titleSnapshot(overrides = {}) {
  return {
    title: 'A useful session title',
    messageSeqs: [1, 4, 8],
    source: { kind: 'provider', provider: 'private-provider', model: { provider: 'private-route', model: 'private-model' } },
    eventSeq: 10,
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

function makeSessionQuery(options = {}) {
  const calls = { observations: [], filters: [], titleReads: [], fullReads: 0, eventLists: 0 }
  const currentCwd = Object.hasOwn(options, 'currentCwd') ? options.currentCwd : CWD
  const sessionQuery = {
    observeSession: async (sessionId, request) => {
      calls.observations.push({ sessionId, request, disposed: false })
      return {
        header: { id: sessionId, ...(currentCwd !== undefined ? { cwd: currentCwd } : {}) },
        [Symbol.dispose]() { calls.observations.at(-1).disposed = true }
      }
    },
    filterSessions: async (filters, signal) => {
      calls.filters.push({ filters, signal })
      if (options.onFilter) options.onFilter()
      if (options.filterError) throw new Error(options.filterError)
      return options.records ?? [{ header: header('session-1'), live: true, persisted: true }]
    },
    readTitleSnapshot: async (sessionId, signal) => {
      calls.titleReads.push({ sessionId, signal })
      if (options.onTitleRead) options.onTitleRead()
      if (options.titleError) throw new Error(options.titleError)
      return options.titleObservation ?? {
        session: header(sessionId),
        title: titleSnapshot(),
      }
    },
    readSession: async () => { calls.fullReads += 1; throw new Error('full logs are not exposed') },
    listEvents: async () => { calls.eventLists += 1; throw new Error('event lists are not exposed') },
  }
  return { sessionQuery, calls }
}

const baseArgs = { sessionId: 'session-1' }

test('requires exact services and registers with a disposer', () => {
  assert.throws(() => createSessionInfoTool({}), /readTitleSnapshot/u)
  assert.equal(registerSessionInfoTool({}, undefined) instanceof Function, true)

  const { sessionQuery } = makeSessionQuery()
  const tools = new Map()
  const dispose = registerSessionInfoTool({
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }, sessionQuery)
  assert.ok(tools.has('session_info'))
  dispose()
  assert.equal(tools.has('session_info'), false)
})

test('defaults to current workspace and returns only bounded allowlisted title metadata', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionInfoTool(fixture.sessionQuery)
  const controller = new AbortController()
  const result = await tool.execute(baseArgs, { agent: { id: 'agent-current' }, signal: controller.signal })

  assert.deepEqual(fixture.calls.filters, [{
    filters: [{ kind: 'id', values: ['session-1'] }, { kind: 'cwd', values: [CWD] }],
    signal: controller.signal,
  }])
  assert.equal(fixture.calls.observations[0].request.projectionMode, 'none')
  assert.equal(fixture.calls.observations[0].disposed, true)
  assert.deepEqual(fixture.calls.titleReads, [{ sessionId: 'session-1', signal: controller.signal }])
  assert.deepEqual(result, {
    sessionId: 'session-1',
    scope: 'current-workspace',
    createdAt: CREATED_AT,
    live: true,
    persisted: true,
    isSeeded: false,
    cwd: CWD,
    hasTitle: true,
    title: 'A useful session title',
    titleSource: 'provider',
    titleEventSeq: 10,
    titleUpdatedAt: UPDATED_AT,
    titleTruncated: false,
  })
  assert.equal(JSON.stringify(result).includes('private-provider'), false)
  assert.equal(JSON.stringify(result).includes('private-model'), false)
  assert.equal(JSON.stringify(result).includes('messageSeqs'), false)
  assert.match(tool.output.render(baseArgs, result)[0].text, /entire target session log on every call/u)
  assert.equal(fixture.calls.fullReads, 0)
  assert.equal(fixture.calls.eventLists, 0)
})

test('treats a missing title as normal and permits explicit global lookup without a current Agent', async () => {
  const fixture = makeSessionQuery({ titleObservation: { session: header('session-1') } })
  const tool = createSessionInfoTool(fixture.sessionQuery)
  const result = await tool.execute({ ...baseArgs, includeOtherProjects: true })
  assert.equal(result.scope, 'all-projects')
  assert.equal(result.hasTitle, false)
  assert.equal('title' in result, false)
  assert.equal('titleSource' in result, false)
  assert.deepEqual(fixture.calls.filters, [{
    filters: [{ kind: 'id', values: ['session-1'] }],
    signal: undefined,
  }])
  assert.deepEqual(fixture.calls.observations, [])
  assert.equal(fixture.calls.titleReads.length, 1)
})

test('fails closed for missing cwd or absent session before title reads', async () => {
  const noCwd = makeSessionQuery({ currentCwd: undefined })
  const noCwdTool = createSessionInfoTool(noCwd.sessionQuery)
  await assert.rejects(noCwdTool.execute(baseArgs, { agent: { id: 'agent-current' } }), /no workspace cwd/u)
  assert.equal(noCwd.calls.observations[0].disposed, true)
  assert.deepEqual(noCwd.calls.filters, [])
  assert.deepEqual(noCwd.calls.titleReads, [])

  const missing = makeSessionQuery({ records: [] })
  const missingTool = createSessionInfoTool(missing.sessionQuery)
  await assert.rejects(missingTool.execute(baseArgs, { agent: { id: 'agent-current' } }), /not found in the current workspace/u)
  assert.deepEqual(missing.calls.titleReads, [])
})

test('validates scope after the separate title read', async () => {
  const wrongId = makeSessionQuery({ titleObservation: { session: header('other-session'), title: titleSnapshot() } })
  const wrongIdTool = createSessionInfoTool(wrongId.sessionQuery)
  await assert.rejects(wrongIdTool.execute(baseArgs, { agent: { id: 'agent-current' } }), /invalid session info metadata/u)

  const wrongCwd = makeSessionQuery({ titleObservation: { session: header('session-1', '/elsewhere'), title: titleSnapshot() } })
  const wrongCwdTool = createSessionInfoTool(wrongCwd.sessionQuery)
  await assert.rejects(wrongCwdTool.execute(baseArgs, { agent: { id: 'agent-current' } }), /outside the current workspace/u)

  const changedHeader = makeSessionQuery({
    titleObservation: { session: header('session-1', CWD, CREATED_AT + 1), title: titleSnapshot() },
  })
  const changedHeaderTool = createSessionInfoTool(changedHeader.sessionQuery)
  await assert.rejects(changedHeaderTool.execute(baseArgs, { agent: { id: 'agent-current' } }), /outside the verified metadata scope/u)
})

test('bounds and sanitizes title text while omitting malformed/private title fields', async () => {
  const longTitle = 'x'.repeat(500)
  const fixture = makeSessionQuery({ titleObservation: {
    session: header('session-1'),
    title: titleSnapshot({ title: `${'x'.repeat(20)}\u202e\u0000${longTitle}` }),
  } })
  const tool = createSessionInfoTool(fixture.sessionQuery)
  const result = await tool.execute(baseArgs, { agent: { id: 'agent-current' } })
  assert.equal(result.title.length, 400)
  assert.equal(result.title.endsWith('…'), true)
  assert.equal(result.titleTruncated, true)
  assert.equal(result.title.includes('\u0000'), false)
  assert.equal(result.title.includes('\u202e'), false)
  assert.equal(JSON.stringify(result).includes('messageSeqs'), false)
  assert.equal(JSON.stringify(result).includes('private-route'), false)

  const malformed = makeSessionQuery({ titleObservation: {
    session: header('session-1'),
    title: titleSnapshot({ source: { kind: 'unexpected' } }),
  } })
  const malformedTool = createSessionInfoTool(malformed.sessionQuery)
  await assert.rejects(malformedTool.execute(baseArgs, { agent: { id: 'agent-current' } }), /invalid session title metadata/u)
})

test('forwards cancellation and rejects results that resolve after abort', async () => {
  const afterFilterController = new AbortController()
  const afterFilter = makeSessionQuery({ onFilter: () => afterFilterController.abort() })
  const afterFilterTool = createSessionInfoTool(afterFilter.sessionQuery)
  await assert.rejects(afterFilterTool.execute(baseArgs, { agent: { id: 'agent-current' }, signal: afterFilterController.signal }), /cancelled/u)
  assert.deepEqual(afterFilter.calls.titleReads, [])

  const afterTitleController = new AbortController()
  const afterTitle = makeSessionQuery({ onTitleRead: () => afterTitleController.abort() })
  const afterTitleTool = createSessionInfoTool(afterTitle.sessionQuery)
  await assert.rejects(afterTitleTool.execute(baseArgs, { agent: { id: 'agent-current' }, signal: afterTitleController.signal }), /cancelled/u)
})

test('sanitizes service errors and validates user arguments before host calls', async () => {
  const fixture = makeSessionQuery({ titleError: 'private host failure' })
  const tool = createSessionInfoTool(fixture.sessionQuery)
  await assert.rejects(tool.execute(baseArgs, { agent: { id: 'agent-current' } }), error => {
    assert.match(error.message, /Could not read the requested session title metadata/u)
    assert.equal(error.message.includes('private host failure'), false)
    return true
  })

  const invalid = makeSessionQuery()
  const invalidTool = createSessionInfoTool(invalid.sessionQuery)
  await assert.rejects(invalidTool.execute({ sessionId: '' }, { agent: { id: 'agent-current' } }), /sessionId/u)
  await assert.rejects(invalidTool.execute({ ...baseArgs, includeOtherProjects: 'yes' }, { agent: { id: 'agent-current' } }), /includeOtherProjects/u)
  assert.deepEqual(invalid.calls.observations, [])
  assert.deepEqual(invalid.calls.filters, [])
  assert.deepEqual(invalid.calls.titleReads, [])
})
