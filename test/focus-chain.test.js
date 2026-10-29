import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createFocusChain, focusChainText } from '../src/focus-chain.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))

const CONTEXT_NAME = 'dsh-omo:focus-chain'

function activeGoal(objective = 'Implement and verify the original request') {
  return { id: 'goal-live', revision: 1, phase: 'active', objective }
}

function makeAgent(id, { context, effect } = {}) {
  const calls = { contexts: [], contextDisposals: 0, effects: 0, trackingDisposals: 0 }
  const contextDisposers = []
  const effectDisposers = []
  const systemPrompt = {
    context: context ?? (entry => {
      calls.contexts.push(entry)
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        calls.contextDisposals += 1
      }
      contextDisposers.push(dispose)
      return dispose
    }),
  }
  const agentContext = {
    systemPrompt,
    effect: effect ?? (execute => {
      calls.effects += 1
      const cleanup = execute()
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        calls.trackingDisposals += 1
        cleanup?.()
      }
      effectDisposers.push(dispose)
      return dispose
    }),
  }
  const agent = { id, ctx: agentContext }
  agent.disposeScope = () => {
    for (const dispose of effectDisposers) dispose()
    for (const dispose of contextDisposers) dispose()
  }
  agent.calls = calls
  return agent
}

function makeService() {
  const live = new Map()
  return { live, service: { get: id => live.get(id) } }
}

async function notify(feature, agent, source = 'startup', signal) {
  return feature.listener({ agent, source, signal })
}

test('renders only an active Goal as bounded sanitized user task data', () => {
  const text = focusChainText(activeGoal('  Build\nthe\t"focus" feature  '))
  assert.match(text, /Current active native Goal \(quoted user task data\): "Build the \\"focus\\" feature"/u)
  assert.match(text, /avoid repeating exploration that adds no new information/u)
  assert.match(text, /verify the remaining work before claiming completion/u)
  assert.match(text, /grants no permissions/u)
  assert.match(text, /does not authorize creating, editing, completing, pausing, or resuming/u)
  assert.equal(text.length < 1_200, true)

  for (const goal of [undefined, null, {}, { phase: 'paused', objective: 'pause' },
    { phase: 'blocked', objective: 'block' }, { phase: 'complete', objective: 'done' },
    { phase: 'active' }, { phase: 'active', objective: ' \n\t ' }]) {
    assert.equal(focusChainText(goal), '')
  }
})

test('bounds hostile objective text and fails open on malformed Goal accessors', () => {
  const text = focusChainText(activeGoal(`start\u202e${'x'.repeat(3_000)}`))
  assert.equal(text.includes('\u202e'), false)
  assert.match(text, /…" \[truncated\]/u)
  assert.equal(text.length < 3_000, true)
  assert.equal(focusChainText({ get phase() { throw new Error('private Host failure') } }), '')
  assert.equal(focusChainText({ phase: 'active', get objective() { throw new Error('private Host failure') } }), '')
})

test('registers for every Agent creation source and re-reads the exact current Goal on each render', async () => {
  const { live, service } = makeService()
  const agent = makeAgent('goal-agent')
  live.set(agent.id, agent)
  const goal = activeGoal('first objective')
  const calls = []
  const feature = createFocusChain({ get(actual) { calls.push(actual); return goal } }, service)

  for (const source of ['startup', 'resume', 'clear', 'compact']) await notify(feature, agent, source)
  assert.equal(calls.length, 0, 'registration does not call Goal business methods')
  assert.equal(agent.calls.contexts.length, 1, 'the same live Agent is deduplicated across lifecycle notifications')
  assert.equal(agent.calls.contexts[0].name, CONTEXT_NAME)
  assert.equal(agent.calls.contexts[0].order, 145)

  const text = agent.calls.contexts[0].text
  assert.match(text(), /first objective/u)
  goal.objective = 'edited objective'
  assert.match(text(), /edited objective/u)
  assert.doesNotMatch(text(), /first objective/u)
  goal.phase = 'paused'
  assert.equal(text(), '')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(actual => actual === agent))
  await feature.dispose()
  assert.equal(text(), '')
})

test('isolates Agents and fails closed for stale, malformed, replaced, or aborted identities', async () => {
  const { live, service } = makeService()
  const feature = createFocusChain({ get: () => activeGoal() }, service)
  const actual = makeAgent('same-id')
  const stale = makeAgent('same-id')
  live.set(actual.id, actual)

  await notify(feature, stale)
  const controller = new AbortController()
  controller.abort()
  await notify(feature, actual, 'startup', controller.signal)
  await feature.listener({ agent: actual, signal: null })
  await notify(feature, makeAgent(''))
  await notify(feature, makeAgent('x'.repeat(257)))
  assert.equal(actual.calls.contexts.length, 0)

  await notify(feature, actual)
  assert.equal(actual.calls.contexts.length, 1)
  const replacement = makeAgent('same-id')
  live.set(replacement.id, replacement)
  await notify(feature, replacement)
  assert.equal(actual.calls.contextDisposals, 1)
  assert.equal(replacement.calls.contexts.length, 1)
  assert.equal(actual.calls.contexts[0].text(), '', 'an old same-ID callback cannot read the replacement Goal')
  assert.match(replacement.calls.contexts[0].text(), /Implement and verify/u)

  const other = makeAgent('other')
  live.set(other.id, other)
  await notify(feature, other)
  assert.equal(other.calls.contexts.length, 1)
  await feature.dispose()
})

test('fails open on registry, Goal, context, effect, and cancellation failures', async () => {
  const actual = makeAgent('live')
  const throwingRegistry = createFocusChain({ get: () => activeGoal() }, { get() { throw new Error('private') } })
  await assert.doesNotReject(notify(throwingRegistry, actual))
  assert.equal(actual.calls.contexts.length, 0)
  await throwingRegistry.dispose()

  const { live, service } = makeService()
  const feature = createFocusChain({ get() { throw new Error('private Goal failure') } }, service)
  live.set(actual.id, actual)
  await notify(feature, actual)
  assert.equal(actual.calls.contexts[0].text(), '')

  const badContext = makeAgent('bad-context', { context() { throw new Error('private context') } })
  const badEffect = makeAgent('bad-effect', { effect() { throw new Error('private effect') } })
  live.set(badContext.id, badContext)
  live.set(badEffect.id, badEffect)
  await assert.doesNotReject(notify(feature, badContext))
  await assert.doesNotReject(notify(feature, badEffect))
  await assert.doesNotReject(feature.listener({ agent: badContext, get signal() { throw new Error('private signal') } }))
  assert.equal(badContext.calls.contextDisposals, 0)
  assert.equal(badEffect.calls.contextDisposals, 1)
  await feature.dispose()
})

test('caps registrations without eviction and releases slots on exact scope cleanup', async () => {
  const { live, service } = makeService()
  const feature = createFocusChain({ get: () => activeGoal() }, service)
  const agents = Array.from({ length: 257 }, (_value, index) => makeAgent(`agent-${index}`))
  for (const agent of agents) live.set(agent.id, agent)

  for (const agent of agents.slice(0, 256)) await notify(feature, agent)
  await notify(feature, agents[0])
  await notify(feature, agents[256])
  assert.equal(agents[0].calls.contexts.length, 1)
  assert.equal(agents[255].calls.contexts.length, 1)
  assert.equal(agents[256].calls.contexts.length, 0)

  agents[0].disposeScope()
  await notify(feature, agents[256])
  assert.equal(agents[256].calls.contexts.length, 1)
  await feature.dispose()
})

test('scope cleanup and plugin disposal invalidate saved callbacks and prevent later work', async () => {
  const { live, service } = makeService()
  const feature = createFocusChain({ get: () => activeGoal() }, service)
  const agent = makeAgent('lifecycle')
  live.set(agent.id, agent)

  await notify(feature, agent)
  const firstText = agent.calls.contexts[0].text
  agent.disposeScope()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(firstText(), '')
  await notify(feature, agent, 'compact')
  assert.equal(agent.calls.contexts.length, 2)
  const secondText = agent.calls.contexts[1].text
  assert.match(secondText(), /Implement and verify/u)

  await feature.dispose()
  await feature.dispose()
  assert.equal(secondText(), '')
  assert.equal(agent.calls.contextDisposals, 2)
  assert.equal(agent.calls.trackingDisposals, 2)
  await notify(feature, agent)
  assert.equal(agent.calls.contexts.length, 2)
})

test('plugin disposal joins an in-flight same-ID replacement cleanup', async () => {
  const { live, service } = makeService()
  const feature = createFocusChain({ get: () => activeGoal() }, service)
  const original = makeAgent('same-id')
  let contextCalls = 0
  original.ctx.systemPrompt.context = () => {
    contextCalls += 1
    return () => { contextCalls += 1; original.calls.contextDisposals += 1 }
  }
  live.set(original.id, original)
  let releaseTracking
  const trackingReady = new Promise(resolve => { releaseTracking = resolve })
  let trackingStartedResolve
  const trackingStarted = new Promise(resolve => { trackingStartedResolve = resolve })
  let trackingDispose
  original.ctx.effect = execute => {
    execute()
    trackingDispose = async () => {
      trackingStartedResolve()
      await trackingReady
    }
    return trackingDispose
  }
  await notify(feature, original)
  const replacement = makeAgent('same-id')
  live.set(replacement.id, replacement)
  const replacing = notify(feature, replacement)
  await trackingStarted
  const pluginCleanup = feature.dispose()
  let settled = false
  void pluginCleanup.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false)
  assert.equal(original.calls.contextDisposals, 0)
  releaseTracking()
  await Promise.all([replacing, pluginCleanup])
  assert.equal(original.calls.contextDisposals, 1)
  assert.equal(contextCalls, 2, 'registration and exactly one context disposal')
  assert.equal(replacement.calls.contexts.length, 0)
})

test('plugin disposal joins Agent-scope cleanup and removes its prompt context', async () => {
  const { live, service } = makeService()
  const feature = createFocusChain({ get: () => activeGoal() }, service)
  const agent = makeAgent('overlapping-cleanup')
  let contextCalls = 0
  agent.ctx.systemPrompt.context = entry => {
    contextCalls += 1
    agent.calls.contexts.push(entry)
    return () => { contextCalls += 1; agent.calls.contextDisposals += 1 }
  }
  live.set(agent.id, agent)
  let releaseTracking
  const trackingReady = new Promise(resolve => { releaseTracking = resolve })
  let trackingStartedResolve
  const trackingStarted = new Promise(resolve => { trackingStartedResolve = resolve })
  let trackingDispose
  agent.ctx.effect = execute => {
    execute()
    trackingDispose = async () => {
      trackingStartedResolve()
      await trackingReady
    }
    return trackingDispose
  }
  await notify(feature, agent)
  const scopeCleanup = Promise.resolve().then(() => trackingDispose())
  await trackingStarted
  const pluginCleanup = feature.dispose()
  let settled = false
  void pluginCleanup.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false)
  releaseTracking()
  await Promise.all([scopeCleanup, pluginCleanup])
  assert.equal(agent.calls.contextDisposals, 1)
  assert.equal(contextCalls, 2, 'registration and exactly one context disposal')
  assert.equal(agent.calls.contexts[0].text(), '')
})

test('assembles the active Goal through real DSH prompt scopes and removes it on disposal', async () => {
  const ctx = new Context()
  const systemPromptFiber = await ctx.plugin(SystemPrompt)
  const agentRegistryFiber = await ctx.plugin(AgentRegistry)
  const goals = new Map()
  const goalCalls = []
  const feature = createFocusChain({
    get(agent) {
      goalCalls.push(agent)
      return goals.get(agent)
    },
  }, ctx.agents)
  const featureFiber = await ctx.plugin(pluginCtx => {
    pluginCtx.on('agent/created', feature.listener)
    pluginCtx.effect(() => feature.dispose, 'test Focus Chain')
  })

  async function createAgent(id, source = 'startup') {
    const agent = { id, session: { id } }
    const scope = createScope(ctx, agent)
    let agentContext
    await scope.ctx.inject(['systemPrompt'], injected => { agentContext = injected })
    agent.ctx = agentContext
    const detach = ctx.agents.enter(agent, undefined)
    await ctx.agents.announce(agent, source)
    return { agent, scope, detach }
  }
  const owned = []
  const track = lifecycle => { owned.push(lifecycle); return lifecycle.agent }

  try {
    const anchored = track(await createAgent('anchored-agent'))
    const outside = track(await createAgent('outside-agent', 'compact'))
    goals.set(anchored, activeGoal('real scoped objective'))
    const assemblyFor = agent => ctx.systemPrompt.assemble({ scope: agent })
    const first = (await assemblyFor(anchored)).contexts.filter(entry => entry.name === CONTEXT_NAME)
    assert.equal(first.length, 1)
    assert.match(first[0].text, /real scoped objective/u)
    const outsideEntries = (await assemblyFor(outside)).contexts.filter(entry => entry.name === CONTEXT_NAME)
    assert.equal(outsideEntries.length, 1, 'every live Agent has a scoped provider')
    assert.equal(outsideEntries[0].text, '', 'an Agent without a Goal emits no prompt text')
    assert.deepEqual((await ctx.systemPrompt.assemble()).contexts.filter(entry => entry.name === CONTEXT_NAME), [],
      'the Goal anchor is not registered globally')

    goals.get(anchored).objective = 'fresh objective after an edit'
    const refreshed = (await assemblyFor(anchored)).contexts.filter(entry => entry.name === CONTEXT_NAME)
    assert.match(refreshed[0].text, /fresh objective after an edit/u)
    assert.ok(goalCalls.filter(agent => agent === anchored).length >= 2)
    assert.ok(goalCalls.includes(outside), 'the outside provider checks its own absent Goal')

    const previous = owned.find(entry => entry.agent === outside)
    await previous.scope.dispose()
    previous.detach()
    const compacted = track(await createAgent(outside.id, 'compact'))
    goals.set(compacted, activeGoal('objective restored after compact'))
    assert.match((await assemblyFor(compacted)).contexts.find(entry => entry.name === CONTEXT_NAME).text, /objective restored after compact/u)

    await featureFiber.dispose()
    assert.deepEqual((await assemblyFor(anchored)).contexts.filter(entry => entry.name === CONTEXT_NAME), [])
  } finally {
    await featureFiber.dispose()
    for (const { scope, detach } of owned) {
      await scope.dispose()
      detach()
    }
    await agentRegistryFiber.dispose()
    await systemPromptFiber.dispose()
  }
})
