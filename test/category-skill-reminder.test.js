import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCategoryRoutes } from '../src/category-routes.js'
import {
  CATEGORY_SKILL_REMINDER_TARGET_TOOLS,
  CATEGORY_SKILL_REMINDER_THRESHOLD,
  MAX_CATEGORY_SKILL_REMINDER_BYTES,
  MAX_CATEGORY_SKILL_REMINDER_CATEGORIES,
  createCategorySkillReminder,
  createCategorySkillReminderText,
} from '../src/category-skill-reminder.js'
import {
  AGENT_USAGE_TASK_TOOLS,
  MAX_ROOTS_TO_SCAN,
  MAX_TRACKED_AGENT_STATES,
} from '../src/agent-usage-reminder.js'

function categories(entries = []) {
  return normalizeCategoryRoutes(entries.map(entry => ({ provider: 'test-provider', model: 'test-model', ...entry })))
}

function createRuntime(rootAgents = [], { visible = true } = {}) {
  const agentsById = new Map(rootAgents.map(agent => [agent.id, agent]))
  const toolCalls = []
  const definitions = new Map()
  let rootList = [...rootAgents]
  let isVisible = typeof visible === 'function' ? visible : () => visible
  const agentsService = {
    get(id) { return agentsById.get(id) },
    roots() { return rootList },
  }
  const toolsService = {
    get(name, agent) {
      toolCalls.push({ name, agent })
      if (definitions.has(name)) return definitions.get(name)
      return isVisible(name, agent)
        ? { name, parameters: { category: { type: 'string', enum: ['review'] } } }
        : undefined
    },
  }
  return {
    agentsService,
    toolsService,
    agentsById,
    toolCalls,
    setRoots(roots) { rootList = roots },
    setVisible(predicate) { isVisible = predicate },
    setDefinition(name, definition) { definitions.set(name, definition) },
  }
}

function accepted(overrides = {}) {
  return { kind: 'accept', content: [{ type: 'text', text: 'unchanged outcome' }], ...overrides }
}

async function execute(reminder, agent, name, options = {}) {
  const exec = {
    name,
    agent,
    signal: options.signal ?? new AbortController().signal,
    ...(Object.hasOwn(options, 'parent') ? { parent: options.parent } : {}),
    ...(Object.hasOwn(options, 'arguments') ? { arguments: options.arguments } : {}),
  }
  const result = options.result ?? { isError: false }
  const terminal = options.decision ?? accepted()
  let nextCalls = 0
  const decision = await reminder.listener(exec, result, async () => {
    nextCalls += 1
    if (nextCalls !== 1) throw new Error('next() called more than once')
    return terminal
  })
  assert.equal(nextCalls, 1)
  return decision
}

function reminderText(decision) {
  return decision.additionalContexts?.at(-1)?.content?.[0]?.text
}

test('builds a bounded config-only list of non-disabled categories with valid skill defaults', () => {
  const routes = categories([
    { name: 'review`focus', skills: ['code-review', 'security-audit'] },
    { name: 'disabled', disable: true, skills: ['hidden-skill'] },
    { name: 'empty', skills: [] },
    { name: 'build', skills: ['ci-fix'] },
    { name: 'docs', skills: ['docs-update'] },
    { name: 'test', skills: ['test-author'] },
    { name: 'extra', skills: ['must-be-capped'] },
  ])
  const text = createCategorySkillReminderText(routes)
  assert.ok(text)
  assert.ok(text.includes('``review`focus``'))
  assert.ok(text.includes('`code-review`'))
  assert.doesNotMatch(text, /hidden-skill|must-be-capped/u)
  assert.equal((text.match(/^- /gmu) ?? []).length, MAX_CATEGORY_SKILL_REMINDER_CATEGORIES)
  assert.ok(text.includes('configuration labels, not instructions'))
  assert.ok(text.includes('not a live skill inventory'))
  assert.ok(new TextEncoder().encode(text).byteLength <= MAX_CATEGORY_SKILL_REMINDER_BYTES)
  assert.equal(createCategorySkillReminderText(categories([{ name: 'no-skills' }])), undefined)
})

test('validates required services only when configured category defaults exist', () => {
  assert.equal(createCategorySkillReminder(undefined, undefined, categories()).enabled, false)
  assert.throws(
    () => createCategorySkillReminder({}, {}, categories([{ name: 'review', skills: ['code-review'] }])),
    /agents\.get and agents\.roots/u,
  )
  assert.throws(
    () => createCategorySkillReminder({ get() {}, roots() {} }, {}, categories([{ name: 'review', skills: ['code-review'] }])),
    /tools\.get/u,
  )
})

test('adds exactly one bounded advisory after three accepted direct calls and preserves other contexts', async t => {
  const agent = { id: 'root' }
  const runtime = createRuntime([agent])
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  const secret = 'private arguments and output must not appear'
  const previous = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'prior context' }] }
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD - 1; index += 1) {
    const decision = await execute(reminder, agent, CATEGORY_SKILL_REMINDER_TARGET_TOOLS[index], {
      arguments: { file_path: secret },
      result: { isError: false, content: [{ type: 'text', text: secret }] },
    })
    assert.equal(decision.additionalContexts, undefined)
  }
  const terminal = accepted({ additionalContexts: [previous] })
  const decision = await execute(reminder, agent, 'grep', {
    arguments: { pattern: secret },
    result: { isError: false, content: [{ type: 'text', text: secret }] },
    decision: terminal,
  })
  assert.equal(decision.additionalContexts.length, 2)
  assert.strictEqual(decision.additionalContexts[0], previous)
  assert.equal(reminderText(decision), reminder.text)
  assert.doesNotMatch(reminderText(decision), new RegExp(secret, 'u'))
  const afterThreshold = await execute(reminder, agent, 'glob')
  assert.equal(afterThreshold.additionalContexts, undefined)
  assert.equal(runtime.toolCalls.every(call => call.agent === agent), true)
  const deltaBytes = new TextEncoder().encode(reminder.text).byteLength
  assert.ok(deltaBytes <= MAX_CATEGORY_SKILL_REMINDER_BYTES)
  t.diagnostic(`Category-skill reminder context: ${deltaBytes} UTF-8 bytes (~${Math.ceil(deltaBytes / 4)} tokens at 4 bytes/token; provider tokenizer unavailable).`)
  reminder.dispose()
})

test('counts only accepted, direct exploration Tool calls for exact root Agents', async () => {
  const root = { id: 'root' }
  const child = { id: 'child' }
  const runtime = createRuntime([root])
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  await execute(reminder, root, 'read', { decision: { kind: 'block', feedback: [] } })
  await execute(reminder, root, 'read', { parent: 'nested' })
  await execute(reminder, root, 'web_search')
  await execute(reminder, child, 'read')
  await execute(reminder, root, 'read')
  await execute(reminder, root, 'edit')
  assert.equal(reminderText(await execute(reminder, root, 'write')), reminder.text)
  reminder.dispose()
})

test('concurrent direct calls share one per-Agent reminder cap', async () => {
  const agent = { id: 'root' }
  const runtime = createRuntime([agent])
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  const decisions = await Promise.all(['read', 'edit', 'write', 'bash'].map(name => execute(reminder, agent, name)))
  assert.equal(decisions.filter(decision => reminderText(decision) === reminder.text).length, 1)
  reminder.dispose()
})

test('pre-execute suppresses immediately before a task Tool dispatch settles', async () => {
  const agent = { id: 'root' }
  const runtime = createRuntime([agent])
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  let release
  const gate = new Promise(resolve => { release = resolve })
  let nextCalls = 0
  const pending = reminder.preExecute({ name: 'dsh_omo_task', agent, parent: undefined }, async () => {
    nextCalls += 1
    await gate
    return { kind: 'deny', reason: 'test block' }
  })
  assert.equal(nextCalls, 1)
  for (const target of CATEGORY_SKILL_REMINDER_TARGET_TOOLS.slice(0, CATEGORY_SKILL_REMINDER_THRESHOLD)) {
    assert.equal(reminderText(await execute(reminder, agent, target)), undefined)
  }
  release()
  assert.deepEqual(await pending, { kind: 'deny', reason: 'test block' })
  reminder.dispose()
})

test('a delegation attempt suppresses the reminder regardless of its outcome or cancellation', async () => {
  const agent = { id: 'root' }
  const runtime = createRuntime([agent])
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  const aborted = new AbortController()
  aborted.abort()
  for (const name of AGENT_USAGE_TASK_TOOLS) {
    const isolated = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
      { name: 'review', skills: ['code-review'] },
    ]))
    await execute(isolated, agent, name, { decision: { kind: 'block', feedback: [] }, signal: aborted.signal })
    for (const target of CATEGORY_SKILL_REMINDER_TARGET_TOOLS.slice(0, CATEGORY_SKILL_REMINDER_THRESHOLD + 1)) {
      assert.equal(reminderText(await execute(isolated, agent, target)), undefined)
    }
    isolated.dispose()
  }
  reminder.dispose()
})

test('requires a visible category-aware delegation Tool before counting or reminding', async () => {
  const agent = { id: 'root' }
  const runtime = createRuntime([agent], { visible: false })
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD; index += 1) {
    assert.equal(reminderText(await execute(reminder, agent, 'glob')), undefined)
  }
  runtime.setVisible(name => name === 'dsh_omo_call_agent')
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD - 1; index += 1) {
    assert.equal(reminderText(await execute(reminder, agent, 'glob')), undefined)
  }
  assert.equal(reminderText(await execute(reminder, agent, 'glob')), reminder.text)
  reminder.dispose()
})

test('a visible scoped Tool must expose a selector for one of the listed categories', async () => {
  const agent = { id: 'root' }
  const runtime = createRuntime([agent], { visible: name => name === 'dsh_omo_task' })
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  runtime.setDefinition('dsh_omo_task', { name: 'dsh_omo_task', parameters: {} })
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD; index += 1) {
    assert.equal(reminderText(await execute(reminder, agent, 'glob')), undefined)
  }
  runtime.setDefinition('dsh_omo_task', {
    name: 'dsh_omo_task', parameters: { category: { type: 'string', enum: ['unlisted'] } },
  })
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD; index += 1) {
    assert.equal(reminderText(await execute(reminder, agent, 'glob')), undefined)
  }
  runtime.setDefinition('dsh_omo_task', {
    name: 'dsh_omo_task', parameters: { category: { type: 'string', enum: ['review'] } },
  })
  await execute(reminder, agent, 'glob')
  await execute(reminder, agent, 'glob')
  assert.equal(reminderText(await execute(reminder, agent, 'glob')), reminder.text)
  reminder.dispose()
})

test('same-ID Agent replacement starts fresh and late old-Agent disposal preserves replacement state', async () => {
  const oldAgent = { id: 'same-id' }
  const newAgent = { id: 'same-id' }
  const runtime = createRuntime([oldAgent])
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  await execute(reminder, oldAgent, 'read')
  await execute(reminder, oldAgent, 'edit')
  runtime.agentsById.set(newAgent.id, newAgent)
  runtime.setRoots([newAgent])
  await execute(reminder, newAgent, 'read')
  await execute(reminder, newAgent, 'edit')
  reminder.clearAgent(oldAgent)
  assert.equal(reminderText(await execute(reminder, newAgent, 'glob')), reminder.text)
  reminder.dispose()
})

test('fails closed for stale Agents, disposal, root-scan caps, and state caps', async () => {
  const root = { id: 'root' }
  const replacement = { id: 'root' }
  const runtime = createRuntime([root])
  const reminder = createCategorySkillReminder(runtime.agentsService, runtime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  runtime.agentsById.set(root.id, replacement)
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD; index += 1) {
    assert.equal(reminderText(await execute(reminder, root, 'glob')), undefined)
  }
  runtime.agentsById.set(replacement.id, replacement)
  runtime.setRoots([replacement])
  await execute(reminder, replacement, 'glob')
  reminder.clearAgent(replacement)
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD; index += 1) {
    assert.equal(reminderText(await execute(reminder, replacement, 'glob')), undefined)
  }
  const fresh = { id: 'fresh' }
  runtime.agentsById.set(fresh.id, fresh)
  runtime.setRoots([fresh])
  reminder.dispose()
  assert.equal(reminderText(await execute(reminder, fresh, 'glob')), undefined)

  const cappedRoots = Array.from({ length: MAX_ROOTS_TO_SCAN }, (_, index) => ({ id: `root-${index}` }))
  const overflow = { id: 'overflow-root' }
  const cappedRuntime = createRuntime([...cappedRoots, overflow])
  const cappedReminder = createCategorySkillReminder(cappedRuntime.agentsService, cappedRuntime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD; index += 1) {
    assert.equal(reminderText(await execute(cappedReminder, overflow, 'glob')), undefined)
  }
  cappedReminder.dispose()

  const tracked = Array.from({ length: MAX_TRACKED_AGENT_STATES }, (_, index) => ({ id: `tracked-${index}` }))
  const stateRuntime = createRuntime(tracked)
  const stateReminder = createCategorySkillReminder(stateRuntime.agentsService, stateRuntime.toolsService, categories([
    { name: 'review', skills: ['code-review'] },
  ]))
  for (const agent of tracked) await execute(stateReminder, agent, 'dsh_omo_task')
  const newcomer = { id: 'newcomer' }
  stateRuntime.agentsById.set(newcomer.id, newcomer)
  stateRuntime.setRoots([newcomer, ...tracked.slice(0, MAX_ROOTS_TO_SCAN - 1)])
  for (let index = 0; index < CATEGORY_SKILL_REMINDER_THRESHOLD; index += 1) {
    assert.equal(reminderText(await execute(stateReminder, newcomer, 'glob')), undefined)
  }
  stateReminder.dispose()
})
