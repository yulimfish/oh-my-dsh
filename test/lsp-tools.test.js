import assert from 'node:assert/strict'
import test from 'node:test'
import { createLspNavigationTools, registerLspNavigationTools } from '../src/lsp-tools.js'

function target(path) {
  return { key: path, path }
}

function makeFs(options = {}) {
  const calls = []
  const fs = {
    async resolve(path, opts) {
      calls.push({ method: 'resolve', path, opts })
      const root = opts?.cwd ?? '/workspace/project'
      const resolved = path.startsWith('/') ? path : `${root}/${path}`
      return target(options.aliases?.[resolved] ?? resolved)
    },
    contains(root, child) {
      calls.push({ method: 'contains', root, child })
      return child.path === root.path || child.path.startsWith(`${root.path}/`)
    },
    processPath(value) {
      calls.push({ method: 'processPath', value })
      return value.path
    },
  }
  return { fs, calls }
}

function makeFixture(options = {}) {
  const queries = []
  const gets = []
  const sessions = {
    get(id) {
      gets.push(id)
      if (options.session === null) return undefined
      return options.session ?? { header: { id, cwd: options.cwd ?? '/workspace/project' } }
    },
  }
  const service = {
    async query(request, signal) {
      queries.push({ request, signal })
      if (options.query) return options.query(request, signal)
      return {
        kind: 'locations',
        resolvedWorkspaceUri: 'file:///workspace/project',
        locations: [{
          uri: 'file:///workspace/project/src/target.js',
          range: { start: { line: 12, character: 3 }, end: { line: 12, character: 9 } },
        }],
      }
    },
  }
  const filesystem = makeFs(options)
  const tools = new Map()
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }
  return { service, sessions, filesystem, tools, ctx, queries, gets }
}

function getTool(fixture, name = 'lsp_goto_definition') {
  return createLspNavigationTools(fixture.service, fixture.sessions, fixture.filesystem.fs)
    .find(tool => tool.name === name)
}

function execution(id = 'session-1', signal) {
  return { agent: { id }, ...(signal ? { signal } : {}) }
}

function input(overrides = {}) {
  return { filePath: 'src/main.js', line: 8, character: 4, ...overrides }
}

test('requires exact DSH service methods and exposes only the two upstream read-only navigation aliases', () => {
  assert.throws(() => createLspNavigationTools({}, {}, {}), /lsp\.query/u)
  assert.throws(() => createLspNavigationTools({ query() {} }, {}, {}), /sessions\.get/u)
  assert.throws(() => createLspNavigationTools({ query() {} }, { get() {} }, {}), /fs\.resolve/u)

  const fixture = makeFixture()
  const tools = createLspNavigationTools(fixture.service, fixture.sessions, fixture.filesystem.fs)
  assert.deepEqual(tools.map(tool => tool.name), ['lsp_goto_definition', 'lsp_find_references'])
  assert.equal(tools[0].parameters.properties.line.type, 'integer')
  assert.match(tools[0].parameters.properties.line.description, /1-based/u)
  assert.match(tools[1].parameters.properties.includeDeclaration.description, /false cannot be honored/u)
  assert.equal(tools[0].timeoutMs, 20_000)
})

test('uses current Agent cwd, canonical filesystem paths, 1-based source lines, and forwards cancellation', async () => {
  const fixture = makeFixture()
  const signal = new AbortController().signal
  const result = await getTool(fixture).execute(input(), execution('session-1', signal))

  assert.deepEqual(fixture.gets, ['session-1'])
  assert.deepEqual(fixture.queries, [{
    request: {
      operation: 'goToDefinition',
      filePath: '/workspace/project/src/main.js',
      position: { line: 7, character: 4 },
      workspaceRoot: '/workspace/project',
    },
    signal,
  }])
  assert.equal(result.operation, 'goToDefinition')
  assert.equal(result.totalLocations, 1)
  assert.equal(result.locations[0].uri, 'file:///workspace/project/src/target.js')
  assert.equal(result.locations[0].range.start.line, 12)
  const rendered = getTool(fixture).output.render({}, result)[0].text
  assert.match(rendered, /goToDefinition returned 1 location/u)
  assert.match(rendered, /`"file:\/\/\/workspace\/project\/src\/target\.js"`/u)
  assert.match(rendered, /not an authorization boundary/u)
})

test('findReferences leaves inclusion provider-defined and rejects unsupported exclusion before Host calls', async () => {
  const fixture = makeFixture()
  const tool = getTool(fixture, 'lsp_find_references')
  const result = await tool.execute(input(), execution())
  assert.equal(result.operation, 'findReferences')
  assert.equal(fixture.queries.length, 1)
  assert.deepEqual(fixture.queries[0].request, {
    operation: 'findReferences',
    filePath: '/workspace/project/src/main.js',
    position: { line: 7, character: 4 },
    workspaceRoot: '/workspace/project',
  })

  const before = fixture.queries.length
  await assert.rejects(tool.execute(input({ includeDeclaration: false }), execution()), /cannot exclude the declaration/u)
  assert.equal(fixture.queries.length, before)
})

test('rejects absolute, URI, traversal, malformed, and control-bearing input paths before session or FS access', async () => {
  const fixture = makeFixture()
  const tool = getTool(fixture)
  for (const filePath of ['/etc/passwd', 'C:/secret.js', '\\\\server\\share\\file.js', 'file:///tmp/a.js', 'https://example.com/a.js', '../outside.js', 'src/../outside.js', './src/a.js', 'src//a.js', 'src\\a.js', 'src/\u0000bad.js', 'src/\u061cbad.js']) {
    await assert.rejects(tool.execute(input({ filePath }), execution()), /filePath/u, filePath)
  }
  assert.deepEqual(fixture.gets, [])
  assert.deepEqual(fixture.filesystem.calls, [])
  assert.deepEqual(fixture.queries, [])
})

test('requires a current matching SessionHeader id and absolute cwd before querying', async () => {
  const missingSession = makeFixture({ session: null })
  await assert.rejects(getTool(missingSession).execute(input(), execution()), /Could not determine the current Agent session/u)
  assert.deepEqual(missingSession.queries, [])

  const wrongId = makeFixture({ session: { header: { id: 'another-session', cwd: '/workspace/project' } } })
  await assert.rejects(getTool(wrongId).execute(input(), execution()), /Could not determine the current Agent session/u)
  assert.deepEqual(wrongId.queries, [])

  const relativeCwd = makeFixture({ cwd: 'workspace/project' })
  await assert.rejects(getTool(relativeCwd).execute(input(), execution()), /valid absolute workspace path/u)
  assert.deepEqual(relativeCwd.queries, [])
})

test('rejects a canonicalized path outside the cwd even when the supplied path is relative', async () => {
  const fixture = makeFixture({ aliases: { '/workspace/project/src/main.js': '/workspace/private/secret.js' } })
  await assert.rejects(getTool(fixture).execute(input(), execution()), /inside the current Agent workspace/u)
  assert.deepEqual(fixture.queries, [])
  assert.ok(fixture.filesystem.calls.some(call => call.method === 'contains'))

  const malformedContainment = makeFixture()
  malformedContainment.filesystem.fs.contains = () => undefined
  await assert.rejects(getTool(malformedContainment).execute(input(), execution()), /inside the current Agent workspace/u)
  assert.deepEqual(malformedContainment.queries, [])
})

test('rejects invalid positions and unsupported includeDeclaration types before query', async () => {
  const fixture = makeFixture()
  const definition = getTool(fixture)
  for (const [key, value] of [['line', 0], ['line', 1.5], ['line', 10_000_001], ['character', -1], ['character', 2.5]]) {
    await assert.rejects(definition.execute(input({ [key]: value }), execution()), new RegExp(key, 'u'))
  }
  const references = getTool(fixture, 'lsp_find_references')
  await assert.rejects(references.execute(input({ includeDeclaration: 'yes' }), execution()), /includeDeclaration.*boolean/u)
  assert.deepEqual(fixture.queries, [])
})

test('maps only exact LSP_UNAVAILABLE to a query-specific message and hides provider errors', async () => {
  const unavailable = makeFixture({ query: async () => { throw Object.assign(new Error('/private/path'), { code: 'LSP_UNAVAILABLE' }) } })
  await assert.rejects(getTool(unavailable).execute(input(), execution()), /No compatible DSH LSP provider/u)

  const failed = makeFixture({ query: async () => { throw new Error('secret provider details /private/path') } })
  await assert.rejects(getTool(failed).execute(input(), execution()), error => {
    assert.match(error.message, /provider error/u)
    assert.doesNotMatch(error.message, /secret|private/u)
    return true
  })
})

test('rejects malformed or wrong-union LSP results and unsafe URIs/ranges', async () => {
  for (const query of [
    async () => ({ kind: 'hover', hover: { contents: 'not a navigation result' } }),
    async () => ({ kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations: [{ uri: 'https://example.com/file.js', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }),
    async () => ({ kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations: [{ uri: 'file:///tmp/\u202e.js', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }),
    async () => ({ kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations: [{ uri: 'file:///tmp/\u200e.js', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }),
    async () => ({ kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations: [{ uri: `file:///${'é'.repeat(700)}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }),
    async () => ({ kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations: [{ uri: 'file:///tmp/file.js', range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } }] }),
  ]) {
    const fixture = makeFixture({ query })
    await assert.rejects(getTool(fixture).execute(input(), execution()), /invalid|unsupported|oversized/u)
  }
})

test('requires and bounds resolvedWorkspaceUri but omits it from model-facing output', async () => {
  const missing = makeFixture({ query: async () => ({ kind: 'locations', locations: [] }) })
  await assert.rejects(getTool(missing).execute(input(), execution()), /invalid result/u)

  const oversized = makeFixture({ query: async () => ({ kind: 'locations', resolvedWorkspaceUri: 'x'.repeat(4_097), locations: [] }) })
  await assert.rejects(getTool(oversized).execute(input(), execution()), /invalid result/u)

  const fixture = makeFixture()
  const result = await getTool(fixture).execute(input(), execution())
  assert.equal(Object.hasOwn(result, 'resolvedWorkspaceUri'), false)
})

test('caps large location lists and aggregate serialized output with explicit truncation', async () => {
  const locations = Array.from({ length: 70 }, (_, index) => ({
    uri: `file:///workspace/project/src/result-${index}.js`,
    range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
  }))
  const fixture = makeFixture({ query: async () => ({ kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations }) })
  const result = await getTool(fixture).execute(input(), execution())
  assert.equal(result.totalLocations, 70)
  assert.equal(result.locations.length, 50)
  assert.equal(result.truncated, true)
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 24_000)
})

test('observes cancellation before filesystem work and discards results after a cancelled query', async () => {
  const preAborted = new AbortController()
  preAborted.abort()
  const before = makeFixture()
  await assert.rejects(getTool(before).execute(input(), execution('session-1', preAborted.signal)), /cancelled/u)
  assert.deepEqual(before.filesystem.calls, [])
  assert.deepEqual(before.queries, [])

  const controller = new AbortController()
  const after = makeFixture({ query: async () => {
    controller.abort()
    return { kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations: [] }
  } })
  await assert.rejects(getTool(after).execute(input(), execution('session-1', controller.signal)), /cancelled/u)
  assert.equal(after.queries[0].signal, controller.signal)

  const synchronousAbort = makeFixture()
  const synchronousController = new AbortController()
  let rejectLate
  let rejectionHandlerAttached = false
  const lateRejection = new Promise((_, reject) => { rejectLate = reject })
  const originalThen = lateRejection.then.bind(lateRejection)
  lateRejection.then = (onFulfilled, onRejected) => {
    if (typeof onRejected === 'function') rejectionHandlerAttached = true
    return originalThen(onFulfilled, onRejected)
  }
  synchronousAbort.service.query = () => {
    synchronousController.abort()
    return lateRejection
  }
  const cancelled = getTool(synchronousAbort).execute(input(), execution('session-1', synchronousController.signal))
  await assert.rejects(cancelled, /cancelled/u)
  assert.equal(rejectionHandlerAttached, true, 'a started operation must remain observed after synchronous cancellation')
  rejectLate(new Error('late provider rejection'))
  await new Promise(resolve => setImmediate(resolve))

  const waitingController = new AbortController()
  let queryStartedResolve
  const queryStarted = new Promise(resolve => { queryStartedResolve = resolve })
  const waiting = makeFixture({ query: async () => {
    queryStartedResolve()
    return new Promise(() => {})
  } })
  const pendingCall = getTool(waiting).execute(input(), execution('session-1', waitingController.signal))
  await queryStarted
  waitingController.abort()
  await assert.rejects(pendingCall, /cancelled/u, 'cancellation settles promptly even if the provider ignores its signal')
})

test('registers exactly two disposable tools and rolls back partial registration', () => {
  const fixture = makeFixture()
  const dispose = registerLspNavigationTools(fixture.ctx, fixture.service, fixture.sessions, fixture.filesystem.fs)
  assert.deepEqual([...fixture.tools.keys()], ['lsp_goto_definition', 'lsp_find_references'])
  dispose()
  dispose()
  assert.equal(fixture.tools.size, 0)

  const rollbackTools = new Map()
  let count = 0
  const ctx = {
    tools: {
      register(tool) {
        count += 1
        if (count === 2) throw new Error('registration failed')
        rollbackTools.set(tool.name, tool)
        return () => rollbackTools.delete(tool.name)
      },
    },
  }
  assert.throws(() => registerLspNavigationTools(ctx, fixture.service, fixture.sessions, fixture.filesystem.fs), /registration failed/u)
  assert.equal(rollbackTools.size, 0)

  const cleanupCalls = []
  const cleanupCtx = {
    tools: {
      register(tool) {
        return () => {
          cleanupCalls.push(tool.name)
          if (tool.name === 'lsp_find_references') throw new Error('cleanup failed')
        }
      },
    },
  }
  const cleanup = registerLspNavigationTools(cleanupCtx, fixture.service, fixture.sessions, fixture.filesystem.fs)
  assert.throws(cleanup, /cleanup failed/u)
  assert.deepEqual(cleanupCalls, ['lsp_find_references', 'lsp_goto_definition'])
  cleanup()
  assert.deepEqual(cleanupCalls, ['lsp_find_references', 'lsp_goto_definition'])
})
