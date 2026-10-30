import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { canonicalCallSignature, createRepeatedCallAdvisory } from '../src/repeated-call-advisory.js'

function makeHarness() {
  const live = new Map()
  const agents = { get: id => live.get(id) }
  const feature = createRepeatedCallAdvisory(agents)
  return { live, feature }
}

function makeExec(agent, args = { path: 'src/a.js' }, overrides = {}) {
  return {
    token: Symbol('call'),
    name: 'read',
    arguments: args,
    parent: undefined,
    agent,
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function complete(feature, exec, { decision, result, preDecision = { kind: 'allow' }, duringNext } = {}) {
  let preNextCalls = 0
  const returnedPre = await feature.preExecute(exec, async () => {
    preNextCalls += 1
    return preDecision
  })
  assert.strictEqual(returnedPre, preDecision)
  assert.equal(preNextCalls, 1)
  let postNextCalls = 0
  const finalDecision = decision ?? { kind: 'accept', value: { ok: true } }
  const returned = await feature.listener(exec, result ?? { isError: false }, async () => {
    postNextCalls += 1
    duringNext?.()
    return finalDecision
  })
  assert.equal(postNextCalls, 1)
  return { returned, finalDecision }
}

function warningCount(result) {
  return result.additionalContexts?.filter(context => context.content?.[0]?.text?.includes('DSH repeated Tool call advisory')).length ?? 0
}

test('canonical signatures are deterministic for nested key order and sensitive to semantic changes', () => {
  const first = {
    path: 'src/a.js',
    options: { offset: 1, filters: [{ glob: '*.js', flags: { ignored: false } }], enabled: true },
    nothing: null,
  }
  const second = {
    nothing: null,
    options: { enabled: true, filters: [{ flags: { ignored: false }, glob: '*.js' }], offset: 1 },
    path: 'src/a.js',
  }
  assert.equal(canonicalCallSignature('read', first), canonicalCallSignature('read', second))
  assert.match(canonicalCallSignature('read', first), /^[a-f0-9]{64}$/u)
  assert.notEqual(canonicalCallSignature('read', first), canonicalCallSignature('write', first))
  assert.notEqual(canonicalCallSignature('read', first), canonicalCallSignature('read', { ...second, path: 'src/b.js' }))
  assert.notEqual(canonicalCallSignature('read', [1, 2]), canonicalCallSignature('read', [2, 1]))
  assert.equal(canonicalCallSignature('read', Object.assign(Object.create(null), { b: 2, a: 1 })), canonicalCallSignature('read', { a: 1, b: 2 }))
  const shared = { value: 1 }
  assert.equal(canonicalCallSignature('read', { a: shared, b: shared }), canonicalCallSignature('read', { a: { value: 1 }, b: { value: 1 } }))
  Object.prototype.inheritedProbe = 7
  try {
    assert.notEqual(canonicalCallSignature('read', {}), canonicalCallSignature('read', { inheritedProbe: 7 }))
    assert.equal(canonicalCallSignature('read', Object.create({ inherited: 3 })), undefined)
  } finally {
    delete Object.prototype.inheritedProbe
  }
  assert.equal(canonicalCallSignature('read', Object.create({ [Symbol.toStringTag]: 'Date' })), undefined)
  const taggedDate = new Date(0)
  taggedDate[Symbol.toStringTag] = 'Object'
  assert.equal(canonicalCallSignature('read', taggedDate), undefined)
  assert.notEqual(canonicalCallSignature('read', taggedDate), canonicalCallSignature('read', {}))
})

test('canonicalization skips ambiguous, hostile, or over-budget arguments without truncation collisions', () => {
  const cyclic = { value: 1 }
  cyclic.self = cyclic
  const deep = { value: 1 }
  let cursor = deep
  for (let index = 0; index < 20; index += 1) {
    cursor.next = {}
    cursor = cursor.next
  }
  const throwing = { get value() { throw new Error('private getter') } }
  for (const args of [cyclic, deep, throwing, new Date(), 1n, () => {}, Symbol('x'), NaN, Infinity,
    'x'.repeat(2_049), Array.from({ length: 257 }, () => 1),
    Array.from({ length: 12 }, () => 'x'.repeat(2_048))]) {
    assert.equal(canonicalCallSignature('read', args), undefined)
  }
  assert.equal(canonicalCallSignature('bad\u202ename', {}), undefined)
  assert.equal(canonicalCallSignature('', {}), undefined)
  assert.equal(canonicalCallSignature('x'.repeat(257), {}), undefined)

  let descriptorReads = 0
  const wide = new Proxy({}, {
    ownKeys() {
      descriptorReads += 1
      return Array.from({ length: 1_000 }, (_value, index) => `key-${index}`)
    },
    getOwnPropertyDescriptor() {
      descriptorReads += 1
      return { enumerable: true, configurable: true }
    },
  })
  assert.equal(canonicalCallSignature('read', wide), undefined)
  assert.ok(descriptorReads < 600, `wide input must stop near the node budget, observed ${descriptorReads} descriptor reads`)
})

test('warns once at the third consecutive identical completed call and preserves downstream decisions', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'agent-one' }
  live.set(agent.id, agent)
  const secret = 'private-argument-must-not-be-echoed'
  const args = { path: secret, options: { offset: 0 } }

  for (let index = 0; index < 2; index += 1) {
    const { returned, finalDecision } = await complete(feature, makeExec(agent, args), { result: { isError: index === 1 } })
    assert.strictEqual(returned, finalDecision)
    assert.equal(warningCount(returned), 0)
  }

  const prior = { role: 'user', content: [{ type: 'text', text: 'prior context' }] }
  const content = [{ type: 'text', text: 'native content' }]
  const { returned } = await complete(feature, makeExec(agent, args), {
    decision: { kind: 'accept', content, additionalContexts: [prior], marker: 'preserved' },
  })
  assert.strictEqual(returned.content, content)
  assert.equal(returned.marker, 'preserved')
  assert.strictEqual(returned.additionalContexts[0], prior)
  assert.equal(warningCount(returned), 1)
  const text = returned.additionalContexts[1].content[0].text
  assert.match(text, /completed 3 consecutive times with identical arguments/u)
  assert.match(text, /not proof of no progress/u)
  assert.match(text, /deliberate polling may continue/u)
  assert.equal(text.includes(secret), false)

  const fourth = await complete(feature, makeExec(agent, args))
  assert.equal(warningCount(fourth.returned), 0, 'the soft warning fires once per identical run')
  const fifth = await complete(feature, makeExec(agent, args))
  assert.equal(warningCount(fifth.returned), 0, 'there is no copied hard escalation')
  feature.dispose()
})

test('changed names or arguments reset the run and legitimate non-consecutive repeats do not warn', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'agent-reset' }
  live.set(agent.id, agent)
  const a = makeExec(agent, { path: 'a' })
  const b = makeExec(agent, { path: 'b' })
  const other = makeExec(agent, { path: 'a' }, { name: 'grep' })
  for (const exec of [a, a, b, a, other, a, a]) {
    const { returned } = await complete(feature, exec)
    assert.equal(warningCount(returned), 0)
  }
  const final = await complete(feature, makeExec(agent, { path: 'a' }))
  assert.equal(warningCount(final.returned), 1)
  feature.dispose()
})

test('nested, stale, canceled, blocked, and malformed positions never produce a warning', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'agent-gates' }
  const cases = [
    makeExec(agent, {}, { parent: Symbol('parent') }),
    makeExec(agent, {}, { name: 'bad\u202ename' }),
    makeExec(agent, {}, { token: 'not-a-symbol' }),
    makeExec(agent, {}, { signal: undefined }),
  ]
  for (const exec of cases) {
    for (let index = 0; index < 3; index += 1) {
      const { returned, finalDecision } = await complete(feature, exec)
      assert.strictEqual(returned, finalDecision)
    }
  }

  const stale = { id: 'stale' }
  live.set(stale.id, { id: stale.id })
  for (let index = 0; index < 3; index += 1) {
    assert.equal(warningCount((await complete(feature, makeExec(stale))).returned), 0)
  }

  live.set(agent.id, agent)
  const controller = new AbortController()
  const canceled = makeExec(agent, {}, { signal: controller.signal })
  await feature.preExecute(canceled, async () => ({ kind: 'allow' }))
  controller.abort()
  assert.equal(warningCount((await complete(feature, canceled)).returned), 0)

  for (let index = 0; index < 3; index += 1) {
    const blocked = await complete(feature, makeExec(agent), { decision: { kind: 'block', feedback: [] } })
    assert.strictEqual(blocked.returned, blocked.finalDecision)
  }
  feature.dispose()
})

test('invalid tokens never install abort listeners or count completions', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'invalid-token' }
  live.set(agent.id, agent)
  const controller = new AbortController()
  const originalAdd = controller.signal.addEventListener.bind(controller.signal)
  let adds = 0
  controller.signal.addEventListener = (...args) => { adds += 1; return originalAdd(...args) }
  const exec = makeExec(agent, {}, { token: 'not-a-symbol', signal: controller.signal })
  const decision = { kind: 'allow' }
  assert.strictEqual(await feature.preExecute(exec, async () => decision), decision)
  assert.equal(adds, 0)
  assert.equal(warningCount((await complete(feature, exec)).returned), 0)
  feature.dispose()
})

test('unsupported or untracked completed calls reset rather than bridging identical runs', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'agent-unsupported' }
  live.set(agent.id, agent)
  for (let index = 0; index < 2; index += 1) await complete(feature, makeExec(agent))
  const cyclic = {}
  cyclic.self = cyclic
  for (let index = 0; index < 3; index += 1) await complete(feature, makeExec(agent, cyclic))
  for (let index = 0; index < 2; index += 1) {
    assert.equal(warningCount((await complete(feature, makeExec(agent))).returned), 0)
  }
  assert.equal(warningCount((await complete(feature, makeExec(agent))).returned), 1)
  feature.dispose()
})

test('parallel completions use completion order and cannot corrupt per-Agent runs', async () => {
  const { live, feature } = makeHarness()
  const first = { id: 'agent-first' }
  const second = { id: 'agent-second' }
  live.set(first.id, first)
  live.set(second.id, second)
  const firstCalls = [makeExec(first), makeExec(first), makeExec(first)]
  const secondCalls = [makeExec(second, { path: 'other' }), makeExec(second, { path: 'other' })]
  for (const exec of [...firstCalls, ...secondCalls]) await feature.preExecute(exec, async () => ({ kind: 'allow' }))

  assert.equal(warningCount((await complete(feature, firstCalls[2])).returned), 0)
  assert.equal(warningCount((await complete(feature, secondCalls[0])).returned), 0)
  assert.equal(warningCount((await complete(feature, firstCalls[0])).returned), 0)
  assert.equal(warningCount((await complete(feature, secondCalls[1])).returned), 0)
  assert.equal(warningCount((await complete(feature, firstCalls[1])).returned), 1)
  feature.dispose()
})

test('result notification before post-execute only cleans pending state without counting a completion', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'result-before-post' }
  live.set(agent.id, agent)
  const exec = makeExec(agent)
  await feature.preExecute(exec, async () => ({ kind: 'allow' }))
  feature.onResult(exec)
  const { returned } = await complete(feature, makeExec(agent))
  assert.equal(warningCount(returned), 0, 'a result observer cannot create an accepted completion before post-execute')
  assert.equal(warningCount((await complete(feature, makeExec(agent))).returned), 0)
  assert.equal(warningCount((await complete(feature, makeExec(agent))).returned), 1)
  feature.dispose()
})

test('same-ID replacement starts fresh and late old-Agent disposal preserves its state', async () => {
  const { live, feature } = makeHarness()
  const oldAgent = { id: 'reused-id' }
  live.set(oldAgent.id, oldAgent)
  for (let index = 0; index < 2; index += 1) await complete(feature, makeExec(oldAgent))

  const replacement = { id: oldAgent.id }
  live.set(replacement.id, replacement)
  for (let index = 0; index < 2; index += 1) {
    assert.equal(warningCount((await complete(feature, makeExec(replacement))).returned), 0)
  }
  feature.clearAgent(oldAgent)
  assert.equal(warningCount((await complete(feature, makeExec(replacement))).returned), 1)
  for (let index = 0; index < 2; index += 1) {
    assert.equal(warningCount((await complete(feature, makeExec(oldAgent))).returned), 0)
  }
  feature.dispose()
})

test('clearAgent removes pending abort listeners even when the Agent ID becomes unreadable', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'unreadable-id' }
  live.set(agent.id, agent)
  const controller = new AbortController()
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal)
  let removals = 0
  controller.signal.removeEventListener = (...args) => {
    removals += 1
    return originalRemove(...args)
  }
  const exec = makeExec(agent, {}, { signal: controller.signal })
  await feature.preExecute(exec, async () => ({ kind: 'allow' }))
  Object.defineProperty(agent, 'id', { get() { throw new Error('private id failure') } })
  assert.doesNotThrow(() => feature.clearAgent(agent))
  assert.equal(removals, 1, 'pending abort listeners must be removed before reading a hostile Agent ID')
  feature.dispose()
  assert.equal(removals, 1, 'the pending entry must not remain for global disposal')
})

test('unreadable old Agent ID does not leak state into a same-ID replacement', async () => {
  const { live, feature } = makeHarness()
  const oldAgent = { id: 'replacement-after-error' }
  live.set(oldAgent.id, oldAgent)
  for (let index = 0; index < 2; index += 1) await complete(feature, makeExec(oldAgent))
  Object.defineProperty(oldAgent, 'id', { get() { throw new Error('private id failure') } })
  feature.clearAgent(oldAgent)
  const replacement = { id: 'replacement-after-error' }
  live.set(replacement.id, replacement)
  for (let index = 0; index < 2; index += 1) {
    assert.equal(warningCount((await complete(feature, makeExec(replacement))).returned), 0)
  }
  assert.equal(warningCount((await complete(feature, makeExec(replacement))).returned), 1)
  feature.dispose()
})

test('late cleanup of an old Agent cannot erase a same-ID replacement state', async () => {
  const { live, feature } = makeHarness()
  const oldAgent = { id: 'late-cleanup' }
  live.set(oldAgent.id, oldAgent)
  await complete(feature, makeExec(oldAgent))
  const replacement = { id: oldAgent.id }
  live.set(replacement.id, replacement)
  feature.clearAgent(oldAgent)
  for (let index = 0; index < 2; index += 1) await complete(feature, makeExec(replacement))
  feature.clearAgent(oldAgent)
  assert.equal(warningCount((await complete(feature, makeExec(replacement))).returned), 1)
  feature.dispose()
})

test('bounds Agent state without eviction and exact disposal frees capacity', async () => {
  const { live, feature } = makeHarness()
  const agents = Array.from({ length: 257 }, (_value, index) => ({ id: `agent-${index}` }))
  for (const agent of agents) live.set(agent.id, agent)
  for (const agent of agents.slice(0, 256)) await complete(feature, makeExec(agent))
  for (let index = 0; index < 3; index += 1) {
    assert.equal(warningCount((await complete(feature, makeExec(agents[256]))).returned), 0)
  }
  await complete(feature, makeExec(agents[0]))
  assert.equal(warningCount((await complete(feature, makeExec(agents[0]))).returned), 1)

  feature.clearAgent(agents[0])
  for (let index = 0; index < 2; index += 1) await complete(feature, makeExec(agents[256]))
  assert.equal(warningCount((await complete(feature, makeExec(agents[256]))).returned), 1)
  feature.dispose()
})

test('clearing an unreadable Agent ID also releases its bounded state slot', async () => {
  const { live, feature } = makeHarness()
  const agents = Array.from({ length: 257 }, (_value, index) => ({ id: `agent-${index}` }))
  for (const agent of agents) live.set(agent.id, agent)
  for (const agent of agents.slice(0, 256)) await complete(feature, makeExec(agent))
  Object.defineProperty(agents[0], 'id', { get() { throw new Error('private id failure') } })
  feature.clearAgent(agents[0])
  for (let index = 0; index < 2; index += 1) await complete(feature, makeExec(agents[256]))
  assert.equal(warningCount((await complete(feature, makeExec(agents[256]))).returned), 1)
  feature.dispose()
})

test('pending entries are removed even when abort listener removal throws', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'throwing-remove' }
  live.set(agent.id, agent)
  const controller = new AbortController()
  controller.signal.removeEventListener = () => { throw new Error('private remove failure') }
  const exec = makeExec(agent, {}, { signal: controller.signal })
  await feature.preExecute(exec, async () => ({ kind: 'allow' }))
  assert.doesNotThrow(() => feature.clearAgent(agent))
  assert.doesNotThrow(() => feature.dispose(), 'disposal must not retry a removed pending entry')
})

test('listener registration failure leaves no pending completion for later counting', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'throwing-add' }
  live.set(agent.id, agent)
  const controller = new AbortController()
  controller.signal.addEventListener = () => { throw new Error('private add failure') }
  const exec = makeExec(agent, {}, { signal: controller.signal })
  const decision = { kind: 'allow' }
  assert.strictEqual(await feature.preExecute(exec, async () => decision), decision)
  for (let index = 0; index < 2; index += 1) {
    assert.equal(warningCount((await complete(feature, makeExec(agent))).returned), 0)
  }
  assert.equal(warningCount((await complete(feature, makeExec(agent))).returned), 1)
  feature.dispose()
})

test('pending capacity evicts the oldest entry and removes its abort listener', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'pending-capacity' }
  live.set(agent.id, agent)
  const controllers = Array.from({ length: 129 }, () => new AbortController())
  const removals = controllers.map(() => 0)
  controllers.forEach((controller, index) => {
    const original = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.removeEventListener = (...args) => {
      removals[index] += 1
      return original(...args)
    }
  })
  for (const controller of controllers) {
    await feature.preExecute(makeExec(agent, {}, { signal: controller.signal }), async () => ({ kind: 'allow' }))
  }
  assert.equal(removals[0], 1, 'the oldest pending listener is released at the 128-entry cap')
  assert.equal(removals.slice(1).every(count => count === 0), true)
  feature.dispose()
  assert.equal(removals.slice(1).every(count => count === 1), true, 'all remaining listeners are released on disposal')
})

test('disposal during downstream execution fences reminders and clears pending abort listeners', async () => {
  const { live, feature } = makeHarness()
  const agent = { id: 'agent-dispose' }
  live.set(agent.id, agent)
  const first = makeExec(agent)
  const second = makeExec(agent)
  const third = makeExec(agent)
  await complete(feature, first)
  await complete(feature, second)
  await feature.preExecute(third, async () => ({ kind: 'allow' }))
  const result = await feature.listener(third, { isError: false }, async () => {
    feature.dispose()
    return { kind: 'accept', value: {} }
  })
  assert.deepEqual(result, { kind: 'accept', value: {} })
  assert.equal(warningCount((await complete(feature, makeExec(agent))).returned), 0)
})

test('real ToolRuntime carries pre/post identity and adds only the third-call advisory', async t => {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const agent = { id: 'real-runtime-agent', session: { id: 'real-runtime-agent', append() {} } }
  const live = new Map([[agent.id, agent]])
  const feature = createRepeatedCallAdvisory({ get: id => live.get(id) })
  const featureFiber = await ctx.plugin(pluginCtx => {
    pluginCtx.on('tools/pre-execute', feature.preExecute)
    pluginCtx.on('tools/post-execute', feature.listener)
    pluginCtx.on('tools/result', feature.onResult)
    pluginCtx.effect(() => feature.dispose, 'test repeated-call advisory')
  })
  const bodies = []
  const unregister = ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'Test-only repeated read.',
    parameters: {},
    async execute(args) {
      bodies.push(args)
      return [{ type: 'text', text: 'unchanged result' }]
    },
  }))
  t.after(async () => {
    unregister()
    await featureFiber.dispose()
    await toolsFiber.dispose()
    await promptFiber.dispose()
  })

  let sequence = 0
  const execute = () => ctx.tools.execute({
    callId: `call-${++sequence}`,
    name: 'read',
    arguments: { path: 'src/a.js', options: { offset: 0 } },
    agent,
    signal: new AbortController().signal,
  })
  for (let index = 0; index < 2; index += 1) {
    const result = await execute()
    assert.equal(result.isError, false)
    assert.equal(result.additionalContexts, undefined)
  }
  const third = await execute()
  assert.equal(third.isError, false)
  assert.equal(third.content[0].text, 'unchanged result')
  assert.equal(warningCount(third), 1)
  assert.equal(bodies.length, 3, 'the warning never denies or rewrites a Tool call')
  const fourth = await execute()
  assert.equal(fourth.additionalContexts, undefined)
})

test('real tools/result removes pending listeners after a post-bypassing pipeline failure', async t => {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const agent = { id: 'pipeline-failure-agent', session: { id: 'pipeline-failure-agent', append() {} } }
  const feature = createRepeatedCallAdvisory({ get: () => agent })
  const featureFiber = await ctx.plugin(pluginCtx => {
    pluginCtx.on('tools/pre-execute', feature.preExecute)
    pluginCtx.on('tools/post-execute', feature.listener)
    pluginCtx.on('tools/result', feature.onResult)
    pluginCtx.effect(() => feature.dispose, 'test repeated-call cleanup')
  })
  let posts = 0
  const failureFiber = await ctx.plugin(pluginCtx => {
    pluginCtx.on('tools/execute', () => { throw new Error('deliberate pipeline failure') })
    pluginCtx.on('tools/post-execute', async (_exec, _result, next) => {
      posts += 1
      return next()
    })
  })
  const controller = new AbortController()
  const originalAdd = controller.signal.addEventListener.bind(controller.signal)
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal)
  let adds = 0
  let removes = 0
  controller.signal.addEventListener = (...args) => { adds += 1; return originalAdd(...args) }
  controller.signal.removeEventListener = (...args) => { removes += 1; return originalRemove(...args) }
  t.after(async () => {
    await failureFiber.dispose()
    await featureFiber.dispose()
    await toolsFiber.dispose()
    await promptFiber.dispose()
  })

  const result = await ctx.tools.execute({
    callId: 'pipeline-failure-call',
    name: 'read',
    arguments: { path: 'src/a.js' },
    agent,
    signal: controller.signal,
  })
  assert.equal(result.isError, true)
  assert.equal(posts, 0, 'the deliberate execute failure bypasses post-execute')
  assert.equal(adds, 1, 'pre-execute installs one abort listener')
  assert.equal(removes, 1, 'tools/result removes that listener without post-execute')
})
