import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRuntimeFallbackController,
  normalizeRuntimeFallback,
  registerRuntimeFallback,
} from '../src/runtime-fallback.js'

const PRIMARY = Object.freeze({
  provider: 'provider-primary',
  model: 'model-primary',
  reasoningEffort: 'high',
  maxTokens: 4096,
  temperature: 0.2,
  stop: Object.freeze(['END']),
})

function policy(overrides = {}) {
  return {
    enabled: true,
    retryOnStatuses: [429, 500, 502, 503, 504],
    chains: [{
      provider: 'provider-primary',
      model: 'model-primary',
      fallbacks: [
        { provider: 'provider-backup', model: 'model-backup', maxTokens: 2048 },
        { provider: 'provider-last', model: 'model-last', reasoningEffort: 'low' },
      ],
    }],
    ...overrides,
  }
}

function requestPayload(id = 'agent-1', turn = 1, step = 1, signal = new AbortController().signal) {
  return { agent: { id }, turn, step, signal }
}

function errorPayload(options = {}) {
  const id = options.id ?? 'agent-1'
  const turn = options.turn ?? 1
  const step = options.step ?? 1
  const provider = options.provider ?? 'provider-primary'
  const status = Object.prototype.hasOwnProperty.call(options, 'status') ? options.status : 429
  const signal = options.signal ?? new AbortController().signal
  const failure = { code: options.code ?? (status === undefined ? 'UNKNOWN' : `HTTP_${status}`), message: 'redacted test failure' }
  if (status !== undefined) failure.status = status
  return { agent: { id }, turn, step, provider, failure, retryPolicy: options.retryPolicy, signal }
}

async function request(controller, id = 'agent-1', turn = 1, step = 1, config = PRIMARY, signal = new AbortController().signal) {
  return controller.onRequest(requestPayload(id, turn, step, signal), async () => config)
}

async function fail(controller, payload, delegated = undefined) {
  return controller.onRequestError(payload, async () => delegated)
}

test('normalizes default-off bounded fallback policy into immutable routes', () => {
  const defaults = normalizeRuntimeFallback()
  assert.deepEqual(defaults, {
    enabled: false,
    retryOnStatuses: [429, 500, 502, 503, 504],
    chains: [],
  })
  assert.equal(Object.isFrozen(defaults), true)
  assert.equal(Object.isFrozen(defaults.retryOnStatuses), true)

  const normalized = normalizeRuntimeFallback(policy())
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.chains.length, 1)
  assert.equal(Object.isFrozen(normalized.chains[0].fallbacks[0]), true)
  assert.deepEqual(normalized.chains[0].fallbacks[1], {
    provider: 'provider-last', model: 'model-last', reasoningEffort: 'low',
  })
})

test('rejects malformed, duplicate, unbounded, and unsupported fallback settings', () => {
  assert.throws(() => normalizeRuntimeFallback(null), /plain object/u)
  assert.throws(() => normalizeRuntimeFallback({ enabled: 'true' }), /enabled must be a boolean/u)
  assert.throws(() => normalizeRuntimeFallback({ enabled: true }), /at least one chain/u)
  assert.throws(() => normalizeRuntimeFallback({ enabled: true, chains: [{ provider: 'p', model: 'm', fallbacks: [] }] }), /between 1 and 3 routes/u)
  assert.throws(() => normalizeRuntimeFallback({ unsupported: true }), /unsupported field/u)
  assert.throws(() => normalizeRuntimeFallback({ retryOnStatuses: [429, 429] }), /must not contain duplicates/u)
  assert.throws(() => normalizeRuntimeFallback({ retryOnStatuses: [399] }), /400 through 599/u)
  assert.throws(() => normalizeRuntimeFallback({ retryOnStatuses: [500.5] }), /400 through 599/u)
  assert.throws(() => normalizeRuntimeFallback({ retryOnStatuses: Array.from({ length: 11 }, (_, index) => 500 + index) }), /at most 10/u)
  assert.throws(() => normalizeRuntimeFallback({ enabled: true, chains: [{ provider: 'p', model: 'm', fallbacks: [{ provider: 'p', model: 'm' }] }] }), /must not repeat/u)
  assert.throws(() => normalizeRuntimeFallback({ chains: Array.from({ length: 33 }, (_, index) => ({
    provider: 'primary', model: `model-${index}`, fallbacks: [{ provider: 'backup', model: `backup-${index}` }],
  })) }), /at most 32 routes/u)
  assert.throws(() => normalizeRuntimeFallback({ chains: [{
    provider: 'primary', model: 'model',
    fallbacks: Array.from({ length: 4 }, (_, index) => ({ provider: 'backup', model: `backup-${index}` })),
  }] }), /between 1 and 3 routes/u)
  assert.throws(() => normalizeRuntimeFallback({
    chains: [
      { provider: 'p', model: 'm', fallbacks: [{ provider: 'p2', model: 'm2' }] },
      { provider: ' p ', model: 'm', fallbacks: [{ provider: 'p3', model: 'm3' }] },
    ],
  }), /repeat a primary/u)
  assert.throws(() => normalizeRuntimeFallback({ chains: [{ provider: 'p', model: 'm', fallbacks: [{ provider: 'p2', model: 'm2', maxTokens: 0 }] }] }), /positive safe integer/u)
  assert.throws(() => normalizeRuntimeFallback({ chains: [{ provider: 'p', model: 'm', fallbacks: [{ provider: 'p2', model: 'm2', cooldownSeconds: 10 }] }] }), /unsupported field/u)
})

test('switches only after delegated same-route retries are exhausted, then advances in order', async () => {
  const switches = []
  const controller = createRuntimeFallbackController(policy(), { onFallback: event => switches.push(event) })
  const original = await request(controller)
  assert.strictEqual(original, PRIMARY)

  assert.deepEqual(await fail(controller, errorPayload(), { kind: 'retry' }), { kind: 'retry' })
  assert.strictEqual(await request(controller), PRIMARY, 'Host-owned same-route retry keeps the primary model')

  assert.deepEqual(await fail(controller, errorPayload(), undefined), { kind: 'retry' })
  const firstFallback = await request(controller)
  assert.equal(firstFallback.provider, 'provider-backup')
  assert.equal(firstFallback.model, 'model-backup')
  assert.equal(firstFallback.reasoningEffort, undefined, 'reasoning effort is cleared when the fallback does not specify one')
  assert.equal(firstFallback.maxTokens, 2048)
  assert.equal(firstFallback.temperature, PRIMARY.temperature)
  assert.strictEqual(firstFallback.stop, PRIMARY.stop)
  assert.equal(PRIMARY.provider, 'provider-primary', 'frozen input config is not mutated')

  assert.deepEqual(
    await fail(controller, errorPayload({ provider: 'provider-backup', status: 503 }), { kind: 'retry' }),
    { kind: 'retry' },
  )
  assert.equal((await request(controller)).provider, 'provider-backup', 'native retry stays on the current fallback')

  assert.deepEqual(await fail(controller, errorPayload({ provider: 'provider-backup', status: 503 })), { kind: 'retry' })
  const secondFallback = await request(controller)
  assert.equal(secondFallback.provider, 'provider-last')
  assert.equal(secondFallback.model, 'model-last')
  assert.equal(secondFallback.reasoningEffort, 'low')
  assert.equal(secondFallback.maxTokens, PRIMARY.maxTokens, 'unspecified token ceiling is preserved')
  assert.deepEqual(switches.map(({ from, to, status }) => [from.provider, to.provider, status]), [
    ['provider-primary', 'provider-backup', 429],
    ['provider-backup', 'provider-last', 503],
  ])
  assert.equal(await fail(controller, errorPayload({ provider: 'provider-last', status: 503 })), undefined)
  assert.strictEqual(await request(controller), PRIMARY, 'an exhausted chain cannot restart within the same turn/step')
  assert.equal(await fail(controller, errorPayload({ status: 429 })), undefined)
  controller.dispose()
})

test('does not preempt retryable Host policy and fails closed for always-retry policy', async () => {
  const retryPolicy = {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['HTTP_429'],
    initialDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0.2,
  }
  const controller = createRuntimeFallbackController(policy())
  await request(controller)
  assert.equal(await fail(controller, errorPayload({ retryPolicy })), undefined)
  assert.strictEqual(await request(controller), PRIMARY, 'an unobserved retry budget prevents cross-route switching')
  assert.deepEqual(await fail(controller, errorPayload({ retryPolicy }), { kind: 'retry' }), { kind: 'retry' })
  assert.deepEqual(await fail(controller, errorPayload({ retryPolicy }), { kind: 'retry' }), { kind: 'retry' })
  assert.deepEqual(await fail(controller, errorPayload({ retryPolicy })), { kind: 'retry' }, 'fallback begins only after delegated retries exhaust the policy budget')
  assert.equal((await request(controller)).provider, 'provider-backup')
  controller.dispose()

  const alwaysController = createRuntimeFallbackController(policy())
  await request(alwaysController)
  const alwaysPolicy = { mode: 'always', initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.2 }
  assert.equal(await fail(alwaysController, errorPayload({ retryPolicy: alwaysPolicy })), undefined)
  assert.strictEqual(await request(alwaysController), PRIMARY)
  alwaysController.dispose()

  const unknownController = createRuntimeFallbackController(policy())
  await request(unknownController)
  assert.equal(await fail(unknownController, errorPayload({ retryPolicy: { mode: 'future' } })), undefined)
  assert.strictEqual(await request(unknownController), PRIMARY)
  unknownController.dispose()

  const validShape = {
    mode: 'normal', maxRetries: 0, retryableCodes: [],
    initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0,
  }
  const missingJitter = { ...validShape }
  delete missingJitter.jitterRatio
  const malformedPolicies = [
    { ...validShape, initialDelayMs: 'invalid' },
    { ...validShape, maxDelayMs: Number.NaN },
    { ...validShape, jitterRatio: -1 },
    missingJitter,
    { ...validShape, maxRetries: -1 },
    { ...validShape, retryableCodes: 'not-an-array' },
  ]
  for (const malformedPolicy of malformedPolicies) {
    const malformedController = createRuntimeFallbackController(policy())
    await request(malformedController)
    assert.equal(await fail(malformedController, errorPayload({ retryPolicy: malformedPolicy })), undefined)
    assert.strictEqual(await request(malformedController), PRIMARY, 'malformed normal policy must not trigger fallback')
    malformedController.dispose()
  }
})

test('retains delegated retry count across interleaved failure codes', async () => {
  const controller = createRuntimeFallbackController(policy())
  const retryPolicy = {
    mode: 'normal', maxRetries: 2,
    retryableCodes: ['HTTP_429', 'HTTP_500'],
    initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.2,
  }
  await request(controller)
  assert.deepEqual(await fail(controller, errorPayload({ code: 'HTTP_429', status: 429, retryPolicy }), { kind: 'retry' }), { kind: 'retry' })
  assert.equal(await fail(controller, errorPayload({ code: 'HTTP_500', status: 500, retryPolicy })), undefined)
  assert.equal(await fail(controller, errorPayload({ code: 'HTTP_429', status: 429, retryPolicy })), undefined)
  assert.strictEqual(await request(controller), PRIMARY, 'A→B→A failure codes do not reset the route-wide retry budget')
  assert.deepEqual(await fail(controller, errorPayload({ code: 'HTTP_500', status: 500, retryPolicy }), { kind: 'retry' }), { kind: 'retry' })
  assert.deepEqual(await fail(controller, errorPayload({ code: 'HTTP_429', status: 429, retryPolicy })), { kind: 'retry' })
  assert.equal((await request(controller)).provider, 'provider-backup')
  controller.dispose()
})

test('does not switch for non-retryable, unknown, mismatched-provider, or cancelled failures', async () => {
  const cases = [
    { status: 400 },
    { status: undefined },
    { status: 429, provider: 'unexpected-provider' },
  ]
  for (const failure of cases) {
    const controller = createRuntimeFallbackController(policy())
    await request(controller)
    assert.equal(await fail(controller, errorPayload(failure)), undefined)
    assert.strictEqual(await request(controller), PRIMARY, 'a terminal failure cannot re-arm the same turn/step')
    assert.equal(await fail(controller, errorPayload({ id: 'agent-1', provider: 'provider-primary', status: 429 })), undefined)
    controller.dispose()
  }

  const controller = createRuntimeFallbackController(policy())
  const abort = new AbortController()
  await request(controller, 'cancelled-agent', 1, 1, PRIMARY, abort.signal)
  abort.abort()
  assert.equal(await fail(controller, errorPayload({ id: 'cancelled-agent', signal: abort.signal })), undefined)
  assert.strictEqual(await request(controller, 'cancelled-agent', 1, 1, PRIMARY, abort.signal), PRIMARY)
  controller.dispose()
})

test('resets route-wide retry budget on Agent turn, step, and primary-route changes', async () => {
  const alternatePrimary = Object.freeze({
    provider: 'provider-secondary',
    model: 'model-secondary',
    maxTokens: 4096,
  })
  const controller = createRuntimeFallbackController({
    enabled: true,
    retryOnStatuses: [429],
    chains: [
      { provider: 'provider-primary', model: 'model-primary', fallbacks: [{ provider: 'provider-backup', model: 'model-backup' }] },
      { provider: 'provider-secondary', model: 'model-secondary', fallbacks: [{ provider: 'provider-secondary-backup', model: 'model-secondary-backup' }] },
    ],
  })
  const retryPolicy = {
    mode: 'normal', maxRetries: 1, retryableCodes: ['HTTP_429'],
    initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.2,
  }

  async function assertReset(id, turn, step, config, provider) {
    await request(controller, id, 1, 1, PRIMARY)
    assert.deepEqual(await fail(controller, errorPayload({ id, provider: 'provider-primary', code: 'HTTP_429', status: 429, retryPolicy }), { kind: 'retry' }), { kind: 'retry' })
    assert.strictEqual(await request(controller, id, turn, step, config), config)
    assert.equal(await fail(controller, errorPayload({ id, turn, step, provider, code: 'HTTP_429', status: 429, retryPolicy })), undefined)
    assert.strictEqual(await request(controller, id, turn, step, config), config, 'a fresh turn/step/route gets a fresh retry budget')
  }

  await assertReset('turn-reset', 2, 1, PRIMARY, 'provider-primary')
  await assertReset('step-reset', 1, 2, PRIMARY, 'provider-primary')
  await assertReset('route-reset', 1, 1, alternatePrimary, 'provider-secondary')
  controller.dispose()
})

test('isolates fallback state by Agent and clears disposed Agents', async () => {
  const controller = createRuntimeFallbackController(policy())
  await request(controller, 'agent-a')
  await request(controller, 'agent-b')
  assert.deepEqual(await fail(controller, errorPayload({ id: 'agent-a' })), { kind: 'retry' })
  assert.strictEqual(await request(controller, 'agent-b'), PRIMARY, 'one Agent cannot consume another Agent’s fallback')
  assert.equal((await request(controller, 'agent-a')).provider, 'provider-backup')

  assert.strictEqual(await request(controller, 'agent-a', 2, 1), PRIMARY, 'a new turn starts from its logged route')
  assert.deepEqual(await fail(controller, errorPayload({ id: 'agent-a', turn: 2 })), { kind: 'retry' })
  assert.equal((await request(controller, 'agent-a', 2, 1)).provider, 'provider-backup')

  controller.onAgentDisposed({ agent: { id: 'agent-a' } })
  assert.strictEqual(await request(controller, 'agent-a', 2, 1), PRIMARY, 'disposal clears per-Agent retry state')
  controller.dispose()
})

test('fails closed when the bounded per-Agent state table is full', async () => {
  const controller = createRuntimeFallbackController(policy())
  for (let index = 0; index < 256; index += 1) {
    await request(controller, `agent-${index}`)
  }
  assert.equal(await fail(controller, errorPayload({ id: 'agent-over-cap' })), undefined)
  assert.strictEqual(await request(controller, 'agent-over-cap'), PRIMARY)
  controller.dispose()
})

test('registration is default-off and disposes its controller with Cordis scope', async () => {
  const events = new Map()
  let cleanup
  const ctx = {
    on: (name, listener) => events.set(name, listener),
    effect: execute => { cleanup = execute() },
  }
  assert.doesNotThrow(() => registerRuntimeFallback({}, undefined))
  assert.equal(events.size, 0)

  const dispose = registerRuntimeFallback(ctx, policy())
  assert.deepEqual([...events.keys()].sort(), ['agent/disposed', 'agent/request', 'agent/request-error'])
  const requestEvent = events.get('agent/request')
  const errorEvent = events.get('agent/request-error')
  await requestEvent(requestPayload(), async () => PRIMARY)
  assert.deepEqual(await errorEvent(errorPayload(), async () => undefined), { kind: 'retry' })
  dispose()
  cleanup()
  assert.strictEqual(await requestEvent(requestPayload(), async () => PRIMARY), PRIMARY, 'disposed handlers no longer route')
})
