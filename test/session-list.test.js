import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionListTool, registerSessionListTool } from '../src/session-list.js'

const DAY = 24 * 60 * 60 * 1_000
const JAN_2 = Date.parse('2024-01-02T00:00:00.000Z')
const baseArgs = { limit: 1, fromDate: '2024-01-02', toDate: '2024-01-02' }

function sessionRecord(id, createdAt, cwd = '/workspace/project', fields = {}) {
  return {
    header: {
      version: 4,
      id,
      createdAt,
      ...(cwd !== undefined ? { cwd } : {}),
      isSeeded: fields.isSeeded ?? false,
      ...(fields.parentSession ? { parentSession: fields.parentSession } : {}),
    },
    live: fields.live ?? false,
    persisted: fields.persisted ?? true,
  }
}

function makeSessionQuery(options = {}) {
  const calls = { observations: [], filters: [], lists: [], fullReads: 0 }
  const records = [
    sessionRecord('session-new', JAN_2 + 12 * 60 * 60 * 1_000, '/workspace/project', {
      live: true, persisted: true, isSeeded: true, parentSession: 'parent-1',
    }),
    sessionRecord('session-old', JAN_2 + 60_000),
  ]
  const sessionQuery = {
    async observeSession(sessionId, request) {
      calls.observations.push({ sessionId, request, disposed: false })
      const cwd = Object.hasOwn(options, 'agentCwd') ? options.agentCwd : '/workspace/project'
      return {
        header: { id: sessionId, ...(cwd !== undefined ? { cwd } : {}) },
        [Symbol.dispose]() { calls.observations.at(-1).disposed = true },
      }
    },
    async filterSessions(filters, signal) {
      calls.filters.push({ filters, signal })
      options.onFilter?.()
      if (options.filterError) throw new Error(options.filterError)
      return options.filteredRecords ?? records
    },
    async listSessions(signal) {
      calls.lists.push(signal)
      options.onList?.()
      if (options.listError) throw new Error(options.listError)
      return options.listedRecords ?? records
    },
    async readSession() { calls.fullReads += 1 },
  }
  return { sessionQuery, calls, records }
}

test('requires exact list services and registers with a disposer', () => {
  assert.throws(() => createSessionListTool({ listSessions() {}, filterSessions() {} }), /requires DSH sessionQuery/u)
  const fixture = makeSessionQuery()
  const registered = new Map()
  const dispose = registerSessionListTool({ tools: { register: tool => { registered.set(tool.name, tool); return () => registered.delete(tool.name) } } }, fixture.sessionQuery)
  assert.ok(registered.has('session_list'))
  dispose()
  assert.equal(registered.has('session_list'), false)
  assert.equal(typeof registerSessionListTool({}, undefined), 'function')
})

test('defaults to current workspace, applies inclusive date filters, and caps metadata output', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionListTool(fixture.sessionQuery)
  const controller = new AbortController()
  const result = await tool.execute(baseArgs, { agent: { id: 'agent-1' }, signal: controller.signal })

  assert.deepEqual(fixture.calls.observations, [{
    sessionId: 'agent-1',
    request: { signal: controller.signal, projectionMode: 'none' },
    disposed: true,
  }])
  assert.deepEqual(fixture.calls.filters, [{
    filters: [
      { kind: 'cwd', values: ['/workspace/project'] },
      { kind: 'created-at', from: JAN_2, to: JAN_2 + DAY - 1 },
    ],
    signal: controller.signal,
  }])
  assert.deepEqual(fixture.calls.lists, [])
  assert.equal(result.scope, 'current-workspace')
  assert.equal(result.totalMatches, 2)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.results, [{
    sessionId: 'session-new',
    createdAt: JAN_2 + 12 * 60 * 60 * 1_000,
    live: true,
    persisted: true,
    isSeeded: true,
    cwd: '/workspace/project',
  }])
  assert.equal('parentSession' in result.results[0], false, 'do not disclose a parent session outside the selected workspace')
  const rendered = tool.output.render(baseArgs, result)[0].text
  assert.match(rendered, /did not project or return event text/u)
  assert.match(rendered, /additional matches omitted/u)
  assert.match(rendered, /no stable cursor/u)
  assert.equal(fixture.calls.fullReads, 0)
})

test('uses listSessions only for unfiltered global scope and accepts no current Agent there', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionListTool(fixture.sessionQuery)
  const signal = new AbortController().signal
  const result = await tool.execute({ includeOtherProjects: true }, { signal })
  assert.equal(result.scope, 'all-projects')
  assert.deepEqual(fixture.calls.lists, [signal])
  assert.deepEqual(fixture.calls.filters, [])
  assert.deepEqual(fixture.calls.observations, [])
})

test('uses only the created-at filter for date-bounded global listing', async () => {
  const fixture = makeSessionQuery({ filteredRecords: [sessionRecord('date-match', JAN_2 + 12 * 60 * 60 * 1_000)] })
  const tool = createSessionListTool(fixture.sessionQuery)
  const result = await tool.execute({
    includeOtherProjects: true,
    fromDate: '2024-01-02T12:00:00Z',
    toDate: '2024-01-02T12:00:00+00:00',
  })
  assert.deepEqual(fixture.calls.filters, [{
    filters: [{ kind: 'created-at', from: JAN_2 + 12 * 60 * 60 * 1_000, to: JAN_2 + 12 * 60 * 60 * 1_000 }],
    signal: undefined,
  }])
  assert.deepEqual(fixture.calls.lists, [])
  assert.equal(result.scope, 'all-projects')

  const preEpoch = makeSessionQuery({ filteredRecords: [] })
  const preEpochTool = createSessionListTool(preEpoch.sessionQuery)
  const beforeEpochResult = await preEpochTool.execute({ includeOtherProjects: true, fromDate: '1969-12-31' })
  assert.equal(beforeEpochResult.totalMatches, 0)
  assert.deepEqual(preEpoch.calls.filters, [{
    filters: [{ kind: 'created-at', from: Date.parse('1969-12-31T00:00:00.000Z') }],
    signal: undefined,
  }])
})

test('rejects invalid date bounds, limits, scope flags, and missing current Agent before listing', async () => {
  const fixture = makeSessionQuery()
  const tool = createSessionListTool(fixture.sessionQuery)
  const invalid = [
    { fromDate: '2024-02-30' },
    { toDate: '2024-01-02T12:00:00' },
    { fromDate: '2024-01-03', toDate: '2024-01-02' },
    { limit: 0 },
    { limit: 26 },
    { includeOtherProjects: 'true' },
  ]
  for (const args of invalid) await assert.rejects(tool.execute(args, { agent: { id: 'agent-1' } }))
  await assert.rejects(tool.execute({}, { agent: undefined }), /current Agent/u)
  const noCwd = makeSessionQuery({ agentCwd: undefined })
  const noCwdTool = createSessionListTool(noCwd.sessionQuery)
  await assert.rejects(noCwdTool.execute({}, { agent: { id: 'agent-1' } }), /no workspace cwd/u)
  assert.equal(noCwd.calls.observations[0].disposed, true)
  assert.deepEqual(noCwd.calls.filters, [])
  assert.deepEqual(fixture.calls.observations, [])
  assert.deepEqual(fixture.calls.filters, [])
  assert.deepEqual(fixture.calls.lists, [])
})

test('fails closed when the filtered result escapes cwd or date scope', async () => {
  const outsideCwd = makeSessionQuery({ filteredRecords: [sessionRecord('inside', JAN_2), sessionRecord('outside', JAN_2, '/elsewhere')] })
  const tool = createSessionListTool(outsideCwd.sessionQuery)
  await assert.rejects(tool.execute(baseArgs, { agent: { id: 'agent-1' } }), /outside the current workspace/u)

  const outsideDate = makeSessionQuery({ filteredRecords: [sessionRecord('inside-date', JAN_2), sessionRecord('outside-date', JAN_2 - 1)] })
  const dateTool = createSessionListTool(outsideDate.sessionQuery)
  await assert.rejects(dateTool.execute(baseArgs, { agent: { id: 'agent-1' } }), /outside the requested date range/u)
})

test('rejects malformed and overlarge service results without reading event logs', async () => {
  const malformed = makeSessionQuery({ filteredRecords: [sessionRecord('bad', Number.NaN)] })
  const malformedTool = createSessionListTool(malformed.sessionQuery)
  await assert.rejects(malformedTool.execute({}, { agent: { id: 'agent-1' } }), /invalid session metadata/u)

  const large = makeSessionQuery({ listedRecords: new Array(20_001).fill(sessionRecord('too-many', JAN_2)) })
  const largeTool = createSessionListTool(large.sessionQuery)
  await assert.rejects(largeTool.execute({ includeOtherProjects: true }), /too-large session list/u)
  assert.equal(large.calls.fullReads, 0)

  const longPath = makeSessionQuery({ listedRecords: [sessionRecord('long-path', JAN_2, `/workspace/${'x'.repeat(600)}`)] })
  const longPathTool = createSessionListTool(longPath.sessionQuery)
  const boundedPath = await longPathTool.execute({ includeOtherProjects: true })
  assert.equal(boundedPath.results[0].cwd.length, 512)
  assert.equal(boundedPath.results[0].cwdTruncated, true)
})

test('reports cancellation when list/filter services resolve after the signal aborts', async () => {
  const afterFilterController = new AbortController()
  const afterFilter = makeSessionQuery({ onFilter: () => afterFilterController.abort() })
  const filterTool = createSessionListTool(afterFilter.sessionQuery)
  await assert.rejects(filterTool.execute({}, { agent: { id: 'agent-1' }, signal: afterFilterController.signal }), /cancelled/u)

  const afterListController = new AbortController()
  const afterList = makeSessionQuery({ onList: () => afterListController.abort() })
  const listTool = createSessionListTool(afterList.sessionQuery)
  await assert.rejects(listTool.execute({ includeOtherProjects: true }, { signal: afterListController.signal }), /cancelled/u)
})

test('sanitizes Host failures and fails closed when cwd observation cannot be released', async () => {
  const failed = makeSessionQuery({ filterError: 'sensitive host error' })
  const failedTool = createSessionListTool(failed.sessionQuery)
  await assert.rejects(failedTool.execute({}, { agent: { id: 'agent-1' } }), /service error/u)
  assert.equal(failed.calls.filters.length, 1)

  const failedDispose = makeSessionQuery()
  failedDispose.sessionQuery.observeSession = async sessionId => ({
    header: { id: sessionId, cwd: '/workspace/project' },
    [Symbol.dispose]() { throw new Error('private dispose detail') },
  })
  const disposeTool = createSessionListTool(failedDispose.sessionQuery)
  await assert.rejects(disposeTool.execute({}, { agent: { id: 'agent-1' } }), /no query was run/u)
  assert.deepEqual(failedDispose.calls.filters, [])
})
