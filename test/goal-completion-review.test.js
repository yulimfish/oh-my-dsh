import assert from 'node:assert/strict'
import test from 'node:test'
import { createGoalCompletionReview, registerGoalCompletionReview } from '../src/goal-completion-review.js'

function harness() {
  const live = new Map()
  const goal = { id: 'goal-1', revision: 1, phase: 'active', objective: 'Implement and verify the requested feature' }
  const calls = []
  const agents = { get: id => live.get(id) }
  const goals = { get: agent => { calls.push(agent); return goal } }
  const review = createGoalCompletionReview(goals, agents)
  return { live, goal, calls, review }
}

function payload(agent, turn = 1, signal = new AbortController().signal) {
  return { agent, turn, signal }
}

test('steers once per exact Goal revision and includes bounded actionable guidance', async () => {
  const { live, goal, calls, review } = harness()
  const messages = []
  const agent = { id: 'agent-1', steer: message => messages.push(message) }
  live.set(agent.id, agent)

  await review.listener(payload(agent))
  await review.listener(payload(agent))
  assert.equal(messages.length, 1)
  assert.equal(calls.length, 2, 'each boundary re-reads the current Goal')
  assert.ok(calls.every(actual => actual === agent))
  const text = messages[0].content[0].text
  assert.match(text, /Implement and verify the requested feature/u)
  assert.match(text, /If requested work remains, continue it now/u)
  assert.match(text, /change strategy instead of repeating it/u)
  assert.match(text, /does not change, complete, pause, resume, or clear the Goal/u)
  assert.equal(messages[0].source.kind, 'goal-completion-review')
  assert.equal(messages[0].source.form, 'notice')
  assert.equal(messages[0].source.summary.length <= 120, true)

  goal.revision = 2
  await review.listener(payload(agent, 2))
  assert.equal(messages.length, 2, 'an edited Goal receives one fresh review')
  await review.listener(payload(agent, 2))
  assert.equal(messages.length, 2)
  review.dispose()
})

test('skips missing, inactive, malformed, stale, aborted, and disposed positions without steering', async () => {
  const { live, goal, review } = harness()
  const messages = []
  const agent = { id: 'agent-gates', steer: message => messages.push(message) }
  live.set(agent.id, agent)

  for (const phase of ['paused', 'blocked', 'complete']) {
    goal.phase = phase
    await review.listener(payload(agent))
  }
  goal.phase = 'active'
  for (const invalid of [null, 0, -1, '1']) {
    goal.revision = invalid
    await review.listener(payload(agent))
  }
  goal.revision = 1
  goal.objective = ' \n\t '
  await review.listener(payload(agent))
  goal.objective = 'valid objective'

  await review.listener(payload(agent, -1))
  await review.listener(payload({ ...agent, id: 'x'.repeat(257) }))
  live.set(agent.id, { id: agent.id })
  await review.listener(payload(agent))
  live.set(agent.id, agent)
  const controller = new AbortController()
  controller.abort()
  await review.listener(payload(agent, 1, controller.signal))
  assert.equal(messages.length, 0)

  await review.listener(payload(agent))
  assert.equal(messages.length, 1)
  review.clearAgent(agent)
  await review.listener(payload(agent, 2))
  assert.equal(messages.length, 1, 'an exact disposed Agent cannot be nudged again')
  review.dispose()
})

test('sanitizes and bounds objective text without allowing prompt controls', async () => {
  const { live, goal, review } = harness()
  const messages = []
  const agent = { id: 'agent-objective', steer: message => messages.push(message) }
  live.set(agent.id, agent)
  goal.objective = `first line\nsecond line\u202e${'x'.repeat(2_500)}`

  await review.listener(payload(agent))
  const text = messages[0].content[0].text
  assert.match(text, /first line second line/u)
  assert.equal(text.includes('\u202e'), false)
  assert.match(text, /…/u)
  assert.equal(text.length < 3_000, true)
  review.dispose()
})

test('isolates same-ID replacements and does not evict live Agent state at capacity', async () => {
  const { live, goal, review } = harness()
  const agents = Array.from({ length: 257 }, (_value, index) => ({ id: `agent-${index}`, messages: [], steer(message) { this.messages.push(message) } }))
  for (const agent of agents) live.set(agent.id, agent)
  for (const agent of agents.slice(0, 256)) await review.listener(payload(agent))
  await review.listener(payload(agents[256]))
  assert.equal(agents[0].messages.length, 1)
  assert.equal(agents[255].messages.length, 1)
  assert.equal(agents[256].messages.length, 0)

  const replacement = { id: agents[0].id, messages: [], steer(message) { this.messages.push(message) } }
  live.set(replacement.id, replacement)
  await review.listener(payload(replacement, 2))
  assert.equal(replacement.messages.length, 1, 'same-ID replacement has an independent review slot')
  review.clearAgent(replacement)
  const admitted = { id: 'agent-admitted', messages: [], steer(message) { this.messages.push(message) } }
  live.set(admitted.id, admitted)
  await review.listener(payload(admitted))
  assert.equal(admitted.messages.length, 1, 'exact disposal frees one bounded slot')
  review.dispose()
})

test('contains steer and Goal service failures and stops future work after disposal', async () => {
  const { live, goal, review } = harness()
  const agent = { id: 'agent-failures', steer() { throw new Error('private driver failure') } }
  live.set(agent.id, agent)
  await assert.doesNotReject(review.listener(payload(agent)))
  goal.revision = 2
  await assert.doesNotReject(review.listener(payload(agent, 2)))
  review.dispose()
  goal.revision = 3
  await review.listener(payload(agent, 3))

  const failing = createGoalCompletionReview({ get() { throw new Error('private Goal failure') } }, { get: () => agent })
  await assert.doesNotReject(failing.listener(payload(agent)))
  failing.dispose()
})

test('registers boundary and exact-Agent disposal cleanup with the owning context', () => {
  const events = []
  let effect
  const ctx = {
    on(name, listener) { events.push([name, listener]) },
    effect(execute, label) { effect = { cleanup: execute(), label } },
  }
  const dispose = registerGoalCompletionReview(ctx, { goals: { get() {} }, agents: { get() {} } })
  assert.deepEqual(events.map(event => event[0]), ['agent/turn-stopping', 'agent/disposed'])
  assert.equal(effect.label, 'dsh-omo Goal completion review')
  dispose()
  effect.cleanup()
  assert.throws(() => registerGoalCompletionReview({ on() {} }, {}), /ctx\.on and ctx\.effect/u)
})
