import assert from 'node:assert/strict'
import test from 'node:test'
import { createTeamTaskUseReminder } from '../src/team-task-use-reminder.js'

const taskTools = ['team_create_task', 'team_list_tasks', 'team_get_task', 'team_update_task']
const teamService = {
  membership: agent => {
    if (typeof agent?.id === 'string' && agent.id.startsWith('team-')) return { id: 'team-1' }
    throw new Error('Agent is not a Team member')
  },
}

function createCall(listener, name, agent, { isError = false, kind = 'accept', signal, additionalContexts } = {}) {
  let nextCalls = 0
  const decision = { kind, ...(kind === 'accept' ? { content: [] } : { feedback: [] }) }
  if (additionalContexts !== undefined) decision.additionalContexts = additionalContexts
  return listener(
    { name, agent, signal: signal ?? new AbortController().signal },
    { isError },
    async () => {
      nextCalls += 1
      return decision
    },
  ).then(result => ({ result, nextCalls }))
}

test('reminds after ten accepted non-task results, counts errors, and preserves existing contexts', async () => {
  const reminder = createTeamTaskUseReminder(teamService)
  const agent = { id: 'team-lead' }
  for (let index = 0; index < 9; index += 1) {
    const { result, nextCalls } = await createCall(reminder.listener, 'fs_read', agent, { isError: index === 2 })
    assert.equal(result.additionalContexts, undefined)
    assert.equal(nextCalls, 1)
  }

  const previous = { role: 'user', content: [{ type: 'text', text: 'existing context' }] }
  const { result, nextCalls } = await createCall(reminder.listener, 'fs_write', agent, {
    isError: true,
    additionalContexts: [previous],
  })
  assert.equal(nextCalls, 1)
  assert.equal(result.additionalContexts.length, 2)
  assert.equal(result.additionalContexts[0], previous)
  assert.match(result.additionalContexts[1].content[0].text, /Team task-use reminder/u)
  reminder.dispose()
})

test('each exact Team task Tool resets the cadence', async () => {
  for (const taskTool of taskTools) {
    const reminder = createTeamTaskUseReminder(teamService)
    const agent = { id: 'team-lead' }
    for (let index = 0; index < 9; index += 1) await createCall(reminder.listener, 'fs_read', agent)
    const task = await createCall(reminder.listener, taskTool, agent, { isError: true })
    assert.equal(task.result.additionalContexts, undefined)
    for (let index = 0; index < 9; index += 1) {
      const { result } = await createCall(reminder.listener, 'fs_read', agent)
      assert.equal(result.additionalContexts, undefined)
    }
    const tenth = await createCall(reminder.listener, 'fs_read', agent)
    assert.match(tenth.result.additionalContexts[0].content[0].text, /Team task-use reminder/u)
    reminder.dispose()
  }
})

test('counts only exact Team membership and resets state when membership changes', async () => {
  let currentTeamId = 'team-1'
  const reminder = createTeamTaskUseReminder({
    membership(agent) {
      if (agent?.id === 'team-lead') return { id: currentTeamId }
      throw new Error('Agent is not a Team member')
    },
  })
  for (let index = 0; index < 12; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', { id: 'outside-agent' })
    assert.equal(result.additionalContexts, undefined)
  }

  const agent = { id: 'team-lead' }
  for (let index = 0; index < 5; index += 1) await createCall(reminder.listener, 'fs_read', agent)
  currentTeamId = 'team-2'
  for (let index = 0; index < 9; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', agent)
    assert.equal(result.additionalContexts, undefined)
  }
  const tenth = await createCall(reminder.listener, 'fs_read', agent)
  assert.match(tenth.result.additionalContexts[0].content[0].text, /Team task-use reminder/u)
  reminder.dispose()
})

test('downstream blocks and cancellation do not count; disposal clears one Agent', async () => {
  const reminder = createTeamTaskUseReminder(teamService)
  const agent = { id: 'team-lead' }
  for (let index = 0; index < 5; index += 1) await createCall(reminder.listener, 'fs_read', agent)
  const blocked = await createCall(reminder.listener, 'fs_read', agent, { kind: 'block' })
  assert.equal(blocked.result.kind, 'block')

  const controller = new AbortController()
  controller.abort()
  const aborted = await createCall(reminder.listener, 'fs_read', agent, { signal: controller.signal })
  assert.equal(aborted.result.additionalContexts, undefined)
  for (let index = 0; index < 4; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', agent)
    assert.equal(result.additionalContexts, undefined)
  }
  assert.match((await createCall(reminder.listener, 'fs_read', agent)).result.additionalContexts[0].content[0].text, /Team task-use reminder/u)

  reminder.clearAgent(agent)
  for (let index = 0; index < 9; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', agent)
    assert.equal(result.additionalContexts, undefined)
  }
  assert.ok((await createCall(reminder.listener, 'fs_read', agent)).result.additionalContexts)
  reminder.dispose()
})

test('does not resume reminder work after plugin disposal during downstream execution', async () => {
  const reminder = createTeamTaskUseReminder(teamService)
  const agent = { id: 'team-lead' }
  for (let index = 0; index < 9; index += 1) await createCall(reminder.listener, 'fs_read', agent)

  let resolveNext
  const pending = reminder.listener(
    { name: 'fs_read', agent, signal: new AbortController().signal },
    { isError: false },
    () => new Promise(resolve => { resolveNext = resolve }),
  )
  reminder.dispose()
  resolveNext({ kind: 'accept', content: [] })
  const decision = await pending
  assert.equal(decision.additionalContexts, undefined)

  for (let index = 0; index < 11; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', agent)
    assert.equal(result.additionalContexts, undefined)
  }
})

test('bounds retained state to 256 Agent IDs and evicts the least-recently-used entry', async () => {
  const reminder = createTeamTaskUseReminder(teamService)
  const first = { id: 'team-agent-0' }
  for (let index = 0; index < 257; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', { id: `team-agent-${index}` })
    assert.equal(result.additionalContexts, undefined)
  }
  for (let index = 0; index < 9; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', first)
    assert.equal(result.additionalContexts, undefined)
  }
  assert.ok((await createCall(reminder.listener, 'fs_read', first)).result.additionalContexts)
  reminder.dispose()
})

test('blocked calls and unseen task calls do not churn counted LRU entries', async () => {
  for (const churn of ['blocked', 'task']) {
    const reminder = createTeamTaskUseReminder(teamService)
    const first = { id: 'team-agent-0' }
    for (let index = 0; index < 256; index += 1) {
      const { result } = await createCall(reminder.listener, 'fs_read', { id: `team-agent-${index}` })
      assert.equal(result.additionalContexts, undefined)
    }

    if (churn === 'blocked') {
      const { result } = await createCall(reminder.listener, 'other_tool', { id: 'team-new-agent' }, { kind: 'block' })
      assert.equal(result.kind, 'block')
    } else {
      const { result } = await createCall(reminder.listener, 'team_create_task', { id: 'team-new-agent' })
      assert.equal(result.additionalContexts, undefined)
    }

    for (let index = 0; index < 8; index += 1) {
      const { result } = await createCall(reminder.listener, 'fs_read', first)
      assert.equal(result.additionalContexts, undefined)
    }
    assert.ok((await createCall(reminder.listener, 'fs_read', first)).result.additionalContexts)
    reminder.dispose()
  }
})

test('documents and enforces explicit Agent and Team identity bounds', async () => {
  let teamId = 't'.repeat(128)
  const reminder = createTeamTaskUseReminder({
    membership(agent) {
      if (typeof agent?.id !== 'string' || !agent.id.startsWith('team-')) throw new Error('Agent is not a Team member')
      return { id: teamId }
    },
  })
  const maxAgentId = { id: `team-${'a'.repeat(251)}` }
  for (let index = 0; index < 10; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', maxAgentId)
    if (index < 9) assert.equal(result.additionalContexts, undefined)
    else assert.ok(result.additionalContexts)
  }

  const overAgentId = { id: `team-${'a'.repeat(252)}` }
  for (let index = 0; index < 11; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', overAgentId)
    assert.equal(result.additionalContexts, undefined)
  }

  const boundedAgent = { id: 'team-boundary' }
  for (let index = 0; index < 9; index += 1) await createCall(reminder.listener, 'fs_read', boundedAgent)
  teamId = 't'.repeat(129)
  assert.equal((await createCall(reminder.listener, 'fs_read', boundedAgent)).result.additionalContexts, undefined)
  teamId = 't'.repeat(128)
  for (let index = 0; index < 9; index += 1) {
    const { result } = await createCall(reminder.listener, 'fs_read', boundedAgent)
    assert.equal(result.additionalContexts, undefined)
  }
  assert.ok((await createCall(reminder.listener, 'fs_read', boundedAgent)).result.additionalContexts)
  reminder.dispose()
})
