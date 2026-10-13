import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelCapabilitiesCommand } from '../src/model-capabilities.js'

function makeLlm(overrides = {}) {
  const calls = []
  const llm = {
    listProviders() {
      calls.push(['providers'])
      return [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'anthropic', name: 'Anthropic' },
      ]
    },
    async resolveModelInfo(provider, model, signal) {
      calls.push(['resolve', provider, model, signal])
      return {
        provider,
        id: model,
        name: 'Flash',
        description: 'This text is intentionally not rendered to the user/model.',
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 8_192,
        inputModalities: ['text', 'image', 'unknown'],
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low', description: 'Short' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'low',
        },
      }
    },
    ...overrides,
  }
  return { llm, calls }
}

test('lists registered DSH providers without issuing model discovery requests', async () => {
  const { llm, calls } = makeLlm()
  const command = createModelCapabilitiesCommand(llm)
  const providers = await command.handler({ rawInput: '' })
  assert.equal(providers.kind, 'success')
  assert.match(providers.text, /deepseek — DeepSeek/u)
  assert.match(providers.text, /anthropic — Anthropic/u)
  assert.deepEqual(calls, [['providers']])
})

test('exact provider lookup extends beyond the display cap and reports uncertainty past its scan cap', async () => {
  const visibleRows = Array.from({ length: 101 }, (_, index) => ({ id: `provider-${index}`, name: `Provider ${index}` }))
  const visible = makeLlm({ listProviders: () => visibleRows })
  const found = await createModelCapabilitiesCommand(visible.llm).handler({ rawInput: 'provider-100/model' })
  assert.equal(found.kind, 'success')
  assert.equal(visible.calls.at(-1)[1], 'provider-100')

  const overLimitRows = Array.from({ length: 1_025 }, (_, index) => ({ id: `provider-${index}`, name: `Provider ${index}` }))
  const overLimit = makeLlm({ listProviders: () => overLimitRows })
  const indeterminate = await createModelCapabilitiesCommand(overLimit.llm).handler({ rawInput: 'provider-1024/model' })
  assert.equal(indeterminate.kind, 'error')
  assert.match(indeterminate.text, /presence is indeterminate/u)
  assert.doesNotMatch(indeterminate.text, /not registered/u)
  assert.equal(overLimit.calls.some(([method]) => method === 'resolve'), false)
})

test('resolves exact live model capability metadata and forwards cancellation', async () => {
  const { llm, calls } = makeLlm()
  const command = createModelCapabilitiesCommand(llm)
  const controller = new AbortController()
  const result = await command.handler({ rawInput: 'deepseek/deepseek-flash', signal: controller.signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Context window: 128000/u)
  assert.match(result.text, /Default maximum output tokens: 8192/u)
  assert.match(result.text, /Input modalities: text, image/u)
  assert.match(result.text, /Reasoning efforts: low, high/u)
  assert.match(result.text, /Default reasoning effort: low/u)
  assert.doesNotMatch(result.text, /intentionally not rendered/u)
  const resolveCall = calls.at(-1)
  assert.deepEqual(resolveCall.slice(0, 3), ['resolve', 'deepseek', 'deepseek-flash'])
  assert.notStrictEqual(resolveCall[3], controller.signal, 'lookup receives the caller signal combined with a deadline')
  assert.equal(resolveCall[3].aborted, false)
  controller.abort(new Error('caller canceled'))
  assert.equal(resolveCall[3].aborted, true)
})

test('returns promptly on caller cancellation even if a model adapter does not settle', async () => {
  let receivedSignal
  const { llm } = makeLlm({
    resolveModelInfo(_provider, _model, signal) {
      receivedSignal = signal
      return new Promise(() => {})
    },
  })
  const controller = new AbortController()
  const command = createModelCapabilitiesCommand(llm)
  const pending = command.handler({ rawInput: 'deepseek/deepseek-flash', signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(receivedSignal)
  controller.abort()
  const result = await pending
  assert.equal(result.kind, 'error')
  assert.match(result.text, /canceled/u)
  assert.equal(receivedSignal.aborted, true)
})

test('rejects unknown providers and malformed model selectors before provider calls', async () => {
  const { llm, calls } = makeLlm()
  const command = createModelCapabilitiesCommand(llm)
  const unknown = await command.handler({ rawInput: 'missing-provider/model' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /not registered/u)
  const malformed = await command.handler({ rawInput: 'deepseek/' })
  assert.equal(malformed.kind, 'error')
  assert.match(malformed.text, /Use \/omo-models/u)
  assert.equal(calls.some(([method]) => method === 'resolve'), false)
})

test('bounds provider metadata output, input, and error detail', async () => {
  const secret = 'provider endpoint secret'
  const { llm } = makeLlm({
    listProviders: () => Array.from({ length: 150 }, (_, index) => ({
      id: `provider-${index}-${'i'.repeat(220)}`,
      name: `name-${index}-${'n'.repeat(220)}`,
    })),
  })
  const command = createModelCapabilitiesCommand(llm)
  const result = await command.handler({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.length <= 12_000)
  assert.match(result.text, /truncated/u)

  const oversized = await command.handler({ rawInput: 'x'.repeat(513) })
  assert.equal(oversized.kind, 'error')
  assert.match(oversized.text, /maximum 512/u)

  const failing = createModelCapabilitiesCommand(makeLlm({
    listProviders() { throw new Error(secret) },
  }).llm)
  const failed = await failing.handler({ rawInput: '' })
  assert.equal(failed.kind, 'error')
  assert.doesNotMatch(failed.text, new RegExp(secret, 'u'))
})

test('degrades safely when the optional DSH LLM service is absent', async () => {
  const command = createModelCapabilitiesCommand(undefined)
  const result = await command.handler({ rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unavailable/u)
})
