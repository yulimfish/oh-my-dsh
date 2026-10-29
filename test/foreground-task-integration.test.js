import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function nativeContext(options = {}) {
  const tools = new Map()
  const starts = []
  const followups = []
  const disposals = []
  const effects = []
  const events = new Map()
  const preflights = []
  const skillReads = []
  const parent = { id: 'foreground-parent', followup: message => followups.push(message) }
  let liveParent = parent
  const services = {
    agents: { get: id => id === parent.id ? liveParent : options.additionalAgents?.find(agent => agent.id === id), withoutInitiator: fn => fn() },
    sessions: { get: id => id === parent.id || options.additionalAgents?.some(agent => agent.id === id) ? { id, header: { cwd: '/workspace/project' } } : undefined },
    ...(options.resolveCallConfig ? { llm: { resolveCallConfig: async (config, signal) => { preflights.push(config); return options.resolveCallConfig(config, signal) } } } : {}),
  }
  const ctx = {
    get: key => services[key],
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get() {} },
    subagents: {
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => {
        starts.push(spec)
        const index = starts.length
        await options.startGate
        return {
          childId: `foreground-child-${index}`,
          result: options.resultForStart?.(index) ?? options.result ?? Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Verified specialist evidence.' }] }),
          dispose: async () => { disposals.push(index); await options.disposeGate },
        }
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: {
      register: () => () => {}, registerProvider: () => () => {},
      get: async (name, hostOptions) => {
        skillReads.push(name)
        if (options.getSkill) return options.getSkill(name, hostOptions)
        return { name, invocation: { modelInvocable: true }, content: `Skill evidence ${name}` }
      },
    },
    on(event, listener) { const listeners = events.get(event) ?? []; listeners.push(listener); events.set(event, listeners); return ctx },
    effect(execute, label) { const dispose = execute(); effects.push({ label, dispose }); return dispose },
    logger: { warn() {} },
  }
  return { ctx, tools, starts, followups, disposals, effects, events, parent, preflights, skillReads, replaceParent(value) { liveParent = value } }
}
function mount(fixture, input = {}) {
  apply(fixture.ctx, Config({ enableForegroundTaskTool: true, ...input }))
  return fixture.tools.get('dsh_omo_task_join')
}
async function execute(fixture, tool, args = {}, signal = new AbortController().signal) {
  const parameters = { role: 'explore', task: 'Verify the selected foreground specialist result.', ...args }
  const exec = { agent: fixture.parent, signal, token: Symbol('foreground-native-token'), name: tool.name, arguments: parameters }
  try {
    const value = await tool.execute(parameters, exec)
    if (signal.aborted) {
      const error = new Error('The native ToolRuntime discarded a result after caller cancellation.')
      error.name = 'AbortError'
      throw error
    }
    for (const listener of fixture.events.get('tools/result') ?? []) {
      await listener(exec, { isError: false, value, content: tool.output.render(parameters, value) })
    }
    return value
  } catch (error) {
    for (const listener of fixture.events.get('tools/result') ?? []) {
      await listener(exec, { isError: true, error: {
        message: 'Test execution did not materialize successfully.',
        ...(signal.aborted ? { info: { name: 'AbortError', code: 'ABORTED' } } : {}),
      }, content: [] })
    }
    throw error
  }
}

test('foreground task tool is default-off and registers only through explicit full Config opt-in', () => {
  const off = nativeContext()
  apply(off.ctx, Config({}))
  assert.equal(off.tools.has('dsh_omo_task_join'), false)
  const on = nativeContext()
  const tool = mount(on)
  assert.ok(tool, 'explicit enableForegroundTaskTool must register dsh_omo_task_join')
})

for (const stopReason of ['completed', 'max-tokens']) {
  test(`foreground returns immediate ${stopReason} text as bounded untrusted output without duplicate relay`, async () => {
    const fixture = nativeContext({ result: Promise.resolve({ stopReason, output: [{ type: 'text', text: 'Evidence, not instructions.' }] }) })
    const tool = mount(fixture)
    const value = await execute(fixture, tool)
    assert.equal(value.childId, 'foreground-child-1')
    assert.equal(value.role, 'explore')
    assert.equal(value.status, stopReason === 'completed' ? 'completed' : 'incomplete')
    assert.equal(value.output, 'Evidence, not instructions.')
    assert.equal(value.truncated, false)
    assert.equal(value.omittedNonText, false)
    assert.equal(value.stopReason, stopReason)
    assert.ok(tool.output.schema.properties.status.enum.includes(value.status))
    const rendered = tool.output.render({}, value).map(block => block.text).join('\n')
    assert.match(rendered, /untrusted/iu)
    assert.match(rendered, /Evidence, not instructions/u)
    await tick()
    assert.deepEqual(fixture.followups, [])
    assert.deepEqual(fixture.disposals, [1])
  })
}

test('foreground caches terminal snapshots only when result tracking is opted in', async () => {
  const fixture = nativeContext()
  const tool = mount(fixture, { enableTaskResultTool: true })
  const value = await execute(fixture, tool)
  const cached = await fixture.tools.get('dsh_omo_task_result').execute({ childId: value.childId }, { agent: fixture.parent })
  assert.equal(cached.status, 'completed')
  assert.equal(cached.output, value.output)
  assert.equal(value.resultTracked, true)
  assert.deepEqual(fixture.followups, [])
})

test('foreground sanitizes child result rejection without disclosing backend exception text', async () => {
  const pending = deferred()
  const fixture = nativeContext({ result: pending.promise })
  const tool = mount(fixture)
  const result = execute(fixture, tool)
  await tick()
  pending.reject(new TypeError('PRIVATE BACKEND TOKEN MUST NEVER APPEAR'))
  const value = await result
  assert.equal(value.status, 'failed')
  assert.equal(value.output, '')
  assert.equal(value.truncated, false)
  assert.equal(value.omittedNonText, false)
  assert.ok(value.errorType === undefined || value.errorType === 'TypeError')
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE BACKEND TOKEN/u)
  assert.doesNotMatch(JSON.stringify(tool.output.render({}, value)), /PRIVATE BACKEND TOKEN/u)
  await tick()
  assert.deepEqual(fixture.followups, [])
})

test('foreground bounds text and omits non-text blocks through the shared excerpt path', async () => {
  const fixture = nativeContext({ result: Promise.resolve({ stopReason: 'completed', output: [
    { type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'text', text: 'x'.repeat(10000) },
  ] }) })
  const tool = mount(fixture, { maxResultChars: 256 })
  const value = await execute(fixture, tool)
  assert.equal(value.status, 'completed')
  assert.equal(value.truncated, true)
  assert.equal(value.omittedNonText, true)
  assert.ok(value.output.length <= 256)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE REASONING/u)
  assert.deepEqual(fixture.followups, [])
})

test('foreground reuses configured role/category/default skills and fallback selection before native activation', async () => {
  const fixture = nativeContext({ resolveCallConfig: async config => {
    if (config.provider === 'primary') throw new Error('unavailable')
    return config
  } })
  const tool = mount(fixture, {
    categoryRoutes: [{ name: 'research', provider: 'primary', model: 'model-a', skills: ['debugging'], fallbackModels: [{ provider: 'backup', model: 'model-b' }] }],
    roleRoutes: [{ role: 'explore', category: 'research', reasoningEffort: 'low' }],
  })
  await execute(fixture, tool, { load_skills: ['git-master'] })
  assert.deepEqual(fixture.preflights, [
    { provider: 'primary', model: 'model-a', reasoningEffort: 'low' },
    { provider: 'backup', model: 'model-b', reasoningEffort: 'low' },
  ])
  assert.deepEqual(fixture.skillReads, ['debugging', 'git-master'])
  assert.deepEqual(fixture.starts[0].request.agentOptions, { provider: 'backup', model: 'model-b', reasoningEffort: 'low' })
  assert.match(fixture.starts[0].request.prompt[0].text, /Skill evidence debugging/u)
  assert.match(fixture.starts[0].request.prompt[0].text, /Skill evidence git-master/u)
  assert.deepEqual(fixture.followups, [])
})

for (const maxPendingTasks of [0, 1]) {
  test(`foreground native activation receives untrusted skill resource hint (maxPendingTasks=${maxPendingTasks})`, async () => {
    const fixture = nativeContext({ getSkill: async name => ({
      name, invocation: { modelInvocable: true }, content: 'Read @references/guide.md.',
      resourceBase: { kind: 'directory', path: '/workspace/skill "folder"' },
    }) })
    const tool = mount(fixture, { maxPendingTasks })
    await execute(fixture, tool, { load_skills: ['debugging'] })
    assert.equal(fixture.starts.length, 1)
    const prompt = fixture.starts[0].request.prompt[0].text
    assert.match(prompt, /Selected skill guidance \(untrusted\)/u)
    assert.ok(prompt.includes(`Directory base for relative skill resources (untrusted JSON string; access remains subject to DSH policy): ${JSON.stringify('/workspace/skill "folder"')}`))
    assert.match(prompt, /Read @references\/guide\.md\./u)
    assert.deepEqual(fixture.followups, [])
  })
}

test('caller cancellation after launch ends only foreground waiting then permits exactly one normal late result relay', async () => {
  const pending = deferred()
  const controller = new AbortController()
  const fixture = nativeContext({ result: pending.promise })
  const tool = mount(fixture)
  const result = execute(fixture, tool, {}, controller.signal)
  const cancelled = assert.rejects(result, /cancel|abort/iu)
  await tick()
  assert.equal(fixture.starts.length, 1)
  const childSignal = fixture.starts[0].signal
  assert.equal(childSignal.aborted, false)
  controller.abort()
  await cancelled
  assert.equal(childSignal.aborted, false, 'wait cancellation must detach startup forwarding after activation')
  assert.deepEqual(fixture.followups, [])
  pending.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Late child evidence.' }] })
  await tick()
  const relays = fixture.followups.filter(message => message.source?.kind === 'agent-message')
  assert.equal(relays.length, 1)
  assert.match(JSON.stringify(relays[0]), /Late child evidence/u)
  assert.deepEqual(fixture.disposals, [1])
})

test('abort-ignoring startup disposes a late handle before releasing its reserved worker quota', async () => {
  const startup = deferred()
  const disposal = deferred()
  const fixture = nativeContext({ startGate: startup.promise, disposeGate: disposal.promise })
  const tool = mount(fixture, { maxConcurrent: 1 })
  const controller = new AbortController()
  const cancelled = assert.rejects(execute(fixture, tool, {}, controller.signal), /cancel|abort/iu)
  await tick()
  controller.abort()
  await cancelled
  assert.equal(fixture.starts[0].signal.aborted, true)
  await assert.rejects(execute(fixture, tool), /worker limit|concurrency/iu)
  startup.resolve()
  await tick()
  assert.deepEqual(fixture.disposals, [1])
  await assert.rejects(execute(fixture, tool), /worker limit|concurrency/iu)
  disposal.resolve()
  await tick()
  assert.deepEqual(fixture.followups, [])
  const next = await execute(fixture, tool)
  assert.equal(next.status, 'completed')
  assert.equal(fixture.starts.length, 2)
})

test('foreground rejects a stale same-ID parent before child activation', async () => {
  const fixture = nativeContext()
  const tool = mount(fixture)
  fixture.replaceParent({ id: fixture.parent.id, followup() {} })
  await assert.rejects(execute(fixture, tool), /Agent|parent|live|stale/iu)
  assert.equal(fixture.starts.length, 0)
})

test('same-ID parent replacement while a foreground child runs cannot capture or relay its result', async () => {
  const pending = deferred()
  const fixture = nativeContext({ result: pending.promise })
  const tool = mount(fixture)
  const outcome = execute(fixture, tool).then(value => ({ value }), error => ({ error }))
  await tick()
  fixture.replaceParent({ id: fixture.parent.id, followup() { assert.fail('replacement must not receive old result') } })
  pending.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Old parent evidence.' }] })
  const result = await outcome
  assert.ok(result.error)
  await tick()
  assert.deepEqual(fixture.followups, [])
})

test('foreground settlement does not release worker quota before actual activation disposal finishes', async () => {
  const gate = deferred()
  const fixture = nativeContext({ disposeGate: gate.promise })
  const tool = mount(fixture, { maxConcurrent: 1 })
  const first = execute(fixture, tool)
  await tick()
  assert.deepEqual(fixture.disposals, [1])
  await assert.rejects(execute(fixture, tool), /worker limit|concurrency/iu)
  gate.resolve()
  await first
  await tick()
  const second = await execute(fixture, tool)
  assert.equal(second.status, 'completed')
  assert.equal(fixture.starts.length, 2)
})

test('parent disposal releases foreground wait and suppresses stale child delivery', async () => {
  const pending = deferred()
  const fixture = nativeContext({ result: pending.promise })
  const tool = mount(fixture)
  const waiting = execute(fixture, tool)
  // Observe possible rejection immediately to avoid treating expected shutdown as unhandled.
  const outcome = waiting.then(value => ({ value }), error => ({ error }))
  await tick()
  const listeners = fixture.events.get('agent/disposed') ?? []
  assert.ok(listeners.length > 0)
  fixture.replaceParent(undefined)
  for (const listener of listeners) await listener({ agent: fixture.parent })
  pending.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Must not reach disposed parent.' }] })
  await outcome
  await tick()
  assert.deepEqual(fixture.followups, [])
})

test('plugin disposal aborts pending foreground wait without relaying a late child result', async () => {
  const pending = deferred()
  const fixture = nativeContext({ result: pending.promise })
  const tool = mount(fixture)
  const outcome = execute(fixture, tool).then(value => ({ value }), error => ({ error }))
  await tick()
  for (const effect of [...fixture.effects].reverse()) if (typeof effect.dispose === 'function') await effect.dispose()
  const result = await outcome
  assert.ok(result.error, 'shutdown must end a waiting foreground execution')
  pending.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Must not relay after plugin shutdown.' }] })
  await tick()
  assert.deepEqual(fixture.followups, [])
  assert.deepEqual(fixture.disposals, [1])
})

// These deliberately non-cooperative mocks violate the Host cancellation contract;
// they do not establish that the actual Host behaves this way.
for (const shutdown of ['caller abort', 'plugin disposal']) {
  test(`native ToolRuntime ends skill lookup on ${shutdown} when mock Host ignores cancellation`, async t => {
    const lookup = deferred()
    const entered = deferred()
    const controller = new AbortController()
    const bFollowups = []
    const parentB = { id: 'skill-parent-b', followup: message => bFollowups.push(message) }
    t.after(() => {
      controller.abort()
      lookup.resolve({ name: 'debugging', invocation: { modelInvocable: true }, content: 'LATE SKILL CONTENT' })
    })
    let hostOptions
    const { runtimeContext, fixture } = await nativePolicyHarness(t, {
      additionalAgents: [parentB], config: { maxConcurrent: 1 },
      getSkill: (name, options) => { hostOptions = options; entered.resolve(); return lookup.promise },
    })
    const pending = runtimeContext.tools.execute({
      callId: `skill-${shutdown}`, name: 'dsh_omo_task',
      arguments: { role: 'explore', task: 'Test non-cooperative skill lookup.', load_skills: ['debugging'] },
      agent: fixture.parent, signal: controller.signal,
    })
    await entered.promise
    assert.equal(hostOptions.cwd, '/workspace/project')
    assert.ok(hostOptions.signal instanceof AbortSignal)
    assert.equal(hostOptions.signal.aborted, false)
    assert.equal(fixture.starts.length, 0)
    if (shutdown === 'caller abort') controller.abort()
    else for (const effect of [...fixture.effects].reverse()) if (typeof effect.dispose === 'function') await effect.dispose()
    const outcome = await Promise.race([pending.then(result => ({ result })), tick().then(() => ({ pending: true }))])
    assert.ok(outcome.result, 'execution must settle before the unresolved Host lookup')
    assert.equal(outcome.result.isError, true)
    if (shutdown === 'caller abort') {
      assert.equal(hostOptions.signal.aborted, true)
      // This proves the worker reservation is reusable by another parent, not
      // that the still-unsettled Host lookup lease has been released.
      const other = await runtimeContext.tools.execute({
        callId: 'other-parent-after-abort', name: 'dsh_omo_task',
        arguments: { role: 'explore', task: 'Check reusable worker capacity.' },
        agent: parentB, signal: new AbortController().signal,
      })
      assert.equal(other.isError, false)
      assert.equal(fixture.starts.length, 1)
      assert.equal(fixture.starts[0].request.parent, parentB)
      await tick()
    } else {
      assert.equal(hostOptions.signal.aborted, true, 'plugin disposal propagates cancellation to the Host lookup')
      assert.equal(controller.signal.aborted, false, 'plugin disposal must not abort the caller signal')
      assert.equal(fixture.starts.length, 0)
    }
    assert.deepEqual(fixture.followups, [], 'cancelled lookup must not relay to its parent')
    const previousStarts = fixture.starts.length
    const previousA = fixture.followups.length
    const previousB = bFollowups.length
    lookup.resolve({ name: 'debugging', invocation: { modelInvocable: true }, content: 'LATE SKILL CONTENT' })
    await tick()
    await tick()
    assert.equal(fixture.starts.length, previousStarts, 'late Host result must not start an activation')
    assert.equal(fixture.followups.length, previousA)
    assert.equal(bFollowups.length, previousB)
    assert.doesNotMatch(JSON.stringify([outcome.result, fixture.followups, bFollowups]), /LATE SKILL CONTENT/u)
  })
}

for (const settlement of ['resolve', 'reject']) {
  for (const order of ['abort-first', 'settle-first']) {
    test(`native skill lookup ${settlement} racing caller abort (${order}) cannot launch or leak`, async t => {
      const lookup = deferred()
      const entered = deferred()
      const controller = new AbortController()
      const unhandled = []
      const onUnhandled = reason => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      t.after(() => { controller.abort(); lookup.resolve(); process.off('unhandledRejection', onUnhandled) })
      const { runtimeContext, fixture } = await nativePolicyHarness(t, {
        config: { maxConcurrent: 1 },
        getSkill: () => { entered.resolve(); return lookup.promise },
      })
      const call = (callId, loadSkills, signal = new AbortController().signal) => runtimeContext.tools.execute({
        callId, name: 'dsh_omo_task_join',
        arguments: { role: 'explore', task: callId, ...(loadSkills ? { load_skills: ['debugging'] } : {}) },
        agent: fixture.parent, signal,
      })
      const pending = call('skill-race', true, controller.signal)
      await entered.promise
      const settle = () => settlement === 'resolve'
        ? lookup.resolve({ name: 'debugging', invocation: { modelInvocable: true }, content: 'PRIVATE RACE SKILL' })
        : lookup.reject(new Error('PRIVATE RACE REJECTION'))
      if (order === 'abort-first') { controller.abort(); settle() } else { settle(); controller.abort() }
      const result = await pending
      assert.equal(result.isError, true)
      await tick()
      const next = await call('short-after-skill-race', false)
      assert.equal(next.isError, false)
      assert.equal(next.value.status, 'completed')
      await tick()
      assert.equal(fixture.starts.length, 1, 'only the subsequent short task may launch')
      assert.deepEqual(fixture.followups, [])
      assert.doesNotMatch(JSON.stringify([result, next, fixture.starts, fixture.followups]), /PRIVATE RACE/u)
      assert.deepEqual(unhandled, [])
    })
  }
}

for (const shutdown of ['caller abort', 'plugin disposal']) {
  test(`native queued skill request is removed on ${shutdown} before Host lookup`, async t => {
    const child = deferred()
    const controller = new AbortController()
    const { runtimeContext, fixture } = await nativePolicyHarness(t, {
      resultForStart: index => index === 1 ? child.promise : Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'SHORT TASK EVIDENCE' }] }),
      config: { maxConcurrent: 1, maxPendingTasks: 1 },
    })
    t.after(() => { controller.abort(); child.resolve({ stopReason: 'completed', output: [] }) })
    const call = (callId, name, extra = {}, signal = new AbortController().signal) => runtimeContext.tools.execute({
      callId, name, arguments: { role: 'explore', task: callId, ...extra }, agent: fixture.parent, signal,
    })
    const active = await call('skill-queue-active', 'dsh_omo_task')
    assert.equal(active.isError, false)
    const waiting = call('skill-queue-waiting', 'dsh_omo_task_join', { load_skills: ['debugging'] }, controller.signal)
    assert.equal(await Promise.race([waiting.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
    const overflow = await call('skill-queue-overflow', 'dsh_omo_task_join')
    assert.equal(overflow.isError, true, 'overflow proves the skill request has occupied the queue')
    assert.deepEqual(fixture.skillReads, [])
    if (shutdown === 'caller abort') controller.abort()
    else for (const effect of [...fixture.effects].reverse()) if (typeof effect.dispose === 'function') await effect.dispose()
    const cancelled = await waiting
    assert.equal(cancelled.isError, true)
    assert.equal(fixture.starts.length, 1)
    assert.deepEqual(fixture.skillReads, [])
    let next
    if (shutdown === 'caller abort') {
      next = call('short-after-queue-cancel', 'dsh_omo_task_join')
      assert.equal(await Promise.race([next.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
    }
    child.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'LATE QUEUE CHILD CONTENT' }] })
    if (next) {
      const result = await next
      assert.equal(result.isError, false)
      assert.equal(result.value.output, 'SHORT TASK EVIDENCE')
      assert.equal(fixture.starts.length, 2)
      assert.doesNotMatch(JSON.stringify([cancelled, result]), /LATE QUEUE CHILD CONTENT/u)
    }
    await tick()
    assert.deepEqual(fixture.skillReads, [], 'removed queue entry must never reach Host get')
    if (shutdown === 'plugin disposal') {
      assert.equal(fixture.starts.length, 1)
      assert.doesNotMatch(JSON.stringify([cancelled, fixture.followups]), /LATE QUEUE CHILD CONTENT/u)
    }
  })
}

test('native ToolRuntime cancellation before one-shot startup settles suppresses a late relay', async t => {
  const startup = deferred()
  const disposal = deferred()
  const { runtimeContext, fixture } = await nativePolicyHarness(t, { startGate: startup.promise, disposeGate: disposal.promise })
  t.after(() => { startup.resolve(); disposal.resolve() })
  const controller = new AbortController()
  const pending = runtimeContext.tools.execute({
    callId: 'ordinary-native-late-cancel', name: 'dsh_omo_task',
    arguments: { role: 'explore', task: 'Verify cancellation while Host startup is pending.' },
    agent: fixture.parent, signal: controller.signal,
  })
  await tick()
  assert.equal(fixture.starts.length, 1)
  controller.abort()
  startup.resolve()
  await tick()
  assert.deepEqual(fixture.disposals, [1], 'late accepted activation is disposed')
  assert.deepEqual(fixture.followups, [], 'late output is not relayed')
  disposal.resolve()
  const result = await pending
  assert.equal(result.isError, true)
  assert.match(result.error?.message ?? '', /accepted child may have run before disposal/u)
  assert.deepEqual(fixture.followups, [])
})

test('native ToolRuntime abort after join body but before final materialization releases exactly one result relay', async t => {
  const runtimeContext = new Context()
  const promptFiber = await runtimeContext.plugin(SystemPrompt)
  const runtimeFiber = await runtimeContext.plugin(ToolRuntime)
  const fixture = nativeContext()
  fixture.ctx.tools = runtimeContext.tools
  const removers = []
  fixture.ctx.on = (event, listener) => { removers.push(runtimeContext.on(event, listener)); return fixture.ctx }
  const gate = deferred()
  const entered = deferred()
  const policy = await runtimeContext.plugin(ctx => ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name === 'dsh_omo_task_join') {
      assert.equal(result.isError, false)
      assert.equal(result.value.status, 'completed')
      entered.resolve()
      await gate.promise
    }
    return decision
  }))
  t.after(async () => {
    gate.resolve()
    for (const effect of fixture.effects.reverse()) if (typeof effect.dispose === 'function') await effect.dispose()
    for (const remove of removers) if (typeof remove === 'function') remove()
    await policy.dispose()
    await runtimeFiber.dispose()
    await promptFiber.dispose()
  })
  apply(fixture.ctx, Config({ enableForegroundTaskTool: true }))
  const controller = new AbortController()
  const pending = runtimeContext.tools.execute({
    callId: 'foreground-post-materialization-abort', name: 'dsh_omo_task_join',
    arguments: { role: 'explore', task: 'Verify native final-outcome acknowledgement.' },
    agent: fixture.parent, signal: controller.signal,
  })
  await entered.promise
  assert.deepEqual(fixture.followups, [], 'captured foreground result is withheld until native final outcome')
  controller.abort()
  gate.resolve()
  const result = await pending
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'ABORTED')
  await tick()
  assert.equal(fixture.followups.filter(message => message.source?.kind === 'agent-message').length, 1)
  assert.equal(fixture.followups.filter(message => message.source?.kind !== 'agent-message').length, 1)
  assert.match(JSON.stringify(fixture.followups), /Verified specialist evidence/u)
})

async function nativePolicyHarness(t, options = {}) {
  const runtimeContext = new Context()
  const promptFiber = await runtimeContext.plugin(SystemPrompt)
  const runtimeFiber = await runtimeContext.plugin(ToolRuntime)
  const fixture = nativeContext(options)
  fixture.ctx.tools = runtimeContext.tools
  const removers = []
  fixture.ctx.on = (event, listener) => { removers.push(runtimeContext.on(event, listener)); return fixture.ctx }
  apply(fixture.ctx, Config({ enableForegroundTaskTool: true, ...options.config }))
  t.after(async () => {
    for (const effect of [...fixture.effects].reverse()) if (typeof effect.dispose === 'function') await effect.dispose()
    for (const remove of removers) if (typeof remove === 'function') remove()
    await runtimeFiber.dispose()
    await promptFiber.dispose()
  })
  return { runtimeContext, fixture }
}

test('native around-dispatch mutation during startup retains the original parent and signal', async t => {
  const startup = deferred()
  const child = deferred()
  const bFollowups = []
  const parentB = { id: 'foreground-parent-b', followup: message => bFollowups.push(message) }
  const { runtimeContext, fixture } = await nativePolicyHarness(t, {
    startGate: startup.promise, result: child.promise, additionalAgents: [parentB],
    config: { enableTaskResultTool: true },
  })
  t.after(() => { startup.resolve(); child.resolve({ stopReason: 'completed', output: [] }) })
  let mutableExec
  const policy = await runtimeContext.plugin(ctx => ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'dsh_omo_task') mutableExec = exec
    return next()
  }))
  t.after(() => policy.dispose())
  const controller = new AbortController()
  const pending = runtimeContext.tools.execute({
    callId: 'mutable-startup-parent', name: 'dsh_omo_task',
    arguments: { role: 'explore', task: 'Retain the original owner during pending startup.' },
    agent: fixture.parent, signal: controller.signal,
  })
  await tick()
  assert.ok(mutableExec, 'native tools/execute middleware receives the dispatch envelope')
  assert.equal(fixture.starts.length, 1)
  assert.equal(fixture.starts[0].request.parent, fixture.parent)
  const replacement = new AbortController()
  replacement.abort()
  mutableExec.agent = parentB
  mutableExec.signal = replacement.signal
  startup.resolve()
  const started = await pending
  assert.equal(started.isError, false)
  assert.equal(started.value.resultTracked, true)
  assert.equal(fixture.starts[0].request.parent, fixture.parent)
  assert.equal(fixture.starts[0].signal.aborted, false, 'replacement signal must not cancel startup')
  child.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'OWNER A PRIVATE EVIDENCE' }] })
  await tick()
  assert.match(JSON.stringify(fixture.followups), /OWNER A PRIVATE EVIDENCE/u)
  assert.deepEqual(bFollowups, [])
  const resultTool = runtimeContext.tools.get('dsh_omo_task_result', fixture.parent)
  const owned = await resultTool.execute({ childId: started.value.childId }, { agent: fixture.parent })
  assert.equal(owned.output, 'OWNER A PRIVATE EVIDENCE')
  await assert.rejects(
    resultTool.execute({ childId: started.value.childId }, { agent: parentB }),
    error => /No unexpired dsh-omo result/u.test(error.message) && !error.message.includes('OWNER A PRIVATE EVIDENCE'),
  )
})

test('native maxPendingTasks queues foreground calls, enforces capacity, and cancels before child launch', async t => {
  const children = []
  const controller = new AbortController()
  t.after(() => {
    controller.abort()
    for (const child of children) child.resolve({ stopReason: 'completed', output: [] })
  })
  const { runtimeContext, fixture } = await nativePolicyHarness(t, {
    resultForStart: () => {
      const child = deferred()
      children.push(child)
      return child.promise
    },
    config: { maxConcurrent: 1, maxPendingTasks: 1 },
  })
  const call = (callId, name, signal = new AbortController().signal) => runtimeContext.tools.execute({
    callId, name, arguments: { role: 'explore', task: callId }, agent: fixture.parent, signal,
  })
  const first = await call('queue-active', 'dsh_omo_task')
  assert.equal(first.isError, false)
  assert.equal(fixture.starts.length, 1)
  const waiting = call('queue-cancelled', 'dsh_omo_task_join', controller.signal)
  assert.equal(await Promise.race([waiting.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
  const overflow = await call('queue-overflow', 'dsh_omo_task_join')
  assert.equal(overflow.isError, true)
  assert.equal(fixture.starts.length, 1)
  controller.abort()
  const cancelled = await waiting
  assert.equal(cancelled.isError, true)
  assert.doesNotMatch(JSON.stringify(cancelled), /ACTIVE CHILD EVIDENCE/u)
  assert.equal(fixture.starts.length, 1)
  assert.deepEqual(fixture.followups, [])
  const next = call('queue-next', 'dsh_omo_task_join')
  assert.equal(await Promise.race([next.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
  children[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ACTIVE CHILD EVIDENCE' }] })
  assert.equal(await Promise.race([next.then(() => 'settled'), tick().then(() => 'pending')]), 'pending', 'second child must wait for its own result')
  assert.equal(fixture.starts.length, 2, 'cancelled and overflow calls must never start children')
  assert.equal(children.length, 2)
  children[1].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'SECOND CHILD EVIDENCE' }] })
  const result = await next
  assert.equal(result.isError, false)
  assert.equal(result.value.childId, 'foreground-child-2')
  assert.equal(result.value.output, 'SECOND CHILD EVIDENCE')
  assert.doesNotMatch(JSON.stringify(result), /ACTIVE CHILD EVIDENCE/u)
  assert.doesNotMatch(JSON.stringify(cancelled), /ACTIVE CHILD EVIDENCE/u)
  assert.doesNotMatch(JSON.stringify(overflow), /ACTIVE CHILD EVIDENCE/u)
  await tick()
  assert.equal(fixture.followups.filter(message => message.source?.kind === 'agent-message').length, 1)
})

for (const oversizedTool of ['dsh_omo_task', 'dsh_omo_task_join']) {
  test(`native ${oversizedTool} rejects an oversized valid skill selector before queueing`, async t => {
    const children = []
    const controllers = []
    t.after(() => {
      for (const controller of controllers) controller.abort()
      for (const child of children) child.resolve({ stopReason: 'completed', output: [] })
    })
    const { runtimeContext, fixture } = await nativePolicyHarness(t, {
      resultForStart: () => {
        const child = deferred()
        children.push(child)
        return child.promise
      },
      config: { maxConcurrent: 1, maxPendingTasks: 1 },
    })
    const call = (callId, name, extra = {}) => {
      const controller = new AbortController()
      controllers.push(controller)
      return runtimeContext.tools.execute({
        callId, name, arguments: { role: 'explore', task: callId, ...extra },
        agent: fixture.parent, signal: controller.signal,
      })
    }
    const first = await call('skill-active', 'dsh_omo_task')
    assert.equal(first.isError, false)
    assert.equal(first.value.status, 'started')
    assert.equal(fixture.starts.length, 1)
    const oversized = 'secret-' + 'a'.repeat(33_000)
    const rejected = call('skill-oversized', oversizedTool, { load_skills: [oversized] })
    const state = await Promise.race([rejected.then(result => ({ result })), tick().then(() => ({ pending: true }))])
    assert.ok(state.result, 'oversized request must fail immediately rather than wait for global capacity')
    assert.equal(state.result.isError, true)
    assert.match(state.result.error?.message ?? '', /queue|queued|large|limit|oversiz/iu)
    assert.doesNotMatch(JSON.stringify(state.result), /secret-|a{100}/u)
    assert.equal(fixture.starts.length, 1)
    assert.equal(fixture.starts[0].signal.aborted, false, 'rejection must not cancel the active child')
    assert.deepEqual(fixture.skillReads, [])
    const next = call('skill-short', 'dsh_omo_task_join', { load_skills: ['debugging'] })
    assert.equal(await Promise.race([next.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
    assert.equal(fixture.starts.length, 1, 'short request must wait for the active child')
    children[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'FIRST SKILL QUEUE EVIDENCE' }] })
    assert.equal(await Promise.race([next.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
    assert.equal(fixture.starts.length, 2, 'short request starts after capacity is released')
    assert.deepEqual(fixture.skillReads, ['debugging'])
    assert.match(fixture.starts[1].request.prompt[0].text, /Skill evidence debugging/u)
    assert.equal(fixture.starts[1].signal.aborted, false)
    children[1].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'SECOND SKILL QUEUE EVIDENCE' }] })
    const result = await next
    assert.equal(result.isError, false)
    assert.equal(result.value.childId, 'foreground-child-2')
    assert.equal(result.value.status, 'completed')
    assert.equal(result.value.output, 'SECOND SKILL QUEUE EVIDENCE')
    assert.doesNotMatch(JSON.stringify(result), /FIRST SKILL QUEUE EVIDENCE/u)
    await tick()
    assert.match(JSON.stringify(fixture.followups), /FIRST SKILL QUEUE EVIDENCE/u)
    assert.doesNotMatch(JSON.stringify(fixture.followups), /SECOND SKILL QUEUE EVIDENCE|secret-a{100}/u)
    assert.deepEqual(fixture.disposals, [1, 2])
  })
}

for (const cancelledSignal of ['caller', 'wrapper']) {
  test(`native maxPendingTasks does not launch queued requests when the ${cancelledSignal} signal is aborted under an execute wrapper`, async t => {
    const child = deferred()
    const caller = new AbortController()
    const wrapper = new AbortController()
    t.after(() => {
      caller.abort()
      wrapper.abort()
      child.resolve({ stopReason: 'completed', output: [] })
    })
    const { runtimeContext, fixture } = await nativePolicyHarness(t, {
      result: child.promise, config: { maxConcurrent: 1, maxPendingTasks: 1 },
    })
    let entered = false
    let restored = false
    const policy = await runtimeContext.plugin(ctx => ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'dsh_omo_task_join') return next()
      const original = exec.signal
      entered = true
      exec.signal = wrapper.signal
      try {
        return await next()
      } finally {
        exec.signal = original
        restored = exec.signal === original
      }
    }))
    t.after(() => policy.dispose())
    const call = (callId, name, signal) => runtimeContext.tools.execute({
      callId, name, arguments: { role: 'explore', task: callId }, agent: fixture.parent, signal,
    })
    const first = await call('wrapped-active', 'dsh_omo_task', new AbortController().signal)
    assert.equal(first.isError, false)
    const waiting = call(`wrapped-${cancelledSignal}`, 'dsh_omo_task_join', caller.signal)
    assert.equal(await Promise.race([waiting.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
    assert.equal(entered, true)
    assert.equal(fixture.starts.length, 1)
    ;(cancelledSignal === 'caller' ? caller : wrapper).abort()
    child.resolve({ stopReason: 'completed', output: [] })
    const result = await waiting
    assert.equal(result.isError, true)
    assert.equal(fixture.starts.length, 1, 'cancelled queued request must not start a child')
    assert.equal(restored, true, 'wrapper restores the original signal in finally')
  })
}

test('native maxPendingTasks rejects a queued foreground call when its exact parent is replaced', async t => {
  const child = deferred()
  const { runtimeContext, fixture } = await nativePolicyHarness(t, {
    result: child.promise, config: { maxConcurrent: 1, maxPendingTasks: 1 },
  })
  t.after(() => child.resolve({ stopReason: 'completed', output: [] }))
  const call = (callId, name) => runtimeContext.tools.execute({
    callId, name, arguments: { role: 'explore', task: callId }, agent: fixture.parent, signal: new AbortController().signal,
  })
  assert.equal((await call('identity-active', 'dsh_omo_task')).isError, false)
  const waiting = call('identity-waiting', 'dsh_omo_task_join')
  assert.equal(await Promise.race([waiting.then(() => 'settled'), tick().then(() => 'pending')]), 'pending')
  const replacementFollowups = []
  fixture.replaceParent({ id: fixture.parent.id, followup: message => replacementFollowups.push(message) })
  child.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PRIVATE OLD PARENT EVIDENCE' }] })
  await tick()
  const state = await Promise.race([waiting.then(result => ({ result })), tick().then(() => ({ pending: true }))])
  assert.ok(state.result, 'released capacity must promptly revalidate the queued parent, not time out')
  assert.equal(state.result.isError, true)
  assert.match(state.result.error?.message ?? '', /parent|agent|live|stale/iu)
  assert.equal(fixture.starts.length, 1, 'stale parent cannot start a child after admission')
  assert.doesNotMatch(JSON.stringify(state.result), /PRIVATE OLD PARENT EVIDENCE/u)
  await tick()
  assert.deepEqual(replacementFollowups, [])
})

for (const abortAtPolicy of [false, true]) {
test(`native post-execute policy block suppresses original result and relay (caller abort at policy=${abortAtPolicy})`, async t => {
  const controller = new AbortController()
  const { runtimeContext, fixture } = await nativePolicyHarness(t, {
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ORIGINAL SENSITIVE CHILD EVIDENCE' }] }),
  })
  const policy = await runtimeContext.plugin(ctx => ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'dsh_omo_task_join') return decision
    assert.equal(result.isError, false)
    assert.match(result.value.output, /ORIGINAL SENSITIVE/u)
    assert.deepEqual(fixture.followups, [], 'original output must remain held before final policy outcome')
    if (abortAtPolicy) controller.abort()
    return { kind: 'block', feedback: [{ type: 'text', text: 'Sensitive child result blocked by native policy.' }] }
  }))
  t.after(() => policy.dispose())
  const result = await runtimeContext.tools.execute({
    callId: 'foreground-native-sensitive-block', name: 'dsh_omo_task_join',
    arguments: { role: 'explore', task: 'A native policy must retain authority over foreground output.' },
    agent: fixture.parent, signal: controller.signal,
  })
  assert.equal(result.isError, true)
  assert.notEqual(result.error?.info?.code, 'ABORTED')
  t.diagnostic(`Native policy block final code: ${result.error?.info?.code}`)
  assert.doesNotMatch(JSON.stringify(result), /ORIGINAL SENSITIVE/u)
  await tick()
  assert.deepEqual(fixture.followups, [], 'blocked original must not escape through background notice or relay')
})
}

test('native caller abort while join body awaits child is classified ABORTED and relays only after final outcome', async t => {
  const child = deferred()
  const { runtimeContext, fixture } = await nativePolicyHarness(t, { result: child.promise })
  const controller = new AbortController()
  const pending = runtimeContext.tools.execute({
    callId: 'foreground-native-body-abort', name: 'dsh_omo_task_join',
    arguments: { role: 'explore', task: 'Check canonical native body cancellation classification.' },
    agent: fixture.parent, signal: controller.signal,
  })
  await tick()
  assert.equal(fixture.starts.length, 1)
  controller.abort()
  const result = await pending
  assert.equal(result.isError, true)
  t.diagnostic(`Native join-body abort final outcome: ${JSON.stringify(result)}`)
  assert.equal(result.error?.info?.code, 'ABORTED')
  assert.equal(fixture.starts[0].signal.aborted, false, 'accepted child continues independently of wait cancellation')
  child.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Late evidence after canonical body abort.' }] })
  await tick()
  assert.equal(fixture.followups.filter(message => message.source?.kind === 'agent-message').length, 1)
  assert.equal(fixture.followups.filter(message => message.source?.kind !== 'agent-message').length, 1)
})

test('enabling foreground joining leaves ordinary asynchronous task result delivery unchanged', async () => {
  const pending = deferred()
  const fixture = nativeContext({ result: pending.promise })
  mount(fixture)
  const value = await execute(fixture, fixture.tools.get('dsh_omo_task'))
  assert.equal(value.status, 'started')
  pending.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Ordinary background evidence.' }] })
  await tick()
  assert.equal(fixture.followups.filter(message => message.source?.kind === 'agent-message').length, 1)
})
