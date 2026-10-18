import assert from 'node:assert/strict'
import test from 'node:test'
import { createGoalUseReminder, GOAL_USE_REMINDER } from '../src/goal-use-reminder.js'

const goalTools = ['dsh_omo_goal_get', 'dsh_omo_goal_create', 'dsh_omo_goal_update']
const liveAgents = new Map()
const agentsService = { get: agentId => liveAgents.get(agentId) }
const teamService = {
  tryMembership: agent => agent?.id?.startsWith('team-') ? { id: 'team-1' } : undefined,
}

function createCall(reminder, name, agent, { isError = false, kind = 'accept', signal, additionalContexts, value } = {}) {
  if (agent && typeof agent.id === 'string') liveAgents.set(agent.id, agent)
  let nextCalls = 0
  const decision = {
    kind,
    ...(kind === 'accept' ? { value: value ?? { ok: true } } : { feedback: [{ type: 'text', text: 'blocked' }] }),
  }
  if (additionalContexts !== undefined) decision.additionalContexts = additionalContexts
  return reminder.listener(
    { name, agent, signal: signal ?? new AbortController().signal },
    { isError },
    async () => {
      nextCalls += 1
      return decision
    },
  ).then(result => ({ result, nextCalls }))
}

test('reminds after ten accepted non-Goal outcomes, including errors, and preserves decisions', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const agent = { id: 'agent-one' }
  for (let index = 0; index < 9; index += 1) {
    const { result, nextCalls } = await createCall(reminder, 'fs_read', agent, { isError: index === 2 })
    assert.equal(result.additionalContexts, undefined)
    assert.equal(nextCalls, 1)
  }

  const prior = { role: 'user', content: [{ type: 'text', text: 'prior context' }] }
  const originalValue = { ok: 'original' }
  const { result, nextCalls } = await createCall(reminder, 'fs_write', agent, {
    isError: true,
    value: originalValue,
    additionalContexts: [prior],
  })
  assert.equal(nextCalls, 1)
  assert.equal(result.value, originalValue)
  assert.equal(result.additionalContexts[0], prior)
  assert.equal(result.additionalContexts.length, 2)
  assert.match(result.additionalContexts[1].content[0].text, /DSH Goal-use reminder/u)
  assert.match(result.additionalContexts[1].content[0].text, /one durable objective, not a task list/u)
  assert.match(result.additionalContexts[1].content[0].text, /never authorizes creating, editing, completing/u)
  assert.equal(result.additionalContexts[1].content[0].text, GOAL_USE_REMINDER)
  reminder.dispose()
})

test('caps reminders at three per Agent and does not evict live state at capacity', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const cappedAgent = { id: 'agent-cap' }
  let reminders = 0
  for (let index = 0; index < 130; index += 1) {
    const { result } = await createCall(reminder, 'fs_read', cappedAgent)
    if (result.additionalContexts) reminders += 1
  }
  assert.equal(reminders, 3)
  assert.equal((await createCall(reminder, 'fs_read', cappedAgent)).result.additionalContexts, undefined)

  const agent = { id: 'agent-cadence' }
  await createCall(reminder, 'fs_read', agent)
  const tracked = Array.from({ length: 254 }, (_value, index) => ({ id: `agent-${index}` }))
  for (const trackedAgent of tracked) await createCall(reminder, 'fs_read', trackedAgent)
  const overflow = { id: 'agent-overflow' }
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', overflow)).result.additionalContexts, undefined)
  }
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', agent)).result.additionalContexts, undefined)
  }
  assert.ok((await createCall(reminder, 'fs_read', agent)).result.additionalContexts, 'the first tracked Agent retains its cadence')

  reminder.clearAgent(tracked[0])
  for (let index = 0; index < 10; index += 1) {
    const result = await createCall(reminder, 'fs_read', overflow)
    if (index < 9) assert.equal(result.result.additionalContexts, undefined)
    else assert.ok(result.result.additionalContexts, 'a disposed Agent frees one bounded slot')
  }
  reminder.dispose()
})

test('each exact Goal Tool resets cadence even when its dispatch is blocked or errors', async () => {
  for (const goalTool of goalTools) {
    const reminder = createGoalUseReminder(teamService, agentsService)
    const agent = { id: `reset-${goalTool}` }
    for (let index = 0; index < 9; index += 1) await createCall(reminder, 'fs_read', agent)
    const { result } = await createCall(reminder, goalTool, agent, { kind: 'block' })
    assert.equal(result.kind, 'block')
    for (let index = 0; index < 9; index += 1) {
      assert.equal((await createCall(reminder, 'fs_read', agent, { isError: index === 0 })).result.additionalContexts, undefined)
    }
    assert.ok((await createCall(reminder, 'fs_read', agent)).result.additionalContexts)
    for (let index = 0; index < 5; index += 1) await createCall(reminder, 'fs_read', agent)
    assert.equal((await createCall(reminder, goalTool, agent, { isError: true })).result.additionalContexts, undefined)
    for (let index = 0; index < 9; index += 1) {
      assert.equal((await createCall(reminder, 'fs_read', agent)).result.additionalContexts, undefined)
    }
    assert.ok((await createCall(reminder, 'fs_read', agent)).result.additionalContexts)
    for (let index = 0; index < 7; index += 1) await createCall(reminder, 'fs_read', agent)
    const aborted = new AbortController()
    aborted.abort()
    assert.equal((await createCall(reminder, goalTool, agent, { signal: aborted.signal })).result.additionalContexts, undefined)
    for (let index = 0; index < 9; index += 1) {
      assert.equal((await createCall(reminder, 'fs_read', agent)).result.additionalContexts, undefined)
    }
    assert.ok((await createCall(reminder, 'fs_read', agent)).result.additionalContexts)
    reminder.dispose()
  }
})

test('counts only accepted non-Team calls and fails closed on unknown membership', async () => {
  let mode = 'normal'
  const service = {
    tryMembership(agent) {
      if (mode === 'throw') throw new Error('private membership failure')
      if (mode === 'malformed') return null
      if (agent?.id?.startsWith('team-')) return { id: 'team-1' }
      return undefined
    },
  }
  const reminder = createGoalUseReminder(service, agentsService)
  const teamAgent = { id: 'team-lead' }
  for (let index = 0; index < 15; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', teamAgent)).result.additionalContexts, undefined)
  }

  const agent = { id: 'non-team' }
  for (let index = 0; index < 5; index += 1) await createCall(reminder, 'fs_read', agent)
  mode = 'throw'
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', agent)).result.additionalContexts, undefined)
  }
  mode = 'malformed'
  assert.equal((await createCall(reminder, 'fs_read', agent)).result.additionalContexts, undefined)
  mode = 'normal'
  for (let index = 0; index < 9; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', agent, { kind: 'block' })).result.additionalContexts, undefined)
    assert.equal((await createCall(reminder, 'fs_read', agent)).result.additionalContexts, undefined)
  }
  assert.ok((await createCall(reminder, 'fs_read', agent)).result.additionalContexts)
  reminder.dispose()
})

test('fails closed when agents.get does not return the exact live caller', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const stale = { id: 'stale-agent' }
  liveAgents.set(stale.id, { id: stale.id })
  for (let index = 0; index < 12; index += 1) {
    const decision = await reminder.listener(
      { name: 'fs_read', agent: stale, signal: new AbortController().signal },
      { isError: false },
      async () => ({ kind: 'accept', value: {} }),
    )
    assert.equal(decision.additionalContexts, undefined)
  }
  reminder.dispose()
})

test('Goal-call matching is exact, Agents are isolated, and disposal clears state', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const first = { id: 'agent-first' }
  const second = { id: 'agent-second' }
  for (let index = 0; index < 9; index += 1) await createCall(reminder, 'fs_read', first)
  for (let index = 0; index < 9; index += 1) await createCall(reminder, 'fs_read', second)
  assert.ok((await createCall(reminder, 'dsh_omo_goal_get_extra', first)).result.additionalContexts,
    'a similarly named Tool is an ordinary counted outcome')
  assert.ok((await createCall(reminder, 'fs_read', second)).result.additionalContexts,
    'the second Agent retains its independent cadence')
  reminder.clearAgent(first)
  const restarted = { id: first.id }
  for (let index = 0; index < 9; index += 1) assert.equal((await createCall(reminder, 'fs_read', restarted)).result.additionalContexts, undefined)
  assert.ok((await createCall(reminder, 'fs_read', restarted)).result.additionalContexts)
  reminder.dispose()
})

test('same-ID replacement gets fresh cadence and cap; late old disposal preserves its state', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const oldAgent = { id: 'reused-agent-id' }
  let oldReminders = 0
  for (let index = 0; index < 30; index += 1) {
    if ((await createCall(reminder, 'fs_read', oldAgent)).result.additionalContexts) oldReminders += 1
  }
  assert.equal(oldReminders, 3, 'the original Agent reaches its existing reminder cap')

  const replacement = { id: oldAgent.id }
  let replacementReminders = 0
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', replacement)).result.additionalContexts, undefined)
  }
  reminder.clearAgent(oldAgent)
  for (let index = 5; index < 30; index += 1) {
    const result = await createCall(reminder, 'fs_read', replacement)
    if (index === 9 || index === 19 || index === 29) {
      assert.ok(result.result.additionalContexts, `replacement reminder ${replacementReminders + 1} should fire at its fresh cadence`)
      replacementReminders += 1
    } else {
      assert.equal(result.result.additionalContexts, undefined)
    }
  }
  assert.equal(replacementReminders, 3, 'replacement receives an independent three-reminder cap')
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', replacement)).result.additionalContexts, undefined)
  }
  reminder.dispose()
})

test('preserves content-only decisions and ignores overlong Agent IDs', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const overlong = { id: 'x'.repeat(257) }
  for (let index = 0; index < 12; index += 1) {
    assert.equal((await createCall(reminder, 'fs_read', overlong)).result.additionalContexts, undefined)
  }

  const agent = { id: 'content-agent' }
  for (let index = 0; index < 9; index += 1) await createCall(reminder, 'fs_read', agent)
  const content = [{ type: 'text', text: 'unchanged native content' }]
  const prior = { role: 'user', content: [{ type: 'text', text: 'prior context' }] }
  const result = await reminder.listener(
    { name: 'fs_read', agent, signal: new AbortController().signal },
    { isError: false },
    async () => ({ kind: 'accept', content, additionalContexts: [prior] }),
  )
  assert.equal(result.content, content)
  assert.equal(result.additionalContexts[0], prior)
  assert.match(result.additionalContexts[1].content[0].text, /DSH Goal-use reminder/u)
  reminder.dispose()
})

test('Agent disposal fences pending callbacks for that exact Agent instance', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const agent = { id: 'disposed-agent' }
  liveAgents.set(agent.id, agent)
  let resolveNext
  const pending = reminder.listener(
    { name: 'fs_read', agent, signal: new AbortController().signal },
    { isError: false },
    () => new Promise(resolve => { resolveNext = resolve }),
  )
  reminder.clearAgent(agent)
  resolveNext({ kind: 'accept', value: {} })
  assert.deepEqual(await pending, { kind: 'accept', value: {} })
  reminder.dispose()
})

test('cancellation and disposal never append a stale reminder', async () => {
  const reminder = createGoalUseReminder(teamService, agentsService)
  const agent = { id: 'cancel-agent' }
  for (let index = 0; index < 9; index += 1) await createCall(reminder, 'fs_read', agent)
  const controller = new AbortController()
  controller.abort()
  assert.equal((await createCall(reminder, 'fs_read', agent, { signal: controller.signal })).result.additionalContexts, undefined)

  let resolveNext
  const pending = reminder.listener(
    { name: 'fs_read', agent, signal: new AbortController().signal },
    { isError: false },
    () => new Promise(resolve => { resolveNext = resolve }),
  )
  reminder.dispose()
  resolveNext({ kind: 'accept', value: {} })
  assert.deepEqual(await pending, { kind: 'accept', value: {} })
})
