import { MODELS_DEV_SOURCE_URL, parseModelsDevSnapshot } from './models-dev-snapshot.js'

const MAX_INPUT_CHARS = 512
const MAX_ROWS = 100
const MAX_PROVIDER_LOOKUP_SCAN = 1_024
const MAX_FIELD_CHARS = 240
const MAX_OUTPUT_CHARS = 12_000
const MODEL_LOOKUP_TIMEOUT_MS = 15_000
const MODELS_DEV_REFRESH_TIMEOUT_MS = 5_000
const ABORTED = Symbol('models.dev refresh cancelled')

function result(kind, text) {
  return { kind, text: text.slice(0, MAX_OUTPUT_CHARS) }
}

function clean(value, maxChars = MAX_FIELD_CHARS, fallback = 'unknown') {
  if (typeof value !== 'string') return fallback
  const wasLong = value.length > maxChars
  const bounded = wasLong ? value.slice(0, maxChars + 1) : value
  const normalized = bounded.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!normalized) return fallback
  return wasLong || normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized
}

function safeErrorName(error) {
  try {
    const name = error instanceof Error && typeof error.name === 'string' ? clean(error.name, 80, 'Error') : 'UnknownError'
    return markdownCodeSpan(name)
  } catch {
    return markdownCodeSpan('UnknownError')
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
      .map(effort => markdownCodeSpan(clean(effort.id, 80)))
      .join(', ') || 'unavailable'
    : 'unavailable'
  const defaultEffort = isRecord(info.reasoning) ? clean(info.reasoning.defaultEffort, 80, 'unspecified') : 'unavailable'
  return result('success', [
    'Live DSH model metadata (catalog and capabilities are advisory; this does not issue a model request).',
    `Provider: ${markdownCodeSpan(clean(provider))}`,
    `Model: ${markdownCodeSpan(clean(model))}`,
    `Context window: ${contextWindow}`,
    `Default maximum output tokens: ${maxTokens}`,
    `Input modalities: ${modalities}`,
    `Reasoning efforts: ${efforts}`,
    `Default reasoning effort: ${markdownCodeSpan(defaultEffort)}`,
  ].join('\n'))
}

async function listProviders(llm, signal, lifecycleSignal, timeoutMs) {
  if (!serviceHas(llm, 'listProviders')) return result('error', 'The DSH LLM provider catalog is unavailable in this profile.')
  let lookupSignal
  try {
    lookupSignal = boundedLookupSignal(signal, lifecycleSignal, timeoutMs)
    const rows = await awaitWithSignal(() => llm.listProviders(), lookupSignal)
    if (lookupSignal.aborted) throw ABORTED
    if (!Array.isArray(rows)) return result('error', 'DSH returned an invalid provider catalog.')
    return formatRows('Registered DSH LLM providers:', rows, row => {
      if (!isRecord(row)) return '- (invalid provider row)'
      return `- ${markdownCodeSpan(clean(row.id))} — ${markdownCodeSpan(clean(row.name))}`
    })
  } catch (error) {
    if (signal?.aborted || lifecycleSignal?.aborted) return result('error', 'Provider catalog lookup was canceled.')
    if (lookupSignal?.aborted) return result('error', 'Provider catalog lookup timed out.')
    return result('error', `Could not list DSH LLM providers (${safeErrorName(error)}).`)
  }
}

async function findProvider(llm, id, signal) {
  if (!serviceHas(llm, 'listProviders')) return undefined
  const rows = await awaitWithSignal(() => llm.listProviders(), signal)
  if (signal.aborted) throw ABORTED
  if (!Array.isArray(rows)) throw new TypeError('invalid provider catalog')
  const provider = rows.slice(0, MAX_PROVIDER_LOOKUP_SCAN).find(row => isRecord(row) && row.id === id)
  if (provider) return provider
  return rows.length > MAX_PROVIDER_LOOKUP_SCAN ? PROVIDER_LOOKUP_INDETERMINATE : undefined
}

function boundedLookupSignal(signal, lifecycleSignal, timeoutMs) {
  const parents = [signal, lifecycleSignal].filter(value => value !== undefined && value !== null)
  if (parents.some(value => !validSignal(value))) throw new TypeError('Invalid model lookup cancellation signal.')
  return AbortSignal.any([...parents, AbortSignal.timeout(timeoutMs)])
}

async function resolveModel(llm, provider, model, signal, lifecycleSignal, timeoutMs) {
  if (!serviceHas(llm, 'resolveModelInfo')) return result('error', 'Exact DSH model capability lookup is unavailable in this profile.')
  let lookupSignal
  try {
    lookupSignal = boundedLookupSignal(signal, lifecycleSignal, timeoutMs)
    const providerRow = await findProvider(llm, provider, lookupSignal)
    if (providerRow === PROVIDER_LOOKUP_INDETERMINATE) {
      return result('error', `Provider presence is indeterminate: the DSH catalog exceeds the ${MAX_PROVIDER_LOOKUP_SCAN}-entry exact lookup limit.`)
    }
    if (!providerRow) return result('error', `Provider ${markdownCodeSpan(clean(provider))} is not registered with DSH LLM.`)
    const info = await awaitWithSignal(() => llm.resolveModelInfo(provider, model, lookupSignal), lookupSignal)
    if (lookupSignal.aborted) throw ABORTED
    return displayModelInfo(providerRow.id, model, info)
  } catch (error) {
    if (signal?.aborted || lifecycleSignal?.aborted) return result('error', 'Model capability lookup was canceled.')
    if (lookupSignal?.aborted) return result('error', 'Model capability lookup timed out.')
    return result('error', `Could not resolve ${markdownCodeSpan(clean(provider))}/${markdownCodeSpan(clean(model))} metadata (${safeErrorName(error)}).`)
  }
}

class ModelsDevRefreshError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ModelsDevRefreshError'
  }
}

function validSignal(signal) {
  return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'
}

function awaitWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(ABORTED)
  let pending
  try { pending = operation() } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      try { signal.removeEventListener('abort', onAbort) } catch {}
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(ABORTED)
    }
    Promise.resolve(pending).then(value => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function createRefreshSignal(callerSignal, lifecycleSignal, timeoutMs) {
  const parents = [callerSignal, lifecycleSignal].filter(signal => signal !== undefined && signal !== null)
  if (parents.some(signal => !validSignal(signal))) throw new ModelsDevRefreshError('A cancellation signal was invalid.')
  const deadline = AbortSignal.timeout(timeoutMs)
  return { signal: AbortSignal.any([...parents, deadline]), deadline }
}

function errorCode(error) {
  try { return typeof error?.code === 'string' ? error.code : undefined } catch { return undefined }
}

function webFailureMessage(error) {
  const code = errorCode(error)
  if (code === 'WEB_PROVIDER_AMBIGUOUS') return 'DSH Web provider selection is ambiguous.'
  if (code === 'WEB_PROVIDER_UNAVAILABLE' || code === 'WEB_PROVIDER_CONFIGURED_MISSING'
    || code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE') return 'No configured DSH Web fetch provider is usable.'
  return `DSH Web fetch failed (${safeErrorName(error)}).`
}

function markdownCodeSpan(value) {
  let longestRun = 0
  for (const run of value.match(/`+/gu) ?? []) longestRun = Math.max(longestRun, run.length)
  const fence = '`'.repeat(longestRun + 1)
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${value}${padding}${fence}`
}

function cleanSnapshotLabel(value) {
  return clean(value).replace(/[\u2028\u2029\p{Bidi_Control}]/gu, ' ')
}

function displayModelsDevSummary(snapshot) {
  return result('success', [
    'Advisory in-memory models.dev capability snapshot; this is not DSH provider availability or route validation.',
    `Source: ${MODELS_DEV_SOURCE_URL}`,
    `Generated at: ${clean(snapshot.generatedAt, 64)}`,
    `Model IDs: ${snapshot.modelCount}`,
    'Use /omo-models snapshot <model-id> to inspect one exact catalog entry.',
  ].join('\n'))
}

function displayModelsDevEntry(snapshot, rawModelId) {
  const entry = snapshot.models.get(rawModelId.toLowerCase())
  if (!entry) return result('error', `No model ID ${markdownCodeSpan(cleanSnapshotLabel(rawModelId))} is present in the current in-memory models.dev snapshot.`)
  const bool = value => typeof value === 'boolean' ? (value ? 'yes' : 'no') : 'unreported'
  const modalityList = values => Array.isArray(values) && values.length > 0
    ? values.map(value => markdownCodeSpan(clean(value, 64))).join(', ')
    : 'unreported'
  const limits = isRecord(entry.limit)
    ? `context=${positiveInteger(entry.limit.context)}, input=${positiveInteger(entry.limit.input)}, output=${positiveInteger(entry.limit.output)}`
    : 'unreported'
  return result('success', [
    'Advisory models.dev capability metadata; this does not establish DSH provider availability, compatibility, or route validity.',
    `Model ID: ${markdownCodeSpan(clean(entry.id))}`,
    `Family: ${entry.family ? markdownCodeSpan(clean(entry.family)) : 'unreported'}`,
    `Reasoning: ${bool(entry.reasoning)}`,
    `Temperature: ${bool(entry.temperature)}`,
    `Tool calls: ${bool(entry.toolCall)}`,
    `Input modalities: ${modalityList(entry.modalities?.input)}`,
    `Output modalities: ${modalityList(entry.modalities?.output)}`,
    `Limits: ${limits}`,
    `Snapshot generated at: ${clean(snapshot.generatedAt, 64)}`,
  ].join('\n'))
}

async function fetchModelsDevSnapshot(web, callerSignal, lifecycleSignal, timeoutMs, trackFetch) {
  if (!serviceHas(web, 'fetch')) throw new ModelsDevRefreshError('DSH Web fetch is unavailable in this profile.')
  const { signal, deadline } = createRefreshSignal(callerSignal, lifecycleSignal, timeoutMs)
  const abortMessage = () => callerSignal?.aborted || lifecycleSignal?.aborted
    ? 'models.dev refresh was canceled.'
    : deadline.aborted ? `models.dev refresh timed out after ${timeoutMs} ms.` : 'models.dev refresh was canceled.'
  if (signal.aborted) throw new ModelsDevRefreshError(abortMessage())

  let response
  try {
    response = await awaitWithSignal(() => {
      const pending = Promise.resolve(web.fetch({ url: MODELS_DEV_SOURCE_URL }, signal))
      trackFetch(pending)
      return pending
    }, signal)
  } catch (error) {
    if (signal.aborted) throw new ModelsDevRefreshError(abortMessage())
    throw new ModelsDevRefreshError(`Could not retrieve the fixed models.dev source (${webFailureMessage(error)}).`)
  }
  if (signal.aborted) throw new ModelsDevRefreshError(abortMessage())
  if (!isRecord(response) || typeof response.url !== 'string' || !Number.isSafeInteger(response.statusCode)
    || !isRecord(response.body) || response.body.kind !== 'text' || typeof response.body.content !== 'string') {
    throw new ModelsDevRefreshError('DSH Web returned an invalid models.dev response shape.')
  }
  if (response.truncated !== false) {
    throw new ModelsDevRefreshError('DSH Web did not confirm a complete response. Configure the selected provider to return the full catalog; web-fetch-http may require higher maxBodyChars and maxResponseBytes.')
  }
  // WebFetchResult.url has no final-URL guarantee; this only checks the reported value after retrieval.
  if (response.url !== MODELS_DEV_SOURCE_URL) {
    throw new ModelsDevRefreshError('DSH Web reported a URL different from the requested fixed source. This post-fetch check does not prevent provider redirects.')
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ModelsDevRefreshError(`models.dev returned HTTP ${response.statusCode}; no snapshot was accepted.`)
  }
  try {
    return parseModelsDevSnapshot(response.body.content)
  } catch (error) {
    if (error?.code === 'MODELS_DEV_TOO_LARGE') {
      throw new ModelsDevRefreshError('models.dev response exceeded the 8 MiB post-fetch size limit.')
    }
    throw new ModelsDevRefreshError(`models.dev response was invalid (${safeErrorName(error)}); no snapshot was accepted.`)
  }
}

/** Create a bounded DSH LLM diagnostic with an optional manual models.dev snapshot. */
export function createModelCapabilitiesCommand(llm, options = {}) {
  const refreshEnabled = options.enableModelCapabilitiesRefresh === true
  const web = options.web
  const lifecycleSignal = options.lifecycleSignal
  const lookupTimeoutMs = Number.isSafeInteger(options.lookupTimeoutMs)
    && options.lookupTimeoutMs > 0 && options.lookupTimeoutMs <= MODEL_LOOKUP_TIMEOUT_MS
    ? options.lookupTimeoutMs
    : MODEL_LOOKUP_TIMEOUT_MS
  const refreshTimeoutMs = Number.isSafeInteger(options.refreshTimeoutMs)
    && options.refreshTimeoutMs > 0 && options.refreshTimeoutMs <= MODELS_DEV_REFRESH_TIMEOUT_MS
    ? options.refreshTimeoutMs
    : MODELS_DEV_REFRESH_TIMEOUT_MS
  const snapshotState = { current: undefined, refreshing: false, pendingFetch: undefined }
  const trackFetch = pending => {
    snapshotState.pendingFetch = pending
    const release = () => {
      if (snapshotState.pendingFetch === pending) snapshotState.pendingFetch = undefined
    }
    // Caller cancellation ends only the local wait, not backend ownership.
    pending.then(release, release)
  }
  const hint = refreshEnabled ? '[provider/model|refresh|snapshot [model-id]]' : '[provider/model]'
  return {
    name: 'omo-models',
    description: refreshEnabled
      ? 'Inspect native DSH model metadata; optionally refresh and view an advisory in-memory models.dev snapshot only when the user explicitly invokes refresh.'
      : 'Inspect provider and model capability metadata from the native DSH LLM service; this does not send a model request.',
    input: { hint },
    async handler(args = {}) {
      const rawInput = args?.rawInput
      if (typeof rawInput !== 'string' || rawInput.length > MAX_INPUT_CHARS) {
        return result('error', `Usage: /omo-models ${hint} (maximum ${MAX_INPUT_CHARS} input characters).`)
      }
      const input = rawInput.trim()
      if (input === 'refresh') {
        if (!refreshEnabled) return result('error', 'models.dev refresh is disabled; set enableModelCapabilitiesRefresh to true.')
        if (snapshotState.refreshing || snapshotState.pendingFetch) return result('error', 'A models.dev refresh is already in progress; its backend request may still be pending after cancellation.')
        snapshotState.refreshing = true
        try {
          const snapshot = await fetchModelsDevSnapshot(web, args?.signal, lifecycleSignal, refreshTimeoutMs, trackFetch)
          snapshotState.current = snapshot
          return result('success', [
            `Refreshed the in-memory models.dev snapshot (${snapshot.modelCount} model IDs).`,
            `Generated at: ${clean(snapshot.generatedAt, 64)}`,
            'The metadata is advisory only; no DSH route or launch decision was changed.',
            'Use /omo-models snapshot to inspect the summary or /omo-models snapshot <model-id> for one entry.',
          ].join('\n'))
        } catch (error) {
          const reason = error instanceof ModelsDevRefreshError
            ? error.message
            : `models.dev refresh failed (${safeErrorName(error)}).`
          return result('error', `${reason} No new snapshot was accepted${snapshotState.current ? '; the prior in-memory snapshot was preserved.' : '.'}`)
        } finally {
          snapshotState.refreshing = false
        }
      }
      if (input === 'snapshot' || input.startsWith('snapshot ')) {
        if (!refreshEnabled) return result('error', 'models.dev snapshot viewing is disabled; set enableModelCapabilitiesRefresh to true.')
        const snapshot = snapshotState.current
        if (!snapshot) return result('error', 'No in-memory models.dev snapshot is available; run /omo-models refresh explicitly first.')
        if (input === 'snapshot') return displayModelsDevSummary(snapshot)
        const modelId = input.slice('snapshot '.length).trim()
        if (!modelId || modelId.length > MAX_INPUT_CHARS) {
          return result('error', 'Use /omo-models snapshot <model-id> with a non-empty model ID of at most 512 characters.')
        }
        return displayModelsDevEntry(snapshot, modelId)
      }
      if (!input) return listProviders(llm, args?.signal, lifecycleSignal, lookupTimeoutMs)

      const separator = input.indexOf('/')
      if (separator < 1 || separator === input.length - 1) {
        return result('error', `Use /omo-models to list registered providers, /omo-models <provider>/<model> for live DSH metadata${refreshEnabled ? ', /omo-models refresh for an explicit models.dev refresh, or /omo-models snapshot [model-id] for the in-memory advisory snapshot' : ''}.`)
      }
      const provider = input.slice(0, separator).trim()
      const model = input.slice(separator + 1).trim()
      if (!provider || !model) return result('error', 'Provider and model names must not be empty.')
      return resolveModel(llm, provider, model, args?.signal, lifecycleSignal, lookupTimeoutMs)
    },
  }
}
