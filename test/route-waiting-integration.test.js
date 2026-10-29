import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'

const queueTurn = () => new Promise(resolve => setImmediate(resolve))
const completed = () => ({ stopReason: 'completed', output: [] })

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

// Exercise ordinary task admission through the real registered Tool and Config,
// with the same controllable legacy-Host runs as plugin.test.js pendingTaskFixture.
function pendingTaskFixture(input = {}) {
  const agents = new Map()
  const tools = new Map()
  const effects = []
  const eventListeners = new Map()
  const runs = []
  const calls = []
  const controllers = []
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
      start: async (_provider, request) => {
        let finish
        const result = new Promise(resolve => { finish = resolve })
        const run = {
          id: `queued-child-${runs.length + 1}`,
          request,
          finish,
          disposeCalls: 0,
          onDispose: undefined,
        }
        runs.push(run)
        return {
          id: run.id,
          result,
          dispose: async () => {
            run.disposeCalls += 1
            await run.onDispose?.()
          },
        }
      },
      getProvider: () => ({ name: 'spawn', capabilities: { depthLimit: true, agentOptions: true } }),
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {}, find: () => undefined },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    fs: {},
    effect: (execute, label) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return async () => dispose()
    },
    on: (event, listener) => {
      const listeners = eventListeners.get(event) ?? []
      listeners.push(listener)
      eventListeners.set(event, listeners)
      return ctx
    },
    logger: { warn: () => {} },
  }
  const config = Config({ provider: 'spawn', maxConcurrent: 2, maxDepth: 1, ...input })
  apply(ctx, config)
  const tool = tools.get('dsh_omo_task')
  const agent = { id: 'queue-parent', followup() {} }
  agents.set(agent.id, agent)
  const call = (task, options = {}) => {
    const controller = new AbortController()
    controllers.push(controller)
    const parent = options.agent ?? agent
    agents.set(parent.id, parent)
    const promise = tool.execute(
      { role: options.role ?? 'explore', task },
      { agent: parent, signal: controller.signal },
    )
    // A rejected queued invocation must never become an unhandled rejection.
    promise.catch(() => {})
    const invocation = { promise, controller }
    calls.push(invocation)
    return invocation
  }
  const cleanup = async () => {
    for (const controller of controllers) controller.abort()
    for (const run of runs) {
      run.finish(completed())
      run.releaseDispose?.()
    }
    await Promise.allSettled(calls.map(call => call.promise))
    await queueTurn()
  }
  return { config, runs, call, cleanup }
}

async function assertStillQueued(promise, message) {
  const state = await Promise.race([
    promise.then(() => 'fulfilled', () => 'rejected'),
    queueTurn().then(() => 'pending'),
  ])
  assert.equal(state, 'pending', message)
}

const routeConfig = {
  providerConcurrency: { 'route-a': 1, 'route-b': 1 },
  roleRoutes: [
    { role: 'explore', provider: 'route-a', model: 'model-a' },
    { role: 'reviewer', provider: 'route-b', model: 'model-b' },
  ],
}

test('maxPendingTasks waits after selectedRoute without consuming global capacity, preserves route FIFO, and releases route before disposal releases global', async () => {
  const q = pendingTaskFixture({ ...routeConfig, maxPendingTasks: 4 })
  const firstDisposal = deferred()
  try {
    assert.equal((await q.call('A1').promise).childId, 'queued-child-1')

    const a2 = q.call('A2')
    await assertStillQueued(a2.promise, 'the second selected A route must wait at its route cap')

    // A1 uses one of two global slots. If A2 held the other while waiting for
    // route A, independently capped B could not start here.
    const b1 = q.call('B1', { role: 'reviewer' })
    await queueTurn()
    assert.equal(q.runs.length, 2, 'route-only waiting must leave a global slot for capped route B')
    assert.equal((await b1.promise).childId, 'queued-child-2')
    assert.equal(q.runs[1].request.agentOptions.provider, 'route-b')

    const a3 = q.call('A3')
    await assertStillQueued(a3.promise, 'a later A request must wait behind A2')

    q.runs[0].onDispose = () => firstDisposal.promise
    q.runs[0].releaseDispose = firstDisposal.resolve
    q.runs[0].finish(completed())
    await queueTurn()
    assert.equal(q.runs[0].disposeCalls, 1)
    assert.equal(q.runs.length, 2, 'A settlement must retain its global slot until A disposal finishes')
    await assertStillQueued(a2.promise)
    await assertStillQueued(a3.promise)

    // B disposal now frees the only available global slot. A2 can use it while
    // A1 disposal is still blocked only if A1 settlement already released route A.
    q.runs[1].finish(completed())
    await queueTurn()
    assert.equal(q.runs.length, 3, 'B disposal must admit A2 without waiting for A1 disposal')
    assert.match(q.runs[2].request.label, /^explore: A2$/u)
    assert.equal((await a2.promise).childId, 'queued-child-3')
    await assertStillQueued(a3.promise, 'A3 must not overtake or share A2\'s capped route')

    q.runs[2].finish(completed())
    await queueTurn()
    assert.equal(q.runs.length, 4, 'A2 settlement must admit the next same-route waiter')
    assert.match(q.runs[3].request.label, /^explore: A3$/u)
    assert.equal((await a3.promise).childId, 'queued-child-4')
  } finally {
    firstDisposal.resolve()
    await q.cleanup()
  }
})

test('default maxPendingTasks path keeps selected-route saturation fail-fast', async () => {
  const q = pendingTaskFixture(routeConfig)
  try {
    assert.equal(q.config.maxPendingTasks, 0, 'exercise the real Config default')
    assert.equal((await q.call('A1').promise).childId, 'queued-child-1')
    await assert.rejects(q.call('A2').promise, /provider concurrency limit reached/iu)
    assert.equal(q.runs.length, 1, 'a saturated route must not start or queue on the default path')
    assert.equal((await q.call('B1', { role: 'reviewer' }).promise).childId, 'queued-child-2')
  } finally {
    await q.cleanup()
  }
})
