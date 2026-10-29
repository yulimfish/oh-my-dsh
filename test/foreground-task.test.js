import assert from 'node:assert/strict'
import test from 'node:test'
import { createForegroundTaskTool } from '../src/foreground-task.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const snapshot = (extra = {}) => ({ childId: 'child-1', role: 'quick', status: 'completed', output: 'untrusted child text', truncated: false, omittedNonText: false, stopReason: 'completed', ...extra })
function fixture(launcher, waitMs = 1000) {
  const parent = { id: 'parent' }
  const lifecycle = new AbortController()
  let live = parent
  const manager = createForegroundTaskTool({ parameters: { role: { type: 'string', required: true } }, launchTask: launcher, lifecycleSignal: lifecycle.signal, isParentCurrent: value => value === live, waitMs })
  const exec = (extra = {}) => ({ agent: parent, token: Symbol('execution'), name: 'dsh_omo_task_join', ...extra })
  const ack = (execution, value) => manager.handleToolResult(execution, { isError: false, value, content: [] })
  const error = (execution, code = 'ABORTED') => manager.handleToolResult(execution, { isError: true, error: { message: 'aborted', ...(code ? { info: { code } } : {}) }, content: [] })
  return { parent, lifecycle, manager, exec, ack, error, replace() { live = { id: 'parent' } } }
}

test('captures immediate completion but suppresses relay only at exact final acknowledgement', async () => {
  let published = 0, delivery
  const state = fixture((_args, exec, gate) => {
    assert.strictEqual(exec.agent, state.parent)
    delivery = gate
    assert.equal(gate.offer(snapshot(), () => { published += 1 }), true)
    return { childId: 'child-1', role: 'quick' }
  })
  const exec = state.exec()
  const result = await state.manager.tool.execute({ role: 'quick' }, exec)
  assert.equal(result.output, 'untrusted child text')
  assert.equal(published, 0)
  state.manager.handleToolResult({ ...exec, token: Symbol('wrong') }, { isError: false, value: result })
  state.manager.handleToolResult({ ...exec, agent: { id: 'parent' } }, { isError: false, value: result })
  assert.equal(published, 0)
  state.ack(exec, result)
  state.error(exec)
  assert.equal(delivery.offer(snapshot(), () => { published += 1 }), true)
  assert.equal(published, 0)
  state.lifecycle.abort()
})

test('delayed final acknowledgement never releases a captured result on an acknowledgement timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let published = 0
  const state = fixture((_args, _exec, delivery) => {
    delivery.offer(snapshot(), () => { published += 1 })
    return { childId: 'child-1', role: 'quick' }
  })
  const exec = state.exec()
  const result = await state.manager.tool.execute({ role: 'quick' }, exec)
  context.mock.timers.tick(120000)
  assert.equal(published, 0)
  state.ack(exec, result)
  assert.equal(published, 0)
  state.lifecycle.abort()
})

test('canonical cancellation releases once while successful policy replacement suppresses the original relay', async () => {
  for (const change of [false, true, 'extra']) {
    let published = 0
    const state = fixture((_args, _exec, gate) => { gate.offer(snapshot(), () => { published += 1 }); return { childId: 'child-1', role: 'quick' } })
    const exec = state.exec()
    const result = await state.manager.tool.execute({ role: 'quick' }, exec)
    if (change === 'extra') state.ack(exec, { ...result, policyMetadata: 'added by Host' })
    else if (change) state.ack(exec, { status: 'redacted', output: 'replaced by policy' })
    else state.error(exec)
    state.error(exec)
    assert.equal(published, change ? 0 : 1)
    state.lifecycle.abort()
  }
})

test('Host blocks suppress held and future output even after a running timeout', async () => {
  for (const terminalBeforeBlock of [false, true]) {
    let gate, published = 0
    const state = fixture((_args, _exec, delivery) => { gate = delivery; return { childId: 'child-1', role: 'quick' } }, 1)
    const exec = state.exec()
    const result = await state.manager.tool.execute({ role: 'quick' }, exec)
    assert.equal(result.status, 'running')
    if (terminalBeforeBlock) assert.equal(gate.offer(snapshot(), () => { published += 1 }), true)
    assert.equal(published, 0, 'timeout cannot preempt native final policy')
    state.error(exec, null)
    assert.equal(gate.canPublish(), false)
    if (!terminalBeforeBlock) assert.equal(gate.offer(snapshot(), () => { published += 1 }), true)
    assert.equal(published, 0)
    state.lifecycle.abort()
  }
})

test('preserves optional tracking availability on terminal and running results', async () => {
  for (const resultTracked of [undefined, false, true]) {
    for (const terminal of [false, true]) {
      const tracking = resultTracked === undefined ? {} : { resultTracked }
      const state = fixture((_args, _exec, gate) => {
        if (terminal) gate.offer(snapshot(tracking), () => assert.fail('joined output must not relay'))
        return { childId: 'child-1', role: 'quick', ...tracking }
      }, 1)
      const exec = state.exec()
      const result = await state.manager.tool.execute({ role: 'quick' }, exec)
      assert.equal(result.resultTracked, resultTracked)
      assert.equal(Object.hasOwn(result, 'resultTracked'), resultTracked !== undefined)
      state.ack(exec, result)
      state.lifecycle.abort()
    }
  }
})

test('waits for a late terminal snapshot and renders partial/failure outputs', async () => {
  for (const status of ['completed', 'incomplete', 'failed']) {
    let gate
    const state = fixture((_args, _exec, delivery) => { gate = delivery; return { childId: 'child-1', role: 'quick' } })
    const exec = state.exec()
    const waiting = state.manager.tool.execute({ role: 'quick' }, exec)
    await tick()
    gate.offer(snapshot({ status, output: 'partial', truncated: true, omittedNonText: true, errorType: status === 'failed' ? 'Error' : undefined }), () => assert.fail('acknowledged result must not relay'))
    const result = await waiting
    assert.equal(result.status, status)
    const rendered = state.manager.tool.output.render({}, result)[0].text
    assert.match(rendered, /untrusted evidence/u)
    assert.match(rendered, /truncated/u)
    assert.match(rendered, /Non-text/u)
    state.ack(exec, result)
    state.lifecycle.abort()
  }
})

test('timeout returns real running identity then later delivery uses the ordinary relay', async () => {
  let gate, published = 0
  const state = fixture((_args, _exec, delivery) => { gate = delivery; return { childId: 'child-1', role: 'quick' } }, 1)
  const exec = state.exec()
  const result = await state.manager.tool.execute({ role: 'quick' }, exec)
  assert.deepEqual(result, { childId: 'child-1', role: 'quick', status: 'running', output: '', truncated: false, omittedNonText: false })
  state.ack(exec, result)
  assert.equal(gate.offer(snapshot(), () => { published += 1 }), false)
  // The launcher's normal publication branch executes only when offer returns false.
  if (gate.canPublish()) published += 1
  assert.equal(published, 1)
  assert.equal(gate.offer(snapshot(), () => { published += 1 }), true)
  state.lifecycle.abort()
})

test('caller cancellation after capture releases the relay but never aborts an accepted child signal', async () => {
  let gate, childSignal, published = 0
  const caller = new AbortController()
  const state = fixture((_args, exec, delivery) => { gate = delivery; childSignal = exec.signal; return { childId: 'child-1', role: 'quick' } })
  const exec = state.exec({ signal: caller.signal })
  const waiting = state.manager.tool.execute({ role: 'quick' }, exec)
  await tick()
  gate.offer(snapshot(), () => { published += 1 })
  const result = await waiting
  caller.abort()
  assert.equal(childSignal.aborted, false)
  assert.equal(published, 0, 'caller cancellation is not a final policy decision')
  state.error(exec)
  assert.equal(published, 1)
  assert.equal(result.status, 'completed')
  state.lifecycle.abort()
})

test('cancellation during startup aborts startup and handles ignored late launch rejection', async () => {
  const start = deferred(), caller = new AbortController()
  let startupSignal
  const state = fixture((_args, exec) => { startupSignal = exec.signal; return start.promise })
  const exec = state.exec({ signal: caller.signal })
  const waiting = state.manager.tool.execute({ role: 'quick' }, exec)
  await tick()
  caller.abort()
  await assert.rejects(waiting, /cancelled/u)
  assert.equal(startupSignal.aborted, true)
  start.reject(new Error('late backend failure'))
  state.error(exec)
  await tick()
  state.lifecycle.abort()
})

test('owner clearing and lifecycle shutdown drop held output and prevent stale background delivery', async () => {
  for (const end of ['clear', 'lifecycle', 'replace']) {
    let gate, childSignal, published = 0
    const state = fixture((_args, exec, delivery) => { gate = delivery; childSignal = exec.signal; delivery.offer(snapshot(), () => { published += 1 }); return { childId: 'child-1', role: 'quick' } })
    const exec = state.exec()
    const result = await state.manager.tool.execute({ role: 'quick' }, exec)
    if (end === 'clear') state.manager.clearAgent(state.parent)
    if (end === 'lifecycle') state.lifecycle.abort()
    if (end === 'replace') state.replace()
    state.error(exec)
    assert.equal(published, 0)
    assert.equal(childSignal.aborted, false)
    assert.equal(gate.canPublish(), false)
    assert.equal(result.status, 'completed')
    state.lifecycle.abort()
  }
})

test('checks current parent before launch, validates token and recovers acknowledgement capacity', async () => {
  let starts = 0
  const state = fixture((_args, _exec, delivery) => { starts += 1; delivery.offer(snapshot(), () => {}); return { childId: 'child-1', role: 'quick' } })
  await assert.rejects(state.manager.tool.execute({ role: 'quick' }, state.exec({ token: undefined })), /token/u)
  const held = []
  for (let i = 0; i < 64; i += 1) {
    const exec = state.exec()
    held.push([exec, await state.manager.tool.execute({ role: 'quick' }, exec)])
  }
  await assert.rejects(state.manager.tool.execute({ role: 'quick' }, state.exec()), /capacity/u)
  assert.equal(starts, 64)
  for (const [exec, result] of held) state.ack(exec, result)
  const exec = state.exec()
  state.ack(exec, await state.manager.tool.execute({ role: 'quick' }, exec))
  assert.equal(starts, 65)
  state.replace()
  await assert.rejects(state.manager.tool.execute({ role: 'quick' }, state.exec()), /exact live/u)
  state.lifecycle.abort()
})

test('launcher rejection respects final policy, rejects malformed identities and leaves no unhandled reactions', async () => {
  let published = 0
  const state = fixture((_args, _exec, delivery) => { delivery.offer(snapshot(), () => { published += 1 }); throw new Error('start failed') })
  const exec = state.exec()
  await assert.rejects(state.manager.tool.execute({ role: 'quick' }, exec), /start failed/u)
  assert.equal(published, 0)
  state.error(exec, null)
  assert.equal(published, 0, 'an arbitrary failure must not bypass Host policy')
  const bad = fixture(() => ({ childId: '', role: 'quick' }))
  const badExec = bad.exec()
  await assert.rejects(bad.manager.tool.execute({ role: 'quick' }, badExec), /identity/u)
  bad.error(badExec)
  state.lifecycle.abort(); bad.lifecycle.abort()
})

test('definition has fixed bounded wait, reusable parameters and a bounded structured renderer', () => {
  const state = fixture(() => {})
  assert.equal(state.manager.tool.name, 'dsh_omo_task_join')
  assert.equal(state.manager.tool.timeoutMs, 30000)
  assert.equal(Object.hasOwn(state.manager.tool.parameters, 'waitMs'), false)
  assert.equal(state.manager.tool.output.schema.additionalProperties, false)
  assert.match(state.manager.tool.output.render({}, { childId: 'c', role: 'quick', status: 'running' })[0].text, /did not interrupt/u)
  for (const waitMs of [0, -1, 8001, 1.1]) assert.throws(() => createForegroundTaskTool({ parameters: {}, launchTask() {}, lifecycleSignal: state.lifecycle.signal, isParentCurrent: () => true, waitMs }), /waitMs/u)
  state.lifecycle.abort()
})
