import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const completed = () => ({ stopReason: 'completed', output: [] })

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

function fixture(input = {}, host = {}) {
  const agents = new Map()
  const tools = new Map()
  const listeners = new Map()
  const controllers = []
  const calls = []
  const runs = []
  const legacyStarts = []
  const activationSpecs = []
  const interrupts = []

  const createRun = (request, id = `child-${runs.length + 1}`) => {
    const result = deferred()
    const run = {
      id,
      request,
      result: result.promise,
      finish: result.resolve,
      disposeCalls: 0,
    }
    runs.push(run)
    return run
  }
  const activation = run => ({
    id: run.id,
    result: run.result,
    dispose: async () => { run.disposeCalls += 1 },
  })

  const ctx = {
    get: key => key === 'agents'
      ? { get: id => agents.get(id), withoutInitiator: fn => fn() }
      : undefined,
    tools: {
      register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
      get: () => undefined,
      guard: () => () => {},
    },
    subagents: {
      start: async (provider, request) => {
        legacyStarts.push({ provider, request })
        if (host.start) return host.start({ provider, request, createRun: id => createRun(request, id) })
        return activation(createRun(request))
      },
      getProvider: () => ({ name: 'spawn', capabilities: { depthLimit: true, agentOptions: true, toolFilter: true } }),
      interrupt: (childId, options) => interrupts.push({ childId, options }),
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {}, find: () => undefined },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    fs: {},
    effect: execute => {
      const dispose = execute()
      return async () => dispose()
    },
    on: (event, listener) => {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return ctx
    },
    logger: { warn: () => {} },
  }
  if (host.startActivation) {
    ctx.subagents.startActivation = spec => {
      activationSpecs.push(spec)
      return host.startActivation({ spec, createRun: id => createRun(spec.request, id) })
    }
  }

  const config = Config({ provider: 'spawn', maxConcurrent: 2, maxDepth: 1, ...input })
  apply(ctx, config)
  const tool = tools.get('dsh_omo_task')
  const agent = { id: 'parent', followup() {} }
  agents.set(agent.id, agent)

  const call = (task, options = {}) => {
    const controller = new AbortController()
    controllers.push(controller)
    const parent = options.agent ?? agent
    agents.set(parent.id, parent)
    const promise = tool.execute(
      { role: options.role ?? 'quick', task },
      { agent: parent, signal: controller.signal },
    )
    promise.catch(() => {})
    const invocation = { promise, controller }
    calls.push(invocation)
    return invocation
  }
  const cleanup = async () => {
    for (const controller of controllers) controller.abort()
    for (const run of runs) run.finish(completed())
    await Promise.allSettled(calls.map(call => call.promise))
    await tick()
  }

  return { config, ctx, tools, runs, legacyStarts, activationSpecs, interrupts, agent, call, cleanup }
}

async function assertPending(promise, message) {
  const outcome = await Promise.race([
    promise.then(
      value => ({ state: 'fulfilled', value }),
      error => ({ state: 'rejected', error }),
    ),
    tick().then(() => ({ state: 'pending' })),
  ])
  assert.equal(
    outcome.state,
    'pending',
    outcome.state === 'rejected' ? `${message}: ${outcome.error?.message}` : message,
  )
}

async function assertRejectsSoon(promise, pattern, message) {
  const outcome = await Promise.race([
    promise.then(value => ({ state: 'fulfilled', value }), error => ({ state: 'rejected', error })),
    tick().then(() => ({ state: 'pending' })),
  ])
  assert.equal(outcome.state, 'rejected', message)
  assert.match(outcome.error.message, pattern)
}

const cappedConfig = {
  maxConcurrent: 1,
  maxPendingTasks: 1,
  providerConcurrency: { 'route-a': 1 },
  roleRoutes: [{ role: 'explore', provider: 'route-a', model: 'model-a' }],
}

test('capped legacy start failure releases capacity for an immediate second start', async () => {
  const q = fixture(cappedConfig, {
    start: ({ createRun }) => {
      if (q.legacyStarts.length === 1) throw new Error('transient ordinary start failure')
      const run = createRun('after-start-failure')
      return { id: run.id, result: run.result, dispose: async () => { run.disposeCalls += 1 } }
    },
  })
  try {
    await assert.rejects(q.call('first', { role: 'explore' }).promise, /transient ordinary start failure/u)
    const second = q.call('second', { role: 'explore' })
    assert.equal((await second.promise).childId, 'after-start-failure')
    assert.equal(q.legacyStarts.length, 2)
    assert.equal(q.runs.length, 1)
  } finally {
    await q.cleanup()
  }
})

test('capped late activation abort releases global and route capacity after successful disposal', async () => {
  const accepted = deferred()
  let disposals = 0
  const q = fixture(cappedConfig, {
    startActivation: ({ createRun }) => {
      if (q.activationSpecs.length === 1) {
        const run = createRun('late-child')
        return accepted.promise.then(() => ({
          childId: run.id,
          result: run.result,
          dispose: async () => { disposals += 1 },
        }))
      }
      const run = createRun('after-late-abort')
      return { childId: run.id, result: run.result, dispose: async () => { run.disposeCalls += 1 } }
    },
  })
  try {
    const first = q.call('late activation', { role: 'explore' })
    while (q.activationSpecs.length === 0) await tick()
    first.controller.abort()
    accepted.resolve()
    await assert.rejects(first.promise, /cancelled while starting/iu)
    assert.equal(disposals, 1)

    // maxConcurrent and the selected provider cap are both one. An immediate
    // same-route start therefore proves that neither reservation was retained.
    const second = q.call('after cleanup', { role: 'explore' })
    assert.equal((await second.promise).childId, 'after-late-abort')
    assert.equal(q.activationSpecs.length, 2)
  } finally {
    accepted.resolve()
    await q.cleanup()
  }
})

test('capped and uncapped duplicate child IDs reject the second without replacing activeRuns', async () => {
  const firstParent = { id: 'capped-owner', followup() {} }
  const secondParent = { id: 'uncapped-owner', followup() {} }
  const q = fixture({
    ...cappedConfig,
    maxConcurrent: 2,
    enableTaskCancelTool: true,
  }, {
    start: ({ createRun }) => {
      const run = createRun(q.legacyStarts.length <= 2 ? 'shared-child' : 'third-child')
      return { id: run.id, result: run.result, dispose: async () => { run.disposeCalls += 1 } }
    },
  })
  try {
    assert.equal((await q.call('capped original', { role: 'explore', agent: firstParent }).promise).childId, 'shared-child')
    await assert.rejects(
      q.call('uncapped duplicate', { role: 'quick', agent: secondParent }).promise,
      /ambiguous subagent identity/iu,
    )
    assert.equal(q.runs.length, 2)

    const cancel = q.tools.get('dsh_omo_task_cancel')
    assert.deepEqual(
      await cancel.execute({ childId: 'shared-child' }, { agent: firstParent }),
      { childId: 'shared-child', status: 'interrupt-requested' },
      'activeRuns must still refer to the original capped run and owner',
    )
    await assert.rejects(
      cancel.execute({ childId: 'shared-child' }, { agent: secondParent }),
      /No active dsh-omo one-shot child/iu,
    )
    assert.deepEqual(q.interrupts, [{ childId: 'shared-child', options: { kind: 'ancestor', agent: firstParent } }])

    q.runs[0].finish(completed())
    await tick()
    assert.equal(q.runs[0].disposeCalls, 1)
    assert.equal(q.runs[1].disposeCalls, 0, 'the rejected duplicate remains ambiguous and is not disposed as the active run')
  } finally {
    await q.cleanup()
  }
})

test('maxPendingTasks=1 bounds global and route waiters with one shared total', async () => {
  const q = fixture({ ...cappedConfig, maxConcurrent: 2 })
  try {
    await q.call('capped holder', { role: 'explore' }).promise
    const routeWaiter = q.call('route waiter', { role: 'explore' })
    await assertPending(routeWaiter.promise, 'the second capped call must wait only for route capacity')
    assert.equal(q.runs.length, 1)

    await q.call('global holder', { role: 'quick' }).promise
    assert.equal(q.runs.length, 2)
    const globalWaiter = q.call('must exceed shared waiter cap', { role: 'quick' })
    await assertRejectsSoon(
      globalWaiter.promise,
      /pending launch limit|worker limit reached/iu,
      'the existing route waiter already consumes the only permitted pending-task slot',
    )
    assert.equal(q.runs.length, 2)

    routeWaiter.controller.abort()
    await assert.rejects(routeWaiter.promise, /abort/iu)
    const nextGlobalWaiter = q.call('shared slot released', { role: 'quick' })
    await assertPending(nextGlobalWaiter.promise, 'aborting the route waiter must release the shared pending-task slot')
  } finally {
    await q.cleanup()
  }
})
