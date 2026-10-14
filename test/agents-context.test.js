import assert from 'node:assert/strict'
import test from 'node:test'
import { createRootAgentsContextListener, registerRootAgentsContext } from '../src/agents-context.js'

const CWD = '/workspace/project'
const AGENTS_TEXT = '# Repository guidance\u202e\u0000\nUse the project formatter.\n'

function makeFixture(options = {}) {
  const calls = []
  const rootTarget = { targetKey: 'root-target' }
  const fileTarget = { targetKey: 'agents-target' }
  const fs = {
    async resolve(path, opts) {
      calls.push(['resolve', path, opts])
      if (path === CWD) return rootTarget
      if (path === 'AGENTS.md') return fileTarget
      throw new Error('unexpected path')
    },
    contains(parent, child) {
      calls.push(['contains', parent, child])
      return options.contains ? options.contains(parent, child) : parent === rootTarget && child === fileTarget
    },
    async lstat(path, opts, signal) {
      calls.push(['lstat', path, opts, signal])
      return Object.hasOwn(options, 'pathInfo') ? options.pathInfo : { type: 'file' }
    },
    async stat(target, signal) {
      calls.push(['stat', target, signal])
      if (target === rootTarget) return options.rootInfo ?? { type: 'directory' }
      return options.fileInfo ?? { type: 'file' }
    },
    async readBytes(target, signal, maxBytes) {
      calls.push(['readBytes', target, signal, maxBytes])
      if (options.readBytes) return options.readBytes(target, signal, maxBytes)
      return new TextEncoder().encode(AGENTS_TEXT)
    },
  }
  const sessions = {
    get: id => {
      calls.push(['sessions.get', id])
      if (options.sessionError) throw new Error('private session error')
      return options.session ?? { header: { id, cwd: CWD } }
    },
  }
  const listener = createRootAgentsContextListener(sessions, fs)
  return { calls, fs, sessions, listener, rootTarget, fileTarget }
}

function execution({ name = 'read', id = 'session-1', cwd = CWD, signal = new AbortController().signal } = {}) {
  return { name, agent: { id }, signal, ...(cwd === undefined ? {} : { cwd }) }
}

function acceptedDecision(overrides = {}) {
  return { kind: 'accept', value: { exact: 'original value' }, ...overrides }
}

function contextText(message) {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

test('adds bounded cwd AGENTS.md as additional user context without changing the accepted result', async () => {
  const fixture = makeFixture()
  const resultContext = { role: 'user', content: [{ type: 'text', text: 'context from the original tool result' }] }
  const previousContext = { role: 'user', content: [{ type: 'text', text: 'earlier post-execute context' }] }
  const decision = acceptedDecision({ additionalContexts: [previousContext] })
  const result = { isError: false, value: { tool: 'read' }, content: [{ type: 'text', text: 'tool output stays unchanged' }], additionalContexts: [resultContext] }
  const output = await fixture.listener(execution(), result, async () => decision)

  assert.notEqual(output, decision)
  assert.equal(output.value, decision.value)
  assert.equal(output.additionalContexts[0], resultContext)
  assert.equal(output.additionalContexts[1], previousContext)
  assert.equal(decision.additionalContexts.length, 1, 'the prior decision is not mutated')
  assert.equal(output.additionalContexts.length, 3)
  assert.equal(output.additionalContexts[2].role, 'user')
  assert.deepEqual(output.additionalContexts[2].source, { kind: 'user' })
  assert.match(contextText(output.additionalContexts[2]), /Repository guidance/u)
  assert.match(contextText(output.additionalContexts[2]), /untrusted/u)
  assert.doesNotMatch(contextText(output.additionalContexts[2]), /[\u202e\u0000]/u, 'bidi and NUL controls are replaced before context injection')
  assert.equal(fixture.calls.find(call => call[0] === 'readBytes')[3], 16_384)
  assert.ok(fixture.calls.some(call => call[0] === 'contains' && call[1] === fixture.rootTarget && call[2] === fixture.fileTarget))
})

test('preserves content-form decisions and skips non-read, failed, and blocked outcomes', async () => {
  const fixture = makeFixture()
  const blocks = [{ type: 'text', text: 'original tool content' }]
  const contentDecision = { kind: 'accept', content: blocks }
  const contentOutput = await fixture.listener(execution(), { isError: false }, async () => contentDecision)
  assert.equal(contentOutput.content, blocks)
  assert.equal(contentOutput.additionalContexts.length, 1)

  for (const { exec, result, decision } of [
    { exec: execution({ name: 'search' }), result: { isError: false }, decision: acceptedDecision() },
    { exec: execution(), result: { isError: true }, decision: acceptedDecision() },
    { exec: execution(), result: { isError: false }, decision: { kind: 'block', reason: 'policy' } },
  ]) {
    const other = makeFixture()
    const output = await other.listener(exec, result, async () => decision)
    assert.equal(output, decision)
    assert.equal(other.calls.some(call => call[0] === 'readBytes'), false)
  }
})

test('requires a matching current session and uses only its absolute cwd', async () => {
  const mismatch = makeFixture({ session: { header: { id: 'different-session', cwd: CWD } } })
  const decision = acceptedDecision()
  assert.equal(await mismatch.listener(execution(), { isError: false }, async () => decision), decision)
  assert.equal(mismatch.calls.some(call => call[0] === 'resolve'), false)

  const relative = makeFixture({ session: { header: { id: 'session-1', cwd: 'project' } } })
  assert.equal(await relative.listener(execution(), { isError: false }, async () => decision), decision)
  assert.equal(relative.calls.some(call => call[0] === 'resolve'), false)
})

test('rejects absent, symlink, non-file, and out-of-workspace AGENTS targets', async () => {
  for (const options of [
    { pathInfo: undefined },
    { pathInfo: { type: 'symlink' } },
    { pathInfo: { type: 'directory' } },
    { contains: () => false },
    { fileInfo: { type: 'directory' } },
  ]) {
    const fixture = makeFixture(options)
    const decision = acceptedDecision()
    const output = await fixture.listener(execution(), { isError: false }, async () => decision)
    assert.equal(output, decision)
    assert.equal(fixture.calls.some(call => call[0] === 'readBytes'), false)
    const filesystemCallsAfterDone = fixture.calls.filter(call => call[0] !== 'sessions.get').length
    const nextDecision = acceptedDecision()
    assert.equal(await fixture.listener(execution(), { isError: false }, async () => nextDecision), nextDecision)
    assert.equal(fixture.calls.filter(call => call[0] !== 'sessions.get').length, filesystemCallsAfterDone, 'completed absent/invalid target checks are memoized')
  }
})

test('skips oversized and invalid UTF-8 instruction files without failing the read tool', async () => {
  for (const readBytes of [
    async () => { throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' }) },
    async () => new Uint8Array([0xc3, 0x28]),
    async () => new Uint8Array(16_385),
  ]) {
    const fixture = makeFixture({ readBytes })
    const decision = acceptedDecision()
    assert.equal(await fixture.listener(execution(), { isError: false }, async () => decision), decision)
    const readsAfterDone = fixture.calls.filter(call => call[0] === 'readBytes').length
    const nextDecision = acceptedDecision()
    assert.equal(await fixture.listener(execution(), { isError: false }, async () => nextDecision), nextDecision)
    assert.equal(fixture.calls.filter(call => call[0] === 'readBytes').length, readsAfterDone, 'completed invalid/oversized checks are memoized')
  }
})

test('deduplicates per session, retries transient failures/cancellation, and cancels on disposal', async () => {
  const fixture = makeFixture()
  const decision = acceptedDecision()
  const first = await fixture.listener(execution(), { isError: false }, async () => decision)
  assert.equal(first.additionalContexts.length, 1)
  const readsAfterFirst = fixture.calls.filter(call => call[0] === 'readBytes').length
  const secondDecision = acceptedDecision()
  const second = await fixture.listener(execution(), { isError: false }, async () => secondDecision)
  assert.equal(second, secondDecision)
  assert.equal(fixture.calls.filter(call => call[0] === 'readBytes').length, readsAfterFirst)

  let concurrentReadResolve
  let concurrentStartedResolve
  const concurrentStarted = new Promise(resolve => { concurrentStartedResolve = resolve })
  const concurrent = makeFixture({ readBytes: () => new Promise(resolve => {
    concurrentReadResolve = resolve
    concurrentStartedResolve()
  }) })
  const concurrentFirstDecision = acceptedDecision()
  const concurrentFirst = concurrent.listener(execution(), { isError: false }, async () => concurrentFirstDecision)
  await concurrentStarted
  const concurrentSecondDecision = acceptedDecision()
  const concurrentSecond = await concurrent.listener(execution(), { isError: false }, async () => concurrentSecondDecision)
  assert.equal(concurrentSecond, concurrentSecondDecision, 'a concurrent post-execute call reuses the in-flight session reservation')
  concurrentReadResolve(new TextEncoder().encode(AGENTS_TEXT))
  assert.equal((await concurrentFirst).additionalContexts.length, 1)
  assert.equal(concurrent.calls.filter(call => call[0] === 'readBytes').length, 1)

  const bounded = makeFixture()
  const invokeFor = id => bounded.listener(execution({ id }), { isError: false }, async () => acceptedDecision())
  for (let index = 0; index < 256; index += 1) await invokeFor(`session-${index}`)
  await invokeFor('session-0')
  await invokeFor('session-256')
  assert.equal(bounded.calls.filter(call => call[0] === 'readBytes').length, 257)
  await invokeFor('session-0')
  assert.equal(bounded.calls.filter(call => call[0] === 'readBytes').length, 257, 'recently used sessions remain in the bounded LRU')
  await invokeFor('session-1')
  assert.equal(bounded.calls.filter(call => call[0] === 'readBytes').length, 258, 'the least-recent session is evicted and may be injected again')

  let attempts = 0
  const transient = makeFixture({ readBytes: async () => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary provider failure')
    return new TextEncoder().encode(AGENTS_TEXT)
  } })
  const firstAttempt = acceptedDecision()
  assert.equal(await transient.listener(execution(), { isError: false }, async () => firstAttempt), firstAttempt)
  const retried = await transient.listener(execution(), { isError: false }, async () => acceptedDecision())
  assert.equal(retried.additionalContexts.length, 1, 'transient filesystem errors do not stick in the session cache')
  assert.equal(attempts, 2)

  const aborted = new AbortController()
  const retryFixture = makeFixture({ readBytes: async (_target, signal) => {
    signal?.throwIfAborted()
    aborted.abort()
    return new TextEncoder().encode(AGENTS_TEXT)
  } })
  const retryDecision = acceptedDecision()
  const cancelled = await retryFixture.listener(execution({ signal: aborted.signal }), { isError: false }, async () => retryDecision)
  assert.equal(cancelled, retryDecision)
  const retry = await retryFixture.listener(execution(), { isError: false }, async () => acceptedDecision())
  assert.equal(retry.additionalContexts.length, 1)

  let pendingReadStartedResolve
  const pendingReadStarted = new Promise(resolve => { pendingReadStartedResolve = resolve })
  const pendingController = new AbortController()
  const pendingFixture = makeFixture({ readBytes: () => {
    pendingReadStartedResolve()
    return new Promise(() => {})
  } })
  const pendingDecision = acceptedDecision()
  const pendingRead = pendingFixture.listener(execution({ signal: pendingController.signal }), { isError: false }, async () => pendingDecision)
  await pendingReadStarted
  pendingController.abort()
  assert.equal(await pendingRead, pendingDecision, 'caller cancellation settles even if a filesystem provider ignores its signal')
  pendingFixture.listener.dispose()

  fixture.listener.dispose()
  const afterDisposeDecision = acceptedDecision()
  const afterDispose = await fixture.listener(execution(), { isError: false }, async () => afterDisposeDecision)
  assert.equal(afterDispose, afterDisposeDecision, 'a disposed listener does not inject or read again')
  assert.equal(fixture.calls.filter(call => call[0] === 'readBytes').length, readsAfterFirst)
  const remounted = createRootAgentsContextListener(fixture.sessions, fixture.fs)
  const remountedOutput = await remounted(execution(), { isError: false }, async () => acceptedDecision())
  assert.equal(remountedOutput.additionalContexts.length, 1, 'a new listener starts with an empty cache')
  remounted.dispose()

  let readStartedResolve
  const readStarted = new Promise(resolve => { readStartedResolve = resolve })
  let observedLifecycleAbort = false
  const disposing = makeFixture({ readBytes: (_target, signal) => new Promise(resolve => {
    readStartedResolve()
    if (signal.aborted) {
      observedLifecycleAbort = true
      resolve(new TextEncoder().encode(AGENTS_TEXT))
      return
    }
    signal.addEventListener('abort', () => {
      observedLifecycleAbort = true
      resolve(new TextEncoder().encode(AGENTS_TEXT))
    }, { once: true })
  }) })
  const disposeDecision = acceptedDecision()
  const pending = disposing.listener(execution(), { isError: false }, async () => disposeDecision)
  await readStarted
  disposing.listener.dispose()
  assert.equal(await pending, disposeDecision)
  assert.equal(observedLifecycleAbort, true, 'disposal aborts in-flight filesystem reads')
})

test('registers the scoped post-execute hook and cache cleanup effect', () => {
  const fixture = makeFixture()
  const events = new Map()
  const effects = []
  const ctx = {
    on: (name, listener) => { events.set(name, listener) },
    effect: (factory, label) => effects.push({ dispose: factory(), label }),
  }
  registerRootAgentsContext(ctx, fixture.sessions, fixture.fs)
  assert.equal(typeof events.get('tools/post-execute'), 'function')
  assert.equal(effects[0].label, 'dsh-omo root AGENTS context cache')
  effects[0].dispose()
})
