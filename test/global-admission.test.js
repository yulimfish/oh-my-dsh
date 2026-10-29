import test from 'node:test'
import assert from 'node:assert/strict'
import { createGlobalAdmission } from '../src/global-admission.js'

function fixture(options = {}) {
  const active = new Set()
  const parents = new Map()
  let time = 0
  let sequence = 0
  const timers = new Map()
  const contexts = []
  const lifecycle = new AbortController()
  const admission = createGlobalAdmission({
    active, maxConcurrent: 1, maxPending: 3,
    isParentLive: parent => parents.get(parent.id) === parent,
    lifecycleSignal: lifecycle.signal,
    now: () => time,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: time + ms, ms }); return id },
    clearTimeout: id => timers.delete(id),
    withoutInitiator: fn => { contexts.push('withoutInitiator'); return fn() },
    ...options,
  })
  const parent = id => { const value = { id }; parents.set(id, value); return value }
  const advance = ms => {
    time += ms
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn() }
  }
  return { admission, active, parent, parents, timers, lifecycle, advance, contexts }
}

test('validates bounds, options, malformed parents and signals', async () => {
  for (const maxPending of [-1, 17, 1.5, NaN]) assert.throws(() => fixture({ maxPending }), /maxPending/)
  for (const maxConcurrent of [0, -1, 1.5, NaN]) assert.throws(() => fixture({ maxConcurrent }), /maxConcurrent/)
  assert.throws(() => fixture({ active: [] }), /Set/)
  assert.throws(() => fixture({ lifecycleSignal: {} }), /signal/)
  const { admission } = fixture()
  for (const parent of [null, undefined, 'id', {}, { id: '' }, { id: 1 }]) await assert.rejects(admission.acquire(parent), /parent/)
  await assert.rejects(admission.acquire({ id: 'ok' }, {}), /signal/)
})

test('immediate reservation and original worker limit when no queue', async () => {
  const { admission: a, active, parent } = fixture({ maxPending: 0 })
  const p = parent('p')
  const first = a.acquire(p)
  assert.equal(active.size, 1)
  await assert.rejects(a.acquire(p), { message: 'dsh-omo one-shot worker limit reached (1); wait for a child to finish.' })
  const token = await first
  assert.equal(typeof token, 'symbol')
  assert.equal(a.release(token), true)
  assert.equal(a.release(token), false)
  assert.equal(active.size, 0)
})

test('oversized payload is rejected only when waiting is necessary', async () => {
  const f = fixture({ maxPending: 1 }); const parent = f.parent('p')
  const first = await f.admission.acquire(parent, undefined, false)
  await assert.rejects(f.admission.acquire(parent, undefined, false), /waiting payload limit/u)
  assert.equal(f.timers.size, 0, 'an oversized waiter must not retain a queue slot')
  const next = f.admission.acquire(parent)
  f.admission.release(first)
  f.admission.release(await next)
  assert.equal(f.active.size, 0)
})

test('FIFO, queue saturation, synchronous reservation and capacity', async () => {
  const { admission: a, active, parent, timers } = fixture({ maxPending: 2 })
  const p = parent('p')
  const held = await a.acquire(p)
  const b = a.acquire(p); const c = a.acquire(p)
  assert.deepEqual([...timers.values()].map(t => t.ms), [8000, 8000])
  await assert.rejects(a.acquire(p), /worker limit/)
  a.release(held)
  assert.equal(active.size, 1)
  const d = a.acquire(p)
  const bt = await b
  assert.ok(active.has(bt))
  a.release(bt)
  const ct = await c
  assert.ok(active.has(ct))
  a.release(ct)
  const dt = await d
  assert.ok(active.has(dt))
  a.release(dt)
  assert.equal(timers.size, 0)
})

test('abort, timeout and dispose clean timers and leave issued leases alone', async () => {
  const f = fixture(); const a = f.admission; const p = f.parent('p')
  const held = await a.acquire(p)
  const controller = new AbortController()
  const cancelled = a.acquire(p, controller.signal)
  const timeout = a.acquire(p)
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  f.advance(7999); assert.equal(f.timers.size, 1)
  f.advance(1); await assert.rejects(timeout, /8000ms/)
  const pending = a.acquire(p)
  f.lifecycle.abort()
  await assert.rejects(pending, /shutting down/)
  await assert.rejects(a.acquire(p), /shutting down/)
  assert.ok(f.active.has(held))
  assert.equal(f.timers.size, 0)
  assert.ok(f.contexts.length >= 3)
  assert.equal(a.release(held), true)
  a.dispose(); a.dispose()
})

test('expired waiter cannot be admitted even if timer callback is delayed', async () => {
  let now = 0
  const f = fixture({ now: () => now, setTimeout: () => 42, clearTimeout: () => {} })
  const p = f.parent('p'); const held = await f.admission.acquire(p)
  const waiting = f.admission.acquire(p)
  now = 8000
  f.admission.release(held)
  await assert.rejects(waiting, /timed out/)
  assert.equal(f.active.size, 0)
})

test('exact parent identity checked on each admission, including same-id replacement', async () => {
  const f = fixture(); const p = f.parent('same'); const held = await f.admission.acquire(p)
  const stale = f.admission.acquire(p)
  const replacement = f.parent('same')
  const current = f.admission.acquire(replacement)
  f.admission.release(held)
  await assert.rejects(stale, /live parent/)
  const token = await current
  assert.equal(f.active.size, 1)
  f.admission.release(token)
  await assert.rejects(f.admission.acquire(p), /live parent/)
})

test('child binding uses unique lease tokens and prevents ABA release', async () => {
  const f = fixture(); const a = f.admission; const p = f.parent('p')
  const first = await a.acquire(p)
  f.active.add('collision')
  assert.throws(() => a.bind(first, 'collision'), /already/)
  assert.throws(() => a.bind(first, ''), /childId/)
  assert.equal(a.release('collision'), false)
  f.active.delete('collision')
  assert.equal(a.bind(first, 'child'), first)
  assert.deepEqual([...f.active], [first])
  assert.throws(() => a.bind(first, 'other'), /already/)
  assert.equal(a.release(first), true)
  const second = await a.acquire(p)
  assert.equal(a.bind(second, 'child'), second)
  assert.equal(a.release(first), false, 'stale release cannot remove a reused child ID')
  assert.ok(f.active.has(second))
  assert.equal(a.release(second), true)
})

test('reentrant parent check cannot bypass earlier waiter or over-admit', async () => {
  let f; let nested; let triggered = false
  f = fixture({ isParentLive: p => {
    if (triggered) return true
    triggered = true
    nested = f.admission.acquire(p)
    return true
  } })
  const p = f.parent('p')
  const first = f.admission.acquire(p)
  assert.equal(f.active.size, 1)
  const token = await first
  f.admission.release(token)
  const second = await nested
  assert.equal(f.active.size, 1)
  f.admission.release(second)
})

test('abort and disposal during live callback do not issue a lease', async () => {
  const controller = new AbortController()
  const f = fixture({ isParentLive: () => { controller.abort(); return true } })
  await assert.rejects(f.admission.acquire(f.parent('p'), controller.signal), { name: 'AbortError' })
  assert.equal(f.active.size, 0)
  let g
  g = fixture({ isParentLive: () => { g.lifecycle.abort(); return true } })
  await assert.rejects(g.admission.acquire(g.parent('p')), /shutting down/)
  assert.equal(g.active.size, 0)
})

test('synchronous timer firing cleans its returned handle', async () => {
  const cleared = []
  const f = fixture({ setTimeout: callback => { callback(); return 123 }, clearTimeout: id => cleared.push(id) })
  const p = f.parent('p'); const token = await f.admission.acquire(p)
  await assert.rejects(f.admission.acquire(p), /timed out/)
  assert.deepEqual(cleared, [123])
  f.admission.release(token)
})

test('all liveness checks run without an initiator, including on release', async () => {
  let depth = 0
  const f = fixture({
    withoutInitiator: fn => { depth++; try { return fn() } finally { depth-- } },
    isParentLive: () => { assert.ok(depth > 0); return true },
  })
  const p = f.parent('p'); const held = await f.admission.acquire(p)
  const waiting = f.admission.acquire(p)
  f.admission.release(held)
  f.admission.release(await waiting)
})

test('external capacity release cannot let newcomers overtake a waiter', async () => {
  const f = fixture(); const p = f.parent('p')
  const held = await f.admission.acquire(p)
  const old = f.admission.acquire(p)
  f.active.delete(held)
  const newcomer = f.admission.acquire(p)
  const oldToken = await old
  assert.ok(f.active.has(oldToken))
  f.admission.release(oldToken)
  f.admission.release(await newcomer)
  f.admission.release(held)
})

test('falsy liveness exceptions fail closed without issuing a lease', async () => {
  for (const thrown of [undefined, null, false, 0, '']) {
    const f = fixture({ isParentLive: () => { throw thrown } })
    await assert.rejects(f.admission.acquire(f.parent('p')), /live parent/)
    assert.equal(f.active.size, 0)
  }
})

test('falsy setup failures reject instead of resolving an invalid token', async () => {
  for (const thrown of [undefined, null, false, 0, '']) {
    const f = fixture()
    const p = f.parent('p')
    const signal = { aborted: false, addEventListener() { throw thrown }, removeEventListener() {} }
    await assert.rejects(f.admission.acquire(p, signal), /Admission failed/)
    assert.equal(f.active.size, 0)
  }
})

test('throwing parent getters reject asynchronously without leaking reservations', async () => {
  const f = fixture()
  const parent = { get id() { throw new Error('private') } }
  let pending
  assert.doesNotThrow(() => { pending = f.admission.acquire(parent) })
  await assert.rejects(pending, /live parent/)
  assert.equal(f.active.size, 0)
})

test('falsy clock failures reject queued waiters without a token', async () => {
  for (const thrown of [undefined, null, false, 0, '']) {
    const f = fixture({ now() { throw thrown } })
    const p = f.parent('p')
    const token = await f.admission.acquire(p)
    await assert.rejects(f.admission.acquire(p), /Admission failed/)
    assert.equal(f.active.size, 1)
    f.admission.release(token)
  }
})

test('initiator wrapper failures cannot strand or leak reservations', async () => {
  for (const stage of ['before', 'after']) {
    let calls = 0
    const f = fixture({ withoutInitiator: fn => {
      calls += 1
      if (calls === 2 && stage === 'before') throw new Error('wrapper unavailable')
      const value = fn()
      if (calls === 2 && stage === 'after') throw new Error('wrapper unavailable')
      return value
    } })
    const result = await f.admission.acquire(f.parent('p')).then(token => ({ token }), error => ({ error }))
    if (result.token) {
      assert.ok(f.active.has(result.token))
      assert.equal(f.admission.release(result.token), true)
    } else {
      assert.ok(result.error)
      assert.equal(f.active.size, 0)
    }
    f.admission.dispose()
    assert.equal(f.active.size, 0)
  }
})

test('wrapper failure during abort or lifecycle teardown closes waiting requests', async () => {
  for (const kind of ['abort', 'lifecycle']) {
    let fail = false
    const f = fixture({ withoutInitiator: fn => { if (fail) throw new Error('disposed context'); return fn() } })
    const p = f.parent('p')
    const token = await f.admission.acquire(p)
    const caller = new AbortController()
    const pending = f.admission.acquire(p, caller.signal)
    const rejected = assert.rejects(pending, /shutting down/)
    fail = true
    if (kind === 'abort') caller.abort()
    else f.lifecycle.abort()
    await rejected
    assert.equal(f.timers.size, 0)
    assert.equal(f.admission.release(token), true)
    assert.equal(f.active.size, 0)
    await assert.rejects(f.admission.acquire(p), /shutting down/)
  }
})

test('wait timers are created without an inherited initiator', async () => {
  let depth = 0
  const f = fixture({
    withoutInitiator: fn => { depth += 1; try { return fn() } finally { depth -= 1 } },
    setTimeout: () => { assert.ok(depth > 0); return 1 },
    clearTimeout() {},
  })
  const p = f.parent('p')
  const token = await f.admission.acquire(p)
  const waiting = f.admission.acquire(p)
  f.admission.release(token)
  f.admission.release(await waiting)
})

test('parent disposal rejects only the exact parent waiters', async () => {
  const f = fixture(); const p = f.parent('shared'); const token = await f.admission.acquire(p)
  const stale = f.admission.acquire(p)
  const replacement = f.parent('shared')
  const next = f.admission.acquire(replacement)
  f.admission.clearParent(p)
  await assert.rejects(stale, /live parent/)
  assert.equal(f.timers.size, 1)
  f.admission.release(token)
  f.admission.release(await next)
  assert.equal(f.timers.size, 0)
})

test('more than one capacity slot never over-admits', async () => {
  const f = fixture({ maxConcurrent: 2, maxPending: 16 }); const p = f.parent('p')
  const one = await f.admission.acquire(p); const two = await f.admission.acquire(p)
  const waiting = Array.from({ length: 16 }, () => f.admission.acquire(p))
  await assert.rejects(f.admission.acquire(p), /worker limit/)
  f.admission.release(one); f.admission.release(two)
  for (const promise of waiting) {
    const token = await promise
    assert.ok(f.active.size <= 2)
    f.admission.release(token)
  }
  assert.equal(f.active.size, 0)
})
