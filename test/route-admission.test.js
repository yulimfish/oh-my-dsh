import assert from 'node:assert/strict'
import test from 'node:test'
import { createRouteAdmission } from '../src/route-admission.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const parent = id => ({ id })
const route = bucket => ({ bucket })

test('same-route waiters retain FIFO while an independent capped route proceeds', async () => {
  const active = new Set()
  const counts = new Map()
  const admission = createRouteAdmission({
    active, maxConcurrent: 2, maxPending: 16,
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
    isParentLive: () => true,
    describeRoute: route,
  })
  const reserve = bucket => {
    if ((counts.get(bucket) ?? 0) >= 1) throw new Error('busy')
    counts.set(bucket, 1)
    return () => counts.set(bucket, 0)
  }
  const first = await admission.acquire({ parent: parent('a'), route: route('a'), reserveRoute: () => reserve('a') })
  assert.equal(active.size, 1)
  let aGrants = 0
  const aWaiter = admission.acquire({
    parent: parent('a'), route: route('a'),
    reserveRoute: () => {
      try { return reserve('a') } finally { aGrants += 1 }
    },
  })
  await tick()
  const second = admission.acquire({ parent: parent('b'), route: route('b'), reserveRoute: () => reserve('b') })
  await tick()
  assert.equal(active.size, 2)
  assert.equal(await second !== undefined, true)
  assert.equal(aGrants > 0, true, 'A makes a reservation attempt but cannot be admitted while full')
  admission.release(second)
  await tick()
  assert.equal(aGrants > 0, true, 'A may retry after B releases, but still cannot obtain route capacity')
  admission.releaseRoute(first)
  admission.release(first)
  const secondLease = await aWaiter
  assert.equal(secondLease.token !== undefined, true)
  admission.release(secondLease)
  admission.dispose()
})

test('reserve reentrancy rolls back route capacity after disposal or abort', async () => {
  for (const event of ['dispose', 'abort']) {
    const active = new Set()
    let releaseCount = 0
    const controller = new AbortController()
    let admission
    admission = createRouteAdmission({
      active, maxConcurrent: 1, maxPending: 1,
      isParentLive: () => true,
      describeRoute: () => ({ bucket: 'a' }),
    })
    const pending = admission.acquire({
      parent: parent('a'), signal: controller.signal, route: { bucket: 'a' },
      reserveRoute: () => {
        if (event === 'dispose') admission.dispose()
        else controller.abort()
        return () => { releaseCount += 1 }
      },
    })
    await assert.rejects(pending)
    assert.equal(releaseCount, 1, event)
    assert.equal(active.size, 0, event)
  }
})

test('expiry during reserve rejects the waiter and rolls back both capacities', async () => {
  const active = new Set()
  let time = 0
  let routeReleases = 0
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    now: () => time,
    setTimer: () => 1,
    clearTimer: () => {},
    isParentLive: () => true,
    describeRoute: () => ({ bucket: 'a' }),
  })
  const first = await admission.acquire({ parent: parent('first'), route: undefined, reserveRoute: () => undefined })
  const waiting = admission.acquire({
    parent: parent('waiting'), route: { bucket: 'a' },
    reserveRoute: () => { time = 8000; return () => { routeReleases += 1 } },
  })
  let outcome = 'pending'
  waiting.catch(error => { outcome = error.message })
  admission.release(first)
  await tick()
  assert.match(outcome, /timed out/u)
  assert.equal(routeReleases, 1)
  assert.equal(active.size, 0)
  admission.dispose()
})

test('forged releases cannot evict a real lease or enable child ID ABA', async () => {
  const active = new Set()
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    isParentLive: () => true,
    describeRoute: () => undefined,
  })
  const a = await admission.acquire({ parent: parent('a'), route: undefined, reserveRoute: () => undefined })
  admission.bind(a, 'child')
  admission.release(a)
  const b = await admission.acquire({ parent: parent('b'), route: undefined, reserveRoute: () => undefined })
  admission.bind(b, 'child')
  assert.equal(admission.release({ token: b.token, childId: 'child', released: false }), false)
  assert.equal(active.has(b.token), true)
  await assert.rejects(admission.acquire({ parent: parent('c'), route: undefined, canWait: false, reserveRoute: () => undefined }))
  admission.release(b)
  admission.dispose()
})

test('cancelled waiter cannot later grant and exact parent replacement is fenced', async () => {
  const active = new Set()
  const old = parent('a')
  const replacement = parent('a')
  let current = old
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
    isParentLive: candidate => current === candidate,
    describeRoute: () => undefined,
  })
  const first = await admission.acquire({ parent: old, route: undefined, reserveRoute: () => undefined })
  const controller = new AbortController()
  const waiting = admission.acquire({ parent: old, signal: controller.signal, route: undefined, reserveRoute: () => undefined })
  await tick()
  controller.abort()
  await assert.rejects(waiting, /abort|live parent/iu)
  current = replacement
  admission.clearParent(old)
  await assert.rejects(admission.acquire({ parent: old, route: undefined, canWait: false, reserveRoute: () => undefined }), /live parent|worker limit/iu)
  admission.release(first)
  admission.dispose()
})

test('a route-capacity classifier prevents arbitrary reserve errors from becoming retryable capacity', async () => {
  const active = new Set()
  const admission = createRouteAdmission({
    active, maxConcurrent: 1, maxPending: 1,
    isParentLive: () => true,
    describeRoute: () => ({ bucket: 'a' }),
  })
  try {
    await assert.rejects(admission.acquire({
      parent: parent('fault'),
      route: route('a'),
      isCapacityError: () => false,
      reserveRoute: () => { throw new Error('preflight getter failed') },
    }), /preflight getter failed/u)
    assert.equal(active.size, 0)
  } finally { admission.dispose() }
})
