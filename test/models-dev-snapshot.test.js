import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildModelsDevSnapshot,
  MAX_MODELS_DEV_MODELS,
  MAX_MODELS_DEV_PROVIDERS,
  MAX_MODELS_DEV_RESPONSE_BYTES,
  MODELS_DEV_SOURCE_URL,
  parseModelsDevSnapshot,
} from '../src/models-dev-snapshot.js'

function providerWithModels(models) {
  return { provider: { models } }
}

test('normalizes only advisory model fields and merges duplicate IDs case-insensitively', () => {
  const snapshot = buildModelsDevSnapshot({
    openai: {
      models: {
        'gpt-4o': {
          id: 'GPT-4o', family: 'gpt-4', reasoning: true, temperature: false, tool_call: true,
          modalities: { input: ['text', 'image', 'text'], output: ['text'] },
          limit: { context: 128_000, input: 100_000, output: 16_384 },
          description: 'must not be retained', api_key: 'must not be retained',
        },
      },
    },
    mirror: {
      models: {
        alias: { id: 'gpt-4o', family: 'gpt-4.1', reasoning: false, modalities: { input: ['audio'] }, limit: { output: 8_192 } },
      },
    },
  }, '2025-01-01T00:00:00.000Z')

  assert.equal(snapshot.sourceUrl, MODELS_DEV_SOURCE_URL)
  assert.equal(snapshot.generatedAt, '2025-01-01T00:00:00.000Z')
  assert.equal(snapshot.modelCount, 1)
  const entry = snapshot.models.get('gpt-4o')
  assert.equal(entry.id, 'gpt-4o')
  assert.equal(entry.family, 'gpt-4.1')
  assert.equal(entry.reasoning, false)
  assert.equal(entry.temperature, false)
  assert.equal(entry.toolCall, true)
  assert.deepEqual(entry.modalities, { input: ['audio'], output: ['text'] })
  assert.deepEqual(entry.limit, { context: 128_000, input: 100_000, output: 8_192 })
  assert.equal(Object.hasOwn(entry, 'description'), false)
  assert.equal(Object.hasOwn(entry, 'api_key'), false)
  assert.equal(Object.isFrozen(snapshot), true)
})

test('parses bounded JSON and rejects malformed, empty, or structurally invalid catalog data', () => {
  const snapshot = parseModelsDevSnapshot(JSON.stringify(providerWithModels({
    sample: { reasoning: true, limit: { context: 32_000 } },
  })))
  assert.equal(snapshot.modelCount, 1)
  assert.equal(Number.isFinite(Date.parse(snapshot.generatedAt)), true)

  assert.throws(() => parseModelsDevSnapshot('{'), /valid JSON/u)
  assert.throws(() => parseModelsDevSnapshot('[]'), /JSON object/u)
  assert.throws(() => parseModelsDevSnapshot('{}'), /provider count/u)
  assert.throws(() => buildModelsDevSnapshot({ provider: { models: {} } }), /valid model capability entries/u)
  assert.throws(() => buildModelsDevSnapshot({ provider: { models: { x: null } } }), /valid model capability entries/u)
  assert.throws(() => buildModelsDevSnapshot(providerWithModels({ x: {} }), 'not-a-timestamp'), /timestamp/u)
})

test('rejects overlarge response, provider catalogs, and model-entry scans', () => {
  assert.throws(
    () => parseModelsDevSnapshot(' '.repeat(MAX_MODELS_DEV_RESPONSE_BYTES + 1)),
    error => error?.code === 'MODELS_DEV_TOO_LARGE',
  )
  assert.throws(
    () => buildModelsDevSnapshot(Object.fromEntries(Array.from({ length: MAX_MODELS_DEV_PROVIDERS + 1 }, (_, index) => [`p${index}`, {}]))),
    /provider count/u,
  )
  const tooManyModels = Object.fromEntries(Array.from({ length: MAX_MODELS_DEV_MODELS + 1 }, (_, index) => [`m${index}`, null]))
  assert.throws(() => buildModelsDevSnapshot(providerWithModels(tooManyModels)), /model count exceeds/u)
})

test('drops unsafe identifiers and modality strings, and rejects unusable numeric limits', () => {
  const snapshot = buildModelsDevSnapshot(providerWithModels({
    'safe-model': {
      id: 'safe-model', family: `family\u202e`, reasoning: 'true', temperature: true, tool_call: false,
      modalities: { input: ['text', 'x'.repeat(40), 'bad\u0000value', 'bad\u2028line'], output: ['image'] },
      limit: { context: -1, input: 12.5, output: 1_000_000_001 },
    },
    [`bad\u0000id`]: { id: 'bad\u0000id' },
  }))
  assert.equal(snapshot.modelCount, 1)
  const entry = snapshot.models.get('safe-model')
  assert.equal(entry.family, undefined)
  assert.equal(entry.reasoning, undefined)
  assert.equal(entry.temperature, true)
  assert.equal(entry.toolCall, false)
  assert.deepEqual(entry.modalities, { input: ['text'], output: ['image'] })
  assert.equal(entry.limit, undefined)
})
