const MAX_INPUT_CHARS = 512
const MAX_ROWS = 100
const MAX_PROVIDER_LOOKUP_SCAN = 1_024
const MAX_FIELD_CHARS = 240
const MAX_OUTPUT_CHARS = 12_000
const MODEL_LOOKUP_TIMEOUT_MS = 15_000

function result(kind, text) {
  return { kind, text: text.slice(0, MAX_OUTPUT_CHARS) }
}

function clean(value, maxChars = MAX_FIELD_CHARS, fallback = 'unknown') {
  if (typeof value !== 'string') return fallback
  const wasLong = value.length > maxChars
  const bounded = wasLong ? value.slice(0, maxChars + 1) : value
  const normalized = bounded.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!normalized) return fallback
  return wasLong || normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized
}

function safeErrorName(error) {
  try {
    return error instanceof Error && typeof error.name === 'string' ? clean(error.name, 80, 'Error') : 'UnknownError'
  } catch {
    return 'UnknownError'
  }
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const PROVIDER_LOOKUP_INDETERMINATE = Symbol('provider lookup indeterminate')

function serviceHas(service, method) {
  try {
    return service !== null && service !== undefined && typeof service[method] === 'function'
  } catch {
    return false
  }
}

function formatRows(title, rows, project) {
  const output = [title]
  let truncated = rows.length > MAX_ROWS
  for (const row of rows.slice(0, MAX_ROWS)) {
    const line = project(row)
    if (output.join('\n').length + line.length + 1 > MAX_OUTPUT_CHARS - 64) {
      truncated = true
      break
    }
    output.push(line)
  }
  if (truncated) output.push('…results truncated by dsh-omo.')
  if (rows.length === 0) output.push('(none advertised by the current DSH LLM service)')
  return result('success', output.join('\n'))
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : 'unavailable'
}

function displayModelInfo(provider, model, info) {
  if (!isRecord(info)) return result('error', 'DSH returned invalid model metadata.')
  const contextWindow = isRecord(info.context) ? positiveInteger(info.context.contextWindow) : 'unavailable'
  const maxTokens = positiveInteger(info.defaultMaxTokens)
  const modalities = Array.isArray(info.inputModalities)
    ? [...new Set(info.inputModalities.slice(0, 32).filter(value => value === 'text' || value === 'image'))].join(', ') || 'unavailable'
    : 'unavailable'
  const efforts = isRecord(info.reasoning) && Array.isArray(info.reasoning.efforts)
    ? info.reasoning.efforts.slice(0, 32)
      .filter(isRecord)
      .map(effort => clean(effort.id, 80))
      .join(', ') || 'unavailable'
    : 'unavailable'
  const defaultEffort = isRecord(info.reasoning) ? clean(info.reasoning.defaultEffort, 80, 'unspecified') : 'unavailable'
  return result('success', [
    'Live DSH model metadata (catalog and capabilities are advisory; this does not issue a model request).',
    `Provider: ${clean(provider)}`,
    `Model: ${clean(model)}`,
    `Context window: ${contextWindow}`,
    `Default maximum output tokens: ${maxTokens}`,
    `Input modalities: ${modalities}`,
    `Reasoning efforts: ${efforts}`,
    `Default reasoning effort: ${defaultEffort}`,
  ].join('\n'))
}

async function listProviders(llm) {
  if (!serviceHas(llm, 'listProviders')) return result('error', 'The DSH LLM provider catalog is unavailable in this profile.')
  try {
    const rows = await llm.listProviders()
    if (!Array.isArray(rows)) return result('error', 'DSH returned an invalid provider catalog.')
    return formatRows('Registered DSH LLM providers:', rows, row => {
      if (!isRecord(row)) return '- (invalid provider row)'
      return `- ${clean(row.id)} — ${clean(row.name)}`
    })
  } catch (error) {
    return result('error', `Could not list DSH LLM providers (${safeErrorName(error)}).`)
  }
}

async function findProvider(llm, id) {
  if (!serviceHas(llm, 'listProviders')) return undefined
  const rows = await llm.listProviders()
  if (!Array.isArray(rows)) throw new TypeError('invalid provider catalog')
  const provider = rows.slice(0, MAX_PROVIDER_LOOKUP_SCAN).find(row => isRecord(row) && row.id === id)
  if (provider) return provider
  return rows.length > MAX_PROVIDER_LOOKUP_SCAN ? PROVIDER_LOOKUP_INDETERMINATE : undefined
}

function boundedLookupSignal(signal) {
  const timeout = AbortSignal.timeout(MODEL_LOOKUP_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function resolveModel(llm, provider, model, signal) {
  if (!serviceHas(llm, 'resolveModelInfo')) return result('error', 'Exact DSH model capability lookup is unavailable in this profile.')
  if (signal?.aborted) return result('error', 'Model capability lookup was canceled.')
  let lookupSignal
  let removeAbortListener
  try {
    const providerRow = await findProvider(llm, provider)
    if (providerRow === PROVIDER_LOOKUP_INDETERMINATE) {
      return result('error', `Provider presence is indeterminate: the DSH catalog exceeds the ${MAX_PROVIDER_LOOKUP_SCAN}-entry exact lookup limit.`)
    }
    if (!providerRow) return result('error', `Provider "${clean(provider)}" is not registered with DSH LLM.`)
    lookupSignal = boundedLookupSignal(signal)
    if (lookupSignal.aborted) {
      return result('error', signal?.aborted ? 'Model capability lookup was canceled.' : 'Model capability lookup timed out.')
    }
    const aborted = new Promise((_, reject) => {
      const rejectOnAbort = () => reject(lookupSignal.reason ?? new Error('model capability lookup aborted'))
      if (lookupSignal.aborted) rejectOnAbort()
      else {
        lookupSignal.addEventListener('abort', rejectOnAbort, { once: true })
        removeAbortListener = () => lookupSignal.removeEventListener('abort', rejectOnAbort)
      }
    })
    const info = await Promise.race([
      Promise.resolve().then(() => llm.resolveModelInfo(provider, model, lookupSignal)),
      aborted,
    ])
    return displayModelInfo(providerRow.id, model, info)
  } catch (error) {
    if (signal?.aborted) return result('error', 'Model capability lookup was canceled.')
    if (lookupSignal?.aborted) return result('error', 'Model capability lookup timed out.')
    return result('error', `Could not resolve ${clean(provider)}/${clean(model)} metadata (${safeErrorName(error)}).`)
  } finally {
    removeAbortListener?.()
  }
}

/** Create a bounded, read-only command over the optional native DSH LLM catalog. */
export function createModelCapabilitiesCommand(llm) {
  return {
    name: 'omo-models',
    description: 'Inspect provider and model capability metadata from the native DSH LLM service; this does not send a model request.',
    input: { hint: '[provider/model]' },
    async handler(args = {}) {
      const rawInput = args?.rawInput
      if (typeof rawInput !== 'string' || rawInput.length > MAX_INPUT_CHARS) {
        return result('error', `Usage: /omo-models [provider/model] (maximum ${MAX_INPUT_CHARS} input characters).`)
      }
      const input = rawInput.trim()
      if (!input) return listProviders(llm)

      const separator = input.indexOf('/')
      if (separator < 1 || separator === input.length - 1) {
        return result('error', 'Use /omo-models to list registered providers or /omo-models <provider>/<model> for exact model metadata.')
      }
      const provider = input.slice(0, separator).trim()
      const model = input.slice(separator + 1).trim()
      if (!provider || !model) return result('error', 'Provider and model names must not be empty.')
      return resolveModel(llm, provider, model, args?.signal)
    },
  }
}
