import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPressureCompactionListener,
  registerPressureCompaction,
} from '../src/pressure-compaction.js'

function fixture(options = {}) {
  const agent = Object.freeze({ id: 'session-1' })
  const session = Object.freeze({ header: Object.freeze({ id: agent.id }) })
  const state = { agent, session }
  const calls = []
  const warnings = []
  const listener = createPressureCompactionListener({
    agents: {
      get(id) {
        calls.push(['agents.get', id])
        return id === state.agent?.id ? state.agent : undefined
      },
    },
    sessions: {
      get(id) {
        calls.push(['sessions.get', id])
        return id === state.session?.header.id ? state.session : undefined
      },
    },
    compaction: {
      async compactIfNeeded(agentContext, trigger, signal) {
        calls.push(['compactIfNeeded', agentContext, trigger, signal])
        if (options.onCompact) return options.onCompact(agentContext, trigger, signal, state)
        return null
      },
    },
    logger: { warn: message => warnings.push(message) },
  })
  return { agent, session, state, calls, warnings, listener }
}

function payload(fixture, overrides = {}) {
  return {
    agent: fixture.agent,
    turn: 3,
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('checks the exact live Agent and Session, then delegates pressure policy to Host compaction', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  await f.listener(payload(f, { signal }))

  assert.deepEqual(f.calls.slice(0, 2), [
    ['agents.get', f.agent.id],
    ['sessions.get', f.agent.id],
  ])
  const call = f.calls[2]
  assert.equal(call[0], 'compactIfNeeded')
  assert.strictEqual(call[1].session, f.session)
  assert.deepEqual(call[1].options, {})
  assert.equal(call[2], 'pressure')
  assert.equal(call[3].aborted, false)
  assert.notStrictEqual(call[3], signal, 'the Host call is cancelled by either the Agent or plugin lifetime')
  f.listener.dispose()
})

test('fails closed for stale identity, mismatched sessions, invalid turns, and aborted signals', async () => {
  const f = fixture()
  const stale = Object.freeze({ id: f.agent.id })
  await f.listener(payload(f, { agent: stale }))
  f.state.session = Object.freeze({ header: Object.freeze({ id: 'other-session' }) })
  await f.listener(payload(f))
  await f.listener(payload(f, { turn: -1 }))
  const aborted = new AbortController()
  aborted.abort()
  await f.listener(payload(f, { signal: aborted.signal }))

  assert.equal(f.calls.filter(([name]) => name === 'compactIfNeeded').length, 0)
  f.listener.dispose()
})

test('coalesces concurrent turn-stopping calls and aborts the Host signal on disposal', async () => {
  let release
  let hostSignal
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({
    onCompact: async (_agentContext, _trigger, signal) => {
      hostSignal = signal
      await gate
      return null
    },
  })

  const first = f.listener(payload(f))
  assert.ok(hostSignal)
  const second = f.listener(payload(f))
  assert.equal(f.calls.filter(([name]) => name === 'compactIfNeeded').length, 1)
  f.listener.dispose()
  assert.equal(hostSignal.aborted, true)
  release()
  await Promise.all([first, second])
})

test('turn cancellation aborts an in-flight Host pressure check', async () => {
  let release
  let hostSignal
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ onCompact: async (_context, _trigger, signal) => {
    hostSignal = signal
    await gate
    return null
  } })
  const turn = new AbortController()
  const operation = f.listener(payload(f, { signal: turn.signal }))
  try {
    assert.ok(hostSignal)
    assert.equal(hostSignal.aborted, false)
    turn.abort()
    assert.equal(hostSignal.aborted, true)
  } finally {
    release()
    await operation
    f.listener.dispose()
  }
})

test('contains Host failures and logs no backend-controlled detail', async () => {
  const f = fixture({ onCompact: () => { throw Object.assign(new Error('private detail'), { name: 'HostFailure' }) } })
  await assert.doesNotReject(f.listener(payload(f)))
  assert.deepEqual(f.warnings, ['[dsh-omo] pressure compaction failed'])
  assert.equal(f.warnings.some(message => message.includes('private detail')), false)
  f.listener.dispose()
})

test('registers only the awaited turn-stopping event and disposes with its owning context', () => {
  const f = fixture()
  let registered
  let cleanup
  let label
  const ctx = {
    on(event, listener) { registered = { event, listener } },
    effect(execute, effectLabel) { cleanup = execute(); label = effectLabel },
  }
  const dispose = registerPressureCompaction(ctx, {
    agents: { get: id => id === f.agent.id ? f.agent : undefined },
    sessions: { get: id => id === f.agent.id ? f.session : undefined },
    compaction: { compactIfNeeded: async () => null },
  })

  assert.equal(registered.event, 'agent/turn-stopping')
  assert.equal(typeof registered.listener, 'function')
  assert.equal(label, 'dsh-omo pressure compaction')
  dispose()
  cleanup()
  assert.throws(() => registerPressureCompaction({ on() {} }, {}), /ctx\.on and ctx\.effect/u)
})
