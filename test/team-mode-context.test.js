import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  createTeamModeContext,
  TEAM_MODE_LEAD_CONTEXT,
  TEAM_MODE_TEAMMATE_CONTEXT,
} from '../src/team-mode-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))

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

function makeHarness() {
  const live = new Map()
  const memberships = new WeakMap()
  const agentsService = { get: id => live.get(id) }
  const teamService = { tryMembership: agent => memberships.get(agent) }
  const context = createTeamModeContext(teamService, agentsService)
  return {
    context,
    live,
    memberships,
    async notify(agent, signal) { await context.listener({ agent, signal }) },
    async dispose() { await context.dispose() },
  }
}

test('registers fixed role-aware guidance only for exact live Team members', async () => {
  const harness = makeHarness()
  const lead = makeAgent('lead-secret-id')
  const teammate = makeAgent('teammate-secret-id')
  const outside = makeAgent('outside-secret-id')
  harness.live.set(lead.id, lead)
  harness.live.set(teammate.id, teammate)
  harness.live.set(outside.id, outside)
  harness.memberships.set(lead, { role: 'lead', id: 'team-secret-id', name: 'Private Team Name' })
  harness.memberships.set(teammate, { role: 'teammate', id: 'team-secret-id', name: 'Private Team Name' })

  await harness.notify(lead)
  await harness.notify(teammate)
  await harness.notify(outside)

  assert.deepEqual(lead.calls.contexts, [{ name: 'dsh-omo:team-mode', order: 160, text: TEAM_MODE_LEAD_CONTEXT }])
  assert.deepEqual(teammate.calls.contexts, [{ name: 'dsh-omo:team-mode', order: 160, text: TEAM_MODE_TEAMMATE_CONTEXT }])
  assert.equal(outside.calls.contexts.length, 0)
  for (const text of [TEAM_MODE_LEAD_CONTEXT, TEAM_MODE_TEAMMATE_CONTEXT]) {
    assert.match(text, /visible Team tools in your current scope/u)
    assert.match(text, /advisory, not permissions/u)
    assert.match(text, /Host authorization and approvals remain authoritative/u)
    assert.match(text, /grants no additional authority/u)
    assert.doesNotMatch(text, /lead-secret-id|teammate-secret-id|team-secret-id|Private Team Name|PRIVATE TASK/u)
  }
  await harness.dispose()
})

test('fails open for non-Team, stale, malformed, and replaced Agent identities', async () => {
  const harness = makeHarness()
  const live = makeAgent('same-id')
  const stale = makeAgent('same-id')
  harness.live.set(live.id, live)
  harness.memberships.set(stale, { role: 'lead' })
  await harness.notify(stale)
  assert.equal(stale.calls.contexts.length, 0)

  const noTeam = makeAgent('no-team')
  harness.live.set(noTeam.id, noTeam)
  await harness.notify(noTeam)
  assert.equal(noTeam.calls.contexts.length, 0)

  for (const id of ['', 'x'.repeat(257)]) {
    const malformed = makeAgent(id)
    harness.live.set(id, malformed)
    harness.memberships.set(malformed, { role: 'lead' })
    await harness.notify(malformed)
    assert.equal(malformed.calls.contexts.length, 0)
  }

  harness.live.set(live.id, live)
  harness.memberships.set(live, { role: 'lead' })
  await harness.notify(live)
  assert.equal(live.calls.contexts.length, 1)

  const replacement = makeAgent(live.id)
  harness.live.set(replacement.id, replacement)
  await harness.notify(replacement)
  assert.equal(live.calls.contextDisposals, 1)
  assert.equal(replacement.calls.contexts.length, 0)
  await harness.dispose()
})

test('deduplicates the same Agent and replaces guidance when its Team role changes', async () => {
  const harness = makeHarness()
  const agent = makeAgent('role-change')
  harness.live.set(agent.id, agent)
  harness.memberships.set(agent, { role: 'lead' })

  await harness.notify(agent)
  await harness.notify(agent)
  assert.equal(agent.calls.contexts.length, 1)
  assert.equal(agent.calls.effects, 1)

  harness.memberships.set(agent, { role: 'teammate' })
  await harness.notify(agent)
  assert.equal(agent.calls.contexts.length, 2)
  assert.equal(agent.calls.contexts[0].text, TEAM_MODE_LEAD_CONTEXT)
  assert.equal(agent.calls.contexts[1].text, TEAM_MODE_TEAMMATE_CONTEXT)
  assert.equal(agent.calls.contextDisposals, 1)
  await harness.dispose()
  assert.equal(agent.calls.contextDisposals, 2)
})

test('fails open on membership, liveness, context, effect, and cancellation failures', async () => {
  const badMembership = makeAgent('bad-membership')
  const membershipPlugin = createTeamModeContext({ tryMembership() { throw new Error('private membership failure') } }, {
    get: id => id === badMembership.id ? badMembership : undefined,
  })
  await assert.doesNotReject(membershipPlugin.listener({ agent: badMembership }))
  assert.equal(badMembership.calls.contexts.length, 0)
  await membershipPlugin.dispose()

  const badRegistryAgent = makeAgent('bad-registry')
  const badRegistry = createTeamModeContext({ tryMembership: () => ({ role: 'lead' }) }, {
    get() { throw new Error('private registry failure') },
  })
  await assert.doesNotReject(badRegistry.listener({ agent: badRegistryAgent }))
  assert.equal(badRegistryAgent.calls.contexts.length, 0)
  await badRegistry.dispose()

  const { context, live, memberships } = makeHarness()
  const badContext = makeAgent('bad-context', { context() { throw new Error('private context failure') } })
  const badEffect = makeAgent('bad-effect', { effect() { throw new Error('private effect failure') } })
  live.set(badContext.id, badContext)
  live.set(badEffect.id, badEffect)
  memberships.set(badContext, { role: 'lead' })
  memberships.set(badEffect, { role: 'teammate' })
  await assert.doesNotReject(context.listener({ agent: badContext }))
  await assert.doesNotReject(context.listener({ agent: badEffect }))
  assert.equal(badContext.calls.contexts.length, 0)
  assert.equal(badEffect.calls.contextDisposals, 1)

  const aborted = new AbortController()
  aborted.abort()
  const skipped = makeAgent('aborted')
  live.set(skipped.id, skipped)
  memberships.set(skipped, { role: 'lead' })
  await context.listener({ agent: skipped, signal: aborted.signal })
  await context.listener({ agent: skipped, signal: null })
  assert.equal(skipped.calls.contexts.length, 0)
  await context.dispose()
})

test('caps live registrations without eviction and releases capacity on scope cleanup', async () => {
  const harness = makeHarness()
  const agents = Array.from({ length: 257 }, (_value, index) => makeAgent(`agent-${index}`))
  for (const agent of agents) {
    harness.live.set(agent.id, agent)
    harness.memberships.set(agent, { role: 'teammate' })
  }
  for (const agent of agents.slice(0, 256)) await harness.notify(agent)
  await harness.notify(agents[0])
  await harness.notify(agents[256])
  assert.equal(agents[0].calls.contexts.length, 1)
  assert.equal(agents[255].calls.contexts.length, 1)
  assert.equal(agents[256].calls.contexts.length, 0)

  agents[0].disposeScope()
  await harness.notify(agents[256])
  assert.equal(agents[256].calls.contexts.length, 1)
  await harness.dispose()
  await harness.notify(agents[256])
  assert.equal(agents[256].calls.contexts.length, 1, 'plugin disposal stops later registrations')
})

test('assembles the Team context only in the matching live Agent scope before first input', async () => {
  const ctx = new Context()
  const systemPromptFiber = await ctx.plugin(SystemPrompt)
  const agentRegistryFiber = await ctx.plugin(AgentRegistry)
  const scopes = []
  const detachers = []
  const memberships = new WeakMap()
  const teamContext = createTeamModeContext({ tryMembership: agent => memberships.get(agent) }, ctx.agents)
  const featureFiber = await ctx.plugin(pluginCtx => {
    pluginCtx.on('agent/created', teamContext.listener)
    pluginCtx.effect(() => teamContext.dispose, 'test Team-mode context')
  })

  async function createAgent(id, role) {
    const agent = { id, session: { id } }
    const scope = createScope(ctx, agent)
    scopes.push(scope)
    let agentContext
    await scope.ctx.inject(['systemPrompt'], injected => { agentContext = injected })
    agent.ctx = agentContext
    const detach = ctx.agents.enter(agent, undefined)
    detachers.push(detach)
    if (role) memberships.set(agent, { role })
    await ctx.agents.announce(agent, 'startup')
    return agent
  }

  try {
    const lead = await createAgent('lead-live', 'lead')
    const teammate = await createAgent('teammate-live', 'teammate')
    const outside = await createAgent('outside-live')
    const contextsFor = async agent => (await ctx.systemPrompt.assemble({ scope: agent })).contexts
      .filter(context => context.name === 'dsh-omo:team-mode')

    assert.deepEqual((await contextsFor(lead)).map(context => context.text), [TEAM_MODE_LEAD_CONTEXT])
    assert.deepEqual((await contextsFor(teammate)).map(context => context.text), [TEAM_MODE_TEAMMATE_CONTEXT])
    assert.deepEqual(await contextsFor(outside), [])
    assert.deepEqual((await ctx.systemPrompt.assemble()).contexts.filter(context => context.name === 'dsh-omo:team-mode'), [])
  } finally {
    await featureFiber.dispose()
    for (const scope of scopes) await scope.dispose()
    for (const detach of detachers) detach()
    await agentRegistryFiber.dispose()
    await systemPromptFiber.dispose()
  }
})
