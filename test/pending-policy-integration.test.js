import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { executeToolOnce, installNativeToolExecutor } from './dsh-runtime-compat.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config } from '../src/index.js'

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

// Exercise the native Cordis post-execute waterfall and final-result event.
async function harness(t, maxPendingTasks = 1) {
  const runtime = new Context()
  const promptFiber = await runtime.plugin(SystemPrompt)
  const runtimeFiber = await runtime.plugin(ToolRuntime)
  const nativeExecutorFiber = await installNativeToolExecutor(runtime)
  const children = [deferred(), deferred(), deferred()]
  const starts = []
  const followups = []
  const disposals = []
  const effects = []
  const removers = []
  const parent = {
    id: 'pending-policy-parent',
    followup(message) {
      followups.push(message)
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
        assert.ok(index <= children.length, 'only the intended children may start')
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
  apply(stub, Config({ enablePendingBackgroundTasks: true, maxConcurrent: 1, maxPendingTasks }))
  t.after(async () => {
    for (const child of children) child.resolve({ stopReason: 'completed', output: [] })
    for (const dispose of [...effects].reverse()) if (typeof dispose === 'function') await dispose()
    for (const remove of removers) if (typeof remove === 'function') remove()
    await nativeExecutorFiber.dispose()
    await runtimeFiber.dispose()
    await promptFiber.dispose()
  })
  const call = (name, callId, args, signal = new AbortController().signal) => executeToolOnce(runtime.tools, {
    callId, name, arguments: args, agent: parent, signal,
  })
  return { runtime, parent, children, starts, followups, disposals, call }
}

// Bound both positive observations and negative windows so a regression cannot
// hang the suite. The negative window gives scheduled pumps time to run.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, description) {
  const deadline = Date.now() + 1000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await delay(5)
  }
}
const start = (f, id, task, signal) => f.call('dsh_omo_task', id, { role: 'explore', task }, signal)
const status = (f, id) => f.call('dsh_omo_task_pending_status', `status-${id}`, { taskId: id })
const finish = (f, index, text = '') => f.children[index].resolve({
  stopReason: 'completed', output: text ? [{ type: 'text', text }] : [],
})
async function assertNoQueuedWork(f, hiddenId) {
  const missing = await status(f, hiddenId)
  assert.equal(missing.isError, true, 'undisclosed staged ID is not in the registry')
  finish(f, 0, 'ACTIVE CHILD EVIDENCE')
  await waitFor(() => f.disposals.includes(1), 'active child disposal')
  await delay(80)
  assert.equal(f.starts.length, 1, 'rejected staged task must not start')
  assert.equal(JSON.stringify(f.followups).includes(hiddenId), false, 'hidden ID must not leak via relay')
  assert.equal(JSON.stringify(f.followups).includes('PENDING CHILD EVIDENCE'), false)
  assert.equal((await status(f, hiddenId)).isError, true)
}

test('canonical accepted pending result starts only after capacity is released', { timeout: 5000 }, async t => {
  const f = await harness(t)
  const active = await start(f, 'active', 'Occupy the only worker.')
  assert.equal(active.value.status, 'started')
  const pending = await start(f, 'queued', 'Run after capacity is released.')
  assert.equal(pending.isError, false)
  assert.equal(pending.value.status, 'pending')
  assert.match(pending.value.taskId, /^bg_/u)
  assert.equal((await status(f, pending.value.taskId)).value.status, 'pending')
  await delay(80)
  assert.equal(f.starts.length, 1)
  finish(f, 0, 'ACTIVE CHILD EVIDENCE')
  await waitFor(() => f.starts.length === 2, 'accepted child start')
  assert.equal(f.starts[1].request.parent, f.parent)
  await waitFor(async () => (await status(f, pending.value.taskId)).value?.status === 'running', 'pending child running')
  finish(f, 1, 'PENDING CHILD EVIDENCE')
  await waitFor(() => f.followups.some(m => JSON.stringify(m).includes('PENDING CHILD EVIDENCE')), 'pending relay')
  await waitFor(() => f.disposals.includes(2), 'pending child disposal')
  assert.equal((await status(f, pending.value.taskId)).value.status, 'completed')
  const relays = f.followups.filter(m => JSON.stringify(m).includes(pending.value.taskId))
  assert.equal(relays.length, 1)
  assert.equal(relays[0].source?.kind, 'agent-message')
})

test('free capacity cannot start staged task until delayed canonical final acceptance', { timeout: 5000 }, async t => {
  const f = await harness(t)
  const release = deferred()
  let observed
  const policy = await f.runtime.plugin(ctx => ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.callId !== 'delayed') return decision
    observed = result.value.taskId
    await release.promise
    return decision
  }))
  t.after(() => { release.resolve(); return policy.dispose() })
  await start(f, 'active', 'Occupy the only worker.')
  const pending = start(f, 'delayed', 'Wait for the final result.')
  await waitFor(() => observed !== undefined, 'post-execute policy')
  finish(f, 0)
  await waitFor(() => f.disposals.includes(1), 'capacity release')
  await delay(80)
  assert.equal(f.starts.length, 1, 'staged work cannot start while policy is unresolved')
  assert.equal(JSON.stringify(f.followups).includes(observed), false)
  release.resolve()
  const accepted = await pending
  assert.equal(accepted.isError, false)
  assert.equal(accepted.value.taskId, observed)
  await waitFor(() => f.starts.length === 2, 'start after acceptance')
  finish(f, 1, 'PENDING CHILD EVIDENCE')
  await waitFor(() => f.followups.some(m => JSON.stringify(m).includes(observed)), 'accepted pending relay')
})

for (const kind of ['block', 'replace', 'redact', 'abort']) {
  test(`native ${kind} final outcome discards staged pending task without leaks`, { timeout: 5000 }, async t => {
    const f = await harness(t)
    const release = deferred()
    const controller = new AbortController()
    let originalPending
    const policy = await f.runtime.plugin(ctx => ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.callId !== 'filtered') return decision
      assert.equal(result.isError, false)
      assert.equal(result.value.status, 'pending')
      originalPending = result.value.taskId
      assert.match(originalPending, /^bg_/u)
      if (kind === 'abort') {
        await release.promise
        return decision
      }
      if (kind === 'block') return { kind: 'block', feedback: [{ type: 'text', text: 'Pending result blocked by test policy.' }] }
      if (kind === 'replace') return { kind: 'accept', value: { role: 'explore', status: 'started', childId: 'policy-replacement' } }
      return { kind: 'accept', content: [{ type: 'text', text: 'Pending output redacted.' }] }
    }))
    t.after(() => { release.resolve(); return policy.dispose() })
    await start(f, 'active', 'Occupy the only worker.')
    const pending = start(f, 'filtered', 'Must not execute.', controller.signal)
    await waitFor(() => originalPending !== undefined, 'policy to observe pending ID')
    if (kind === 'abort') { controller.abort(); release.resolve() }
    const filtered = await pending
    if (kind === 'block') {
      assert.equal(filtered.isError, true)
      assert.match(JSON.stringify(filtered), /Pending result blocked by test policy/u)
    } else if (kind === 'replace') {
      assert.equal(filtered.isError, false)
      assert.deepEqual(filtered.value, { role: 'explore', status: 'started', childId: 'policy-replacement' })
    } else if (kind === 'redact') {
      assert.equal(filtered.isError, false)
      assert.deepEqual(filtered.content, [{ type: 'text', text: 'Pending output redacted.' }])
      // Content-only replacement may retain the value; it is not an acknowledgement.
      assert.equal(filtered.value.taskId, originalPending)
    } else {
      assert.equal(filtered.isError, true)
      assert.equal(filtered.error?.info?.code, 'ABORTED')
    }
    if (kind !== 'redact') assert.equal(JSON.stringify(filtered).includes(originalPending), false)
    await assertNoQueuedWork(f, originalPending)
  })
}

test('same-parent staged tokens settle independently in reverse acceptance order', { timeout: 5000 }, async t => {
  const f = await harness(t, 2)
  const release = { first: deferred(), second: deferred() }
  const ids = {}
  const policy = await f.runtime.plugin(ctx => ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!(exec.callId in release)) return decision
    ids[exec.callId] = result.value.taskId
    await release[exec.callId].promise
    return decision
  }))
  t.after(() => { release.first.resolve(); release.second.resolve(); return policy.dispose() })
  await start(f, 'active', 'Occupy the only worker.')
  const first = start(f, 'first', 'FIRST TOKEN TASK')
  await waitFor(() => ids.first, 'first staged token')
  const second = start(f, 'second', 'SECOND TOKEN TASK')
  await waitFor(() => ids.second, 'second staged token')
  assert.notEqual(ids.first, ids.second)
  finish(f, 0)
  await waitFor(() => f.disposals.includes(1), 'capacity release')
  await delay(80)
  assert.equal(f.starts.length, 1)
  release.second.resolve()
  assert.equal((await second).value.taskId, ids.second)
  await waitFor(() => f.starts.length === 2, 'second token activation')
  assert.match(JSON.stringify(f.starts[1].request.prompt), /SECOND TOKEN TASK/u)
  await delay(80)
  assert.equal(f.starts.length, 2, 'first token remains staged')
  release.first.resolve()
  assert.equal((await first).value.taskId, ids.first)
  finish(f, 1, 'SECOND TOKEN EVIDENCE')
  await waitFor(() => f.starts.length === 3, 'first token activation after capacity')
  assert.match(JSON.stringify(f.starts[2].request.prompt), /FIRST TOKEN TASK/u)
  finish(f, 2, 'FIRST TOKEN EVIDENCE')
  await waitFor(() => f.followups.some(m => JSON.stringify(m).includes('FIRST TOKEN EVIDENCE'))
    && f.followups.some(m => JSON.stringify(m).includes('SECOND TOKEN EVIDENCE')), 'both token relays')
  for (const [id, evidence] of [[ids.first, 'FIRST TOKEN EVIDENCE'], [ids.second, 'SECOND TOKEN EVIDENCE']]) {
    const relay = f.followups.filter(m => JSON.stringify(m).includes(evidence))
    assert.equal(relay.length, 1)
    assert.ok(JSON.stringify(relay[0]).includes(id))
    const otherId = id === ids.first ? ids.second : ids.first
    assert.equal(JSON.stringify(relay[0]).includes(otherId), false)
  }
})
