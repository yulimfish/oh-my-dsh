import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelCapabilitiesCommand } from '../src/model-capabilities.js'
import { MAX_MODELS_DEV_RESPONSE_BYTES, MODELS_DEV_SOURCE_URL } from '../src/models-dev-snapshot.js'

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

function modelsDevResponse(raw = { openai: { models: { 'gpt-4o': {
  id: 'gpt-4o', family: 'gpt-4', reasoning: true, tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 128_000, output: 16_384 },
} } } }, overrides = {}) {
  return {
    url: MODELS_DEV_SOURCE_URL,
    statusCode: 200,
    body: { kind: 'text', content: JSON.stringify(raw) },
    truncated: false,
    ...overrides,
  }
}

test('lists registered DSH providers without issuing model discovery requests', async () => {
  const { llm, calls } = makeLlm()
  const command = createModelCapabilitiesCommand(llm)
  const providers = await command.handler({ rawInput: '' })
  assert.equal(providers.kind, 'success')
  assert.match(providers.text, /`deepseek` — `DeepSeek`/u)
  assert.match(providers.text, /`anthropic` — `Anthropic`/u)
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
  assert.match(result.text, /Reasoning efforts: `low`, `high`/u)
  assert.match(result.text, /Default reasoning effort: `low`/u)
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

test('code-spans live provider and reasoning labels and removes bidi controls', async () => {
  const providerId = '`<img src=x onerror=1>`\u202e'
  const providerName = '[click](https://example.test)'
  const modelId = '`<svg onload=1>`'
  const effortId = '`<script>alert(1)</script>`'
  const defaultEffort = '[default](https://example.test)'
  const { llm } = makeLlm({
    listProviders: () => [{ id: providerId, name: providerName }],
    resolveModelInfo: async () => ({
      reasoning: { efforts: [{ id: effortId }], defaultEffort },
    }),
  })
  const command = createModelCapabilitiesCommand(llm)
  const listed = await command.handler({ rawInput: '' })
  assert.ok(listed.text.includes(`\`\` ${providerId.slice(0, -1)} \`\``))
  assert.ok(listed.text.includes(`\`${providerName}\``))
  assert.doesNotMatch(listed.text, /\u202e/u)

  const resolved = await command.handler({ rawInput: `${providerId}/${modelId}` })
  assert.ok(resolved.text.includes(`\`\` ${providerId.slice(0, -1)} \`\``))
  assert.ok(resolved.text.includes(`\`\` ${modelId} \`\``))
  assert.ok(resolved.text.includes(`\`\` ${effortId} \`\``))
  assert.ok(resolved.text.includes(`\`${defaultEffort}\``))
  assert.doesNotMatch(resolved.text, /\u202e/u)
})

test('degrades safely when the optional DSH LLM service is absent', async () => {
  const command = createModelCapabilitiesCommand(undefined)
  const result = await command.handler({ rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unavailable/u)
})

test('models.dev snapshot refresh is fixed-source, explicit, in-memory, and advisory', async () => {
  const { llm, calls: llmCalls } = makeLlm()
  const fetchCalls = []
  const web = {
    async fetch(request, signal) {
      fetchCalls.push({ request, signal })
      return modelsDevResponse()
    },
  }
  const command = createModelCapabilitiesCommand(llm, { enableModelCapabilitiesRefresh: true, web })
  assert.deepEqual(fetchCalls, [], 'creating the command must not fetch')
  const absent = await command.handler({ rawInput: 'snapshot' })
  assert.equal(absent.kind, 'error')
  assert.match(absent.text, /run \/omo-models refresh explicitly/u)
  assert.deepEqual(fetchCalls, [])

  const refreshed = await command.handler({ rawInput: 'refresh' })
  assert.equal(refreshed.kind, 'success')
  assert.match(refreshed.text, /1 model IDs/u)
  assert.match(refreshed.text, /advisory only/u)
  assert.deepEqual(fetchCalls.map(call => call.request), [{ url: MODELS_DEV_SOURCE_URL }])
  assert.ok(fetchCalls[0].signal instanceof AbortSignal)
  assert.deepEqual(llmCalls, [], 'models.dev refresh must not call DSH LLM methods')

  const summary = await command.handler({ rawInput: 'snapshot' })
  assert.equal(summary.kind, 'success')
  assert.match(summary.text, /Model IDs: 1/u)
  const model = await command.handler({ rawInput: 'snapshot gpt-4o' })
  assert.equal(model.kind, 'success')
  assert.match(model.text, /Context|Limits: context=128000/u)
  assert.match(model.text, /not establish DSH provider availability/u)
  assert.deepEqual(llmCalls, [], 'snapshot display must not query live DSH metadata')
})

test('accepts a large catalog only when the Web provider returns it as complete', async () => {
  const content = JSON.stringify({ openai: { models: {
    'gpt-4o': { id: 'gpt-4o', description: 'x'.repeat(150_000), limit: { context: 128_000 } },
  } } })
  assert.ok(content.length > 100_000, 'models.dev catalog may exceed web-fetch-http default maxBodyChars')
  const command = createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    web: { async fetch() {
      return { url: MODELS_DEV_SOURCE_URL, statusCode: 200, body: { kind: 'text', content }, truncated: false }
    } },
  })
  const result = await command.handler({ rawInput: 'refresh' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /1 model IDs/u)
  assert.doesNotMatch(result.text, /x{100}/u, 'unprojected provider fields must not appear in output')
})

test('models.dev refresh remains disabled unless explicitly opted in', async () => {
  let fetchCalls = 0
  const command = createModelCapabilitiesCommand(undefined, {
    web: { async fetch() { fetchCalls += 1; return modelsDevResponse() } },
  })
  const result = await command.handler({ rawInput: 'refresh' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /disabled/u)
  assert.equal(fetchCalls, 0)
})

test('models.dev refresh rejects missing, ambiguous, and malformed web responses without leaking data', async () => {
  const missing = await createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
  }).handler({ rawInput: 'refresh' })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /DSH Web fetch is unavailable/u)

  const secret = 'private provider endpoint token'
  const ambiguous = await createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    web: { async fetch() { throw Object.assign(new Error(secret), { code: 'WEB_PROVIDER_AMBIGUOUS' }) } },
  }).handler({ rawInput: 'refresh' })
  assert.equal(ambiguous.kind, 'error')
  assert.match(ambiguous.text, /ambiguous/u)
  assert.doesNotMatch(ambiguous.text, new RegExp(secret, 'u'))
  for (const code of ['WEB_PROVIDER_UNAVAILABLE', 'WEB_PROVIDER_CONFIGURED_MISSING', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE']) {
    const unavailable = await createModelCapabilitiesCommand(undefined, {
      enableModelCapabilitiesRefresh: true,
      web: { async fetch() { throw Object.assign(new Error(secret), { code }) } },
    }).handler({ rawInput: 'refresh' })
    assert.equal(unavailable.kind, 'error')
    assert.match(unavailable.text, /No configured DSH Web fetch provider is usable/u)
    assert.doesNotMatch(unavailable.text, new RegExp(secret, 'u'))
  }

  const overDefaultProviderLimit = JSON.stringify({ provider: { models: {
    model: { id: 'model', description: 'x'.repeat(150_000) },
  } } })
  const invalid = [
    ['HTTP failure', modelsDevResponse(undefined, { statusCode: 503 })],
    ['reported URL mismatch', modelsDevResponse(undefined, { url: 'https://redirect.example/api.json' })],
    ['truncation', modelsDevResponse(undefined, { truncated: true, body: { kind: 'text', content: overDefaultProviderLimit } })],
    ['HTML body', modelsDevResponse(undefined, { body: { kind: 'html', content: '<html>blocked</html>' } })],
    ['invalid JSON', modelsDevResponse(undefined, { body: { kind: 'text', content: '{' } })],
    ['invalid shape', modelsDevResponse([], {})],
    ['oversized body', modelsDevResponse(undefined, { body: { kind: 'text', content: 'x'.repeat(MAX_MODELS_DEV_RESPONSE_BYTES + 1) } })],
  ]
  for (const [label, response] of invalid) {
    const calls = []
    const command = createModelCapabilitiesCommand(undefined, {
      enableModelCapabilitiesRefresh: true,
      web: { async fetch(request) { calls.push(request); return response } },
    })
    const result = await command.handler({ rawInput: 'refresh' })
    assert.equal(result.kind, 'error', label)
    if (label === 'truncation') assert.match(result.text, /maxBodyChars and maxResponseBytes/u)
    assert.deepEqual(calls, [{ url: MODELS_DEV_SOURCE_URL }], label)
    const view = await command.handler({ rawInput: 'snapshot' })
    assert.equal(view.kind, 'error', `${label}: a failed refresh must not create a snapshot`)
    assert.doesNotMatch(result.text, /blocked|private provider/u, label)
  }
})

test('failed refresh preserves the last known in-memory snapshot', async () => {
  const responses = [modelsDevResponse(), modelsDevResponse(undefined, { truncated: true })]
  const command = createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    web: { async fetch() { return responses.shift() } },
  })
  assert.equal((await command.handler({ rawInput: 'refresh' })).kind, 'success')
  assert.equal((await command.handler({ rawInput: 'refresh' })).kind, 'error')
  const summary = await command.handler({ rawInput: 'snapshot' })
  assert.equal(summary.kind, 'success')
  assert.match(summary.text, /Model IDs: 1/u)
  assert.match(summary.text, /in-memory/u)
})

test('caller and plugin cancellation plus deadline promptly settle ignored web requests', async () => {
  let callerFetchSignal
  const caller = new AbortController()
  const callerCommand = createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    web: { fetch(_request, signal) { callerFetchSignal = signal; return new Promise(() => {}) } },
  })
  const callerPending = callerCommand.handler({ rawInput: 'refresh', signal: caller.signal })
  assert.ok(callerFetchSignal)
  caller.abort()
  const callerResult = await callerPending
  assert.equal(callerResult.kind, 'error')
  assert.match(callerResult.text, /canceled/u)
  assert.equal(callerFetchSignal.aborted, true)

  const lateController = new AbortController()
  let resolveLate
  const lateCommand = createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    web: { fetch() { return new Promise(resolve => { resolveLate = resolve }) } },
  })
  const latePending = lateCommand.handler({ rawInput: 'refresh', signal: lateController.signal })
  lateController.abort()
  assert.equal((await latePending).kind, 'error')
  resolveLate(modelsDevResponse())
  await new Promise(resolve => setImmediate(resolve))
  const lateSnapshot = await lateCommand.handler({ rawInput: 'snapshot' })
  assert.equal(lateSnapshot.kind, 'error', 'a response after cancellation must not publish a snapshot')

  const lifecycle = new AbortController()
  let lifecycleFetchSignal
  const lifecycleCommand = createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    lifecycleSignal: lifecycle.signal,
    web: { fetch(_request, signal) { lifecycleFetchSignal = signal; return new Promise(() => {}) } },
  })
  const lifecyclePending = lifecycleCommand.handler({ rawInput: 'refresh' })
  lifecycle.abort()
  const lifecycleResult = await lifecyclePending
  assert.equal(lifecycleResult.kind, 'error')
  assert.match(lifecycleResult.text, /canceled/u)
  assert.equal(lifecycleFetchSignal.aborted, true)

  let timeoutFetchSignal
  const timeoutCommand = createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    refreshTimeoutMs: 10,
    web: { fetch(_request, signal) { timeoutFetchSignal = signal; return new Promise(() => {}) } },
  })
  const timeoutResult = await timeoutCommand.handler({ rawInput: 'refresh' })
  assert.equal(timeoutResult.kind, 'error')
  assert.match(timeoutResult.text, /timed out after 10 ms/u)
  assert.equal(timeoutFetchSignal.aborted, true)
})

test('untrusted snapshot labels remain inside dynamic Markdown code spans', async () => {
  const modelId = '`<img src=x onerror=1>`'
  const family = '[click](https://example.test)'
  const raw = { provider: { models: { alias: { id: modelId, family } } } }
  const command = createModelCapabilitiesCommand(undefined, {
    enableModelCapabilitiesRefresh: true,
    web: { async fetch() { return modelsDevResponse(raw) } },
  })
  assert.equal((await command.handler({ rawInput: 'refresh' })).kind, 'success')
  const view = await command.handler({ rawInput: `snapshot ${modelId}` })
  assert.equal(view.kind, 'success')
  assert.ok(view.text.includes(`\`\` ${modelId} \`\``))
  assert.ok(view.text.includes(`\`${family}\``))
})
