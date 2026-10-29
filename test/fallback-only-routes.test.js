import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'

const chain = [1, 2, 3].map(index => ({ provider: `provider-${index}`, model: `model-${index}` }))
const tick = () => new Promise(resolve => setImmediate(resolve))

// Deliberately exercise the current Host activation seam, not legacy start().
function makeContext(resolveCallConfig, { holdResults = false } = {}) {
  const tools = new Map()
  const starts = []
  const completions = []
  const effects = []
  const ctx = {
    get: key => key === 'llm' && resolveCallConfig ? { resolveCallConfig } : undefined,
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get() {} },
    subagents: {
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => {
        starts.push(spec)
        const result = holdResults ? new Promise(resolve => completions.push(resolve)) : Promise.resolve({ stopReason: 'completed', output: [] })
        return { childId: `child-${starts.length}`, result, dispose: async () => {} }
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    on() { return ctx },
    effect(execute) { const dispose = execute(); effects.push(dispose); return dispose },
    logger: { warn() {} },
  }
  return { ctx, tools, starts, completions, effects }
}
function mount(fixture, overrides = {}) {
  // Exercise the real Loader schema, including optional-array omission semantics.
  apply(fixture.ctx, Config({ maxConcurrent: 4, roleRoutes: [{ role: 'explore', fallbackModels: chain }], ...overrides }))
  return fixture.tools.get('dsh_omo_task')
}
function execute(tool, args = {}, signal = new AbortController().signal) {
  return tool.execute({ role: 'explore', task: 'Choose one explicit fallback-only role route.', ...args }, { agent: { id: 'parent', followup() {} }, signal })
}

for (let selected = 0; selected < chain.length; selected += 1) {
  test(`fallback-only role selects candidate ${selected + 1} with exact modern activation options`, async () => {
    const calls = []
    const fixture = makeContext(async config => {
      calls.push(config)
      if (config.provider !== chain[selected].provider) throw new Error('unavailable')
      return config
    })
    const tool = mount(fixture)
    await execute(tool)
    assert.deepEqual(calls, chain.slice(0, selected + 1))
    assert.equal(fixture.starts.length, 1)
    assert.deepEqual(fixture.starts[0].request.agentOptions, chain[selected])
    assert.equal(fixture.starts[0].delivery, 'caller')
    assert.equal(fixture.starts[0].provider, 'spawn')
    await tick()
  })
}

test('fallback-only role fails closed when every explicit candidate fails', async () => {
  const calls = []
  const fixture = makeContext(async config => { calls.push(config); throw new Error('private backend details') })
  const tool = mount(fixture)
  await assert.rejects(execute(tool), error => !error.message.includes('private backend details'))
  assert.deepEqual(calls, chain)
  assert.equal(fixture.starts.length, 0)
})

test('fallback-only role cannot launch without the Host route resolver', async () => {
  const fixture = makeContext()
  const tool = mount(fixture)
  await assert.rejects(execute(tool), /resolveCallConfig|resolver|preflight|LLM/iu)
  assert.equal(fixture.starts.length, 0)
})

test('fallback-only role rejects default-category and explicit task-category ambiguity', async () => {
  const categoryRoutes = [{ name: 'research', provider: 'category-provider', model: 'category-model' }]
  const fixture = makeContext(async config => config)
  assert.throws(() => mount(fixture, { categoryRoutes, roleRoutes: [{ role: 'explore', category: 'research', fallbackModels: chain }] }), /category/iu)
  const other = makeContext(async () => { assert.fail('category conflict must reject before route resolution') })
  const tool = mount(other, { categoryRoutes })
  await assert.rejects(execute(tool, { category: 'research' }), /category/iu)
  assert.equal(other.starts.length, 0)
})

test('fallback-only role rejects empty chains, partial primary pins, malformed and duplicate candidates', () => {
  for (const route of [
    { fallbackModels: [] },
    { provider: 'partial', fallbackModels: chain },
    { model: 'partial', fallbackModels: chain },
    { fallbackModels: [{ provider: 'missing-model' }] },
    { fallbackModels: [...chain, { provider: 'fourth', model: 'fourth' }] },
    { fallbackModels: [chain[0], chain[0]] },
  ]) {
    const fixture = makeContext(async config => config)
    assert.throws(() => mount(fixture, { roleRoutes: [{ role: 'explore', ...route }] }))
    assert.equal(fixture.starts.length, 0)
  }
})

test('fallback-only alias targets cannot collapse distinct candidates into a duplicate pair', () => {
  const fixture = makeContext(async config => config)
  assert.throws(() => mount(fixture, {
    enableRoleCategoryRouteAliases: true,
    roleCategoryRouteAliases: [{ from: chain[0], to: chain[1] }],
    roleRoutes: [{ role: 'explore', fallbackModels: chain.slice(0, 2) }],
  }), /duplicate/iu)
  assert.equal(fixture.starts.length, 0)
})

test('real Config preserves omitted role arrays but retains an explicit empty allowlist', async () => {
  const route = Config({ roleRoutes: [{ role: 'explore', reasoningEffort: 'low' }] }).roleRoutes[0]
  assert.equal(route.fallbackModels, undefined)
  assert.equal(route.allowTools, undefined)
  assert.equal(route.denyTools, undefined)
  const explicit = Config({ roleRoutes: [{ role: 'explore', allowTools: [] }] }).roleRoutes[0]
  assert.deepEqual(explicit.allowTools, [])
  const fixture = makeContext(async () => { assert.fail('no candidate chain should be probed') })
  const tool = mount(fixture, { roleRoutes: [{ role: 'explore', allowTools: [] }] })
  await assert.rejects(execute(tool), /tool filter/iu)
  assert.equal(fixture.starts.length, 0)
})

test('a full-schema pinned role without fallback or filters remains launchable', async () => {
  const fixture = makeContext(async () => { assert.fail('ordinary pinned route preflight stays opt-in') })
  const tool = mount(fixture, { roleRoutes: [{ role: 'explore', ...chain[0] }] })
  await execute(tool)
  assert.deepEqual(fixture.starts[0].request.agentOptions, chain[0])
  await tick()
})

test('a role without any route still inherits rather than invoking the resolver', async () => {
  const fixture = makeContext(async () => { assert.fail('unconfigured role must inherit') })
  const tool = mount(fixture, { roleRoutes: [] })
  await execute(tool)
  assert.equal(fixture.starts.length, 1)
  assert.equal(fixture.starts[0].request.agentOptions, undefined)
  await tick()
})

test('an explicit pinned role still wins over its category fallback chain', async () => {
  const calls = []
  const fixture = makeContext(async config => { calls.push(config); return config })
  const tool = mount(fixture, {
    categoryRoutes: [{ name: 'research', provider: 'category', model: 'category-model', fallbackModels: [chain[2]] }],
    roleRoutes: [{ role: 'explore', ...chain[0], fallbackModels: [chain[1]] }],
  })
  await execute(tool, { category: 'research' })
  assert.deepEqual(calls, [chain[0]])
  assert.deepEqual(fixture.starts[0].request.agentOptions, chain[0])
  await tick()
})

test('role reasoning overrides candidate reasoning while selected candidate tokens override role tokens', async () => {
  const calls = []
  const fixture = makeContext(async config => { calls.push(config); return { ...config, reasoningEffort: 'materialized-default' } })
  const tool = mount(fixture, { roleRoutes: [{
    role: 'explore', reasoningEffort: 'medium', maxTokens: 1024,
    fallbackModels: [{ ...chain[0], reasoningEffort: 'low', maxTokens: 512 }],
  }] })
  await execute(tool)
  const expected = { ...chain[0], reasoningEffort: 'medium', maxTokens: 512 }
  assert.deepEqual(calls, [expected])
  assert.deepEqual(fixture.starts[0].request.agentOptions, expected)
  await tick()
})

test('caller cancellation during fallback preflight cannot cause a late spawn', async () => {
  let release
  let entered
  const called = new Promise(resolve => { entered = resolve })
  const controller = new AbortController()
  const fixture = makeContext(config => { entered(); return new Promise(resolve => { release = () => resolve(config) }) })
  const tool = mount(fixture)
  const pending = execute(tool, {}, controller.signal)
  const rejected = assert.rejects(pending, /cancel|abort/iu)
  await called
  controller.abort()
  await rejected
  release()
  await tick()
  assert.equal(fixture.starts.length, 0)
})

test('new fallback-only chain has one aggregate five-second deadline and no late spawn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const fixture = makeContext((config, signal) => new Promise((resolve, reject) => {
    calls.push({ config, signal, resolve, reject })
  }))
  const tool = mount(fixture)
  const pending = execute(tool)
  const rejected = assert.rejects(pending, /timeout|timed out|deadline|preflight|fallback/iu)
  await tick()
  t.mock.timers.tick(3000)
  calls[0].reject(new Error('private first failure'))
  await tick()
  assert.equal(calls.length, 2)
  t.mock.timers.tick(2000)
  await rejected
  assert.equal(calls.length, 2, 'the shared deadline must not try the third candidate')
  assert.ok(calls.every(call => call.signal.aborted))
  calls[1].resolve(chain[1])
  await tick()
  assert.equal(fixture.starts.length, 0)
})

test('unsettled Host calls share the 64-call gate across one-shot and continuable routes', async () => {
  const calls = []
  const fixture = makeContext((config, signal) => new Promise((resolve, reject) => {
    calls.push({ config, signal, resolve, reject })
  }))
  fixture.ctx.subagents.getProvider = () => ({
    name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
    prepareContinuable() {},
  })
  const continuableStarts = []
  fixture.ctx.subagents.startContinuable = async spec => {
    continuableStarts.push(spec)
    return { childId: 'continuable-child', messageId: 'message' }
  }
  const oneShot = mount(fixture, {
    enableContinuableTasks: true,
    roleRoutes: [
      { role: 'explore', fallbackModels: chain },
      { role: 'quick', ...chain[0], fallbackModels: chain.slice(1) },
    ],
  })
  const continuable = fixture.tools.get('dsh_omo_task_continuable')
  assert.ok(continuable)
  const controllers = Array.from({ length: 64 }, () => new AbortController())
  const first = controllers.slice(0, 4).map(controller => execute(oneShot, {}, controller.signal))
  const firstCancelled = first.map(promise => assert.rejects(promise, /cancel|abort/iu))
  await tick()
  assert.equal(calls.length, 4)
  controllers.slice(0, 4).forEach(controller => controller.abort())
  await Promise.all(firstCancelled)
  const rest = controllers.slice(4).map(controller => execute(continuable, {}, controller.signal))
  const restCancelled = rest.map(promise => assert.rejects(promise, /cancel|abort/iu))
  await tick()
  assert.equal(calls.length, 64)
  assert.ok(calls.every(call => call.config.provider === chain[0].provider))
  assert.ok(calls.slice(4).every(call => !call.signal.aborted))

  for (const tool of [oneShot, continuable]) {
    for (const role of ['explore', 'quick']) {
      await assert.rejects(execute(tool, { role }), /preflight is busy.*64/iu)
      assert.equal(calls.length, 64, 'busy must not probe any later candidate')
    }
  }
  controllers.forEach(controller => controller.abort())
  await Promise.all(restCancelled)
  assert.ok(calls.every(call => call.signal.aborted))
  await assert.rejects(execute(oneShot), /preflight is busy.*64/iu)
  assert.equal(calls.length, 64, 'cancellation alone does not release a Host-call lease')

  calls[0].resolve(chain[0])
  await tick()
  const next = execute(continuable, { role: 'quick' })
  await tick()
  assert.equal(calls.length, 65, 'late Host settlement releases exactly one lease')
  await assert.rejects(execute(oneShot), /preflight is busy.*64/iu)
  calls[64].resolve(chain[0])
  await next
  assert.equal(continuableStarts.length, 1)
  assert.deepEqual(continuableStarts[0].request.agentOptions, chain[0])
  assert.equal(fixture.starts.length, 0, 'cancelled preflights must never spawn late')
  calls.slice(1, 64).forEach(call => call.reject(new Error('late private failure')))
  await tick()
})

for (const pinned of [false, true]) {
  test(`a Host-replayed route gate busy error advances ${pinned ? 'pinned' : 'fallback-only'} candidates`, async () => {
    const calls = []
    let replay
    const fixture = makeContext((config, signal) => {
      if (replay) {
        calls.push({ config, signal })
        if (config.provider === chain[0].provider) throw replay
        return config
      }
      return new Promise(resolve => calls.push({ config, signal, resolve }))
    })
    const tool = mount(fixture, { roleRoutes: [{ role: 'explore', ...(pinned ? chain[0] : {}), fallbackModels: pinned ? chain.slice(1) : chain }] })
    const controllers = []
    const pending = []
    try {
      for (let batch = 0; batch < 16; batch += 1) {
        const group = Array.from({ length: 4 }, () => {
          const controller = new AbortController()
          controllers.push(controller)
          const result = execute(tool, {}, controller.signal)
          pending.push(result)
          return { controller, rejected: assert.rejects(result, /cancel|abort/iu) }
        })
        await tick()
        group.forEach(({ controller }) => controller.abort())
        await Promise.all(group.map(({ rejected }) => rejected))
      }
      assert.equal(calls.length, 64)
      await assert.rejects(execute(tool), error => {
        assert.match(error.message, /preflight is busy.*64/iu)
        replay = error
        return true
      })
      assert.equal(calls.length, 64, 'a full gate must not invoke the resolver')
      calls[0].resolve(chain[0])
      await tick()
      await execute(tool)
      assert.deepEqual(calls.slice(64).map(call => call.config), chain.slice(0, 2))
      assert.deepEqual(fixture.starts[0].request.agentOptions, chain[1])
      assert.equal(fixture.starts.length, 1)
    } finally {
      controllers.forEach(controller => controller.abort())
      calls.forEach(call => call.resolve?.(call.config))
      await Promise.allSettled(pending)
      await tick()
    }
  })
}

test('Host status and TypeError failures remain ordinary candidate failures', async () => {
  const failures = [Object.assign(new Error('private status'), { status: 429 }), new TypeError('private type')]
  const calls = []
  const fixture = makeContext(async config => {
    calls.push(config)
    if (calls.length <= failures.length) throw failures[calls.length - 1]
    return config
  })
  const tool = mount(fixture)
  await execute(tool)
  assert.deepEqual(calls, chain)
  assert.deepEqual(fixture.starts[0].request.agentOptions, chain[2])
  await tick()
})

test('preset preflight leases are shared by one-shot and legacy continuable calls until Host settlement', async () => {
  const calls = []
  const fixture = makeContext()
  const originalGet = fixture.ctx.get
  fixture.ctx.get = key => key === 'agentPresets'
    ? { resolve: id => new Promise((resolve, reject) => calls.push({ id, resolve, reject })) }
    : originalGet(key)
  fixture.ctx.subagents.getProvider = () => ({
    name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
    prepareContinuable() {},
  })
  const continuableStarts = []
  fixture.ctx.subagents.startContinuable = async spec => {
    continuableStarts.push(spec)
    return { childId: 'continuable-child', messageId: 'message' }
  }
  const oneShot = mount(fixture, {
    enableContinuableTasks: true,
    enableAgentPresetPreflight: true,
    roleRoutes: [{ role: 'explore', agentPreset: 'test-preset' }],
  })
  const continuable = fixture.tools.get('dsh_omo_task_continuable')
  assert.ok(continuable)
  const controllers = []
  const pending = []
  function launch(tool) {
    const controller = new AbortController()
    controllers.push(controller)
    const result = execute(tool, {}, controller.signal)
    // Always observe rejections, including on an assertion failure.
    result.catch(() => {})
    pending.push(result)
    return { controller, result }
  }
  try {
    const first = Array.from({ length: 4 }, () => launch(oneShot))
    await tick()
    assert.equal(calls.length, 4)
    first.forEach(({ controller }) => controller.abort())
    await Promise.all(first.map(({ result }) => assert.rejects(result, /cancel|abort/iu)))
    const rest = Array.from({ length: 60 }, () => launch(continuable))
    await tick()
    assert.equal(calls.length, 64)
    rest.forEach(({ controller }) => controller.abort())
    await Promise.all(rest.map(({ result }) => assert.rejects(result, /cancel|abort/iu)))

    let realBusy
    for (const tool of [oneShot, continuable]) {
      const busy = launch(tool)
      await tick()
      assert.equal(calls.length, 64, 'cancelled but unsettled Host calls retain all preset leases')
      const failure = await busy.result.then(() => undefined, error => error)
      assert.match(failure?.message ?? '', /preflight.*busy|busy.*preflight/iu)
      realBusy ??= failure
    }
    assert.ok(calls.every(call => call.id === 'test-preset'))
    calls[0].resolve({ id: 'test-preset' })
    await tick()
    const replayed = launch(oneShot)
    await tick()
    assert.equal(calls.length, 65, 'settlement releases exactly one shared lease')
    calls[64].reject(realBusy)
    await assert.rejects(replayed.result, error => {
      assert.match(error.message, /agentPreset could not be resolved/u)
      assert.doesNotMatch(error.message, /preflight.*busy/iu)
      return true
    })
    const recovered = launch(continuable)
    await tick()
    assert.equal(calls.length, 66, 'replayed Host failure releases its own lease')
    const busyAgain = launch(oneShot)
    await tick()
    assert.equal(calls.length, 66)
    await assert.rejects(busyAgain.result, /preflight.*busy|busy.*preflight/iu)
    calls[65].resolve({ id: 'test-preset' })
    await recovered.result
    assert.equal(continuableStarts.length, 1)
    assert.equal(continuableStarts[0].request.agentPreset, 'test-preset')
  } finally {
    controllers.forEach(controller => controller.abort())
    calls.forEach(call => call.resolve({ id: 'test-preset' }))
    await Promise.allSettled(pending)
    await tick()
  }
  assert.equal(fixture.starts.length, 0, 'cancelled preflights never spawn after late settlement')
  assert.equal(continuableStarts.length, 1, 'late settlements never spawn cancelled continuable calls')
})

test('ordinary resolver errors are filtered and advance with a live preflight signal', async () => {
  const calls = []
  const fixture = makeContext(async (config, signal) => {
    calls.push({ config, signal })
    if (config.provider === chain[0].provider) throw new Error('private backend details')
    return config
  })
  const controller = new AbortController()
  const tool = mount(fixture, { roleRoutes: [{ role: 'explore', ...chain[0], fallbackModels: chain.slice(1) }] })
  await execute(tool, {}, controller.signal)
  assert.deepEqual(calls.map(call => call.config), chain.slice(0, 2))
  assert.ok(calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted))
  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(fixture.starts[0].request.agentOptions, chain[1])
  await tick()
})

test('concurrent fallback-only launches reserve concurrency on the selected candidate pair', async () => {
  const preflights = []
  const fixture = makeContext(config => {
    if (config.provider === chain[0].provider) return Promise.reject(new Error('unavailable'))
    return new Promise(resolve => preflights.push(() => resolve(config)))
  }, { holdResults: true })
  const tool = mount(fixture, { modelConcurrency: { 'provider-1/model-1': 0, 'provider-2/model-2': 1 } })
  const first = execute(tool)
  const second = execute(tool)
  await tick()
  assert.equal(preflights.length, 2)
  for (const release of preflights) release()
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
  assert.ok(outcomes.some(value => value.status === 'rejected' && /concurrency/iu.test(value.reason.message)))
  assert.equal(fixture.starts.length, 1)
  assert.deepEqual(fixture.starts[0].request.agentOptions, chain[1])
  fixture.completions[0]({ stopReason: 'completed', output: [] })
  await tick()
})
