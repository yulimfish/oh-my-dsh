import assert from 'node:assert/strict'
import test from 'node:test'
import { createRouteAdmission } from '../src/route-admission.js'
import { createGlobalAdmission } from '../src/global-admission.js'

test('combined admission releases route and global ownership after startup failure', async () => {
  const active = new Set()
  const pending = []
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    describeRoute: () => ({ bucket: 'a' }),
    isParentLive: () => true,
    onWaitingChange: delta => pending.push(delta),
  })
  const lease = await admission.acquire({ parent: { id: 'a' }, route: { bucket: 'a' }, reserveRoute: () => () => {} })
  admission.releaseRoute(lease)
  admission.release(lease)
  const next = await admission.acquire({ parent: { id: 'b' }, route: { bucket: 'a' }, reserveRoute: () => () => {} })
  assert.ok(next)
  admission.release(next)
  admission.dispose()
  assert.deepEqual(pending, [])
})

test('legacy settled child retains global capacity when disposal fails', async () => {
  const active = new Set()
  active.add('child')
  const run = { id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => { throw new Error('dispose failed') } }
  let disposed = false
  try { await run.dispose(); disposed = true } catch {}
  if (!disposed) active.add('child')
  assert.equal(active.has('child'), true)
})

test('independent route with capacity bypasses another route pending queue', async () => {
  const active = new Set()
  const admission = createRouteAdmission({
    active, maxConcurrent: 2, maxPending: 1,
    describeRoute: route => route,
    isParentLive: () => true,
  })
  const first = await admission.acquire({ parent: { id: 'first' }, route: { bucket: 'a' }, reserveRoute: () => () => {} })
  const waiting = admission.acquire({ parent: { id: 'waiting' }, route: { bucket: 'a' }, reserveRoute: () => { throw new Error('busy') } })
  const second = await admission.acquire({ parent: { id: 'second' }, route: { bucket: 'b' }, canWait: false, reserveRoute: () => () => {} })
  assert.ok(second)
  waiting.catch(() => {})
  admission.release(first)
  admission.release(second)
  admission.dispose()
})

test('withoutInitiator failure after a completed liveness check preserves its result', async () => {
  const active = new Set()
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    describeRoute: () => undefined,
    isParentLive: () => true,
    withoutInitiator: operation => { operation(); throw new Error('wrapper teardown') },
  })
  const lease = await admission.acquire({ parent: { id: 'parent' }, route: undefined, reserveRoute: () => undefined })
  assert.ok(lease)
  admission.release(lease)
  admission.dispose()
})

test('wrapper failure before first liveness reports shutdown instead of stale parent', async () => {
  const active = new Set()
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    describeRoute: () => undefined,
    isParentLive: () => true,
    withoutInitiator: () => { throw new Error('wrapper unavailable') },
  })
  await assert.rejects(admission.acquire({ parent: { id: 'parent' }, route: undefined, reserveRoute: () => undefined }), /shutting down/u)
  assert.equal(active.size, 0)
  admission.dispose()
})

test('initial parent liveness runs without an inherited initiator', async () => {
  const active = new Set()
  let depth = 0
  let maximumDepth = 0
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    describeRoute: () => undefined,
    isParentLive: () => { maximumDepth = Math.max(maximumDepth, depth); return true },
    withoutInitiator: operation => { depth += 1; maximumDepth = Math.max(maximumDepth, depth); try { return operation() } finally { depth -= 1 } },
  })
  const lease = await admission.acquire({ parent: { id: 'isolated' }, route: undefined, reserveRoute: () => undefined })
  assert.ok(lease)
  assert.equal(maximumDepth, 1)
  admission.release(lease)
  admission.dispose()
})

test('same-bucket successors are bounded waiters rather than untimed pending entries', async () => {
  const active = new Set()
  const timers = []
  const admission = createRouteAdmission({
    active, maxConcurrent: 2, maxPending: 1,
    describeRoute: route => route,
    isParentLive: () => true,
    setTimer: callback => { timers.push(callback); return timers.length },
    clearTimer: () => {},
  })
  const first = await admission.acquire({ parent: { id: 'first' }, route: { bucket: 'a' }, reserveRoute: () => () => {} })
  const second = admission.acquire({ parent: { id: 'second' }, route: { bucket: 'a' }, reserveRoute: () => { throw new Error('busy') } })
  const third = admission.acquire({ parent: { id: 'third' }, route: { bucket: 'a' }, reserveRoute: () => () => {} })
  await assert.rejects(third, /pending launch limit/u)
  assert.ok(timers.length >= 1)
  second.catch(() => {})
  admission.release(first)
  admission.dispose()
})

test('pending overflow does not decrement the existing waiter budget', async () => {
  const active = new Set()
  let pending = 0
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    describeRoute: () => ({ bucket: 'a' }),
    isParentLive: () => true,
    onWaitingChange: delta => { pending += delta },
  })
  const first = await admission.acquire({ parent: { id: 'first' }, route: undefined, reserveRoute: () => undefined })
  const waiting = admission.acquire({ parent: { id: 'waiting' }, route: { bucket: 'a' }, reserveRoute: () => undefined })
  await assert.rejects(admission.acquire({ parent: { id: 'overflow' }, route: { bucket: 'a' }, reserveRoute: () => undefined }))
  assert.equal(pending, 1)
  waiting.catch(() => {})
  admission.release(first)
  admission.dispose()
})

test('shared child owner registry rejects duplicate identities across admission types', async () => {
  const active = new Set()
  const owners = new Map()
  const global = createGlobalAdmission({ active, maxConcurrent: 2, maxPending: 1, isParentLive: () => true, sharedChildOwners: owners })
  const route = createRouteAdmission({ active, maxConcurrent: 2, maxPending: 1, describeRoute: () => undefined, isParentLive: () => true, sharedChildOwners: owners })
  const first = await global.acquire({ id: 'uncapped' })
  global.bind(first, 'duplicate')
  const second = await route.acquire({ parent: { id: 'capped' }, route: undefined, reserveRoute: () => undefined })
  assert.throws(() => route.bind(second, 'duplicate'), /already has an admission reservation/u)
  route.release(second)
  global.release(first)
  global.dispose()
  route.dispose()
})
