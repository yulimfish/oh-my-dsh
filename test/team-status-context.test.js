import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createTeamStatusContext } from '../src/team-status-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))

const CONTEXT_NAME = 'dsh-omo:team-status'

function member(overrides = {}) {
  return {
    id: 'PRIVATE_MEMBER_ID',
    name: 'PRIVATE_MEMBER_NAME',
    role: 'teammate',
    status: 'running',
    description: 'PRIVATE_MEMBER_DESCRIPTION',
    diagnostics: ['PRIVATE_DIAGNOSTIC'],
    diagnosticsTruncated: false,
    ...overrides,
  }
}

function task(overrides = {}) {
  return {
    id: 'PRIVATE_TASK_ID',
    revision: 1,
    subject: 'PRIVATE_TASK_SUBJECT',
    description: 'PRIVATE_TASK_DESCRIPTION',
    status: 'pending',
    blockedBy: [],
    blockedByTruncated: false,
    writeScopes: ['PRIVATE_WRITE_SCOPE'],
    writeScopesTruncated: false,
    writeScopeWarnings: ['PRIVATE_WRITE_SCOPE_WARNING'],
    writeScopeWarningsTruncated: false,
    ready: true,
    ...overrides,
  }
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

function makeHarness({ listMembers = () => [], listTasks = () => [] } = {}) {
  const live = new Map()
  const memberships = new WeakMap()
  const calls = { memberships: [], members: [], tasks: [] }
  const teamService = {
    tryMembership(agent) {
      calls.memberships.push(agent)
      return memberships.get(agent)
    },
    listMembers(agent) {
      calls.members.push(agent)
      return listMembers(agent)
    },
    listTasks(agent) {
      calls.tasks.push(agent)
      return listTasks(agent)
    },
  }
  const agentsService = { get: id => live.get(id) }
  const context = createTeamStatusContext(teamService, agentsService)
  return {
    context,
    live,
    memberships,
    calls,
    teamService,
    async notify(agent, signal) { await context.listener({ agent, signal }) },
    async dispose() { await context.dispose() },
  }
}

function render(entry, agent, signal) {
  assert.equal(typeof entry?.text, 'function', 'Team status is registered as dynamic text')
  return entry.text({ scope: agent, signal })
}

function privateValues(text) {
  assert.doesNotMatch(text, /PRIVATE_|TEAM_PRIVATE|AGENT_PRIVATE/u)
}

test('registers dynamic scoped status only for exact live Team Agents', async () => {
  const harness = makeHarness()
  const lead = makeAgent('AGENT_PRIVATE_LEAD_ID')
  const teammate = makeAgent('AGENT_PRIVATE_TEAMMATE_ID')
  const outside = makeAgent('outside-agent')
  const stale = makeAgent('stale-agent')
  const replacement = makeAgent(stale.id)
  for (const agent of [lead, teammate, outside, stale, replacement]) harness.live.set(agent.id, agent)
  harness.live.set(stale.id, replacement)
  harness.memberships.set(lead, { id: 'TEAM_PRIVATE_ID', name: 'TEAM_PRIVATE_NAME', role: 'lead' })
  harness.memberships.set(teammate, { id: 'TEAM_PRIVATE_ID', name: 'TEAM_PRIVATE_NAME', role: 'teammate' })
  harness.memberships.set(stale, { role: 'lead' })

  await harness.notify(lead)
  await harness.notify(teammate)
  await harness.notify(outside)
  await harness.notify(stale)
  await harness.notify(replacement)

  assert.deepEqual(lead.calls.contexts.map(({ name, order }) => ({ name, order })), [
    { name: CONTEXT_NAME, order: 161 },
  ])
  assert.deepEqual(teammate.calls.contexts.map(({ name, order }) => ({ name, order })), [
    { name: CONTEXT_NAME, order: 161 },
  ])
  assert.equal(typeof lead.calls.contexts[0].text, 'function')
  assert.equal(typeof teammate.calls.contexts[0].text, 'function')
  for (const agent of [outside, stale, replacement]) assert.equal(agent.calls.contexts.length, 0)
  assert.ok(harness.calls.memberships.every(agent => [lead, teammate, outside, stale, replacement].includes(agent)))
  assert.deepEqual(harness.calls.members, [], 'listMembers is deferred until assembly')
  assert.deepEqual(harness.calls.tasks, [], 'listTasks is deferred until assembly')

  await harness.dispose()
})

test('summarizes only allowed counts and totals using the exact Agent as caller', async () => {
  const members = [
    member({ role: 'teammate', status: 'running' }),
    member({ role: 'teammate', status: 'inactive' }),
    member({ role: 'lead', status: 'provisioning' }),
  ]
  const tasks = [
    task({ status: 'pending', ready: true }),
    task({ status: 'in_progress', ready: false }),
    task({ status: 'completed', ready: true }),
  ]
  const harness = makeHarness({ listMembers: () => members, listTasks: () => tasks })
  const agent = makeAgent('AGENT_PRIVATE_ID')
  harness.live.set(agent.id, agent)
  harness.memberships.set(agent, { id: 'TEAM_PRIVATE_ID', name: 'TEAM_PRIVATE_NAME', role: 'lead' })

  await harness.notify(agent)
  const [entry] = agent.calls.contexts
  assert.equal(typeof entry.text, 'function')
  assert.deepEqual(harness.calls.members, [])
  assert.deepEqual(harness.calls.tasks, [])
  const text = render(entry, agent)

  assert.equal(typeof text, 'string')
  assert.ok(text.length <= 768, 'rendered context respects its hard character cap')
  assert.match(text, /member/iu)
  assert.match(text, /task/iu)
  assert.match(text, /\b3\b/u, 'both collection totals are represented in the summary')
  assert.match(text, /lead|teammate/iu, 'member role counts are represented')
  assert.match(text, /running|inactive|provisioning/iu, 'member status counts are represented')
  assert.match(text, /pending|in_progress|in progress|completed/iu, 'task status counts are represented')
  assert.match(text, /ready/iu, 'ready-task counts are represented')
  privateValues(text)
  assert.deepEqual(harness.calls.members, [agent], 'the roster is read with the exact scoped Agent')
  assert.deepEqual(harness.calls.tasks, [agent], 'the task board is read with the exact scoped Agent')
  assert.ok(harness.calls.memberships.every(caller => caller === agent), 'membership is revalidated for the exact Agent')

  await harness.dispose()
})

test('re-reads current member and task rows on every prompt assembly', async () => {
  let members = [member({ role: 'teammate', status: 'running' })]
  let tasks = [task({ status: 'pending', ready: true })]
  const harness = makeHarness({ listMembers: () => members, listTasks: () => tasks })
  const agent = makeAgent('fresh-status-agent')
  harness.live.set(agent.id, agent)
  harness.memberships.set(agent, { role: 'teammate' })
  await harness.notify(agent)
  const entry = agent.calls.contexts[0]

  const first = render(entry, agent)
  assert.match(first, /activity running 1, inactive 0/u)
  assert.match(first, /tasks pending 1, in progress 0, completed 0; ready 1/u)
  members = [member({ role: 'lead', status: 'inactive' })]
  tasks = [task({ status: 'completed', ready: false })]
  const second = render(entry, agent)
  assert.match(second, /roles lead 1, teammate 0; activity running 0, inactive 1/u)
  assert.match(second, /tasks pending 0, in progress 0, completed 1; ready 0/u)
  assert.notEqual(second, first)
  assert.deepEqual(harness.calls.members, [agent, agent])
  assert.deepEqual(harness.calls.tasks, [agent, agent])

  await harness.dispose()
})

test('omits over-limit breakdowns instead of partially counting the first 100 rows', async () => {
  const memberRowsRead = new Set()
  const taskRowsRead = new Set()
  function boundedRows(rows, reads) {
    return new Proxy(rows, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/u.test(property)) {
          const index = Number(property)
          if (index >= 100) throw new Error('scan exceeded 100 rows')
          reads.add(index)
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }
  const memberRows = boundedRows(Array.from({ length: 101 }, () => member()), memberRowsRead)
  const taskRows = boundedRows(Array.from({ length: 101 }, () => task()), taskRowsRead)
  const harness = makeHarness({ listMembers: () => memberRows, listTasks: () => taskRows })
  const agent = makeAgent('bounded-agent')
  harness.live.set(agent.id, agent)
  harness.memberships.set(agent, { role: 'teammate' })
  await harness.notify(agent)

  const text = render(agent.calls.contexts[0], agent)
  assert.equal(typeof text, 'string')
  assert.ok(text.length <= 768, 'overflow summaries also respect the hard character cap')
  assert.match(text, /101/u, 'the full total remains visible')
  assert.match(text, /member/iu)
  assert.match(text, /task/iu)
  assert.match(text, /omit|omission|not (?:shown|counted|included|summarized)|excluded/iu,
    'each over-limit breakdown is explicitly omitted')
  assert.doesNotMatch(text, /(?:teammate|running|pending|ready)\s*[:=]\s*100\b/iu,
    'the first 100 rows are never exposed as a misleading partial count')
  assert.ok(memberRowsRead.size <= 100)
  assert.ok(taskRowsRead.size <= 100)

  await harness.dispose()
})

test('fails open for stale membership, cancellation, invalid rows, and service failures', async () => {
  const harness = makeHarness({ listMembers: () => [member()], listTasks: () => [task()] })
  const agent = makeAgent('fail-open-agent')
  harness.live.set(agent.id, agent)
  harness.memberships.set(agent, { role: 'lead' })
  await harness.notify(agent)
  const [entry] = agent.calls.contexts
  assert.notEqual(render(entry, agent), '')

  harness.memberships.delete(agent)
  assert.equal(render(entry, agent), '', 'a departed/non-Team Agent has no snapshot')

  harness.memberships.set(agent, { role: 'teammate' })
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(render(entry, agent, aborted.signal), '', 'a canceled assembly has no snapshot')

  harness.teamService.listMembers = () => [null]
  assert.equal(render(entry, agent), '', 'an invalid roster row invalidates the whole advisory snapshot')

  harness.teamService.listMembers = () => [member()]
  harness.teamService.listTasks = () => [{ status: 'unknown', ready: true }]
  assert.equal(render(entry, agent), '', 'an invalid task row invalidates the whole advisory snapshot')

  harness.teamService.tryMembership = () => { throw new Error('PRIVATE_MEMBERSHIP_FAILURE') }
  assert.equal(render(entry, agent), '', 'membership service failures fail open')
  harness.teamService.tryMembership = caller => harness.memberships.get(caller)
  harness.teamService.listTasks = () => { throw new Error('PRIVATE_TASK_FAILURE') }
  assert.equal(render(entry, agent), '', 'list service failures fail open')

  harness.teamService.listTasks = () => [task()]
  const replacementDuringRowRead = makeAgent(agent.id)
  harness.teamService.listMembers = () => [{
    role: 'teammate',
    get status() {
      harness.live.set(agent.id, replacementDuringRowRead)
      return 'running'
    },
  }]
  assert.equal(render(entry, agent), '', 'identity changes during status projection are fenced')
  harness.live.set(agent.id, makeAgent(agent.id))
  assert.equal(render(entry, agent), '', 'a replaced Agent identity is not a live caller')
  await harness.dispose()
})

test('prompt-context and Agent-effect registration failures fail open and dispose partial scopes', async () => {
  const harness = makeHarness({ listMembers: () => [member()], listTasks: () => [task()] })
  const contextFailure = makeAgent('context-registration-fails', {
    context() { throw new Error('PRIVATE_CONTEXT_REGISTRATION_FAILURE') },
  })
  harness.live.set(contextFailure.id, contextFailure)
  harness.memberships.set(contextFailure, { role: 'teammate' })
  await assert.doesNotReject(harness.notify(contextFailure), 'agent/created remains advisory')
  assert.deepEqual(contextFailure.calls.contexts, [])

  const effectFailure = makeAgent('effect-registration-fails', {
    effect() { throw new Error('PRIVATE_EFFECT_REGISTRATION_FAILURE') },
  })
  harness.live.set(effectFailure.id, effectFailure)
  harness.memberships.set(effectFailure, { role: 'lead' })
  await assert.doesNotReject(harness.notify(effectFailure), 'scope effect failures do not reject Agent creation')
  assert.equal(effectFailure.calls.contexts.length, 1)
  assert.equal(effectFailure.calls.contextDisposals, 1, 'a context registered before effect failure is removed')
  assert.equal(render(effectFailure.calls.contexts[0], effectFailure), '')

  await harness.dispose()
})

test('per-Agent effect cleanup and plugin disposal invalidate saved dynamic callbacks', async () => {
  const harness = makeHarness({ listMembers: () => [member()], listTasks: () => [task()] })
  const scoped = makeAgent('cleanup-scoped')
  const pluginOwned = makeAgent('cleanup-plugin')
  for (const agent of [scoped, pluginOwned]) {
    harness.live.set(agent.id, agent)
    harness.memberships.set(agent, { role: 'teammate' })
    await harness.notify(agent)
  }
  const scopedText = scoped.calls.contexts[0].text
  const pluginText = pluginOwned.calls.contexts[0].text
  assert.notEqual(render({ text: scopedText }, scoped), '')
  assert.notEqual(render({ text: pluginText }, pluginOwned), '')

  scoped.disposeScope()
  assert.equal(scoped.calls.contextDisposals, 1)
  assert.equal(scoped.calls.trackingDisposals, 1)
  assert.equal(render({ text: scopedText }, scoped), '', 'Agent scope cleanup empties a saved callback')

  await harness.dispose()
  assert.equal(pluginOwned.calls.contextDisposals, 1)
  assert.equal(pluginOwned.calls.trackingDisposals, 1)
  assert.equal(render({ text: pluginText }, pluginOwned), '', 'plugin disposal empties a saved callback')
  await harness.dispose()
  assert.equal(pluginOwned.calls.contextDisposals, 1, 'cleanup is idempotent')
})

test('caps live Agent registrations at 256 without eviction and frees capacity on scope cleanup', async () => {
  const harness = makeHarness()
  const agents = Array.from({ length: 256 }, (_, index) => makeAgent(`capacity-agent-${index}`))
  for (const agent of agents) {
    harness.live.set(agent.id, agent)
    harness.memberships.set(agent, { role: 'teammate' })
    await harness.notify(agent)
  }
  assert.ok(agents.every(agent => agent.calls.contexts.length === 1))

  const overflow = makeAgent('capacity-overflow')
  harness.live.set(overflow.id, overflow)
  harness.memberships.set(overflow, { role: 'lead' })
  await harness.notify(overflow)
  assert.equal(overflow.calls.contexts.length, 0, 'a 257th Agent receives no context instead of evicting a live Agent')
  assert.notEqual(render(agents[0].calls.contexts[0], agents[0]), '', 'existing registrations remain active at capacity')

  agents[0].disposeScope()
  const next = makeAgent('capacity-next')
  harness.live.set(next.id, next)
  harness.memberships.set(next, { role: 'lead' })
  await harness.notify(next)
  assert.equal(next.calls.contexts.length, 1, 'Agent scope cleanup frees one registration slot')
  assert.notEqual(render(next.calls.contexts[0], next), '')

  await harness.dispose()
})

test('assembles Team status through the real DSH systemPrompt service in the matching live Agent scope', async () => {
  const ctx = new Context()
  const systemPromptFiber = await ctx.plugin(SystemPrompt)
  const agentRegistryFiber = await ctx.plugin(AgentRegistry)
  const scopes = []
  const detachers = []
  const memberships = new WeakMap()
  const callers = { membership: [], members: [], tasks: [] }
  const teamService = {
    tryMembership(agent) {
      callers.membership.push(agent)
      return memberships.get(agent)
    },
    listMembers(agent) {
      callers.members.push(agent)
      return [member()]
    },
    listTasks(agent) {
      callers.tasks.push(agent)
      return [task()]
    },
  }
  const teamStatus = createTeamStatusContext(teamService, ctx.agents)
  const featureFiber = await ctx.plugin(pluginCtx => {
    pluginCtx.on('agent/created', teamStatus.listener)
    pluginCtx.effect(() => teamStatus.dispose, 'test Team-status context')
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
    if (role) memberships.set(agent, { id: 'TEAM_PRIVATE_ID', name: 'TEAM_PRIVATE_NAME', role })
    await ctx.agents.announce(agent, 'startup')
    return agent
  }

  try {
    const lead = await createAgent('AGENT_PRIVATE_LIVE', 'lead')
    const outside = await createAgent('outside-live')
    const assemblyFor = async agent => ctx.systemPrompt.assemble({ scope: agent })
    const leadAssembly = await assemblyFor(lead)
    const outsideAssembly = await assemblyFor(outside)
    const statusEntries = leadAssembly.contexts.filter(entry => entry.name === CONTEXT_NAME)
    assert.equal(statusEntries.length, 1)
    assert.match(statusEntries[0].text, /member/iu)
    assert.match(statusEntries[0].text, /task/iu)
    privateValues(statusEntries[0].text)
    assert.deepEqual(outsideAssembly.contexts.filter(entry => entry.name === CONTEXT_NAME), [])
    assert.deepEqual((await ctx.systemPrompt.assemble()).contexts.filter(entry => entry.name === CONTEXT_NAME), [],
      'the contribution is scoped, not globally registered')
    assert.deepEqual(callers.members, [lead])
    assert.deepEqual(callers.tasks, [lead])
    assert.ok(callers.membership.filter(agent => agent === lead).length >= 2,
      'assembly revalidates membership for the exact scoped Agent')
    assert.ok(callers.membership.every(agent => agent === lead || agent === outside),
      'event-time membership checks also receive the exact Agent objects')

    await featureFiber.dispose()
    assert.deepEqual((await assemblyFor(lead)).contexts.filter(entry => entry.name === CONTEXT_NAME), [],
      'plugin disposal removes the dynamic context from the real scope')
  } finally {
    await featureFiber.dispose()
    for (const scope of scopes) await scope.dispose()
    for (const detach of detachers) detach()
    await agentRegistryFiber.dispose()
    await systemPromptFiber.dispose()
  }
})
