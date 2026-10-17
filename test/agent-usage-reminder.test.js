import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_USAGE_DELEGATION_TOOLS,
  AGENT_USAGE_REMINDER,
  AGENT_USAGE_TARGET_TOOLS,
  AGENT_USAGE_TASK_TOOLS,
  MAX_AGENT_ID_LENGTH,
  MAX_AGENT_USAGE_REMINDERS,
  MAX_ROOTS_TO_SCAN,
  MAX_TOOL_NAME_LENGTH,
  MAX_TRACKED_AGENT_STATES,
  createAgentUsageReminder,
} from '../src/agent-usage-reminder.js'

const visibleTools = [...AGENT_USAGE_DELEGATION_TOOLS]

function createRuntime(rootAgents = [], { visible = visibleTools } = {}) {
  const agentsById = new Map(rootAgents.map(agent => [agent.id, agent]))
  const failures = { get: false, roots: false, tools: false, malformedRoots: false }
  const toolCalls = []
  let rootList = [...rootAgents]
  let visibleTool = (name, _agent) => visible.includes(name)

  const agentsService = {
    get(id) {
      if (failures.get) throw new Error('agent lookup failed')
      return agentsById.get(id)
    },
    roots() {
      if (failures.roots) throw new Error('root lookup failed')
      if (failures.malformedRoots) return null
      return rootList
    },
  }
  const toolsService = {
    get(name, agent) {
      toolCalls.push({ name, agent })
      if (failures.tools) throw new Error('tool lookup failed')
      return visibleTool(name, agent) ? { name } : undefined
    },
  }

  return {
    agentsService,
    toolsService,
    agentsById,
    failures,
    toolCalls,
    setRoots(roots) { rootList = roots },
    setVisibleTool(predicate) { visibleTool = predicate },
  }
}

function accepted(overrides = {}) {
  return {
    kind: 'accept',
    content: [{ type: 'text', text: 'unchanged terminal outcome' }],
    ...overrides,
  }
}

async function cordisWaterfall(listeners, exec, result, terminalDecision) {
  const nextCalls = Array(listeners.length).fill(0)
  async function dispatch(index) {
    if (index >= listeners.length) return terminalDecision
    const next = () => {
      nextCalls[index] += 1
      if (nextCalls[index] !== 1) throw new Error('Cordis next() called more than once')
      return dispatch(index + 1)
    }
    const decision = await listeners[index](exec, result, next)
    assert.equal(nextCalls[index], 1, `waterfall listener ${index} must call next() exactly once`)
    return decision
  }
  return { decision: await dispatch(0), nextCalls }
}

async function execute(reminder, agent, name, options = {}) {
  const exec = {
    name,
    agent,
    signal: options.signal ?? new AbortController().signal,
    ...(Object.hasOwn(options, 'parent') ? { parent: options.parent } : {}),
    ...(options.execFields ?? {}),
  }
  const result = options.result ?? { isError: false }
  const decision = options.decision ?? accepted()
  const middleware = [reminder.listener, ...(options.downstream ? [options.downstream] : [])]
  return cordisWaterfall(middleware, exec, result, decision)
}

function reminderText(decision) {
  return decision.additionalContexts?.at(-1)?.content?.[0]?.text
}

test('validates exact DSH services and participates once in the Cordis waterfall', async () => {
  assert.throws(() => createAgentUsageReminder({}, { get() {} }), /agents\.get and agents\.roots/u)
  assert.throws(() => createAgentUsageReminder({ get() {}, roots() {} }, {}), /tools\.get/u)

  const agent = { id: 'root' }
  const runtime = createRuntime([agent])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
  const passThrough = async (_exec, _result, next) => next()
  const { decision, nextCalls } = await execute(reminder, agent, 'grep', {
    downstream: passThrough,
    result: { isError: true },
  })
  assert.equal(nextCalls[0], 1)
  assert.equal(nextCalls[1], 1)
  assert.equal(reminderText(decision), AGENT_USAGE_REMINDER)
  reminder.dispose()
})

test('accepts only exact live roots within the bounded roots prefix', async () => {
  const root = { id: 'root' }
  const child = { id: 'child' }
  const stale = { id: 'root' }
  const runtime = createRuntime([root])
  runtime.agentsById.set(child.id, child)
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)

  for (const untracked of [child, stale]) {
    for (let index = 0; index < 4; index += 1) {
      const { decision } = await execute(reminder, untracked, 'grep')
      assert.equal(decision.additionalContexts, undefined)
    }
  }
  assert.equal(reminderText((await execute(reminder, root, 'grep')).decision), AGENT_USAGE_REMINDER)

  const roots = Array.from({ length: MAX_ROOTS_TO_SCAN + 1 }, (_value, index) => ({ id: `root-${index}` }))
  const beyondScan = roots.at(-1)
  const boundedRuntime = createRuntime(roots)
  const boundedReminder = createAgentUsageReminder(boundedRuntime.agentsService, boundedRuntime.toolsService)
  assert.equal((await execute(boundedReminder, beyondScan, 'grep')).decision.additionalContexts, undefined)
  assert.equal(reminderText((await execute(boundedReminder, roots[MAX_ROOTS_TO_SCAN - 1], 'grep')).decision), AGENT_USAGE_REMINDER)
  reminder.dispose()
  boundedReminder.dispose()
})

test('requires an exact delegation Tool visible to the caller Agent scope', async () => {
  const agent = { id: 'scoped-root' }
  const runtime = createRuntime([agent], { visible: [] })
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)

  for (let index = 0; index < 5; index += 1) {
    assert.equal((await execute(reminder, agent, 'web_fetch')).decision.additionalContexts, undefined)
  }
  assert.deepEqual(runtime.toolCalls.map(call => call.name), Array(5).fill(AGENT_USAGE_DELEGATION_TOOLS).flat())
  assert.ok(runtime.toolCalls.every(call => call.agent === agent))

  runtime.setVisibleTool((name, scope) => name === 'dsh_omo_task_followup' && scope === agent)
  const { decision } = await execute(reminder, agent, 'web_fetch')
  assert.equal(reminderText(decision), AGENT_USAGE_REMINDER)
  assert.equal(runtime.toolCalls.at(-1).name, 'dsh_omo_task_followup')
  assert.equal(runtime.toolCalls.at(-1).agent, agent)
  reminder.dispose()

  const mismatchedAgent = { id: 'mismatched-definition' }
  const mismatchedRuntime = createRuntime([mismatchedAgent])
  mismatchedRuntime.toolsService.get = () => ({ name: 'different-visible-tool' })
  const mismatchedReminder = createAgentUsageReminder(mismatchedRuntime.agentsService, mismatchedRuntime.toolsService)
  assert.equal((await execute(mismatchedReminder, mismatchedAgent, 'grep')).decision.additionalContexts, undefined)
  mismatchedReminder.dispose()
})

test('matches the pinned target allowlist case-insensitively, counts accepted errors, and keeps advice fixed', async () => {
  for (const name of AGENT_USAGE_TARGET_TOOLS) {
    const agent = { id: `root-${name}` }
    const runtime = createRuntime([agent])
    const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
    const { decision } = await execute(reminder, agent, name.toUpperCase(), {
      result: { isError: true, output: 'SECRET TOOL OUTPUT' },
      execFields: { arguments: { query: 'SECRET ARGUMENT' } },
    })
    assert.equal(reminderText(decision), AGENT_USAGE_REMINDER, name)
    assert.equal(decision.content[0].text, 'unchanged terminal outcome')
    assert.equal(JSON.stringify(decision.additionalContexts).includes('SECRET'), false)
    reminder.dispose()
  }

  const agent = { id: 'near-match' }
  const runtime = createRuntime([agent])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
  for (const name of ['grep_extra', 'webfetcher', 'dsh_omo_task_extra', 'g'.repeat(MAX_TOOL_NAME_LENGTH + 1)]) {
    const { decision } = await execute(reminder, agent, name)
    assert.equal(decision.additionalContexts, undefined)
  }
  reminder.dispose()
})

test('each exact delegation Tool suppresses reminders even when blocked, failed, or canceled', async () => {
  for (const taskTool of AGENT_USAGE_TASK_TOOLS) {
    const agent = { id: `task-${taskTool}` }
    const runtime = createRuntime([agent])
    const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
    assert.equal(reminderText((await execute(reminder, agent, 'grep')).decision), AGENT_USAGE_REMINDER)

    const controller = new AbortController()
    controller.abort()
    const { decision: blocked } = await execute(reminder, agent, taskTool, {
      signal: controller.signal,
      result: { isError: true, error: 'failed task dispatch' },
      decision: { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] },
    })
    assert.equal(blocked.kind, 'block')

    for (let index = 0; index < 4; index += 1) {
      assert.equal((await execute(reminder, agent, 'grep')).decision.additionalContexts, undefined)
    }
    reminder.dispose()
  }
})

test('blocked, canceled, and nested target dispatches do not consume the cap', async () => {
  const agent = { id: 'dispatch-filter' }
  const runtime = createRuntime([agent])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
  const blocked = { kind: 'block', feedback: [] }
  assert.equal((await execute(reminder, agent, 'grep', { decision: blocked })).decision, blocked)

  const controller = new AbortController()
  const abortAfterDownstream = async (_exec, _result, next) => {
    const result = await next()
    controller.abort()
    return result
  }
  assert.equal((await execute(reminder, agent, 'grep', {
    signal: controller.signal,
    downstream: abortAfterDownstream,
  })).decision.additionalContexts, undefined)

  const callsBeforeNested = runtime.toolCalls.length
  assert.equal((await execute(reminder, agent, 'grep', { parent: { token: 'parent' } })).decision.additionalContexts, undefined)
  assert.equal(runtime.toolCalls.length, callsBeforeNested)

  for (let index = 0; index < MAX_AGENT_USAGE_REMINDERS; index += 1) {
    assert.equal(reminderText((await execute(reminder, agent, 'grep')).decision), AGENT_USAGE_REMINDER)
  }
  assert.equal((await execute(reminder, agent, 'grep')).decision.additionalContexts, undefined)
  reminder.dispose()
})

test('limits reminders to three per Agent while isolating independent Agent state', async () => {
  const first = { id: 'first' }
  const second = { id: 'second' }
  const runtime = createRuntime([first, second])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)

  for (const agent of [first, second]) {
    for (let index = 0; index < MAX_AGENT_USAGE_REMINDERS; index += 1) {
      assert.equal(reminderText((await execute(reminder, agent, 'glob')).decision), AGENT_USAGE_REMINDER)
    }
    assert.equal((await execute(reminder, agent, 'glob')).decision.additionalContexts, undefined)
  }
  reminder.dispose()
})

test('keeps 256 tracked Agent states without evicting for a new Agent', async () => {
  const runtime = createRuntime([])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
  const oldAgents = Array.from({ length: MAX_TRACKED_AGENT_STATES - 1 }, (_value, index) => ({ id: `old-${index}` }))

  // State is intentionally process-local, so these still occupy slots until their scopes dispose.
  for (const agent of oldAgents) {
    runtime.agentsById.set(agent.id, agent)
    runtime.setRoots([agent])
    assert.equal(reminderText((await execute(reminder, agent, 'grep')).decision), AGENT_USAGE_REMINDER)
  }

  const keeper = { id: 'keeper' }
  runtime.agentsById.set(keeper.id, keeper)
  runtime.setRoots([keeper])
  assert.equal(reminderText((await execute(reminder, keeper, 'grep')).decision), AGENT_USAGE_REMINDER)

  const overflow = { id: 'overflow' }
  runtime.agentsById.set(overflow.id, overflow)
  runtime.setRoots([overflow, keeper])
  assert.equal((await execute(reminder, overflow, 'grep')).decision.additionalContexts, undefined)
  assert.equal(reminderText((await execute(reminder, keeper, 'grep')).decision), AGENT_USAGE_REMINDER)
  reminder.clearAgent(oldAgents[0])
  assert.equal(reminderText((await execute(reminder, overflow, 'grep')).decision), AGENT_USAGE_REMINDER)
  reminder.dispose()
})

test('requires bounded nonempty Agent IDs and fails closed on malformed runtime services', async () => {
  const exactLength = { id: 'a'.repeat(MAX_AGENT_ID_LENGTH) }
  const overLength = { id: 'b'.repeat(MAX_AGENT_ID_LENGTH + 1) }
  const empty = { id: '' }
  const runtime = createRuntime([exactLength])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
  assert.equal(reminderText((await execute(reminder, exactLength, 'grep')).decision), AGENT_USAGE_REMINDER)
  for (const agent of [overLength, empty]) {
    runtime.agentsById.set(agent.id, agent)
    runtime.setRoots([agent])
    assert.equal((await execute(reminder, agent, 'grep')).decision.additionalContexts, undefined)
  }

  const valid = { id: 'service-errors' }
  const failuresRuntime = createRuntime([valid])
  const failuresReminder = createAgentUsageReminder(failuresRuntime.agentsService, failuresRuntime.toolsService)
  for (const failure of ['get', 'roots', 'malformedRoots', 'tools']) {
    failuresRuntime.failures[failure] = true
    assert.equal((await execute(failuresReminder, valid, 'grep')).decision.additionalContexts, undefined, failure)
    failuresRuntime.failures[failure] = false
  }
  assert.equal(reminderText((await execute(failuresReminder, valid, 'grep')).decision), AGENT_USAGE_REMINDER)

  failuresRuntime.setRoots([valid, null])
  assert.equal((await execute(failuresReminder, valid, 'grep')).decision.additionalContexts, undefined)
  failuresRuntime.setRoots([valid])
  assert.equal(reminderText((await execute(failuresReminder, valid, 'grep')).decision), AGENT_USAGE_REMINDER)
  reminder.dispose()
  failuresReminder.dispose()
})

test('stale ID callers cannot replace live state; Agent disposal and ID reuse reset exact scope state', async () => {
  const original = { id: 'reused-id' }
  const runtime = createRuntime([original])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
  assert.equal(reminderText((await execute(reminder, original, 'grep')).decision), AGENT_USAGE_REMINDER)

  const stale = { id: original.id }
  assert.equal((await execute(reminder, stale, 'grep')).decision.additionalContexts, undefined)
  assert.equal(reminderText((await execute(reminder, original, 'grep')).decision), AGENT_USAGE_REMINDER)

  const replacement = { id: original.id }
  runtime.agentsById.set(replacement.id, replacement)
  runtime.setRoots([replacement])
  assert.equal(reminderText((await execute(reminder, replacement, 'grep')).decision), AGENT_USAGE_REMINDER)
  reminder.clearAgent(original)
  assert.equal(reminderText((await execute(reminder, replacement, 'grep')).decision), AGENT_USAGE_REMINDER)

  reminder.clearAgent(replacement)
  const recreatedScope = { id: replacement.id }
  runtime.agentsById.set(recreatedScope.id, recreatedScope)
  runtime.setRoots([recreatedScope])
  assert.equal(reminderText((await execute(reminder, recreatedScope, 'grep')).decision), AGENT_USAGE_REMINDER)
  reminder.dispose()
})

test('scope disposal fences a pending callback and plugin disposal prevents all new work', async () => {
  const agent = { id: 'pending' }
  const runtime = createRuntime([agent])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)

  let resolveDownstream
  let reachedDownstream
  const downstreamReady = new Promise(resolve => { reachedDownstream = resolve })
  const pending = execute(reminder, agent, 'grep', {
    downstream: async (_exec, _result, next) => {
      const decision = await next()
      return new Promise(resolve => {
        resolveDownstream = () => resolve(decision)
        reachedDownstream()
      })
    },
  })
  await downstreamReady
  reminder.clearAgent(agent)
  resolveDownstream()
  assert.equal((await pending).decision.additionalContexts, undefined)

  let resolveNext
  let reachedNext
  const nextReady = new Promise(resolve => { reachedNext = resolve })
  const duringDispose = execute(reminder, agent, 'grep', {
    downstream: async (_exec, _result, next) => {
      const decision = await next()
      return new Promise(resolve => {
        resolveNext = () => resolve(decision)
        reachedNext()
      })
    },
  })
  await nextReady
  reminder.dispose()
  resolveNext()
  assert.equal((await duringDispose).decision.additionalContexts, undefined)
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await execute(reminder, agent, 'grep')).decision.additionalContexts, undefined)
  }
})

test('preserves downstream decision and contexts without reading arguments or result output', async () => {
  const agent = { id: 'opaque-data' }
  const runtime = createRuntime([agent])
  const reminder = createAgentUsageReminder(runtime.agentsService, runtime.toolsService)
  const prior = { role: 'user', content: [{ type: 'text', text: 'prior context' }] }
  const originalContent = [{ type: 'text', text: 'downstream result text' }]
  const terminal = accepted({ content: originalContent, additionalContexts: [prior], marker: 'preserved' })
  const execFields = {}
  Object.defineProperty(execFields, 'arguments', {
    get() { throw new Error('arguments must not be read') },
  })
  const result = {}
  Object.defineProperty(result, 'output', {
    get() { throw new Error('result output must not be read') },
  })
  Object.defineProperty(result, 'isError', {
    get() { throw new Error('result status must not be read') },
  })

  const { decision, nextCalls } = await execute(reminder, agent, 'web_search', {
    execFields,
    result,
    decision: terminal,
  })
  assert.equal(nextCalls[0], 1)
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content, originalContent)
  assert.equal(decision.marker, 'preserved')
  assert.equal(decision.additionalContexts[0], prior)
  assert.equal(decision.additionalContexts[1].content[0].text, AGENT_USAGE_REMINDER)
  assert.equal(JSON.stringify(decision.additionalContexts).includes('downstream result text'), false)
  reminder.dispose()
})
