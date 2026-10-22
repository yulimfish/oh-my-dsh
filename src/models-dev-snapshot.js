export const MODELS_DEV_SOURCE_URL = 'https://models.dev/api.json'
export const MAX_MODELS_DEV_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_MODELS_DEV_PROVIDERS = 512
export const MAX_MODELS_DEV_MODELS = 100_000

const MAX_MODEL_ID_BYTES = 256
const MAX_FAMILY_BYTES = 128
const MAX_MODALITY_COUNT = 16
const MAX_MODALITY_BYTES = 32
const MAX_LIMIT = 1_000_000_000
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/u

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeString(value, maxBytes) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes
    || CONTROL_OR_BIDI.test(value)) return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function positiveLimit(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_LIMIT ? value : undefined
}

function readStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const result = []
  const seen = new Set()
  for (const item of value.slice(0, MAX_MODALITY_COUNT)) {
    const normalized = safeString(item, MAX_MODALITY_BYTES)
    if (normalized !== undefined && !seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result.length > 0 ? result : undefined
}

function normalizeEntry(rawModelId, rawModel) {
  if (!isRecord(rawModel)) return undefined
  const id = safeString(rawModel.id, MAX_MODEL_ID_BYTES) ?? safeString(rawModelId, MAX_MODEL_ID_BYTES)
  if (!id) return undefined

  const family = safeString(rawModel.family, MAX_FAMILY_BYTES)
  const rawModalities = isRecord(rawModel.modalities) ? rawModel.modalities : undefined
  const input = readStringArray(rawModalities?.input)
  const output = readStringArray(rawModalities?.output)
  const modalities = input || output
    ? { ...(input ? { input } : {}), ...(output ? { output } : {}) }
    : undefined

  const rawLimit = isRecord(rawModel.limit) ? rawModel.limit : undefined
  const context = positiveLimit(rawLimit?.context)
  const maxInput = positiveLimit(rawLimit?.input)
  const maxOutput = positiveLimit(rawLimit?.output)
  const limit = context !== undefined || maxInput !== undefined || maxOutput !== undefined
    ? {
        ...(context !== undefined ? { context } : {}),
        ...(maxInput !== undefined ? { input: maxInput } : {}),
        ...(maxOutput !== undefined ? { output: maxOutput } : {}),
      }
    : undefined

  return {
    id,
    ...(family ? { family } : {}),
    ...(typeof rawModel.reasoning === 'boolean' ? { reasoning: rawModel.reasoning } : {}),
    ...(typeof rawModel.temperature === 'boolean' ? { temperature: rawModel.temperature } : {}),
    ...(typeof rawModel.tool_call === 'boolean' ? { toolCall: rawModel.tool_call } : {}),
    ...(modalities ? { modalities } : {}),
    ...(limit ? { limit } : {}),
  }
}

function mergeEntry(existing, incoming) {
  if (!existing) return incoming
  const modalities = existing.modalities || incoming.modalities
    ? { ...existing.modalities, ...incoming.modalities }
    : undefined
  const limit = existing.limit || incoming.limit
    ? { ...existing.limit, ...incoming.limit }
    : undefined
  return {
    ...existing,
    ...incoming,
    ...(modalities ? { modalities } : {}),
    ...(limit ? { limit } : {}),
  }
}

function freezeModelEntry(entry) {
  if (entry.modalities) {
    if (entry.modalities.input) Object.freeze(entry.modalities.input)
    if (entry.modalities.output) Object.freeze(entry.modalities.output)
    Object.freeze(entry.modalities)
  }
  if (entry.limit) Object.freeze(entry.limit)
  return Object.freeze(entry)
}

class ReadonlyModelMap extends Map {
  #sealed = false

  constructor(entries) {
    super()
    for (const [key, value] of entries) super.set(key, value)
    this.#sealed = true
    Object.freeze(this)
  }

  set(key, value) {
    if (this.#sealed) throw new TypeError('models.dev snapshot models are read-only.')
    return super.set(key, value)
  }

  delete(key) {
    if (this.#sealed) throw new TypeError('models.dev snapshot models are read-only.')
    return super.delete(key)
  }

  clear() {
    if (this.#sealed) throw new TypeError('models.dev snapshot models are read-only.')
    return super.clear()
  }
}

export function buildModelsDevSnapshot(raw, generatedAt = new Date().toISOString()) {
  if (!isRecord(raw)) throw new TypeError('models.dev data must be a JSON object.')
  if (typeof generatedAt !== 'string' || generatedAt.length > 64 || !Number.isFinite(Date.parse(generatedAt))) {
    throw new TypeError('snapshot timestamp is invalid.')
  }
  const providers = Object.entries(raw)
  if (providers.length === 0 || providers.length > MAX_MODELS_DEV_PROVIDERS) {
    throw new RangeError(`models.dev provider count must be between 1 and ${MAX_MODELS_DEV_PROVIDERS}.`)
  }

  const models = new Map()
  let scannedModels = 0
  for (const [, provider] of providers) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue
    for (const [rawModelId, rawModel] of Object.entries(provider.models)) {
      scannedModels += 1
      if (scannedModels > MAX_MODELS_DEV_MODELS) {
        throw new RangeError(`models.dev model count exceeds ${MAX_MODELS_DEV_MODELS}.`)
      }
      const entry = normalizeEntry(rawModelId, rawModel)
      if (!entry) continue
      const key = entry.id.toLowerCase()
      models.set(key, mergeEntry(models.get(key), entry))
    }
  }
  if (models.size === 0) throw new TypeError('models.dev data did not contain any valid model capability entries.')
  for (const [key, entry] of models) models.set(key, freezeModelEntry(entry))
  const readonlyModels = new ReadonlyModelMap(models)
  return Object.freeze({
    sourceUrl: MODELS_DEV_SOURCE_URL,
    generatedAt,
    modelCount: readonlyModels.size,
    models: readonlyModels,
  })
}

export function parseModelsDevSnapshot(content) {
  if (typeof content !== 'string') throw new TypeError('models.dev response body must be text.')
  if (Buffer.byteLength(content, 'utf8') > MAX_MODELS_DEV_RESPONSE_BYTES) {
    const error = new RangeError(`models.dev response exceeds ${MAX_MODELS_DEV_RESPONSE_BYTES} bytes.`)
    error.code = 'MODELS_DEV_TOO_LARGE'
    throw error
  }
  let raw
  try {
    raw = JSON.parse(content)
  } catch {
    throw new TypeError('models.dev response is not valid JSON.')
  }
  return buildModelsDevSnapshot(raw)
}
