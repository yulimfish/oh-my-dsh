import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createContextOverflowRecoveryController,
  normalizeContextOverflowRecovery,
  registerContextOverflowRecovery,
} from '../src/context-overflow-recovery.js'

const policy = Object.freeze({
  enabled: true,
  codesByProvider: Object.freeze({ 'provider-a': Object.freeze(['context_window_exceeded']) }),
})

function fixture(options = {}) {
  const agent = Object.freeze({ id: 'session-1' })
  const session = Object.freeze({ id: agent.id })
  const state = { agent, session }
  const calls = []
  const pruneResult = options.pruneResult ?? { pruned: [{ replacementSeq: 4 }], charsRemoved: 120 }
  const controller = createContextOverflowRecoveryController(policy, {
    agents: { get(id) { calls.push(['agents.get', id]); return id === state.agent?.id ? state.agent : undefined } },
    sessions: { get(id) { calls.push(['sessions.get', id]); return id === state.session?.id ? state.session : undefined } },
    pruner: {
      pruneSession(value) {
        calls.push(['pruneSession', value])
        if (options.onPrune) options.onPrune(value, state)
        if (options.throwOnPrune) throw new Error('private Host detail')
        return typeof options.getPruneResult === 'function' ? options.getPruneResult() : pruneResult
      },
    },
    compaction: {
      async compactIfNeeded(agent, trigger, signal) {
        calls.push(['compactIfNeeded', agent, trigger, signal])
        if (options.onCompact) return options.onCompact(agent, trigger, signal, state)
        return options.compactResult ?? null
      },
    },
  })
  return { agent, session, state, calls, controller }
}

function request(f, overrides = {}) {
  return {
    agent: f.agent,
    turn: 7,
    step: 2,
    provider: 'provider-a',
    failure: { code: 'context_window_exceeded', message: 'input exceeds context window' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('uses Host compaction only when pruning has no output and only retries after a real result', async () => {
  const compacted = []
  const f = fixture({
    pruneResult: { pruned: [] },
    compactResult: { compactionId: 'compact-1' },
    onCompact: (agent, trigger, signal) => { compacted.push({ agent, trigger, signal }); return { compactionId: 'compact-1' } },
  })
  const decision = await f.controller.onRequestError(request(f), async () => undefined)
  assert.deepEqual(decision, { kind: 'retry' })
  assert.equal(compacted.length, 1)
  assert.equal(compacted[0].agent.session, f.session)
  assert.deepEqual(compacted[0].agent.options, {})
  assert.equal(compacted[0].trigger, 'context-overflow')
})

test('does not compact when pruning already recovered, or when compaction returns null or fails', async () => {
  const recovered = fixture({ pruneResult: { pruned: [{ replacementSeq: 2 }] } })
  const decision = await recovered.controller.onRequestError(request(recovered), async () => undefined)
  assert.deepEqual(decision, { kind: 'retry' })
  assert.equal(recovered.calls.some(call => call[0] === 'compactIfNeeded'), false)

  for (const options of [{ pruneResult: { pruned: [] }, compactResult: null }, { pruneResult: { pruned: [] }, onCompact: () => { throw new Error('private') } }]) {
    const f = fixture(options)
    const result = await f.controller.onRequestError(request(f), async () => undefined)
    assert.equal(result, undefined)
  }
})

test('normalizes a default-off policy and requires bounded exact provider codes when enabled', () => {
  assert.deepEqual(normalizeContextOverflowRecovery(undefined), {
    enabled: false,
    codesByProvider: Object.create(null),
  })
  assert.throws(() => normalizeContextOverflowRecovery({ enabled: true }), /at least one exact provider error code/u)
  const normalized = normalizeContextOverflowRecovery(policy)
  assert.equal(normalized.enabled, true)
  assert.deepEqual(normalized.codesByProvider['provider-a'], ['context_window_exceeded'])
  assert.throws(() => normalizeContextOverflowRecovery({ enabled: 'yes' }), /enabled must be a boolean/u)
  assert.throws(() => normalizeContextOverflowRecovery({ enabled: true, codesByProvider: { 'provider-a': ['code', 'code'] } }), /must not repeat/u)
  assert.throws(() => normalizeContextOverflowRecovery({ enabled: true, codesByProvider: { 'provider-a': [' code'] } }), /surrounding whitespace/u)
  assert.throws(() => normalizeContextOverflowRecovery({ enabled: true, codesByProvider: { 'provider-a': [] } }), /between 1 and/u)
  assert.throws(() => normalizeContextOverflowRecovery({ enabled: false, unexpected: true }), /unsupported field/u)
  assert.throws(() => normalizeContextOverflowRecovery({ codesByProvider: {
    'provider-a': ['x'.repeat(129)],
  } }), /at most 128 UTF-8 bytes/u)
  assert.throws(() => normalizeContextOverflowRecovery({ codesByProvider: {
    'provider-a': Array.from({ length: 17 }, (_, index) => `code-${index}`),
  } }), /between 1 and 16/u)
  assert.throws(() => normalizeContextOverflowRecovery({ codesByProvider: Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`provider-${index}`, ['overflow']]),
  ) }), /at most 32 providers/u)
})

test('prunes the exact live Session and retries only when the Host reports replacements', async () => {
  const f = fixture()
  const order = []
  const action = await f.controller.onRequestError(request(f), async () => {
    order.push('next')
    return undefined
  })
  assert.deepEqual(action, { kind: 'retry' })
  assert.deepEqual(order, ['next'])
  assert.deepEqual(f.calls, [
    ['agents.get', f.agent.id],
    ['sessions.get', f.agent.id],
    ['pruneSession', f.session],
    ['agents.get', f.agent.id],
    ['sessions.get', f.agent.id],
  ])
})

test('requires exact provider and failure codes, never broad error-message matching', async () => {
  const f = fixture()
  for (const overrides of [
    { provider: 'Provider-A' },
    { failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'input exceeds context window' } },
    { failure: { code: 'unknown', message: 'context_window_exceeded input exceeds context window' } },
  ]) {
    assert.equal(await f.controller.onRequestError(request(f, overrides), async () => undefined), undefined)
  }
  assert.equal(f.calls.some(([name]) => name === 'pruneSession'), false)
})

test('preserves a delegated retry and suppresses another retry in that Agent turn', async () => {
  const f = fixture()
  const delegatedRetry = Object.freeze({ kind: 'retry' })
  assert.strictEqual(await f.controller.onRequestError(request(f), async () => delegatedRetry), delegatedRetry)
  assert.equal(await f.controller.onRequestError(request(f), async () => undefined), undefined)
  assert.equal(f.calls.some(([name]) => name === 'pruneSession'), false)
})

test('allows at most one recovery per Agent turn but permits a later turn', async () => {
  const f = fixture()
  assert.deepEqual(await f.controller.onRequestError(request(f), async () => undefined), { kind: 'retry' })
  assert.equal(await f.controller.onRequestError(request(f), async () => undefined), undefined)
  assert.deepEqual(await f.controller.onRequestError(request(f, { turn: 8 }), async () => undefined), { kind: 'retry' })
  assert.equal(f.calls.filter(([name]) => name === 'pruneSession').length, 2)
})

test('serializes concurrent same-turn failures to one prune and one retry', async () => {
  const f = fixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = f.controller.onRequestError(request(f), async () => gate)
  const second = f.controller.onRequestError(request(f), async () => gate)
  release(undefined)
  const actions = await Promise.all([first, second])
  assert.equal(actions.filter(action => action?.kind === 'retry').length, 1)
  assert.equal(f.calls.filter(([name]) => name === 'pruneSession').length, 1)
})

test('no-op pruning, malformed results, and partial-throw outcomes never request a retry', async () => {
  for (const options of [
    { pruneResult: { pruned: [], charsRemoved: 0 } },
    { getPruneResult: () => undefined },
    { throwOnPrune: true },
  ]) {
    const f = fixture(options)
    assert.equal(await f.controller.onRequestError(request(f), async () => undefined), undefined)
    assert.equal(await f.controller.onRequestError(request(f), async () => undefined), undefined)
    assert.equal(f.calls.filter(([name]) => name === 'pruneSession').length, 1, 'a no-op or uncertain partial pass consumes the turn attempt')
  }
})

test('fails closed on stale Agent, missing or mismatched Session, and lookup errors', async () => {
  const stale = fixture()
  stale.state.agent = Object.freeze({ id: stale.agent.id })
  assert.equal(await stale.controller.onRequestError(request(stale), async () => undefined), undefined)
  assert.equal(stale.calls.some(([name]) => name === 'pruneSession'), false)

  const mismatchedSession = fixture()
  mismatchedSession.state.session = Object.freeze({ id: 'other-session' })
  assert.equal(await mismatchedSession.controller.onRequestError(request(mismatchedSession), async () => undefined), undefined)
  assert.equal(mismatchedSession.calls.some(([name]) => name === 'pruneSession'), false)

  const lookupFailureAgent = Object.freeze({ id: 'session-lookup-failure' })
  const lookupFailure = createContextOverflowRecoveryController(policy, {
    agents: { get() { throw new Error('private Agent lookup detail') } },
    sessions: { get() { throw new Error('private Session lookup detail') } },
    pruner: { pruneSession() { assert.fail('pruning must not run after a lookup error') } },
  })
  assert.equal(await lookupFailure.onRequestError(request({ agent: lookupFailureAgent }), async () => undefined), undefined)
})

test('cancellation before or during pruning prevents retry', async () => {
  const before = fixture()
  const beforeAbort = new AbortController()
  beforeAbort.abort()
  assert.equal(await before.controller.onRequestError(request(before, { signal: beforeAbort.signal }), async () => undefined), undefined)
  assert.equal(before.calls.some(([name]) => name === 'pruneSession'), false)

  const during = fixture({ onPrune: () => duringAbort.abort() })
  const duringAbort = new AbortController()
  assert.equal(await during.controller.onRequestError(request(during, { signal: duringAbort.signal }), async () => undefined), undefined)
  assert.equal(during.calls.filter(([name]) => name === 'pruneSession').length, 1)
})

test('does not retry if the live Agent or Session changes during synchronous pruning', async () => {
  const replacedAgent = fixture({ onPrune: (_session, state) => { state.agent = Object.freeze({ id: state.agent.id }) } })
  assert.equal(await replacedAgent.controller.onRequestError(request(replacedAgent), async () => undefined), undefined)

  const replacedSession = fixture({ onPrune: (_session, state) => { state.session = Object.freeze({ id: state.session.id }) } })
  assert.equal(await replacedSession.controller.onRequestError(request(replacedSession), async () => undefined), undefined)
})

test('same-ID replacement has independent turn state and late old disposal cannot clear it', async () => {
  const f = fixture()
  const replacement = Object.freeze({ id: f.agent.id })
  const retry = Object.freeze({ kind: 'retry' })
  assert.strictEqual(await f.controller.onRequestError(request(f), async () => retry), retry)
  f.state.agent = replacement
  assert.deepEqual(await f.controller.onRequestError(request(f, { agent: replacement }), async () => undefined), { kind: 'retry' })
  f.controller.onAgentDisposed({ agent: f.agent })
  assert.equal(await f.controller.onRequestError(request(f, { agent: replacement }), async () => undefined), undefined)
  assert.equal(f.calls.filter(([name]) => name === 'pruneSession').length, 1)
})

test('registration is default-off and owns listener cleanup', async () => {
  const events = new Map()
  let cleanup
  const ctx = {
    on: (name, listener) => { events.set(name, listener) },
    effect: execute => { cleanup = execute() },
  }
  assert.doesNotThrow(() => registerContextOverflowRecovery({}, undefined, {}))
  assert.equal(events.size, 0)

  const f = fixture()
  const dispose = registerContextOverflowRecovery(ctx, policy, {
    agents: { get: id => id === f.agent.id ? f.state.agent : undefined },
    sessions: { get: id => id === f.session.id ? f.state.session : undefined },
    pruner: { pruneSession: session => { f.calls.push(['pruneSession', session]); return { pruned: [{}] } } },
  })
  assert.deepEqual([...events.keys()], ['agent/request-error', 'agent/disposed'])
  assert.deepEqual(await events.get('agent/request-error')(request(f), async () => undefined), { kind: 'retry' })
  dispose()
  cleanup()
  assert.equal(await events.get('agent/request-error')(request(f, { turn: 8 }), async () => undefined), undefined)
  assert.equal(f.calls.filter(([name]) => name === 'pruneSession').length, 1)
})
