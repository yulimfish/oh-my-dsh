import assert from 'node:assert/strict'
import test from 'node:test'
import { createPendingBackgroundScheduler } from '../src/pending-background.js'
import { createPendingTaskCancelTool, createPendingTaskStatusTool } from '../src/pending-task-tools.js'
import { createPendingTaskRegistry } from '../src/pending-task-registry.js'

function fixture() {
  let sequence = 0
  let current = 1
  const timers = new Map()
  const registry = createPendingTaskRegistry({
    now: () => current,
    createId: () => `bg_pending-tool-${sequence += 1}`,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }
      timers.set(timer, timer)
      return timer
    },
    clearTimer(timer) { timers.delete(timer) },
  })
  const parent = Object.freeze({ id: 'pending-tools-parent' })
  return {
    registry, parent,
    statusTool: createPendingTaskStatusTool(registry),
    cancelTool: createPendingTaskCancelTool({ cancel: (agent, taskId) => registry.cancel(agent, taskId) }),
    enqueue: () => registry.enqueue(parent),
    close: () => registry.dispose(),
    setNow: value => { current = value },
  }
}

test('pending status reads only the exact Agent lifecycle and never exposes a child ID', async () => {
  const f = fixture()
  try {
    const pending = f.enqueue()
    assert.deepEqual(await f.statusTool.execute({ taskId: pending.id }, { agent: f.parent }), {
      taskId: pending.id, status: 'pending',
    })
    f.registry.start(f.parent, pending.id, 'child-bound-1')
    const running = await f.statusTool.execute({ taskId: pending.id }, { agent: f.parent })
    assert.deepEqual(running, { taskId: pending.id, status: 'running' })
    assert.equal(Object.hasOwn(running, 'childId'), false)
    assert.doesNotMatch(f.statusTool.output.render({ taskId: pending.id }, running)[0].text, /child-bound-1/u)
    f.registry.settle(f.parent, pending.id, 'completed')
    assert.equal((await f.statusTool.execute({ taskId: pending.id }, { agent: f.parent })).status, 'completed')
  } finally { f.close() }
})

test('pending status rejects malformed, expired, and cross-Agent lookups', async () => {
  const f = fixture()
  try {
    const pending = f.enqueue()
    await assert.rejects(f.statusTool.execute({ taskId: pending.id }, { agent: { id: f.parent.id } }), /No unexpired pending task/u)
    await assert.rejects(f.statusTool.execute({ taskId: 'child-1' }, { agent: f.parent }), /bounded pending taskId/u)
    await assert.rejects(f.statusTool.execute({ taskId: pending.id, extra: true }, { agent: f.parent }), /bounded pending taskId/u)
    await assert.rejects(f.statusTool.execute({ taskId: pending.id }, { agent: f.parent, signal: AbortSignal.abort() }), /cancelled before it ran/u)
    f.registry.cancel(f.parent, pending.id)
    f.setNow(600_001)
    await assert.rejects(f.statusTool.execute({ taskId: pending.id }, { agent: f.parent }), /No unexpired pending task/u)
  } finally { f.close() }
})

test('queued pending cancellation stays exact-Agent-owned and warns about startup uncertainty', async () => {
  const f = fixture()
  try {
    const pending = f.enqueue()
    await assert.rejects(f.cancelTool.execute({ taskId: pending.id }, { agent: { id: f.parent.id } }), /No queued\/starting task/u)
    const result = await f.cancelTool.execute({ taskId: pending.id }, { agent: f.parent })
    assert.deepEqual(result, { taskId: pending.id, status: 'cancelled' })
    assert.match(f.cancelTool.output.render({ taskId: pending.id }, result)[0].text, /does not prove the child stopped/u)
    assert.equal(f.registry.read(f.parent, pending.id).status, 'cancelled')
  } finally { f.close() }
})

test('pending cancel refuses bound children without Host interruption and rejects malformed or aborted requests', async () => {
  const f = fixture()
  try {
    const pending = f.enqueue()
    f.registry.start(f.parent, pending.id, 'child-bound-2')
    await assert.rejects(f.cancelTool.execute({ taskId: pending.id }, { agent: f.parent }), /already bound/u)
    await assert.rejects(f.cancelTool.execute({ taskId: 'child-bound-2' }, { agent: f.parent }), /bounded pending taskId/u)
    await assert.rejects(f.cancelTool.execute({ taskId: pending.id }, { agent: f.parent, signal: AbortSignal.abort() }), /cancelled before it ran/u)
  } finally { f.close() }
})

test('pending cancel reports a bound-child interruption request without exposing the child ID', async () => {
  const f = fixture()
  const interruptions = []
  let disposals = 0
  const scheduler = createPendingBackgroundScheduler({
    registry: f.registry,
    launchTask: async (_args, exec) => {
      const run = { id: 'child-private-pending-cancel', dispose: async () => { disposals += 1 } }
      exec.onPendingRun(run)
      return { status: 'started', childId: run.id }
    },
    isParentCurrent: candidate => candidate === f.parent,
    interruptChild: (childId, parent) => interruptions.push({ childId, parent }),
  })
  const cancelTool = createPendingTaskCancelTool(scheduler)
  const pending = scheduler.enqueue({ role: 'quick', task: 'interrupt this bound child' }, { agent: f.parent })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.registry.read(f.parent, pending.taskId).status, 'running')

    const result = await cancelTool.execute({ taskId: pending.taskId }, { agent: f.parent })
    assert.deepEqual(result, { taskId: pending.taskId, status: 'interrupt-requested' })
    assert.equal(Object.hasOwn(result, 'childId'), false)
    assert.deepEqual(interruptions, [{
      childId: 'child-private-pending-cancel',
      parent: f.parent,
    }])
    const rendered = cancelTool.output.render({ taskId: pending.taskId }, result)[0].text
    assert.match(rendered, /may continue until it observes the request/u)
    assert.doesNotMatch(rendered, /child-private-pending-cancel/u)
    assert.equal(f.registry.read(f.parent, pending.taskId).status, 'running')
    assert.equal(disposals, 0)
  } finally {
    await scheduler.dispose()
    f.close()
  }
})

test('pending cancel uses the real scheduler and leaves starting foreign-owner or bound children untouched', async () => {
  const f = fixture()
  let childSignal
  let disposeCount = 0
  let releaseLaunch
  let markLaunchStarted
  const launchStarted = new Promise(resolve => { markLaunchStarted = resolve })
  const launchResult = new Promise(resolve => { releaseLaunch = resolve })
  const run = { id: 'child-real-scheduler', dispose: async () => { disposeCount += 1 } }
  const scheduler = createPendingBackgroundScheduler({
    registry: f.registry,
    launchTask: async (_args, exec) => {
      childSignal = exec.signal
      exec.onPendingRun(run)
      markLaunchStarted()
      return launchResult
    },
    isParentCurrent: candidate => candidate === f.parent,
    withoutInitiator: fn => fn(),
  })
  const cancelTool = createPendingTaskCancelTool(scheduler)
  const pending = scheduler.enqueue({ role: 'quick', task: 'keep the bound child alive' }, { agent: f.parent })
  try {
    await launchStarted
    assert.ok(childSignal)
    assert.equal(f.registry.read(f.parent, pending.taskId).status, 'pending')

    await assert.rejects(cancelTool.execute({ taskId: pending.taskId }, { agent: { id: f.parent.id } }), /No queued\/starting task/u)
    assert.equal(childSignal.aborted, false)
    assert.equal(disposeCount, 0)
    assert.equal(f.registry.read(f.parent, pending.taskId).status, 'pending')

    releaseLaunch({ status: 'started', childId: run.id })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.registry.read(f.parent, pending.taskId).status, 'running')

    await assert.rejects(cancelTool.execute({ taskId: pending.taskId }, { agent: f.parent }), /already bound/u)
    assert.equal(childSignal.aborted, false)
    assert.equal(disposeCount, 0)
    assert.equal(f.registry.read(f.parent, pending.taskId).status, 'running')
  } finally {
    await new Promise(resolve => setImmediate(resolve))
    releaseLaunch?.({ status: 'started', childId: run.id })
    await scheduler.dispose()
    f.close()
  }
})
