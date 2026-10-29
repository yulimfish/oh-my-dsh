import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingCapacityError } from '../src/global-admission.js'
import { createPendingBackgroundScheduler } from '../src/pending-background.js'
import { createPendingTaskRegistry } from '../src/pending-task-registry.js'

const parent = { id: 'parent-a' }
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(launchTask, options = {}) {
  let scheduler
  let now = 0
  let sequence = 0
  const timers = new Map()
  const failures = []
  const expiries = []
  const registry = createPendingTaskRegistry({
    maxPending: 4,
    now: () => now,
    createId: () => `bg_test-${sequence += 1}`,
    setTimer(callback, delay) {
      const timer = { callback, due: now + delay, unref() {} }
      timers.set(timer, timer)
      return timer
    },
    clearTimer(timer) { timers.delete(timer) },
    withoutInitiator: fn => fn(),
    onChange: snapshot => scheduler?.onRegistryChange(snapshot),
  })
  scheduler = createPendingBackgroundScheduler({
    registry,
    launchTask,
    isParentCurrent: options.isParentCurrent ?? (candidate => candidate === parent),
    withoutInitiator: fn => fn(),
    notifyFailure: (entry, error) => failures.push({ entry, error }),
    notifyExpiry: (entry, details = {}) => { expiries.push({ entry, ...details }); options.notifyExpiry?.(entry, details) },
    interruptChild: options.interruptChild,
  })
  return {
    registry, scheduler, failures, expiries,
    async advance(ms) {
      now += ms
      for (const [timer, value] of [...timers]) {
        if (value.due <= now) {
          timers.delete(timer)
          value.callback()
        }
      }
      await flush()
    },
    dispose: async () => { await scheduler.dispose(); registry.dispose() },
  }
}

test('capacity retries stay queued without spinning and capacity notifications wake one attempt', async () => {
  let attempts = 0
  let settle
  const receivedSkills = []
  const f = fixture(async (args, exec) => {
    receivedSkills.push([...args.load_skills])
    attempts += 1
    if (attempts === 1) throw new PendingCapacityError()
    const run = { id: 'child-one', dispose: async () => {} }
    exec.onPendingRun(run)
    settle = exec.pendingOutcome
    return { status: 'started', childId: run.id }
  })
  const args = { role: 'quick', task: 'work', load_skills: ['a'] }
  const pending = f.scheduler.enqueue(args, { agent: parent })
  args.load_skills[0] = 'caller-mutated'
  try {
    await flush()
    assert.deepEqual(receivedSkills[0], ['a'], 'queued skill selectors are copied before the caller can mutate them')
    await flush()
    assert.equal(attempts, 1, 'capacity rejection does not schedule an immediate retry loop')
    assert.equal(f.registry.read(parent, pending.taskId).status, 'pending')
    f.scheduler.notify()
    await flush()
    assert.equal(attempts, 2)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'running')
    settle('completed')
    assert.equal(f.registry.read(parent, pending.taskId).status, 'completed')
  } finally { await f.dispose() }
})

test('a fast child outcome arriving before bind is buffered and settled accurately', async () => {
  const f = fixture(async (_args, exec) => {
    const run = { id: 'child-fast', dispose: async () => {} }
    exec.onPendingRun(run)
    exec.pendingOutcome('failed')
    return { status: 'started', childId: run.id }
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'fast' }, { agent: parent })
  try {
    await flush()
    assert.equal(f.registry.read(parent, pending.taskId).status, 'failed')
    assert.equal(f.failures.length, 0, 'a child runtime failure is not mislabeled as startup failure')
  } finally { await f.dispose() }
})

test('non-capacity startup failures settle pending records and notify the exact parent', async () => {
  const f = fixture(async () => { throw new Error('host preflight failed') })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'broken' }, { agent: parent })
  try {
    await flush()
    assert.equal(f.registry.read(parent, pending.taskId).status, 'failed')
    assert.equal(f.failures.length, 1)
    assert.equal(f.failures[0].entry.taskId, pending.taskId)
  } finally { await f.dispose() }
})

test('the original caller signal is not retained after enqueue', async () => {
  let attempts = 0
  const f = fixture(async (_args, exec) => {
    attempts += 1
    if (attempts === 1) throw new PendingCapacityError()
    const run = { id: 'child-after-abort', dispose: async () => {} }
    exec.onPendingRun(run)
    return { status: 'started', childId: run.id }
  })
  const controller = new AbortController()
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'detached' }, { agent: parent, signal: controller.signal })
  try {
    await flush()
    controller.abort()
    f.scheduler.notify()
    await flush()
    assert.equal(attempts, 2)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'running')
  } finally { await f.dispose() }
})

test('registry expiry removes a queued scheduler entry before it can launch', async () => {
  let attempts = 0
  const f = fixture(async () => { attempts += 1; throw new PendingCapacityError() })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'expire' }, { agent: parent })
  try {
    await flush()
    assert.equal(attempts, 1)
    await f.advance(30 * 60 * 1000)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'expired')
    assert.equal(f.expiries.length, 1)
    assert.equal(f.expiries[0].entry.taskId, pending.taskId)
    assert.equal(f.expiries[0].startupInProgress, false)
    f.scheduler.notify()
    await flush()
    assert.equal(attempts, 1)
  } finally { await f.dispose() }
})

test('pending expiry stays silent when the exact parent is no longer current', async () => {
  const replacement = { id: parent.id }
  let liveParent = parent
  const f = fixture(async () => { throw new PendingCapacityError() }, {
    isParentCurrent: candidate => candidate === liveParent,
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'expire after parent replacement' }, { agent: parent })
  try {
    await flush()
    liveParent = replacement
    await f.advance(30 * 60 * 1000)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'expired')
    assert.equal(f.expiries.length, 0)
  } finally { await f.dispose() }
})

test('expiry during startup warns that a child may already have been accepted and disposes it', async () => {
  let releaseLaunch
  let disposals = 0
  let disposePromise
  const f = fixture(async (_args, exec) => {
    const run = {
      id: 'child-start-expiry',
      dispose() {
        if (!disposePromise) {
          disposals += 1
          disposePromise = Promise.resolve()
        }
        return disposePromise
      },
    }
    exec.onPendingRun(run)
    await new Promise(resolve => { releaseLaunch = resolve })
    return { status: 'started', childId: run.id }
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'expire during startup' }, { agent: parent })
  try {
    await flush()
    await f.advance(30 * 60 * 1000)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'expired')
    assert.equal(f.expiries.length, 1)
    assert.equal(f.expiries[0].startupInProgress, true)
    assert.equal(disposals, 1)
    releaseLaunch()
    await flush()
    assert.equal(f.failures.length, 0)
    assert.equal(disposals, 1)
  } finally { releaseLaunch?.(); await f.dispose() }
})

test('queued cancellation removes the scheduler entry before launch', async () => {
  let attempts = 0
  const f = fixture(async () => { attempts += 1 })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'cancel before pump' }, { agent: parent })
  try {
    assert.equal(f.scheduler.cancel(parent, pending.taskId).status, 'cancelled')
    await flush()
    assert.equal(attempts, 0)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'cancelled')
  } finally { await f.dispose() }
})

test('starting cancellation disposes the exact late-published run once', async () => {
  let releaseLaunch
  let disposals = 0
  let disposePromise
  let run
  const f = fixture(async (_args, exec) => {
    run = {
      id: 'child-starting-cancel',
      dispose() {
        if (!disposePromise) {
          disposals += 1
          disposePromise = Promise.resolve()
        }
        return disposePromise
      },
    }
    exec.onPendingRun(run)
    await new Promise(resolve => { releaseLaunch = resolve })
    return { status: 'started', childId: run.id }
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'cancel while starting' }, { agent: parent })
  try {
    await flush()
    assert.equal(f.scheduler.cancel(parent, pending.taskId).status, 'cancelled')
    releaseLaunch()
    await flush()
    assert.equal(disposals, 1)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'cancelled')
  } finally { await f.dispose() }
})

test('scheduler disposal drains an in-flight start and its late activation', async () => {
  let releaseLaunch
  let disposals = 0
  let run
  const f = fixture(async (_args, exec) => {
    run = { id: 'child-dispose-late', dispose: async () => { disposals += 1 } }
    exec.onPendingRun(run)
    await new Promise(resolve => { releaseLaunch = resolve })
    return { status: 'started', childId: run.id }
  })
  f.scheduler.enqueue({ role: 'quick', task: 'dispose in flight' }, { agent: parent })
  await flush()
  const draining = f.scheduler.dispose()
  assert.equal(run !== undefined, true)
  releaseLaunch()
  await draining
  assert.equal(disposals, 1)
  f.registry.dispose()
})

test('a route-blocked task does not head-of-line block an independent pending route', async () => {
  let routeAFull = true
  const attempts = []
  const outcomes = new Map()
  const f = fixture(async (args, exec) => {
    attempts.push(args.role)
    if (args.role === 'explore' && routeAFull) throw new PendingCapacityError()
    const run = { id: `child-${args.role}-${attempts.length}`, dispose: async () => {} }
    exec.onPendingRun(run)
    outcomes.set(args.role, exec.pendingOutcome)
    return { status: 'started', childId: run.id }
  })
  const blocked = f.scheduler.enqueue({ role: 'explore', task: 'route A' }, { agent: parent })
  const independent = f.scheduler.enqueue({ role: 'quick', task: 'route B' }, { agent: parent })
  try {
    await flush()
    await flush()
    assert.deepEqual(attempts, ['explore', 'quick'])
    assert.equal(f.registry.read(parent, blocked.taskId).status, 'pending')
    assert.equal(f.registry.read(parent, independent.taskId).status, 'running')

    routeAFull = false
    f.scheduler.notify()
    await flush()
    assert.deepEqual(attempts, ['explore', 'quick', 'explore'])
    assert.equal(f.registry.read(parent, blocked.taskId).status, 'running')

    outcomes.get('quick')('completed')
    outcomes.get('explore')('completed')
    await flush()
    assert.equal(f.registry.read(parent, blocked.taskId).status, 'completed')
    assert.equal(f.registry.read(parent, independent.taskId).status, 'completed')
  } finally { await f.dispose() }
})

test('a Host child ID with the pending prefix is valid when it is a distinct ID', async () => {
  let recordOutcome
  const f = fixture(async (_args, exec) => {
    const run = { id: 'bg_host-child', dispose: async () => {} }
    exec.onPendingRun(run)
    recordOutcome = exec.pendingOutcome
    return { status: 'started', childId: run.id }
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'prefixed Host ID' }, { agent: parent })
  try {
    await flush()
    assert.equal(f.registry.read(parent, pending.taskId).status, 'running')
    assert.equal(pending.taskId, 'bg_test-1')
    assert.notEqual(pending.taskId, 'bg_host-child')
    assert.equal(f.failures.length, 0)
    recordOutcome('completed')
    await flush()
    assert.equal(f.registry.read(parent, pending.taskId).status, 'completed')
  } finally { await f.dispose() }
})

test('a Host child ID colliding with a pending task ID fails and disposes the run', async () => {
  let disposals = 0
  const f = fixture(async (_args, exec) => {
    const run = { id: exec.pendingTaskId, dispose: async () => { disposals += 1 } }
    exec.onPendingRun(run)
    return { status: 'started', childId: run.id }
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'colliding child ID' }, { agent: parent })
  try {
    await flush()
    assert.equal(disposals, 1)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'failed')
    assert.equal(f.failures.length, 1)
  } finally { await f.dispose() }
})

test('bound pending cancellation requests one fire-and-return child interrupt for the exact parent', async () => {
  let outcome
  let childSignal
  let disposals = 0
  const interruptions = []
  const f = fixture(async (_args, exec) => {
    childSignal = exec.signal
    const run = { id: 'child-bound-interrupt', dispose: async () => { disposals += 1 } }
    exec.onPendingRun(run)
    outcome = exec.pendingOutcome
    return { status: 'started', childId: run.id }
  }, {
    interruptChild: (childId, authorizingParent) => interruptions.push({ childId, parent: authorizingParent }),
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'interrupt bound child' }, { agent: parent })
  try {
    await flush()
    assert.equal(f.registry.read(parent, pending.taskId).status, 'running')

    const result = f.scheduler.cancel(parent, pending.taskId)
    assert.deepEqual(result, { id: pending.taskId, status: 'interrupt-requested' })
    assert.equal(Object.hasOwn(result, 'childId'), false)
    assert.deepEqual(interruptions, [{ childId: 'child-bound-interrupt', parent }])
    assert.equal(childSignal.aborted, false, 'the Host interruption request is distinct from aborting the scheduler signal')
    assert.equal(disposals, 0, 'a bound child is not disposed as a substitute for Host interruption')
    assert.deepEqual(f.scheduler.cancel(parent, pending.taskId), result)
    assert.equal(interruptions.length, 1, 'repeat requests do not reissue the Host interruption')
    assert.equal(f.registry.read(parent, pending.taskId).status, 'running', 'request acceptance is not child settlement')

    outcome('failed')
    assert.equal(f.registry.read(parent, pending.taskId).status, 'failed')
    assert.equal(disposals, 0, 'the scheduler does not dispose the bound child when receiving settlement')
  } finally { await f.dispose() }
})

test('bound pending interruption fails closed after same-ID parent replacement', async () => {
  let liveParent = parent
  let outcome
  const interruptions = []
  const f = fixture(async (_args, exec) => {
    const run = { id: 'child-stale-parent-interrupt', dispose: async () => {} }
    exec.onPendingRun(run)
    outcome = exec.pendingOutcome
    return { status: 'started', childId: run.id }
  }, {
    isParentCurrent: candidate => candidate === liveParent,
    interruptChild: (childId, authorizingParent) => interruptions.push({ childId, parent: authorizingParent }),
  })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'stale parent must not interrupt' }, { agent: parent })
  try {
    await flush()
    assert.equal(f.registry.read(parent, pending.taskId).status, 'running')
    liveParent = { id: parent.id }

    assert.equal(f.scheduler.cancel(parent, pending.taskId), undefined)
    assert.deepEqual(interruptions, [])
    assert.equal(f.registry.read(parent, pending.taskId).status, 'running')
    outcome('completed')
    assert.equal(f.registry.read(parent, pending.taskId).status, 'completed')
  } finally { await f.dispose() }
})

test('stale exact parent after activation cancels the pending record and disposes the run', async () => {
  const replacement = { id: parent.id }
  let liveParent = parent
  let disposals = 0
  const f = fixture(async (_args, exec) => {
    const run = { id: 'child-parent-replaced', dispose: async () => { disposals += 1 } }
    exec.onPendingRun(run)
    liveParent = replacement
    return { status: 'started', childId: run.id }
  }, { isParentCurrent: candidate => candidate === liveParent })
  const pending = f.scheduler.enqueue({ role: 'quick', task: 'same-id parent replacement' }, { agent: parent })
  try {
    await flush()
    assert.equal(disposals, 1)
    assert.equal(f.registry.read(parent, pending.taskId).status, 'cancelled')
    assert.equal(f.failures.length, 0)
  } finally { await f.dispose() }
})
