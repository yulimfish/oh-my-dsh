import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function makeContext({ withAgentsGet = true } = {}) {
  const tools = new Map()
  const listeners = new Map()
  const effects = []
  const agents = new Map()
  const starts = []
  const results = []
  const disposals = []
  const ctx = {
    get: key => key === 'agents' ? {
      ...(withAgentsGet ? { get: id => agents.get(id) } : {}),
      withoutInitiator: fn => fn(),
    } : undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: () => undefined,
    },
    subagents: {
      getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true } }),
      async startActivation(spec) {
        const result = deferred()
        const childId = `identity-child-${starts.length + 1}`
        starts.push(spec)
        results.push(result)
        return {
          childId,
          result: result.promise,
          async dispose() { disposals.push(childId) },
        }
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    fs: {},
    logger: { warn() {} },
    on(event, listener) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return ctx
    },
    effect(execute, label) {
      const dispose = execute()
      effects.push({ dispose, label })
      return async () => dispose?.()
    },
  }

  const config = Config({ maxPendingTasks: 0, enableTaskResultTool: true })
  assert.equal(config.maxPendingTasks, 0)
  apply(ctx, config)

  function makeParent(id) {
    const followups = []
    const agent = { id, followup: message => followups.push(message) }
    agents.set(id, agent)
    return { agent, followups }
  }

  async function launch(agent, task) {
    return tools.get('dsh_omo_task').execute(
      { role: 'quick', task },
      { agent, signal: new AbortController().signal },
    )
  }

  async function dispose(agent) {
    for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent })
  }

  async function cachedStatus(agent, childId) {
    try {
      const result = await tools.get('dsh_omo_task_result').execute({ childId }, { agent })
      return result.status
    } catch (error) {
      assert.match(error.message, /No unexpired dsh-omo result/u)
      return null
    }
  }

  return { agents, starts, results, disposals, makeParent, launch, dispose, cachedStatus }
}

test('maxPendingTasks=0 rejects a stale parent before startActivation', async () => {
  const fixture = makeContext()
  const original = fixture.makeParent('same-parent')
  const replacement = fixture.makeParent(original.agent.id)

  await assert.rejects(fixture.launch(original.agent, 'stale parent must not start'), /live parent/iu)

  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.results.length, 0)
  assert.deepEqual(original.followups, [])
  assert.deepEqual(replacement.followups, [])
})

test('maxPendingTasks=0 rejected stale result neither relays nor blocks same-ID replacement tracking', async () => {
  const fixture = makeContext()
  const original = fixture.makeParent('same-parent')
  const staleStart = await fixture.launch(original.agent, 'old child rejects after replacement')
  assert.equal(staleStart.resultTracked, true)
  const replacement = fixture.makeParent(original.agent.id)

  fixture.results[0].reject(new Error('private stale failure'))
  await tick()

  assert.deepEqual(original.followups, [])
  assert.deepEqual(replacement.followups, [])
  assert.equal(await fixture.cachedStatus(original.agent, staleStart.childId), null)
  assert.equal(await fixture.cachedStatus(replacement.agent, staleStart.childId), null)

  const replacementStart = await fixture.launch(replacement.agent, 'replacement owns fresh tracking')
  assert.equal(replacementStart.resultTracked, true)
  fixture.results[1].resolve({
    stopReason: 'completed',
    output: [{ type: 'text', text: 'replacement result' }],
  })
  await tick()

  assert.deepEqual(original.followups, [])
  assert.equal(await fixture.cachedStatus(replacement.agent, replacementStart.childId), 'completed')
})

for (const outcome of ['completed', 'failed']) {
  test(`maxPendingTasks=0 ${outcome} disposal suppresses relay/cache without agents.get`, async () => {
    const fixture = makeContext({ withAgentsGet: false })
    const parent = fixture.makeParent('disposed-without-agents-get')
    const started = await fixture.launch(parent.agent, 'dispose before child settlement')
    assert.equal(started.resultTracked, true)

    await fixture.dispose(parent.agent)
    if (outcome === 'completed') {
      fixture.results[0].resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'stale private result' }],
      })
    } else {
      fixture.results[0].reject(new Error('private stale failure'))
    }
    await tick()

    assert.deepEqual(parent.followups, [])
    assert.equal(await fixture.cachedStatus(parent.agent, started.childId), null)
    assert.deepEqual(fixture.disposals, [started.childId])
  })
}
