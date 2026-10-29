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

function fixture({ ids = [], onDispose } = {}) {
  const agents = new Map()
  const tools = new Map()
  const listeners = new Map()
  const runs = []
  const calls = []
  const warnings = []

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
        const result = deferred()
        const index = runs.length
        const run = {
          id: ids[index] ?? `child-${index + 1}`,
          request,
          finish: result.resolve,
          disposeCalls: 0,
        }
        runs.push(run)
        return {
          id: run.id,
          result: result.promise,
          dispose: async () => {
            run.disposeCalls += 1
            await onDispose?.(run, index)
          },
        }
      },
      getProvider: () => ({ name: 'spawn', capabilities: { depthLimit: true, agentOptions: true } }),
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {}, find: () => undefined },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    fs: {},
    effect: execute => {
      const dispose = execute()
      return async () => dispose?.()
    },
    on: (event, listener) => {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return ctx
    },
    logger: { warn: message => warnings.push(message) },
  }

  const config = Config({ provider: 'spawn', maxConcurrent: 2, maxDepth: 1 })
  assert.equal(config.maxPendingTasks, 0, 'exercise the real Config default')
  apply(ctx, config)

  const agent = { id: 'default-parent', followup() {} }
  agents.set(agent.id, agent)
  const tool = tools.get('dsh_omo_task')
  const call = task => {
    const promise = tool.execute(
      { role: 'quick', task },
      { agent, signal: new AbortController().signal },
    )
    promise.catch(() => {})
    calls.push(promise)
    return promise
  }
  const cleanup = async () => {
    for (const run of runs) run.finish(completed())
    await Promise.allSettled(calls)
    await tick()
  }

  return { runs, warnings, call, cleanup }
}

test('default duplicate child ID retains ambiguous capacity and rejects a third start', async () => {
  const q = fixture({ ids: ['shared-child', 'shared-child', 'must-not-start'] })
  try {
    assert.equal((await q.call('first')).childId, 'shared-child')
    await assert.rejects(q.call('duplicate'), /ambiguous subagent identity/iu)
    assert.equal(q.runs.length, 2)

    await assert.rejects(q.call('third'), /worker limit reached \(2\)/iu)
    assert.equal(q.runs.length, 2, 'the ambiguous reservation must not let a third child exceed maxConcurrent')
  } finally {
    await q.cleanup()
  }
})

test('default failed settlement disposal permits an ambiguous same-ID retry but retains both capacities', async () => {
  const q = fixture({
    ids: ['shared-child', 'shared-child', 'must-not-start'],
    onDispose: async (_run, index) => {
      if (index === 0) throw new Error('dispose failed')
    },
  })
  try {
    await q.call('first')
    q.runs[0].finish(completed())
    await tick()
    assert.equal(q.runs[0].disposeCalls, 1)
    assert.ok(q.warnings.some(warning => /could not dispose child shared-child \(Error\)/u.test(warning)))

    await assert.rejects(q.call('same ID after failed disposal'), /ambiguous subagent identity/iu)
    assert.equal(q.runs.length, 2)

    await assert.rejects(q.call('third'), /worker limit reached \(2\)/iu)
    assert.equal(q.runs.length, 2, 'failed disposal and the ambiguous retry must both retain capacity')
  } finally {
    await q.cleanup()
  }
})

test('default uncapped settlement emits no route-release TypeError warning', async () => {
  const q = fixture({ ids: ['uncapped-child'] })
  try {
    await q.call('uncapped')
    q.runs[0].finish(completed())
    await tick()

    assert.equal(q.runs[0].disposeCalls, 1)
    assert.deepEqual(q.warnings, [], 'an absent uncapped route lease is normal and must not be released or warned about')
  } finally {
    await q.cleanup()
  }
})
