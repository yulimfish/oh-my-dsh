const DEFAULT_RETRY_ON_STATUSES = Object.freeze([429, 500, 502, 503, 504])
const MAX_ROUTE_CHAINS = 32
const MAX_FALLBACKS_PER_CHAIN = 3
const MAX_RETRY_STATUSES = 10
const MAX_AGENT_STATES = 256
const MAX_PROVIDER_CHARS = 128
const MAX_MODEL_CHARS = 256
const MAX_REASONING_EFFORT_CHARS = 64
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
const POLICY_FIELDS = new Set(['enabled', 'retryOnStatuses', 'chains'])
const CHAIN_FIELDS = new Set(['provider', 'model', 'fallbacks'])
const ROUTE_FIELDS = new Set(['provider', 'model', 'reasoningEffort', 'maxTokens'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function assertFields(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unsupported field ${String(key)}`)
    }
  }
}

function normalizeString(value, label, maxChars) {
  if (typeof value !== 'string' || value.length > maxChars) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxChars} characters`)
  }
  const normalized = value.trim()
  if (!normalized || CONTROL_CHARACTERS.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxChars} characters without controls`)
  }
  return normalized
}

function normalizeRoute(value, label, allowSettings) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`)
  assertFields(value, allowSettings ? ROUTE_FIELDS : new Set(['provider', 'model']), label)
  const route = {
    provider: normalizeString(value.provider, `${label} provider`, MAX_PROVIDER_CHARS),
    model: normalizeString(value.model, `${label} model`, MAX_MODEL_CHARS),
  }
  if (allowSettings && value.reasoningEffort !== undefined) {
    route.reasoningEffort = normalizeString(value.reasoningEffort, `${label} reasoningEffort`, MAX_REASONING_EFFORT_CHARS)
  }
  if (allowSettings && value.maxTokens !== undefined) {
    if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1) {
      throw new TypeError(`${label} maxTokens must be a positive safe integer`)
    }
    route.maxTokens = value.maxTokens
  }
  return Object.freeze(route)
}

function routeKey(provider, model) {
  return JSON.stringify([provider, model])
}

function normalizeChain(value, index) {
  const label = `runtimeFallback chains[${index}]`
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`)
  assertFields(value, CHAIN_FIELDS, label)
  const primary = normalizeRoute({ provider: value.provider, model: value.model }, `${label} primary`, false)
  if (!Array.isArray(value.fallbacks) || value.fallbacks.length < 1 || value.fallbacks.length > MAX_FALLBACKS_PER_CHAIN) {
    throw new TypeError(`${label} fallbacks must contain between 1 and ${MAX_FALLBACKS_PER_CHAIN} routes`)
  }
  const seen = new Set([routeKey(primary.provider, primary.model)])
  const fallbacks = value.fallbacks.map((fallback, fallbackIndex) => {
    const route = normalizeRoute(fallback, `${label} fallbacks[${fallbackIndex}]`, true)
    const key = routeKey(route.provider, route.model)
    if (seen.has(key)) throw new TypeError(`${label} must not repeat a provider/model route`)
    seen.add(key)
    return route
  })
  return Object.freeze({ primary, fallbacks: Object.freeze(fallbacks) })
}

export function normalizeRuntimeFallback(input) {
  const value = input === undefined ? {} : input
  if (!isRecord(value)) throw new TypeError('runtimeFallback must be a plain object')
  assertFields(value, POLICY_FIELDS, 'runtimeFallback')

  const enabled = value.enabled === undefined ? false : value.enabled
  if (typeof enabled !== 'boolean') throw new TypeError('runtimeFallback enabled must be a boolean')

  const statusesInput = value.retryOnStatuses === undefined ? DEFAULT_RETRY_ON_STATUSES : value.retryOnStatuses
  if (!Array.isArray(statusesInput) || statusesInput.length > MAX_RETRY_STATUSES) {
    throw new TypeError(`runtimeFallback retryOnStatuses must be an array of at most ${MAX_RETRY_STATUSES} HTTP statuses`)
  }
  const statuses = []
  const seenStatuses = new Set()
  for (let index = 0; index < statusesInput.length; index += 1) {
    const status = statusesInput[index]
    if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
      throw new TypeError(`runtimeFallback retryOnStatuses[${index}] must be an integer from 400 through 599`)
    }
    if (seenStatuses.has(status)) throw new TypeError('runtimeFallback retryOnStatuses must not contain duplicates')
    seenStatuses.add(status)
    statuses.push(status)
  }

  const chainsInput = value.chains === undefined ? [] : value.chains
  if (!Array.isArray(chainsInput) || chainsInput.length > MAX_ROUTE_CHAINS) {
    throw new TypeError(`runtimeFallback chains must be an array of at most ${MAX_ROUTE_CHAINS} routes`)
  }
  const chains = chainsInput.map(normalizeChain)
  const seenPrimaries = new Set()
  for (const chain of chains) {
    const key = routeKey(chain.primary.provider, chain.primary.model)
    if (seenPrimaries.has(key)) throw new TypeError('runtimeFallback chains must not repeat a primary provider/model route')
    seenPrimaries.add(key)
  }
  if (enabled && chains.length === 0) throw new TypeError('runtimeFallback requires at least one chain when enabled')
  if (enabled && statuses.length === 0) throw new TypeError('runtimeFallback requires at least one retryable status when enabled')

  return Object.freeze({
    enabled,
    retryOnStatuses: Object.freeze(statuses),
    chains: Object.freeze(chains),
  })
}

function applyFallbackRoute(base, route) {
  const next = { ...base, provider: route.provider, model: route.model }
  if (route.reasoningEffort === undefined) delete next.reasoningEffort
  else next.reasoningEffort = route.reasoningEffort
  if (route.maxTokens !== undefined) next.maxTokens = route.maxTokens
  return next
}

function validPosition(payload) {
  return Number.isSafeInteger(payload?.turn) && payload.turn >= 0
    && Number.isSafeInteger(payload?.step) && payload.step >= 0
}

function validAgentId(payload) {
  return typeof payload?.agent?.id === 'string' && payload.agent.id.length > 0
}

function retryBudgetRemains(policy, failureCode, observedRetries) {
  if (policy === undefined) return false
  if (!isRecord(policy)) return true
  if (policy.mode === 'always') return true
  if (policy.mode !== 'normal'
    || !Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0
    || !Array.isArray(policy.retryableCodes)
    || policy.retryableCodes.some(code => typeof code !== 'string')
    || !Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0
    || !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0
    || !Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0) return true
  return policy.retryableCodes.includes(failureCode) && observedRetries < policy.maxRetries
}

function createController(policy, options = {}) {
  const chainsByPrimary = new Map(policy.chains.map(chain => [
    routeKey(chain.primary.provider, chain.primary.model),
    chain,
  ]))
  const retryStatuses = new Set(policy.retryOnStatuses)
  const states = new Map()
  const onFallback = typeof options.onFallback === 'function' ? options.onFallback : undefined
  let disposed = false

  async function onRequest(payload, next) {
    if (typeof next !== 'function') throw new TypeError('agent/request requires next()')
    const base = await next()
    if (!policy.enabled || disposed || !validAgentId(payload)) return base
    const agentId = payload.agent.id
    if (payload.signal?.aborted || !validPosition(payload)
      || !base || typeof base.provider !== 'string' || typeof base.model !== 'string') {
      states.delete(agentId)
      return base
    }

    const primaryKey = routeKey(base.provider, base.model)
    let state = states.get(agentId)
    if (state && (state.turn !== payload.turn || state.step !== payload.step || state.primaryKey !== primaryKey)) {
      states.delete(agentId)
      state = undefined
    }
    if (!state) {
      const chain = chainsByPrimary.get(primaryKey)
      if (!chain || states.size >= MAX_AGENT_STATES) return base
      state = { turn: payload.turn, step: payload.step, primaryKey, chain, fallbackIndex: 0, sameRouteRetries: 0 }
      states.set(agentId, state)
      return base
    }

    if (state.blocked || state.fallbackIndex === 0) return base
    const route = state.chain.fallbacks[state.fallbackIndex - 1]
    if (!route) {
      states.delete(agentId)
      return base
    }
    return applyFallbackRoute(base, route)
  }

  async function onRequestError(payload, next) {
    if (typeof next !== 'function') throw new TypeError('agent/request-error requires next()')
    const delegated = await next()
    if (!policy.enabled || disposed || !validAgentId(payload)) return delegated
    const agentId = payload.agent.id
    const state = states.get(agentId)
    if (!state) return delegated
    if (!validPosition(payload) || state.turn !== payload.turn || state.step !== payload.step) {
      states.delete(agentId)
      return delegated
    }
    if (state.blocked) return delegated
    if (payload.signal?.aborted) {
      state.blocked = true
      return delegated
    }

    const currentRoute = state.fallbackIndex === 0
      ? state.chain.primary
      : state.chain.fallbacks[state.fallbackIndex - 1]
    const failure = payload.failure
    if (!currentRoute || payload.provider !== currentRoute.provider
      || typeof failure?.code !== 'string' || !failure.code) {
      state.blocked = true
      return delegated
    }
    if (delegated?.kind === 'retry') {
      if (state.sameRouteRetries < Number.MAX_SAFE_INTEGER) state.sameRouteRetries += 1
      return delegated
    }
    if (retryBudgetRemains(payload.retryPolicy, failure.code, state.sameRouteRetries)) return delegated
    if (!retryStatuses.has(failure.status)) {
      state.blocked = true
      return delegated
    }

    const nextRoute = state.chain.fallbacks[state.fallbackIndex]
    if (!nextRoute) {
      state.blocked = true
      return delegated
    }
    state.fallbackIndex += 1
    state.sameRouteRetries = 0
    try {
      onFallback?.({
        turn: payload.turn,
        step: payload.step,
        status: payload.failure.status,
        from: currentRoute,
        to: nextRoute,
      })
    } catch {
      // Logging/notification hooks must not block recovery.
    }
    return { kind: 'retry' }
  }

  function onAgentDisposed(payload) {
    if (validAgentId(payload)) states.delete(payload.agent.id)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    states.clear()
  }

  return Object.freeze({ onRequest, onRequestError, onAgentDisposed, dispose })
}

export function createRuntimeFallbackController(input, options = {}) {
  return createController(normalizeRuntimeFallback(input), options)
}

export function registerRuntimeFallback(ctx, input, options = {}) {
  const policy = normalizeRuntimeFallback(input)
  if (!policy.enabled) return () => {}
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') {
    throw new TypeError('enabled runtimeFallback requires Cordis ctx.on and ctx.effect')
  }
  const controller = createController(policy, options)
  try {
    ctx.on('agent/request', controller.onRequest)
    ctx.on('agent/request-error', controller.onRequestError)
    ctx.on('agent/disposed', controller.onAgentDisposed)
    ctx.effect(() => controller.dispose, 'dsh-omo runtime model fallback')
  } catch (error) {
    controller.dispose()
    throw error
  }
  return controller.dispose
}
