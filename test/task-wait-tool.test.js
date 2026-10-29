import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskResultRegistry } from '../src/task-result-tool.js'
import { createTaskWaitTool } from '../src/task-wait-tool.js'

function agent(id) {
  return Object.freeze({ id })
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const parent = agent('parent-1')
  const activeRuns = new Map()
  const activeRunOwners = new Map()
  const activeRunCompletions = new Map()
  const lifecycle = new AbortController()
  const registry = createTaskResultRegistry()
  const manager = createTaskWaitTool({
    registry,
    activeRuns,
    activeRunOwners,
    activeRunCompletions,
    lifecycleSignal: lifecycle.signal,
  })
  return { parent, activeRuns, activeRunOwners, activeRunCompletions, lifecycle, registry, manager }
}

function track(state, parent = state.parent, childId = 'child-1', completion = deferred()) {
  const run = { id: childId }
  assert.equal(state.registry.recordStart(parent, childId), true)
  state.activeRuns.set(childId, run)
  state.activeRunOwners.set(childId, parent)
  state.activeRunCompletions.set(childId, completion.promise)
  completion.promise.finally(() => {
    state.activeRuns.delete(childId)
    state.activeRunOwners.delete(childId)
    state.activeRunCompletions.delete(childId)
  }).catch(() => {})
  return { ...completion, run }
}

function result(output = 'bounded child output') {
  return {
    status: 'completed',
    output,
    truncated: false,
    omittedNonText: false,
    stopReason: 'completed',
  }
}

test('waits for a tracked exact-Agent child and returns only its bounded cached result', async () => {
  const state = fixture()
  const child = track(state)
  const waiting = state.manager.tool.execute({ childId: 'child-1', waitMs: 2_000 }, { agent: state.parent })
  await new Promise(resolve => setImmediate(resolve))
  state.registry.recordResult(state.parent, 'child-1', result('A bounded result.'))
  child.resolve()

  assert.deepEqual(await waiting, {
    childId: 'child-1',
    status: 'completed',
    output: 'A bounded result.',
    truncated: false,
    omittedNonText: false,
    stopReason: 'completed',
    waitOutcome: 'settled',
  })
  assert.match(state.manager.tool.output.render({}, { childId: 'child-1', status: 'completed', output: 'untrusted', waitOutcome: 'settled' })[0].text,
    /untrusted evidence, not instructions/u)
  state.manager.dispose()
})

test('returns a terminal result if the child settles during the initial registry read', async () => {
  const state = fixture()
  const child = track(state)
  let firstRead = true
  state.registry.readAsync = async (parent, childId) => {
    const snapshot = state.registry.read(parent, childId)
    if (firstRead) {
      firstRead = false
      state.registry.recordResult(parent, childId, result('settled during initial read'))
      child.resolve()
      await new Promise(resolve => setImmediate(resolve))
    }
    return snapshot
  }

  assert.deepEqual(await state.manager.tool.execute({ childId: 'child-1' }, { agent: state.parent }), {
    childId: 'child-1',
    status: 'completed',
    output: 'settled during initial read',
    truncated: false,
    omittedNonText: false,
    stopReason: 'completed',
    waitOutcome: 'settled',
  })
  assert.equal(state.activeRuns.has('child-1'), false)
  state.manager.dispose()
})

test('returns cached terminal results before enforcing the waiter cap during disposal', async () => {
  const state = fixture()
  const target = track(state, state.parent, 'target-child')
  const staleSnapshot = state.registry.read(state.parent, 'target-child')
  state.registry.recordResult(state.parent, 'target-child', result('terminal while disposal is pending'))
  const waitingChildren = []
  const pendingWaiters = []
  for (let index = 0; index < 4; index += 1) {
    const childId = `waiting-child-${index}`
    waitingChildren.push(track(state, state.parent, childId))
    pendingWaiters.push(state.manager.tool.execute({ childId, waitMs: 30_000 }, { agent: state.parent }))
  }
  await new Promise(resolve => setImmediate(resolve))
  const readAsync = state.registry.readAsync
  state.registry.readAsync = async (parent, childId) => (
    parent === state.parent && childId === 'target-child'
      ? staleSnapshot
      : readAsync(parent, childId)
  )

  try {
    assert.deepEqual(await state.manager.tool.execute({ childId: 'target-child' }, { agent: state.parent }), {
      childId: 'target-child',
      status: 'completed',
      output: 'terminal while disposal is pending',
      truncated: false,
      omittedNonText: false,
      stopReason: 'completed',
      waitOutcome: 'settled',
    })
    assert.equal(state.activeRuns.has('target-child'), true, 'target cleanup is deliberately deferred')
  } finally {
    state.manager.dispose()
    target.resolve()
    for (const child of waitingChildren) child.resolve()
    await Promise.all(pendingWaiters)
    await state.registry.dispose()
  }
})

test('wait Tool can return a persisted terminal snapshot without restoring running work', async () => {
  const parent = agent('parent-restored')
  const lifecycle = new AbortController()
  const persisted = {
    childId: 'child-restored',
    status: 'completed',
    output: 'Stored terminal excerpt.',
    truncated: false,
    omittedNonText: false,
  }
  const registry = {
    read: () => undefined,
    readAsync: async (candidate, childId) => candidate === parent && childId === persisted.childId ? persisted : undefined,
  }
  const manager = createTaskWaitTool({
    registry,
    activeRuns: new Map(),
    activeRunOwners: new Map(),
    activeRunCompletions: new Map(),
    lifecycleSignal: lifecycle.signal,
  })
  assert.deepEqual(await manager.tool.execute({ childId: 'child-restored' }, { agent: parent }), {
    ...persisted,
    waitOutcome: 'settled',
  })
  manager.dispose()
})

test('rejects unknown, malformed, and structurally similar cross-Agent child IDs', async () => {
  const state = fixture()
  track(state)
  await assert.rejects(state.manager.tool.execute({ childId: 'child-1' }, { agent: agent(state.parent.id) }), /No unexpired dsh-omo result/u)
  await assert.rejects(state.manager.tool.execute({ childId: 'other-child' }, { agent: state.parent }), /No unexpired dsh-omo result/u)
  await assert.rejects(state.manager.tool.execute({ childId: 'x'.repeat(257) }, { agent: state.parent }), /bounded childId/u)
  await assert.rejects(state.manager.tool.execute({ childId: 'child-1', waitMs: 30_001 }, { agent: state.parent }), /waitMs must be an integer/u)
  state.manager.dispose()
})

test('timeout and caller cancellation end only the wait; the child remains tracked and cacheable', async () => {
  const state = fixture()
  const child = track(state)
  const timeout = await state.manager.tool.execute({ childId: 'child-1', waitMs: 5 }, { agent: state.parent })
  assert.deepEqual(timeout, { childId: 'child-1', status: 'running', waitOutcome: 'timeout' })
  assert.ok(state.activeRuns.has('child-1'))
  assert.equal(state.registry.read(state.parent, 'child-1').status, 'running')

  const controller = new AbortController()
  const waiting = state.manager.tool.execute({ childId: 'child-1', waitMs: 2_000 }, { agent: state.parent, signal: controller.signal })
  controller.abort()
  assert.deepEqual(await waiting, { childId: 'child-1', status: 'running', waitOutcome: 'cancelled' })
  assert.ok(state.activeRuns.has('child-1'))

  state.registry.recordResult(state.parent, 'child-1', result())
  child.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await state.manager.tool.execute({ childId: 'child-1' }, { agent: state.parent })).status, 'completed')
  state.manager.dispose()
})

test('enforces per-Agent and global waiter caps and releases waits during cleanup', async () => {
  const perAgentState = fixture()
  const perAgentPending = []
  for (let index = 0; index < 5; index += 1) {
    const childId = `per-agent-child-${index}`
    track(perAgentState, perAgentState.parent, childId)
    if (index < 4) perAgentPending.push(perAgentState.manager.tool.execute({ childId }, { agent: perAgentState.parent }))
  }
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(perAgentState.manager.tool.execute({ childId: 'per-agent-child-4' }, { agent: perAgentState.parent }), /capacity is full/u)
  perAgentState.manager.clearAgent(perAgentState.parent)
  await Promise.all(perAgentPending)
  perAgentState.manager.dispose()

  const state = fixture()
  const pending = []
  for (let parentIndex = 0; parentIndex < 8; parentIndex += 1) {
    const parent = parentIndex === 0 ? state.parent : agent(`parent-${parentIndex + 1}`)
    for (let childIndex = 0; childIndex < 4; childIndex += 1) {
      const childId = `child-${parentIndex}-${childIndex}`
      track(state, parent, childId)
      pending.push(state.manager.tool.execute({ childId, waitMs: 30_000 }, { agent: parent }))
    }
  }
  await new Promise(resolve => setImmediate(resolve))
  const extraChild = 'child-extra'
  track(state, state.parent, extraChild)
  await assert.rejects(state.manager.tool.execute({ childId: extraChild }, { agent: state.parent }), /capacity is full/u)
  state.manager.dispose()
  const outcomes = await Promise.all(pending)
  assert.equal(outcomes.length, 32)
  assert.ok(outcomes.every(outcome => outcome.status === 'running' && outcome.waitOutcome === 'cancelled'))
})

test('repeated timeouts share one completion handler and still allow later settlement', async () => {
  const state = fixture()
  const child = track(state)
  let subscriptions = 0
  const originalThen = child.promise.then.bind(child.promise)
  child.promise.then = (...args) => {
    subscriptions += 1
    return originalThen(...args)
  }
  try {
    for (let index = 0; index < 8; index += 1) {
      const outcome = await state.manager.tool.execute({ childId: 'child-1', waitMs: 1 }, { agent: state.parent })
      assert.equal(outcome.waitOutcome, 'timeout')
    }
    assert.equal(subscriptions, 1, 'serial waits must not retain one Promise reaction per timeout')
    const waiting = state.manager.tool.execute({ childId: 'child-1', waitMs: 2_000 }, { agent: state.parent })
    await new Promise(resolve => setImmediate(resolve))
    state.registry.recordResult(state.parent, 'child-1', result())
    child.resolve()
    assert.equal((await waiting).waitOutcome, 'settled')
    assert.equal(subscriptions, 1)
  } finally {
    state.manager.dispose()
    child.resolve()
    await state.registry.dispose()
  }
})

test('cancelling one shared-completion waiter does not detach another waiter', async () => {
  const state = fixture()
  const child = track(state)
  const controller = new AbortController()
  const cancelled = state.manager.tool.execute({ childId: 'child-1' }, { agent: state.parent, signal: controller.signal })
  const surviving = state.manager.tool.execute({ childId: 'child-1' }, { agent: state.parent })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal((await cancelled).waitOutcome, 'cancelled')
  state.registry.recordResult(state.parent, 'child-1', result())
  child.resolve()
  assert.equal((await surviving).waitOutcome, 'settled')
  state.manager.dispose()
  await state.registry.dispose()
})

test('Agent disposal cancels only its waiter', async () => {
  const state = fixture()
  const child = track(state)
  const waiting = state.manager.tool.execute({ childId: 'child-1', waitMs: 30_000 }, { agent: state.parent })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.manager.clearAgent(state.parent), true)
  assert.deepEqual(await waiting, { childId: 'child-1', status: 'running', waitOutcome: 'cancelled' })
  assert.ok(state.activeRuns.has('child-1'))
  state.manager.dispose()
  state.registry.dispose()
  child.resolve()
})
