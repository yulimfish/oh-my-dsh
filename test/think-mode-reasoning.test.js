import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createThinkModeReasoningController,
  detectThinkKeyword,
} from '../src/think-mode-reasoning.js'

const route = Object.freeze({ provider: 'provider-a', model: 'model-a' })

function userMessage(text, source = { kind: 'user' }) {
  return { role: 'user', source, content: [{ type: 'text', text }] }
}

function entered(messages) {
  return { kind: 'enter', messages }
}

function makeFixture(resolveCallConfig, options = {}) {
  const liveAgents = new Map()
  const agents = { get: id => liveAgents.get(id) }
  const llm = { resolveCallConfig }
  return {
    agents,
    liveAgents,
    llm,
    controller: createThinkModeReasoningController(llm, { agents, ...options }),
  }
}

async function captureThink(controller, agent, turn, step, text, signal = new AbortController().signal) {
  await controller.onPreStep({ agent, turn, step, signal }, async () => entered([userMessage(text)]))
}

function requestPayload(agent, turn, step, signal = new AbortController().signal) {
  return { agent, turn, step, signal }
}

test('detects multilingual think cues after stripping fenced and inline code', () => {
  assert.equal(detectThinkKeyword('Please ultrathink this carefully.'), true)
  assert.equal(detectThinkKeyword('이 문제를 생각해 보세요.'), true)
  assert.equal(detectThinkKeyword('考えを整理して。'), true)
  assert.equal(detectThinkKeyword('Reflexiona antes de responder.'), true)
  assert.equal(detectThinkKeyword('Use `think` as the variable name.'), false)
  assert.equal(detectThinkKeyword('Example:\n```txt\nthink carefully\n```\nContinue.'), false)
  assert.equal(detectThinkKeyword('No special cue here.'), false)
  assert.equal(detectThinkKeyword(`think${'x'.repeat(65_536)}`), false, 'oversized text fails closed rather than truncating code fences')
})

test('applies high reasoning effort only after same-route resolution accepts it', async () => {
  const calls = []
  const fixture = makeFixture(async (config, signal) => {
    calls.push({ config, signal })
    // The Host may return undefined when validation needs no default materialization.
    return undefined
  })
  const agent = { id: 'think-agent' }
  fixture.liveAgents.set(agent.id, agent)
  const signal = new AbortController().signal
  await captureThink(fixture.controller, agent, 2, 3, 'Think through the alternatives.', signal)

  const result = await fixture.controller.onRequest(requestPayload(agent, 2, 3, signal), async () => route)
  assert.deepEqual(result, { ...route, reasoningEffort: 'high' })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].config.provider, route.provider)
  assert.equal(calls[0].config.model, route.model)
  assert.equal(calls[0].config.reasoningEffort, 'high')
  const temperatureAgent = { id: 'think-temperature', options: { temperature: 0.4 } }
  fixture.liveAgents.set(temperatureAgent.id, temperatureAgent)
  await captureThink(fixture.controller, temperatureAgent, 2, 3, 'Think through the alternatives.', signal)
  const withTemperature = await fixture.controller.onRequest(requestPayload(temperatureAgent, 2, 3, signal), async () => route)
  assert.equal(calls.at(-1).config.temperature, 0.4)
  assert.equal(withTemperature.temperature, 0.4)
  assert.notEqual(calls[0].signal, signal, 'the resolver receives a bounded child signal')
  fixture.controller.dispose()
})

test('uses only the latest real user text and ignores synthetic or code-only cues', async () => {
  let resolverCalls = 0
  const fixture = makeFixture(async config => {
    resolverCalls += 1
    return { ...config }
  })
  const agent = { id: 'latest-user-agent' }
  fixture.liveAgents.set(agent.id, agent)
  const signal = new AbortController().signal
  const cases = [
    [
      userMessage('Think about this.'),
      userMessage('Answer normally.'),
    ],
    [userMessage('Think about this.', { kind: 'tool' })],
    [userMessage('```js\nthink();\n```')],
  ]
  for (let index = 0; index < cases.length; index += 1) {
    const turn = 1
    const step = index + 1
    await fixture.controller.onPreStep({ agent, turn, step, signal }, async () => entered(cases[index]))
    const base = Object.freeze({ ...route, temperature: 0.2 })
    assert.strictEqual(await fixture.controller.onRequest(requestPayload(agent, turn, step, signal), async () => base), base)
  }
  assert.equal(resolverCalls, 0)
  fixture.controller.dispose()
})

test('preserves explicit reasoning effort and never overrides the selected route', async () => {
  let resolverCalls = 0
  const fixture = makeFixture(async config => {
    resolverCalls += 1
    return { ...config }
  })
  const agent = { id: 'explicit-effort-agent' }
  fixture.liveAgents.set(agent.id, agent)
  const signal = new AbortController().signal
  await captureThink(fixture.controller, agent, 1, 1, 'Think carefully.', signal)
  const base = Object.freeze({ ...route, reasoningEffort: 'medium' })
  assert.strictEqual(await fixture.controller.onRequest(requestPayload(agent, 1, 1, signal), async () => base), base)
  assert.equal(resolverCalls, 0)
  fixture.controller.dispose()
})

test('resolver rejection and timeout fail open to the original call config', async () => {
  const rejected = makeFixture(async () => { throw new Error('provider details must be hidden') })
  const agentA = { id: 'reject-agent' }
  rejected.liveAgents.set(agentA.id, agentA)
  const signalA = new AbortController().signal
  await captureThink(rejected.controller, agentA, 1, 1, 'Think deeply.', signalA)
  assert.strictEqual(await rejected.controller.onRequest(requestPayload(agentA, 1, 1, signalA), async () => route), route)
  rejected.controller.dispose()

  const changedRoute = makeFixture(async config => ({ ...config, model: 'other-model' }))
  const agentChanged = { id: 'changed-route-agent' }
  changedRoute.liveAgents.set(agentChanged.id, agentChanged)
  const signalChanged = new AbortController().signal
  await captureThink(changedRoute.controller, agentChanged, 1, 1, 'Think carefully.', signalChanged)
  assert.strictEqual(await changedRoute.controller.onRequest(requestPayload(agentChanged, 1, 1, signalChanged), async () => route), route)
  changedRoute.controller.dispose()

  let resolverSignal
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  const timedOut = makeFixture((_config, signal) => {
    resolverSignal = signal
    started()
    return new Promise(() => {})
  }, { timeoutMs: 10 })
  const agentB = { id: 'timeout-agent' }
  timedOut.liveAgents.set(agentB.id, agentB)
  const signalB = new AbortController().signal
  await captureThink(timedOut.controller, agentB, 1, 1, 'Think deeply.', signalB)
  const pending = timedOut.controller.onRequest(requestPayload(agentB, 1, 1, signalB), async () => route)
  await startedPromise
  assert.strictEqual(await pending, route)
  assert.equal(resolverSignal.aborted, true)
  timedOut.controller.dispose()
})

test('caller cancellation aborts the validation and leaves the route unchanged', async () => {
  let resolverSignal
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  const fixture = makeFixture((_config, signal) => {
    resolverSignal = signal
    started()
    return new Promise(() => {})
  }, { timeoutMs: 1_000 })
  const agent = { id: 'cancel-agent' }
  fixture.liveAgents.set(agent.id, agent)
  const caller = new AbortController()
  await captureThink(fixture.controller, agent, 1, 1, 'Think carefully.', caller.signal)
  const pending = fixture.controller.onRequest(requestPayload(agent, 1, 1, caller.signal), async () => route)
  await startedPromise
  caller.abort(new Error('caller cancelled'))
  assert.strictEqual(await pending, route)
  assert.equal(resolverSignal.aborted, true)
  fixture.controller.dispose()
})

test('same-ID replacement and late preflight completion cannot consume newer Agent state', async () => {
  let releaseFirst
  let firstStarted
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve })
  let callCount = 0
  const fixture = makeFixture((config) => {
    callCount += 1
    if (callCount === 1) {
      firstStarted()
      return new Promise(resolve => { releaseFirst = () => resolve({ ...config }) })
    }
    return Promise.resolve({ ...config })
  })
  const id = 'think-reused-agent'
  const oldAgent = { id }
  const replacement = { id }
  fixture.liveAgents.set(id, oldAgent)
  await captureThink(fixture.controller, oldAgent, 1, 1, 'Think now.')
  const oldRequest = fixture.controller.onRequest(requestPayload(oldAgent, 1, 1), async () => route)
  await firstStartedPromise

  fixture.liveAgents.set(id, replacement)
  await captureThink(fixture.controller, replacement, 1, 2, 'Think again.')
  releaseFirst()
  assert.strictEqual(await oldRequest, route)
  const replacementResult = await fixture.controller.onRequest(requestPayload(replacement, 1, 2), async () => route)
  assert.deepEqual(replacementResult, { ...route, reasoningEffort: 'high' })
  assert.equal(callCount, 2)
  fixture.controller.dispose()
})

test('a later step of the same Agent retains its cue when an older preflight completes late', async () => {
  let releaseFirst
  let firstStarted
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve })
  let callCount = 0
  const fixture = makeFixture(config => {
    callCount += 1
    if (callCount === 1) {
      firstStarted()
      return new Promise(resolve => { releaseFirst = () => resolve({ ...config }) })
    }
    return Promise.resolve({ ...config })
  })
  const agent = { id: 'same-agent-steps' }
  fixture.liveAgents.set(agent.id, agent)
  await captureThink(fixture.controller, agent, 1, 1, 'Think about the first step.')
  const oldRequest = fixture.controller.onRequest(requestPayload(agent, 1, 1), async () => route)
  await firstStartedPromise

  await captureThink(fixture.controller, agent, 1, 2, 'Think about the next step.')
  releaseFirst()
  assert.strictEqual(await oldRequest, route)
  const nextResult = await fixture.controller.onRequest(requestPayload(agent, 1, 2), async () => route)
  assert.deepEqual(nextResult, { ...route, reasoningEffort: 'high' })
  assert.equal(callCount, 2)
  fixture.controller.dispose()
})

test('exact disposal clears only the disposed Agent state', async () => {
  const fixture = makeFixture(async config => ({ ...config }))
  const id = 'dispose-reused-agent'
  const oldAgent = { id }
  const currentAgent = { id }
  fixture.liveAgents.set(id, oldAgent)
  await captureThink(fixture.controller, oldAgent, 1, 1, 'Think deeply.')
  fixture.liveAgents.set(id, currentAgent)
  await captureThink(fixture.controller, currentAgent, 1, 2, 'Think deeply.')
  fixture.controller.onAgentDisposed({ agent: oldAgent })
  const result = await fixture.controller.onRequest(requestPayload(currentAgent, 1, 2), async () => route)
  assert.deepEqual(result, { ...route, reasoningEffort: 'high' })
  fixture.controller.dispose()
})

test('without agents.get, a same-ID cue fails closed until the exact old Agent is disposed', async () => {
  let resolverCalls = 0
  const controller = createThinkModeReasoningController({
    resolveCallConfig: async config => {
      resolverCalls += 1
      return { ...config }
    },
  })
  const id = 'no-registry-think-agent'
  const oldAgent = { id }
  const replacement = { id }
  await captureThink(controller, oldAgent, 1, 1, 'Think carefully.')
  await captureThink(controller, replacement, 1, 2, 'Think carefully.')

  assert.strictEqual(await controller.onRequest(requestPayload(replacement, 1, 2), async () => route), route)
  assert.equal(resolverCalls, 0)
  assert.deepEqual(
    await controller.onRequest(requestPayload(oldAgent, 1, 1), async () => route),
    { ...route, reasoningEffort: 'high' },
  )

  controller.onAgentDisposed({ agent: oldAgent })
  await captureThink(controller, replacement, 1, 3, 'Think carefully.')
  assert.deepEqual(
    await controller.onRequest(requestPayload(replacement, 1, 3), async () => route),
    { ...route, reasoningEffort: 'high' },
  )
  controller.dispose()
})
