import assert from 'node:assert/strict'
import test from 'node:test'
import { createGoalCommand, createStopContinuationCommand } from '../src/goals.js'

function invoke(command, agent, rawInput) {
  return command.handler({ agent, rawInput })
}

function validGoal(overrides = {}) {
  return {
    id: 'goal-17',
    revision: 9,
    objective: 'Finish the adapter tests',
    phase: 'active',
    roundsStarted: 2,
    createdAt: '2025-01-02T03:04:05.000Z',
    updatedAt: '2025-01-03T03:04:05.000Z',
    activation: 'armed',
    maxGoalRounds: 5,
    ...overrides,
  }
}

test('registers /goal and supports empty/status display and objective creation', async () => {
  const agent = { id: 'live-agent' }
  const events = []
  const goals = {
    get(actualAgent) {
      events.push(['get', actualAgent])
      return validGoal()
    },
    create(actualAgent, options) {
      events.push(['create', actualAgent, options])
      return validGoal()
    },
  }
  const command = createGoalCommand(goals)

  assert.equal(command.name, 'goal')
  assert.equal(typeof command.handler, 'function')

  const empty = await invoke(command, agent, '')
  assert.equal(empty.kind, 'success')
  assert.match(empty.text, /Current native DSH Goal/u)
  assert.match(empty.text, /Finish the adapter tests/u)
  assert.match(empty.text, /Phase: active; activation: armed/u)
  assert.match(empty.text, /Rounds started: 2; maximum: 5/u)
  assert.match(empty.text, /Revision: 9; ID: goal-17/u)
  assert.match(empty.text, /DSH retains authority over Goal persistence and continuation/u)

  const status = await invoke(command, agent, ' status ')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /Current native DSH Goal/u)

  const created = await invoke(command, agent, '  Finish 12 rounds of review  ')
  assert.equal(created.kind, 'success')
  assert.match(created.text, /Native DSH Goal created/u)
  assert.match(created.text, /DSH retains authority over Goal persistence and continuation/u)
  assert.deepEqual(events.map(event => event[0]), ['get', 'get', 'create'])
  assert.strictEqual(events[0][1], agent)
  assert.strictEqual(events[1][1], agent)
  assert.strictEqual(events[2][1], agent)
  assert.deepEqual(events[2][2], { objective: 'Finish 12 rounds of review' })
  assert.ok(!Object.hasOwn(events[2][2], 'maxGoalRounds'), 'round settings are not inferred from objective text')
})

test('sanitizes bidi controls from the native Goal command display', async () => {
  const command = createGoalCommand({ get: () => validGoal({ objective: 'Build\u202e feature' }) })
  const response = await invoke(command, { id: 'agent-current' }, '')

  assert.equal(response.kind, 'success')
  assert.match(response.text, /Objective: Build feature/u)
  assert.doesNotMatch(response.text, /\p{Bidi_Control}/u)
})

test('passes the exact live agent and freshly-read Goal revision to each mutation', async () => {
  const agent = { id: 'agent-identity' }
  const events = []
  let revision = 40
  const goals = {
    get(actualAgent) {
      events.push(['get', actualAgent])
      return validGoal({ revision: revision++ })
    },
  }
  for (const action of ['pause', 'resume', 'complete', 'clear']) {
    goals[action] = (actualAgent, ref) => events.push([action, actualAgent, ref])
  }
  const command = createGoalCommand(goals)

  for (let index = 0; index < 4; index += 1) {
    const action = ['pause', 'resume', 'complete', 'clear'][index]
    const response = await invoke(command, agent, action)
    assert.equal(response.kind, 'success', `${action} succeeds`)
    assert.match(response.text, new RegExp(`Goal ${action} requested`, 'u'))
  }

  assert.deepEqual(events.map(event => event[0]), [
    'get', 'pause', 'get', 'resume', 'get', 'complete', 'get', 'clear',
  ])
  for (let index = 0; index < 4; index += 1) {
    const read = events[index * 2]
    const mutation = events[index * 2 + 1]
    assert.strictEqual(read[1], agent)
    assert.strictEqual(mutation[1], agent)
    assert.deepEqual(mutation[2], { id: 'goal-17', revision: 40 + index })
  }
})

test('/stop-continuation clears the exact current Goal revision and labels its limited effect', async () => {
  const agent = { id: 'stop-agent' }
  const calls = []
  const command = createStopContinuationCommand({
    get(actualAgent) {
      calls.push(['get', actualAgent])
      return validGoal({ id: 'goal-stop', revision: 23 })
    },
    clear(actualAgent, ref) {
      calls.push(['clear', actualAgent, ref])
    },
  })
  assert.ok(command)
  assert.equal(command.name, 'stop-continuation')
  const response = await invoke(command, agent, '')
  assert.equal(response.kind, 'success')
  assert.match(response.text, /native DSH Goal cleared/u)
  assert.match(response.text, /DSH continuable children and OMO todo\/boulder state are not changed/u)
  assert.deepEqual(calls, [
    ['get', agent],
    ['clear', agent, { id: 'goal-stop', revision: 23 }],
  ])
})

test('/stop-continuation no-ops without a Goal and rejects arguments before Host calls', async () => {
  const agent = { id: 'stop-empty-agent' }
  const calls = []
  const command = createStopContinuationCommand({
    get(actualAgent) {
      calls.push(['get', actualAgent])
      return undefined
    },
    clear(...args) { calls.push(['clear', ...args]) },
  })
  const noGoal = await invoke(command, agent, '  ')
  assert.equal(noGoal.kind, 'success')
  assert.match(noGoal.text, /No current native DSH Goal/u)
  assert.equal(calls.length, 1)

  for (const rawInput of ['clear', '  stop  ', 'x'.repeat(129), undefined]) {
    const invalid = await command.handler({ agent, rawInput })
    assert.equal(invalid.kind, 'error')
    assert.match(invalid.text, /Usage: \/stop-continuation/u)
  }
  assert.equal(calls.length, 1, 'invalid arguments do not read or clear Goal state')
  assert.equal(createStopContinuationCommand(undefined), undefined)
  assert.equal(createStopContinuationCommand({ get() {} }), undefined, 'clear capability is required')
})

test('/stop-continuation refuses malformed references and hides Host clear errors', async () => {
  const agent = { id: 'stop-failure-agent' }
  let clearCalls = 0
  const malformed = createStopContinuationCommand({
    get: () => ({ id: 'goal-without-revision' }),
    clear: () => { clearCalls += 1 },
  })
  const invalidRef = await invoke(malformed, agent, '')
  assert.equal(invalidRef.kind, 'error')
  assert.match(invalidRef.text, /no valid revision reference/u)
  assert.equal(clearCalls, 0)

  const secret = 'private-clear-service-error'
  const failing = createStopContinuationCommand({
    get: () => validGoal(),
    clear: () => { throw new Error(secret) },
  })
  const failedClear = await invoke(failing, agent, '')
  assert.equal(failedClear.kind, 'error')
  assert.match(failedClear.text, /Could not clear the native DSH Goal/u)
  assert.ok(!failedClear.text.includes(secret))
})

test('displays the empty state and never mutates without a current Goal', async () => {
  const agent = { id: 'agent-without-goal' }
  const mutations = []
  const goals = {
    get(actualAgent) {
      assert.strictEqual(actualAgent, agent)
      return undefined
    },
  }
  for (const action of ['pause', 'resume', 'complete', 'clear']) {
    goals[action] = (...args) => mutations.push([action, ...args])
  }
  const command = createGoalCommand(goals)

  const status = await invoke(command, agent, '')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /No current native DSH Goal/u)
  for (const action of ['pause', 'resume', 'complete', 'clear']) {
    const response = await invoke(command, agent, action)
    assert.equal(response.kind, 'error')
    assert.match(response.text, /no current DSH Goal/u)
  }
  assert.deepEqual(mutations, [])
})

test('validates agent, raw input, empty objectives, and bounded objective text', async () => {
  let createCalls = 0
  let getCalls = 0
  const goals = {
    get() {
      getCalls += 1
      return undefined
    },
    create() {
      createCalls += 1
    },
  }
  const command = createGoalCommand(goals)

  const malformedArgs = await command.handler(null)
  assert.equal(malformedArgs.kind, 'error')
  assert.match(malformedArgs.text, /active agent is required/u)

  for (const agent of [undefined, null, 'agent-id', 1]) {
    const response = await invoke(command, agent, 'Build a goal')
    assert.equal(response.kind, 'error')
    assert.match(response.text, /active agent is required/u)
  }
  for (const rawInput of [undefined, null, 5, {}]) {
    const response = await invoke(command, {}, rawInput)
    assert.equal(response.kind, 'error')
    assert.match(response.text, /Usage: \/goal/u)
  }

  const blank = await invoke(command, {}, ' \t ')
  assert.equal(blank.kind, 'success', 'blank command input displays status')
  assert.match(blank.text, /No current native DSH Goal/u)

  for (const rawInput of ['status extra', 'status\tfoo', 'status\nfoo', 'STATUS\tfoo']) {
    const malformedStatus = await invoke(command, {}, rawInput)
    assert.equal(malformedStatus.kind, 'error')
    assert.match(malformedStatus.text, /Usage: \/goal/u)
  }

  const tooLong = await invoke(command, {}, 'x'.repeat(4_001))
  assert.equal(tooLong.kind, 'error')
  assert.match(tooLong.text, /maximum 4000 characters/u)
  assert.equal(createCalls, 0)
  assert.equal(getCalls, 1, 'invalid input does not query or mutate Goal state')
})

test('treats round-related wording as part of the objective, not adapter configuration', async () => {
  const agent = { id: 'agent-round-independent' }
  const calls = []
  const command = createGoalCommand({
    create(actualAgent, options) {
      calls.push([actualAgent, options])
    },
  })
  const objective = 'Run for 8 rounds; maxGoalRounds=12 is part of the task text'

  const response = await invoke(command, agent, objective)
  assert.equal(response.kind, 'success')
  assert.strictEqual(calls[0][0], agent)
  assert.deepEqual(calls[0][1], { objective })
})

test('catches Goal service failures without exposing raw error details', async () => {
  const secret = 'private-host-stack-token-DO-NOT-LEAK'
  const agent = { id: 'agent-errors' }
  const command = createGoalCommand({
    get() {
      throw new Error(secret)
    },
    create() {
      throw new Error(secret)
    },
    pause() {
      throw new Error(secret)
    },
  })

  for (const rawInput of ['', 'Create a goal', 'pause']) {
    const response = await invoke(command, agent, rawInput)
    assert.equal(response.kind, 'error')
    assert.ok(response.text.length <= 1_600)
    assert.ok(!response.text.includes(secret))
  }
})

test('fails safely when the Host rejects a stale Goal revision', async () => {
  const agent = { id: 'agent-stale' }
  let suppliedRef
  const command = createGoalCommand({
    get(actualAgent) {
      assert.strictEqual(actualAgent, agent)
      return validGoal({ revision: 21 })
    },
    pause(actualAgent, ref) {
      assert.strictEqual(actualAgent, agent)
      suppliedRef = ref
      throw new Error('stale Goal revision secret')
    },
  })

  const response = await invoke(command, agent, 'pause')
  assert.equal(response.kind, 'error')
  assert.match(response.text, /Could not pause/u)
  assert.ok(!response.text.includes('stale Goal revision secret'))
  assert.deepEqual(suppliedRef, { id: 'goal-17', revision: 21 })
})

test('handles an unavailable service and a malformed current Goal reference safely', async () => {
  const agent = { id: 'agent-invalid' }
  const unavailable = createGoalCommand(undefined)
  assert.equal((await invoke(unavailable, agent, 'Build a goal')).kind, 'error')
  assert.equal((await invoke(unavailable, agent, '')).kind, 'error')

  let mutations = 0
  const malformed = createGoalCommand({
    get() {
      return { id: 'goal-no-revision' }
    },
    pause() {
      mutations += 1
    },
  })
  const response = await invoke(malformed, agent, 'pause')
  assert.equal(response.kind, 'error')
  assert.match(response.text, /no valid revision reference/u)
  assert.equal(mutations, 0)
})
