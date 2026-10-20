import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTeamTools } from '../src/teams.js'

const NAMES = [
  'team_membership',
  'team_status',
  'team_members',
  'team_spawn',
  'team_send_message',
  'team_create_task',
  'team_list_tasks',
  'team_get_task',
  'team_update_task',
  'team_wait_for_change',
  'team_interrupt',
]
const ACTIONS = ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']

function taskView(overrides = {}) {
  return {
    id: 'task-1',
    revision: 1,
    subject: 'Implement feature',
    description: 'Complete the adapter.',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...overrides,
  }
}

function memberView(overrides = {}) {
  return {
    id: 'agent-2',
    name: 'builder',
    role: 'teammate',
    status: 'running',
    diagnostics: [],
    ...overrides,
  }
}

function makeService(overrides = {}) {
  return {
    membership: () => ({ root: { id: 'agent-root' }, id: 'team-1', role: 'lead', name: 'lead' }),
    listMembers: () => [memberView()],
    spawnTeammate: async () => ({ member: memberView() }),
    sendMessage: async () => ({ messageId: 'message-1' }),
    createTask: async () => taskView(),
    getTask: () => taskView(),
    listTasks: () => [taskView()],
    updateTask: async (_caller, request) => taskView({ revision: request.expectedRevision + 1 }),
    waitForChange: async () => ({ timedOut: false }),
    interrupt: () => ({ previousStatus: 'running' }),
    tryMembership: () => undefined,
    ...overrides,
  }
}

function makeContext(service = makeService()) {
  const registered = new Map()
  const ctx = {
    get(key) {
      assert.equal(key, 'agentTeams')
      return service
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }
  return { ctx, service, registered }
}

const lead = { id: 'agent-root', exact: Symbol('authority') }
const signal = new AbortController().signal
const exec = { agent: lead, signal }

function input(name, overrides = {}) {
  const defaults = {
    team_membership: {},
    team_status: {},
    team_members: {},
    team_spawn: {
      name: 'builder', description: 'Implement a focused task.', prompt: [{ type: 'text', text: 'Build it.' }],
      context: 'fresh', provider: 'spawn',
    },
    team_send_message: { target: 'builder', content: [{ type: 'text', text: 'Please report.' }] },
    team_create_task: { subject: 'Implement feature', description: 'Complete the adapter.' },
    team_list_tasks: {},
    team_get_task: { id: 'task-1' },
    team_update_task: { taskId: 'task-1', expectedRevision: 1, action: 'claim' },
    team_wait_for_change: { timeoutMs: 10_000 },
    team_interrupt: { targetName: 'builder' },
  }
  return { ...defaults[name], ...overrides }
}

test('registers eleven uniquely named team tools with bounded, strict output contracts', () => {
  const fixture = makeContext()
  const dispose = registerTeamTools(fixture.ctx)
  assert.deepEqual([...fixture.registered.keys()], NAMES)
  assert.equal(typeof dispose, 'function')

  const schemas = []
  for (const name of NAMES) {
    const definition = fixture.registered.get(name)
    assert.equal(definition.name, name)
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(definition.output.schema.additionalProperties, false)
    assert.ok(definition.output.schema !== undefined)
    schemas.push(definition.output.schema)
  }
  assert.equal(new Set(schemas).size, NAMES.length, 'each tool declares its own output contract')
  assert.deepEqual(fixture.registered.get('team_update_task').parameters.properties.action.enum, ACTIONS)
  assert.match(fixture.registered.get('team_wait_for_change').parameters.properties.timeoutMs.description, /10000 through 3600000/)
  assert.equal(fixture.registered.get('team_wait_for_change').timeoutMs, 3_630_000, 'tool deadline includes Host wait plus result-settlement grace')
  assert.match(fixture.registered.get('team_create_task').description, /advisory.*not file locks or security boundaries/i)
  assert.match(fixture.registered.get('team_update_task').description, /advisory.*not file locks or security boundaries/i)
  assert.match(fixture.registered.get('team_interrupt').description, /only signals a turn.*does not guarantee termination/i)
  const sendMessage = fixture.registered.get('team_send_message')
  assert.deepEqual(sendMessage.output.schema.properties, {
    messageId: { type: 'string' },
  })
  assert.deepEqual(sendMessage.output.schema.required, ['messageId'])
  assert.equal('status' in sendMessage.output.schema.properties, false)
  assert.match(sendMessage.description, /accepted message ID/u)
  assert.doesNotMatch(sendMessage.description, /status|queued/u)

  const membership = fixture.registered.get('team_membership')
  const result = { teamId: 'team-1', rootAgentId: 'agent-root', role: 'lead', name: 'lead' }
  assert.deepEqual(membership.output.render({}, result), [{ type: 'text', text: JSON.stringify(result) }])

  dispose()
  assert.equal(fixture.registered.size, 0)
  dispose()
})

test('resolves the optional Host service and registers nothing when unavailable', () => {
  const registered = new Map()
  const dispose = registerTeamTools({ get: () => undefined, tools: { register: tool => registered.set(tool.name, tool) } })
  assert.equal(registered.size, 0)
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('attempts every Team tool disposer and reports cleanup failures once', () => {
  const service = makeService()
  const registered = new Map()
  const disposedNames = []
  const expectedError = new Error('tool cleanup failed')
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => {
          disposedNames.push(definition.name)
          registered.delete(definition.name)
          if (definition.name === 'team_wait_for_change') throw expectedError
        }
      },
    },
  }

  const dispose = registerTeamTools(ctx, service)
  assert.throws(dispose, error => error === expectedError)
  assert.equal(disposedNames.length, 11)
  assert.equal(new Set(disposedNames).size, 11)
  assert.equal(registered.size, 0)
  assert.doesNotThrow(dispose, 'subsequent disposal is idempotent after every handle was attempted')
  assert.equal(disposedNames.length, 11)
})

test('rolls back earlier tool registrations when a later registration fails', () => {
  const service = makeService()
  const registered = new Map()
  let attempts = 0
  const expectedError = new Error('duplicate scoped tool')
  const ctx = {
    tools: {
      register(definition) {
        attempts += 1
        if (attempts === 5) throw expectedError
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }

  assert.throws(() => registerTeamTools(ctx, service), error => error === expectedError)
  assert.equal(attempts, 5)
  assert.equal(registered.size, 0, 'all earlier registrations are disposed on failure')
})

test('forwards the exact caller, request fields, and execution cancellation to Host', async () => {
  const calls = []
  const fixture = makeContext(makeService({
    spawnTeammate: async (caller, request) => {
      calls.push({ method: 'spawn', caller, request })
      return { member: memberView() }
    },
    sendMessage: async (caller, request) => {
      calls.push({ method: 'send', caller, request })
      return { messageId: 'message-2' }
    },
    waitForChange: async (caller, timeoutMs, receivedSignal) => {
      calls.push({ method: 'wait', caller, timeoutMs, signal: receivedSignal })
      return { timedOut: true }
    },
  }))
  registerTeamTools(fixture.ctx)

  const prompt = [{ type: 'text', text: 'Implement the UI.' }]
  const spawnResult = await fixture.registered.get('team_spawn').execute(input('team_spawn', { prompt }), exec)
  assert.equal(spawnResult.member.name, 'builder')
  assert.equal(calls[0].caller, lead)
  assert.deepEqual(calls[0].request, {
    name: 'builder', description: 'Implement a focused task.', prompt, context: 'fresh', provider: 'spawn', signal,
  })
  assert.equal(calls[0].request.signal, signal)

  const content = [{ type: 'text', text: 'Please report status.' }]
  const sendResult = await fixture.registered.get('team_send_message').execute(input('team_send_message', { content }), exec)
  assert.deepEqual(sendResult, { messageId: 'message-2' })
  assert.equal(calls[1].caller, lead)
  assert.deepEqual(calls[1].request, { target: 'builder', content, signal })
  assert.equal(calls[1].request.signal, signal)

  const waitResult = await fixture.registered.get('team_wait_for_change').execute(input('team_wait_for_change', { timeoutMs: 45_000 }), exec)
  assert.deepEqual(waitResult, { timedOut: true })
  assert.deepEqual(calls[2], { method: 'wait', caller: lead, timeoutMs: 45_000, signal })
})

test('team_send_message rejects missing or invalid Host message IDs', async () => {
  const invalidResults = [
    undefined,
    null,
    {},
    { messageId: '' },
    { messageId: '   ' },
    { messageId: 123 },
    { messageId: 'm'.repeat(129) },
  ]
  let resultIndex = 0
  const fixture = makeContext(makeService({ sendMessage: async () => invalidResults[resultIndex++] }))
  registerTeamTools(fixture.ctx)
  const send = fixture.registered.get('team_send_message')
  for (let index = 0; index < invalidResults.length; index += 1) {
    await assert.rejects(
      send.execute(input('team_send_message'), exec),
      /invalid message result|message id/u,
    )
  }
  assert.equal(resultIndex, invalidResults.length)
})

test('routes membership, roster, task reads/creation, and interruption through the Host service', async () => {
  const calls = []
  const fixture = makeContext(makeService({
    membership: caller => {
      calls.push({ method: 'membership', caller })
      return { root: { id: 'agent-root' }, id: 'team-1', role: 'lead', name: 'lead' }
    },
    listMembers: caller => {
      calls.push({ method: 'members', caller })
      return [memberView()]
    },
    createTask: async (caller, request) => {
      calls.push({ method: 'create', caller, request })
      return taskView({ writeScopes: ['src/teams.js'] })
    },
    getTask: (caller, id) => {
      calls.push({ method: 'get', caller, id })
      return taskView()
    },
    listTasks: caller => {
      calls.push({ method: 'list', caller })
      return [taskView()]
    },
    interrupt: (caller, targetName) => {
      calls.push({ method: 'interrupt', caller, targetName })
      return { previousStatus: 'inactive' }
    },
  }))
  registerTeamTools(fixture.ctx)

  assert.deepEqual(await fixture.registered.get('team_membership').execute({}, exec), {
    teamId: 'team-1', rootAgentId: 'agent-root', role: 'lead', name: 'lead',
  })
  assert.equal((await fixture.registered.get('team_members').execute({}, exec)).members[0].id, 'agent-2')
  const createArgs = {
    subject: 'Implement feature', description: 'Complete the adapter.',
    blockedBy: ['task-parent'], writeScopes: ['src/teams.js'],
  }
  const created = await fixture.registered.get('team_create_task').execute(createArgs, exec)
  assert.deepEqual(created.task.writeScopes, ['src/teams.js'])
  assert.deepEqual(calls.find(call => call.method === 'create'), {
    method: 'create', caller: lead, request: createArgs,
  })
  assert.equal((await fixture.registered.get('team_get_task').execute({ id: 'task-1' }, exec)).task.id, 'task-1')
  assert.equal((await fixture.registered.get('team_list_tasks').execute({}, exec)).tasks.length, 1)
  assert.deepEqual(await fixture.registered.get('team_interrupt').execute({ targetName: 'builder' }, exec), { previousStatus: 'inactive' })
  assert.deepEqual(calls.map(call => call.method), ['membership', 'members', 'create', 'get', 'list', 'interrupt'])
  assert.ok(calls.every(call => call.caller === lead))
})

test('team_status aggregates only the exact caller Team through read-only Host methods', async () => {
  const calls = []
  let mutations = 0
  const fixture = makeContext(makeService({
    membership: caller => {
      calls.push({ method: 'membership', caller })
      return { root: { id: 'agent-root' }, id: 'team-1', role: 'lead', name: 'lead' }
    },
    listMembers: caller => {
      calls.push({ method: 'members', caller })
      return [memberView()]
    },
    listTasks: caller => {
      calls.push({ method: 'tasks', caller })
      return [taskView()]
    },
    spawnTeammate: async () => { mutations += 1; return { member: memberView() } },
    sendMessage: async () => { mutations += 1; return { messageId: 'message-1' } },
    createTask: async () => { mutations += 1; return taskView() },
    updateTask: async () => { mutations += 1; return taskView() },
    interrupt: () => { mutations += 1; return { previousStatus: 'running' } },
  }))
  registerTeamTools(fixture.ctx)

  const tool = fixture.registered.get('team_status')
  assert.match(tool.description, /read-only bounded snapshot/iu)
  assert.match(tool.description, /does not enumerate or mutate Teams/u)
  assert.deepEqual(tool.parameters.properties, {})
  const result = await tool.execute({}, exec)
  assert.deepEqual(calls, [
    { method: 'membership', caller: lead },
    { method: 'members', caller: lead },
    { method: 'tasks', caller: lead },
  ])
  assert.equal(result.teamId, 'team-1')
  assert.equal(result.rootAgentId, 'agent-root')
  assert.equal(result.role, 'lead')
  assert.equal(result.name, 'lead')
  assert.equal(result.members.length, 1)
  assert.equal(result.members[0].id, 'agent-2')
  assert.equal(result.membersTruncated, false)
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].id, 'task-1')
  assert.equal(result.tasksTruncated, false)
  assert.equal(JSON.stringify(result).length <= 48_000, true)
  assert.equal(mutations, 0, 'the aggregate status tool never calls Team mutation methods')
})

test('team_status caps aggregate snapshots and rejects malformed Host rows', async () => {
  const largeMember = memberView({
    description: 'D'.repeat(8_000),
    diagnostics: Array.from({ length: 20 }, () => 'x'.repeat(1_000)),
  })
  const largeTask = taskView({
    subject: 'S'.repeat(240),
    description: 'D'.repeat(8_000),
    blockedBy: Array.from({ length: 100 }, () => 'b'.repeat(128)),
    writeScopes: Array.from({ length: 32 }, () => 'w'.repeat(512)),
    writeScopeWarnings: Array.from({ length: 20 }, () => 'x'.repeat(1_000)),
  })
  const fixture = makeContext(makeService({
    listMembers: () => Array.from({ length: 100 }, () => largeMember),
    listTasks: () => Array.from({ length: 100 }, () => largeTask),
  }))
  registerTeamTools(fixture.ctx)
  const result = await fixture.registered.get('team_status').execute({}, exec)
  assert.ok(result.members.length > 0)
  assert.ok(result.tasks.length > 0)
  assert.equal(result.membersTruncated, true)
  assert.equal(result.tasksTruncated, true)
  assert.ok(result.members.every(row => row.description.length <= 1_000 && row.diagnostics.length <= 8))
  assert.ok(result.tasks.every(row => row.description.length <= 1_200 && row.writeScopes.length <= 12))
  assert.ok(JSON.stringify(result).length <= 48_000)

  let taskReads = 0
  const malformed = makeContext(makeService({
    listMembers: () => [memberView({ status: 'complete' })],
    listTasks: () => { taskReads += 1; return [] },
  }))
  registerTeamTools(malformed.ctx)
  await assert.rejects(malformed.registered.get('team_status').execute({}, exec), /invalid member role or status/u)
  assert.equal(taskReads, 0, 'invalid member snapshots fail before reporting tasks')

  const invalidTask = makeContext(makeService({ listTasks: () => [taskView({ status: 'unknown' })] }))
  registerTeamTools(invalidTask.ctx)
  await assert.rejects(invalidTask.registered.get('team_status').execute({}, exec), /invalid task status/u)

  const hostReadError = new Error('Team task read failed')
  const hostFailure = makeContext(makeService({ listTasks: () => { throw hostReadError } }))
  registerTeamTools(hostFailure.ctx)
  await assert.rejects(hostFailure.registered.get('team_status').execute({}, exec), error => error === hostReadError)

  const memberCountFixture = makeContext(makeService({
    listMembers: () => Array.from({ length: 101 }, (_, index) => memberView({ id: `member-${index}` })),
    listTasks: () => [],
  }))
  registerTeamTools(memberCountFixture.ctx)
  const memberCount = await memberCountFixture.registered.get('team_status').execute({}, exec)
  assert.equal(memberCount.members.length, 100)
  assert.equal(memberCount.membersTruncated, true)
  assert.equal(memberCount.tasks.length, 0)
  assert.equal(memberCount.tasksTruncated, false)

  const taskCountFixture = makeContext(makeService({
    listMembers: () => [],
    listTasks: () => Array.from({ length: 101 }, (_, index) => taskView({ id: `task-${index}` })),
  }))
  registerTeamTools(taskCountFixture.ctx)
  const taskCount = await taskCountFixture.registered.get('team_status').execute({}, exec)
  assert.equal(taskCount.members.length, 0)
  assert.equal(taskCount.membersTruncated, false)
  assert.equal(taskCount.tasks.length, 100)
  assert.equal(taskCount.tasksTruncated, true)
})

test('fails closed for a missing agent before invoking any Host service method', async () => {
  let calls = 0
  const source = makeService()
  const counted = Object.fromEntries(Object.entries(source).map(([key, value]) => [
    key,
    typeof value === 'function' ? (...args) => { calls += 1; return value(...args) } : value,
  ]))
  const fixture = makeContext(counted)
  registerTeamTools(fixture.ctx)
  for (const name of NAMES) {
    await assert.rejects(
      fixture.registered.get(name).execute(input(name), { signal }),
      /require an active agent/,
      name,
    )
  }
  assert.equal(calls, 0)
})

test('preserves Host service errors without translating them into success or status claims', async () => {
  const hostError = new Error('Host rejected a stale task revision')
  const fixture = makeContext(makeService({ updateTask: async () => { throw hostError } }))
  registerTeamTools(fixture.ctx)
  await assert.rejects(
    fixture.registered.get('team_update_task').execute(input('team_update_task'), exec),
    error => error === hostError,
  )
})

test('forwards task revisions and each supported update action unchanged', async () => {
  const calls = []
  const fixture = makeContext(makeService({
    updateTask: async (caller, request) => {
      calls.push({ caller, request })
      return taskView({ revision: request.expectedRevision + 1 })
    },
  }))
  registerTeamTools(fixture.ctx)
  const tool = fixture.registered.get('team_update_task')

  const dependencyChange = {
    taskId: 'task-1', expectedRevision: 9, action: 'set_dependencies', blockedBy: ['task-2'], writeScopes: ['src/teams.js'],
  }
  const changed = await tool.execute(dependencyChange, exec)
  assert.equal(changed.task.revision, 10)
  assert.deepEqual(calls[0], {
    caller: lead,
    request: dependencyChange,
  })

  for (const [index, action] of ACTIONS.entries()) {
    const expectedRevision = 20 + index
    const args = { taskId: 'task-1', expectedRevision, action }
    await tool.execute(args, exec)
    assert.equal(calls[index + 1].caller, lead)
    assert.deepEqual(calls[index + 1].request, args)
  }
  assert.deepEqual(tool.parameters.properties.action.enum, ACTIONS)
})

test('truncates large Team lists to the complete response budget', async () => {
  const largeTask = taskView({
    subject: 'S'.repeat(240),
    description: 'D'.repeat(8_000),
    blockedBy: Array.from({ length: 100 }, () => 'b'.repeat(128)),
    writeScopes: Array.from({ length: 32 }, () => 'w'.repeat(512)),
    writeScopeWarnings: Array.from({ length: 20 }, () => 'x'.repeat(1_000)),
  })
  const fixture = makeContext(makeService({ listTasks: () => Array.from({ length: 100 }, () => largeTask) }))
  registerTeamTools(fixture.ctx)

  const result = await fixture.registered.get('team_list_tasks').execute({}, exec)
  assert.ok(result.tasks.length > 0)
  assert.ok(result.tasks.length < 100)
  assert.equal(result.truncated, true)
  assert.ok(result.tasks.every(row => row.description.length <= 1_200))
  assert.ok(result.tasks.every(row => row.blockedBy.length <= 12 && row.blockedByTruncated))
  assert.ok(result.tasks.every(row => row.writeScopes.length <= 12 && row.writeScopesTruncated))
  assert.ok(JSON.stringify(result).length <= 48_000)
})

test('only inspects bounded prefixes of large service arrays', async () => {
  const arrayPrefix = (length, allowedPrefix, label) => new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return length
      if (typeof property === 'string' && /^\d+$/u.test(property)) {
        const index = Number(property)
        if (index >= allowedPrefix) throw new Error(`${label} read beyond projected prefix`)
        return `${label}-${index}`
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const hugeTask = taskView({
    blockedBy: arrayPrefix(1_000_000, 12, 'blocker'),
    writeScopes: arrayPrefix(1_000_000, 12, 'scope'),
    writeScopeWarnings: arrayPrefix(1_000_000, 8, 'warning'),
  })
  const hugeMember = memberView({ diagnostics: arrayPrefix(1_000_000, 8, 'diagnostic') })
  const fixture = makeContext(makeService({ listTasks: () => [hugeTask], listMembers: () => [hugeMember] }))
  registerTeamTools(fixture.ctx)

  const taskResult = await fixture.registered.get('team_list_tasks').execute({}, exec)
  const memberResult = await fixture.registered.get('team_members').execute({}, exec)
  const statusResult = await fixture.registered.get('team_status').execute({}, exec)
  assert.equal(taskResult.tasks[0].blockedBy.length, 12)
  assert.equal(taskResult.tasks[0].writeScopes.length, 12)
  assert.equal(taskResult.tasks[0].writeScopeWarnings.length, 8)
  assert.equal(memberResult.members[0].diagnostics.length, 8)
  assert.equal(statusResult.tasks[0].blockedBy.length, 12)
  assert.equal(statusResult.tasks[0].writeScopes.length, 12)
  assert.equal(statusResult.tasks[0].writeScopeWarnings.length, 8)
  assert.equal(statusResult.members[0].diagnostics.length, 8)
})

test('passes wait cancellation to Host and leaves cancellation ownership there', async () => {
  const controller = new AbortController()
  let observedSignal
  const fixture = makeContext(makeService({
    waitForChange: (_caller, _timeoutMs, signal) => new Promise((_resolve, reject) => {
      observedSignal = signal
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('wait aborted')), { once: true })
    }),
  }))
  registerTeamTools(fixture.ctx)
  const operation = fixture.registered.get('team_wait_for_change').execute(
    { timeoutMs: 60_000 },
    { agent: lead, signal: controller.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(observedSignal, controller.signal)
  controller.abort(new Error('cancel wait'))
  await assert.rejects(operation, /cancel wait/u)
})

test('validates obvious limits and required cancellation without invoking the service', async () => {
  let calls = 0
  const fixture = makeContext(makeService({
    updateTask: async () => { calls += 1; return taskView() },
    waitForChange: async () => { calls += 1; return { timedOut: false } },
    sendMessage: async () => { calls += 1; return { messageId: 'message-1' } },
  }))
  registerTeamTools(fixture.ctx)
  const update = fixture.registered.get('team_update_task')
  const wait = fixture.registered.get('team_wait_for_change')
  const send = fixture.registered.get('team_send_message')

  await assert.rejects(update.execute(input('team_update_task', { expectedRevision: 0 }), exec), /expectedRevision/)
  await assert.rejects(wait.execute(input('team_wait_for_change', { timeoutMs: 9_999 }), exec), /timeoutMs/)
  await assert.rejects(send.execute(input('team_send_message'), { agent: lead }), /AbortSignal/)
  await assert.rejects(send.execute(input('team_send_message', { content: [{ type: 'mystery' }] }), exec), /unsupported content block type/)
  assert.equal(calls, 0)
})
