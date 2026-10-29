import assert from 'node:assert/strict'
import test from 'node:test'
import { createPendingTaskRegistry, PENDING_TASK_ID_PREFIX } from '../src/pending-task-registry.js'

function fixture(options = {}) {
  let current = 0
  let sequence = 0
  const timers = new Map()
  const cleared = []
  const changes = []
  const registry = createPendingTaskRegistry({
    now: () => current,
    createId: options.createId ?? (() => `bg_test-${sequence += 1}`),
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }
      timers.set(timer, timer)
      return timer
    },
    clearTimer(timer) {
      cleared.push(timer)
      timers.delete(timer)
    },
    withoutInitiator: fn => fn(),
    onChange: snapshot => changes.push(snapshot),
    ...options,
  })
  return {
    registry, changes, timers, cleared,
    advance(ms) {
      current += ms
      for (const timer of [...timers.keys()]) {
        if (timer.delay <= current) {
          timers.delete(timer)
          timer.callback()
        }
      }
    },
    now: () => current,
  }
}

const parent = { id: 'parent-a' }

test('allocates independent bounded pending IDs and isolates exact Agent ownership', () => {
  const f = fixture()
  const first = f.registry.enqueue(parent)
  assert.match(first.id, new RegExp(`^${PENDING_TASK_ID_PREFIX}`))
  assert.equal(first.status, 'pending')
  assert.equal(first.childId, undefined)
  assert.equal(f.registry.pendingCount(), 1)
  assert.equal(f.registry.read({ id: parent.id }, first.id), undefined)
  assert.equal(f.registry.read({ ...parent }, first.id), undefined)
  assert.deepEqual(f.registry.list({ ...parent }), [])
  assert.equal(f.registry.cancel({ ...parent }, first.id), undefined)
  assert.equal(f.registry.pendingCount(), 1)
})

test('invalid enqueue attempts do not retain empty parent records', () => {
  const f = fixture()
  for (let index = 0; index < 64; index += 1) {
    assert.throws(() => f.registry.enqueue({ id: `invalid-parent-${index}` }, { signal: null }), /invalid cancellation signal/u)
  }
  const liveParent = { id: 'still-live' }
  assert.equal(f.registry.enqueue(liveParent).status, 'pending')
  assert.equal(f.registry.pendingCount(liveParent), 1)
})

test('enforces per-parent and total retained capacities without evicting live pending work', () => {
  const f = fixture({ maxPending: 1, maxRetained: 1 })
  const other = { id: 'parent-b' }
  f.registry.enqueue(parent)
  assert.throws(() => f.registry.enqueue(other), /capacity/u)
  assert.equal(f.registry.pendingCount(), 1)
  f.registry.cancel(parent, 'bg_test-1')
  assert.throws(() => f.registry.enqueue(other), /capacity/u)
  f.advance(600_000)
  f.registry.enqueue(other)
  assert.equal(f.registry.pendingCount(), 1)
  assert.equal(f.registry.pendingCount(other), 1)
})

test('retries ID collisions only a bounded number of times', () => {
  const f = fixture({ createId: () => 'bg_collision' })
  f.registry.enqueue(parent)
  assert.throws(() => f.registry.enqueue({ id: 'parent-b' }), /unique pending task ID/u)
  assert.equal(f.registry.size(), 1)
})

test('pending cancellation is terminal and never binds or starts a child', () => {
  const f = fixture()
  const pending = f.registry.enqueue(parent)
  const cancelled = f.registry.cancel(parent, pending.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.childId, undefined)
  assert.equal(f.registry.start(parent, pending.id, 'child-1'), undefined)
  assert.equal(f.registry.cancel(parent, pending.id), undefined)
  assert.equal(f.registry.pendingCount(), 0)
  assert.equal(f.registry.read(parent, pending.id).status, 'cancelled')
})

test('abort signal cancels only pending work and is detached on start', () => {
  const f = fixture()
  const controller = new AbortController()
  const pending = f.registry.enqueue(parent, { signal: controller.signal })
  const started = f.registry.start(parent, pending.id, 'child-1')
  assert.equal(started.status, 'running')
  controller.abort()
  assert.equal(f.registry.read(parent, pending.id).status, 'running')
  assert.equal(f.registry.settle(parent, pending.id, 'completed').status, 'completed')
})

test('child identity binds once and cannot be reused by another task', () => {
  const f = fixture()
  const first = f.registry.enqueue(parent)
  const second = f.registry.enqueue(parent)
  assert.equal(f.registry.start(parent, first.id, 'child-1').childId, 'child-1')
  assert.equal(f.registry.start(parent, first.id, 'child-2'), undefined)
  assert.equal(f.registry.start(parent, second.id, 'child-1'), undefined)
  assert.equal(f.registry.start(parent, second.id, 'child-2').childId, 'child-2')
})

test('settlement accepts one terminal outcome and rejects double settlement', () => {
  const f = fixture()
  const pending = f.registry.enqueue(parent)
  f.registry.start(parent, pending.id, 'child-1')
  const completed = f.registry.settle(parent, pending.id, 'completed')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.childId, 'child-1')
  assert.equal(f.registry.settle(parent, pending.id, 'failed'), undefined)
  assert.equal(f.registry.cancel(parent, pending.id), undefined)
})

test('pending expiry becomes bounded terminal retention and then disappears', () => {
  const f = fixture({ pendingTtlMs: 100, terminalTtlMs: 50 })
  const pending = f.registry.enqueue(parent)
  f.advance(100)
  assert.equal(f.registry.read(parent, pending.id).status, 'expired')
  assert.equal(f.registry.start(parent, pending.id, 'child-1'), undefined)
  f.advance(50)
  assert.equal(f.registry.read(parent, pending.id), undefined)
  assert.equal(f.registry.size(), 0)
  assert.equal(f.timers.size, 0)
})

test('running work has no pending TTL and terminal retention is cleared on settlement', () => {
  const f = fixture({ pendingTtlMs: 100, terminalTtlMs: 50 })
  const pending = f.registry.enqueue(parent)
  f.registry.start(parent, pending.id, 'child-1')
  f.advance(1_000)
  assert.equal(f.registry.read(parent, pending.id).status, 'running')
  f.registry.settle(parent, pending.id, 'failed')
  f.advance(50)
  assert.equal(f.registry.read(parent, pending.id), undefined)
})

test('clearAgent cancels queued records and returns running tasks for external ownership', () => {
  const f = fixture()
  const queued = f.registry.enqueue(parent)
  const running = f.registry.enqueue(parent)
  f.registry.start(parent, running.id, 'child-running')
  const detached = f.registry.clearAgent(parent)
  assert.equal(detached.length, 1)
  assert.equal(detached[0].childId, 'child-running')
  assert.equal(detached[0].status, 'running')
  assert.equal(f.registry.read(parent, queued.id), undefined)
  assert.equal(f.registry.read(parent, running.id), undefined)
  assert.equal(f.registry.pendingCount(), 0)
  assert.throws(() => f.registry.enqueue(parent), /exact live parent/u)
})

test('same-ID replacement cannot access or cancel the old Agent tasks', () => {
  const f = fixture()
  const pending = f.registry.enqueue(parent)
  const replacement = { id: parent.id }
  assert.equal(f.registry.read(replacement, pending.id), undefined)
  assert.equal(f.registry.cancel(replacement, pending.id), undefined)
  assert.throws(() => f.registry.enqueue(replacement), /exact live parent/u)
  assert.equal(f.registry.read(parent, pending.id).status, 'pending')
})

test('dispose cancels pending work, detaches running work and is idempotent', () => {
  const f = fixture()
  f.registry.enqueue(parent)
  const running = f.registry.enqueue(parent)
  f.registry.start(parent, running.id, 'child-running')
  const detached = f.registry.dispose()
  assert.equal(detached.length, 1)
  assert.equal(detached[0].status, 'running')
  assert.equal(f.registry.size(), 0)
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.registry.dispose(), [])
  assert.throws(() => f.registry.enqueue(parent), /exact live parent/u)
})

test('timer and observer failures do not corrupt lifecycle state', () => {
  const f = fixture({
    setTimer: () => { throw new Error('timer unavailable') },
    onChange: () => { throw new Error('observer unavailable') },
    pendingTtlMs: 100,
    terminalTtlMs: 50,
  })
  const pending = f.registry.enqueue(parent)
  assert.equal(f.registry.read(parent, pending.id).status, 'pending')
  f.advance(100)
  assert.equal(f.registry.read(parent, pending.id).status, 'expired')
  f.advance(50)
  assert.equal(f.registry.read(parent, pending.id), undefined)
})

test('running notification disposal cannot leave a stale child owner behind', () => {
  let registry
  const f = fixture({
    onChange: snapshot => {
      if (snapshot.status === 'running') registry.dispose()
    },
  })
  registry = f.registry
  const pending = registry.enqueue(parent)
  registry.start(parent, pending.id, 'child-running')
  assert.equal(registry.size(), 0)
  assert.equal(registry.start(parent, pending.id, 'child-running'), undefined)
  assert.throws(() => registry.enqueue({ id: 'parent-b' }), /exact live parent/u)
})

test('synchronous abort during listener registration returns no task ID', () => {
  const f = fixture()
  const controller = new AbortController()
  const signal = {
    aborted: false,
    addEventListener(_name, callback) {
      this.aborted = true
      callback()
    },
    removeEventListener() {},
  }
  assert.throws(() => f.registry.enqueue(parent, { signal }), error => error?.name === 'AbortError')
  assert.equal(f.registry.size(), 0)
  assert.equal(f.registry.pendingCount(), 0)
})

test('pending IDs cannot alias child IDs but a distinct child may use the same prefix', () => {
  const f = fixture()
  const pending = f.registry.enqueue(parent)
  assert.equal(f.registry.start(parent, pending.id, pending.id), undefined)
  assert.equal(f.registry.read(parent, pending.id).status, 'pending')
  assert.equal(f.registry.start(parent, pending.id, 'bg_host-child').status, 'running')
})

test('terminal notification disposal leaves no task, timer or child ownership residue', () => {
  let registry
  const f = fixture({
    onChange: snapshot => {
      if (snapshot.status === 'completed') registry.dispose()
    },
  })
  registry = f.registry
  const pending = registry.enqueue(parent)
  registry.start(parent, pending.id, 'child-running')
  assert.equal(registry.settle(parent, pending.id, 'completed').status, 'completed')
  assert.equal(registry.size(), 0)
  assert.equal(f.timers.size, 0)
  assert.equal(registry.start(parent, pending.id, 'child-running'), undefined)
})

test('parent-clear notification cannot resurrect a pending entry', () => {
  let registry
  const f = fixture({
    onChange: snapshot => {
      if (snapshot.status === 'cancelled') registry.clearAgent(parent)
    },
  })
  registry = f.registry
  const pending = registry.enqueue(parent)
  assert.equal(registry.clearAgent(parent).length, 0)
  assert.equal(registry.read(parent, pending.id), undefined)
  assert.equal(registry.size(), 0)
  assert.equal(f.timers.size, 0)
})

test('reentrant clearAgent cannot erase a replacement or detach running work twice', () => {
  let registry
  let replacement
  let nested
  const replacementOwner = { id: parent.id }
  const f = fixture({
    onChange: snapshot => {
      if (snapshot.status !== 'cancelled' || nested) return
      nested = registry.clearAgent(parent)
      replacement = registry.enqueue(replacementOwner)
    },
  })
  registry = f.registry
  registry.enqueue(parent)
  const running = registry.enqueue(parent)
  registry.start(parent, running.id, 'child-running')
  const detached = registry.clearAgent(parent)
  assert.equal(nested.length, 0)
  assert.equal(detached.length, 1)
  assert.equal(registry.pendingCount(), 1)
  assert.equal(registry.pendingCount(replacement && { id: parent.id }), 0)
  assert.equal(registry.read(replacementOwner, replacement.id).status, 'pending')
  assert.equal(registry.cancel(replacementOwner, replacement.id).status, 'cancelled')
})

test('dispose reentrancy cannot hand the same running child to clearAgent and dispose', () => {
  let registry
  let nested
  const f = fixture({
    onChange: snapshot => {
      if (snapshot.status === 'cancelled' && !nested) nested = registry.clearAgent(parent)
    },
  })
  registry = f.registry
  registry.enqueue(parent)
  const running = registry.enqueue(parent)
  registry.start(parent, running.id, 'child-running')
  const detached = registry.dispose()
  assert.equal(nested.length, 0)
  assert.equal(detached.length, 1)
  assert.equal(registry.size(), 0)
})

test('validates setup bounds and malformed operations', () => {
  assert.throws(() => createPendingTaskRegistry({ maxPending: 0 }), /maxPending/u)
  assert.throws(() => createPendingTaskRegistry({ maxRetained: 0 }), /maxRetained/u)
  assert.throws(() => createPendingTaskRegistry({ pendingTtlMs: 0 }), /pendingTtlMs/u)
  assert.throws(() => createPendingTaskRegistry({ terminalTtlMs: 0 }), /terminalTtlMs/u)
  assert.throws(() => createPendingTaskRegistry({ now: null }), /callbacks/u)
  const f = fixture()
  assert.throws(() => f.registry.enqueue(parent, { signal: {} }), /invalid cancellation signal/u)
  assert.equal(f.registry.start(parent, 'not-a-pending-id', 'child'), undefined)
  assert.equal(f.registry.read(parent, 'not-a-pending-id'), undefined)
})
