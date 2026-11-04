import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config } from '../src/index.js'

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

// The Host event is tools/post-execute: a waterfall over the normalized
// ToolExecutionResult. A block or replacement governs that tool result; this
// test records the observed side effects, not an asserted security protocol.
async function harness(t) {
  const runtime = new Context()
  const promptFiber = await runtime.plugin(SystemPrompt)
  const runtimeFiber = await runtime.plugin(ToolRuntime)
  const children = [deferred(), deferred()]
  const startedSecond = deferred()
  const relayedSecond = deferred()
  const starts = []
  const followups = []
  const disposals = []
  const effects = []
  const removers = []
  const parent = {
    id: 'pending-policy-parent',
    followup(message) {
      followups.push(message)
      if (JSON.stringify(message).includes('PENDING CHILD EVIDENCE')) relayedSecond.resolve(message)
    },
  }
  const services = {
    agents: { get: id => id === parent.id ? parent : undefined, withoutInitiator: fn => fn() },
    sessions: { get: id => id === parent.id ? { id, header: { cwd: '/workspace/project' } } : undefined },
  }
  const stub = {
    get: key => services[key],
    tools: runtime.tools,
    subagents: {
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
      async startActivation(spec) {
        starts.push(spec)
        const index = starts.length
        if (index === 2) startedSecond.resolve()
        assert.ok(index <= children.length, 'only the two intended children may start')
        return {
          childId: `policy-child-${index}`,
          result: children[index - 1].promise,
          dispose: async () => { disposals.push(index) },
        }
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    on(event, listener) { removers.push(runtime.on(event, listener)); return stub },
    effect(execute) { const dispose = execute(); effects.push(dispose); return dispose },
    logger: { warn() {} },
  }
  apply(stub, Config({ enablePendingBackgroundTasks: true, maxConcurrent: 1, maxPendingTasks: 1 }))
  t.after(async () => {
    for (const child of children) child.resolve({ stopReason: 'completed', output: [] })
    for (const dispose of [...effects].reverse()) if (typeof dispose === 'function') await dispose()
    for (const remove of removers) if (typeof remove === 'function') remove()
    await runtimeFiber.dispose()
    await promptFiber.dispose()
  })
  const call = (name, callId, args) => runtime.tools.execute({
    callId, name, arguments: args, agent: parent, signal: new AbortController().signal,
  })
  return { runtime, parent, children, starts, followups, disposals, startedSecond, relayedSecond, call }
}

test('queued child may relay while startup post-policy is still pending', { timeout: 5000 }, async t => {
  const f = await harness(t)
  const entered = deferred()
  const releasePolicy = deferred()
  let originalPending
  const policy = await f.runtime.plugin(ctx => ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'dsh_omo_task' || exec.callId !== 'queued-delayed-policy') return decision
    originalPending = result.value.taskId
    entered.resolve()
    await releasePolicy.promise
    return { kind: 'block', feedback: [{ type: 'text', text: 'Delayed policy block.' }] }
  }))
  t.after(() => { releasePolicy.resolve(); return policy.dispose() })
  const active = await f.call('dsh_omo_task', 'active-delayed-policy', { role: 'explore', task: 'Occupy the only worker.' })
  assert.equal(active.isError, false)
  const pending = f.call('dsh_omo_task', 'queued-delayed-policy', { role: 'explore', task: 'Run after capacity is released.' })
  await entered.promise
  f.children[0].resolve({ stopReason: 'completed', output: [] })
  await f.startedSecond.promise
  f.children[1].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PENDING CHILD EVIDENCE' }] })
  const relay = await f.relayedSecond.promise
  assert.ok(JSON.stringify(relay).includes(`Pending task ID: ${originalPending}`))
  releasePolicy.resolve()
  const filtered = await pending
  assert.equal(filtered.isError, true)
  assert.equal(JSON.stringify(filtered).includes(originalPending), false)
})

for (const policyKind of ['block', 'replace']) {
  test(`native post-execute ${policyKind} of pending output: observe queued launch and relay`, { timeout: 5000 }, async t => {
    const f = await harness(t)
    let originalPending
    const policy = await f.runtime.plugin(ctx => ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'dsh_omo_task' || exec.callId !== 'queued-call') return decision
      assert.equal(result.isError, false)
      assert.equal(result.value.status, 'pending')
      originalPending = result.value.taskId
      assert.match(originalPending, /^bg_/u)
      assert.equal(f.starts.length, 1, 'capacity remains saturated at post-execute')
      return policyKind === 'block'
        ? { kind: 'block', feedback: [{ type: 'text', text: 'Pending result blocked by test policy.' }] }
        : { kind: 'accept', value: { role: 'explore', status: 'started', childId: 'policy-replacement' } }
    }))
    t.after(() => policy.dispose())

    const active = await f.call('dsh_omo_task', 'active-call', { role: 'explore', task: 'Occupy the only worker.' })
    assert.equal(active.isError, false)
    assert.equal(active.value.status, 'started')
    assert.equal(active.value.childId, 'policy-child-1')

    const filtered = await f.call('dsh_omo_task', 'queued-call', { role: 'explore', task: 'Run the pending child after capacity is released.' })
    assert.ok(originalPending, 'policy observed the original pending ID')
    assert.equal(filtered.isError, policyKind === 'block')
    if (policyKind === 'block') assert.match(JSON.stringify(filtered), /Pending result blocked by test policy/u)
    else assert.deepEqual(filtered.value, { role: 'explore', status: 'started', childId: 'policy-replacement' })
    assert.equal(JSON.stringify(filtered).includes(originalPending), false, 'final tool result hides the original pending ID')
    assert.equal(f.starts.length, 1)
    assert.deepEqual(f.followups, [])

    let statusCall = 0
    const status = () => f.call('dsh_omo_task_pending_status', `status-${++statusCall}`, { taskId: originalPending })
    const queuedStatus = await status()
    assert.equal(queuedStatus.isError, false)
    assert.equal(queuedStatus.value.status, 'pending')

    f.children[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ACTIVE CHILD EVIDENCE' }] })
    await f.startedSecond.promise
    assert.equal(f.starts.length, 2, 'queued child starts after capacity becomes available')
    assert.equal(f.starts[1].request.parent, f.parent)
    // startActivation was entered above; allow its returned handle to be bound.
    await new Promise(resolve => setImmediate(resolve))
    const runningStatus = await status()
    assert.equal(runningStatus.value.status, 'running')

    f.children[1].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PENDING CHILD EVIDENCE' }] })
    const relay = await f.relayedSecond.promise
    assert.equal(relay.source?.kind, 'agent-message')
    assert.ok(JSON.stringify(relay).includes(`Pending task ID: ${originalPending}`), 'settlement relay exposes the originally filtered pending ID')
    // Relay delivery precedes completion of settlement and registry update.
    await new Promise(resolve => setImmediate(resolve))
    const completedStatus = await status()
    assert.equal(completedStatus.value.status, 'completed')
    assert.deepEqual(f.disposals, [1, 2])
    assert.equal(f.followups.filter(message => JSON.stringify(message).includes(originalPending)).length, 1)
  })
}
