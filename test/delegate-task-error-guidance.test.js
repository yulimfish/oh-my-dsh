import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDelegateTaskErrorGuidanceListener,
  DELEGATE_TASK_ERROR_GUIDANCE,
} from '../src/delegate-task-error-guidance.js'

function makeExec(overrides = {}) {
  return {
    name: 'dsh_omo_task',
    arguments: { role: 'explore', task: 'Inspect the bounded target' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function makeFailure(message) {
  return { isError: true, error: { message }, content: [{ type: 'text', text: message }] }
}

test('adds fixed advice for two bounded task-text errors on exact one-shot and continuable Tools', async () => {
  const listener = createDelegateTaskErrorGuidanceListener(12000)
  const toolNames = ['dsh_omo_task', 'dsh_omo_task_continuable']
  const messages = [
    ['Task must not be empty.', ' \t '],
    ['Task is 12001 characters; dsh-omo limit is 12000.', 'x'.repeat(12001)],
  ]

  for (const name of toolNames) {
    for (const [message, task] of messages) {
      const value = { unchanged: true }
      const previous = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'prior context' }] }
      const downstreamDecision = { kind: 'accept', value, additionalContexts: [previous] }
      let nextCalls = 0
      const result = makeFailure(message)
      const decision = await listener(makeExec({ name, arguments: { role: 'explore', task } }), result, async () => {
        nextCalls += 1
        return downstreamDecision
      })

      assert.equal(nextCalls, 1)
      assert.equal(decision.kind, 'accept')
      assert.strictEqual(decision.value, value)
      assert.strictEqual(decision.additionalContexts[0], previous)
      assert.equal(decision.additionalContexts.length, 2)
      assert.equal(decision.additionalContexts[1].content[0].text, DELEGATE_TASK_ERROR_GUIDANCE)
      assert.ok(!decision.additionalContexts[1].content[0].text.includes(message))
      if (task.length > 256) assert.ok(!decision.additionalContexts[1].content[0].text.includes(task))
      assert.strictEqual(result.error.message, message, 'the normalized Tool error is not rewritten')
    }
  }
})

test('skips other tools, success, unrelated failures, and oversized error messages', async () => {
  const listener = createDelegateTaskErrorGuidanceListener(12000)
  const oversizedNumericError = `Task is ${'9'.repeat(300)} characters; dsh-omo limit is 12000.`
  const cases = [
    [makeExec({ name: 'task' }), makeFailure('Task must not be empty.')],
    [makeExec({ name: 'dsh_omo_task_followup' }), makeFailure('Task must not be empty.')],
    [makeExec({ name: 'dsh_omo_task_extra' }), makeFailure('Task must not be empty.')],
    [makeExec(), makeFailure('Task must not be empty.')],
    [makeExec(), makeFailure('Task is 12001 characters; dsh-omo limit is 12000.')],
    [makeExec({ arguments: { role: 'explore', task: 'x'.repeat(12001) } }), makeFailure('Task is 12002 characters; dsh-omo limit is 12000.')],
    [makeExec({ arguments: { role: 'explore', task: 'x'.repeat(12001) } }), makeFailure('Task is 12001 characters; dsh-omo limit is 11999.')],
    [makeExec({ arguments: { role: 'explore', task: ' '.repeat(257) } }), makeFailure('Task must not be empty.')],
    [makeExec(), { isError: false, error: { message: 'Task must not be empty.' }, content: [] }],
    [makeExec(), makeFailure('The worker limit is saturated.')],
    [makeExec(), makeFailure('dsh-omo one-shot worker limit reached (4); wait for a child to finish.')],
    [makeExec(), makeFailure('Specialist role "unknown" is not available in dsh-omo.')],
    [makeExec(), makeFailure('LLM provider route is unavailable.')],
    [makeExec({ name: 'dsh_omo_task_continuable' }), makeFailure('DSH continuation services are unavailable in this profile; use one-shot mode.')],
    [makeExec(), makeFailure(oversizedNumericError)],
  ]

  for (const [exec, result] of cases) {
    const downstreamDecision = { kind: 'accept', value: { unchanged: true } }
    let nextCalls = 0
    const decision = await listener(exec, result, async () => {
      nextCalls += 1
      return downstreamDecision
    })
    assert.equal(nextCalls, 1)
    assert.strictEqual(decision, downstreamDecision)
    assert.equal(decision.additionalContexts, undefined)
  }
})

test('does not add guidance after a downstream block or cancellation', async () => {
  const listener = createDelegateTaskErrorGuidanceListener(12000)
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
  let nextCalls = 0
  const blankArguments = { role: 'explore', task: '   ' }
  const blockDecision = await listener(makeExec({ arguments: blankArguments }), makeFailure('Task must not be empty.'), async () => {
    nextCalls += 1
    return blocked
  })
  assert.equal(nextCalls, 1)
  assert.strictEqual(blockDecision, blocked)

  const controller = new AbortController()
  const accepted = { kind: 'accept', value: { unchanged: true } }
  const cancelledDecision = await listener(makeExec({ arguments: blankArguments, signal: controller.signal }), makeFailure('Task must not be empty.'), async () => {
    nextCalls += 1
    controller.abort()
    return accepted
  })
  assert.equal(nextCalls, 2)
  assert.strictEqual(cancelledDecision, accepted)
  assert.equal(cancelledDecision.additionalContexts, undefined)
})
