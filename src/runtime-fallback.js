const DEFAULT_RETRY_ON_STATUSES = Object.freeze([429, 500, 502, 503, 504])
const MAX_ROUTE_CHAINS = 32
const MAX_FALLBACKS_PER_CHAIN = 3
const MAX_RETRY_STATUSES = 10
const DEFAULT_COOLDOWN_SECONDS = 60
const MAX_COOLDOWN_SECONDS = 86_400
const MAX_AGENT_STATES = 256
const MAX_FAILED_ROUTES_PER_AGENT = MAX_ROUTE_CHAINS * (MAX_FALLBACKS_PER_CHAIN + 1)
const MAX_PROVIDER_CHARS = 128
const MAX_MODEL_CHARS = 256
const MAX_REASONING_EFFORT_CHARS = 64
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
const POLICY_FIELDS = new Set(['enabled', 'retryOnStatuses', 'cooldownSeconds', 'chains'])
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
  const cooldownSeconds = value.cooldownSeconds === undefined ? DEFAULT_COOLDOWN_SECONDS : value.cooldownSeconds
  if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > MAX_COOLDOWN_SECONDS) {
    throw new TypeError(`runtimeFallback cooldownSeconds must be an integer from 0 through ${MAX_COOLDOWN_SECONDS}`)
  }

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
    cooldownSeconds,
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
  const failedRoutesByAgent = new Map()
  const onFallback = typeof options.onFallback === 'function' ? options.onFallback : undefined
  const now = typeof options.now === 'function' ? options.now : Date.now
  const agents = typeof options.agents?.get === 'function' ? options.agents : undefined
  const disposedAgents = new WeakSet()
  let disposed = false

  function currentTime() {
    try {
      const value = now()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  function isAgentObject(agent) {
    return agent !== null && typeof agent === 'object' && !Array.isArray(agent)
      && typeof agent.id === 'string' && agent.id.length > 0
  }

  function isCurrentAgent(agent) {
    if (!isAgentObject(agent) || disposedAgents.has(agent)) return false
    if (!agents) return true
    try {
      return agents.get(agent.id) === agent
    } catch {
      return false
    }
  }

  function prepareAgent(agent) {
    if (!isCurrentAgent(agent)) return false
    const agentId = agent.id
    const state = states.get(agentId)
    const failedRecord = failedRoutesByAgent.get(agentId)
    if ((state && state.agent !== agent) || (failedRecord && failedRecord.agent !== agent)) {
      // Without the live registry, a different same-ID object may be a stale event.
      // Wait for exact disposal instead of letting it steal or clear the current state.
      if (!agents) return false
      if (state && state.agent !== agent) states.delete(agentId)
      if (failedRecord && failedRecord.agent !== agent) failedRoutesByAgent.delete(agentId)
    }
    return true
  }

  function getActiveFailedRoutes(agent, time) {
    if (policy.cooldownSeconds === 0) return undefined
    const record = failedRoutesByAgent.get(agent.id)
    if (!record || record.agent !== agent) return undefined
    const failedRoutes = record.routes
    const cooldownMs = policy.cooldownSeconds * 1000
    for (const [key, failedAt] of failedRoutes) {
      if (!Number.isFinite(failedAt) || time - failedAt >= cooldownMs) failedRoutes.delete(key)
    }
    if (failedRoutes.size === 0) {
      if (failedRoutesByAgent.get(agent.id) === record) failedRoutesByAgent.delete(agent.id)
      return undefined
    }
    return failedRoutes
  }

  function markRouteFailed(agent, route, time) {
    if (policy.cooldownSeconds === 0) return
    const agentId = agent.id
    let record = failedRoutesByAgent.get(agentId)
    if (record && record.agent !== agent) return
    let failedRoutes = getActiveFailedRoutes(agent, time)
    if (!failedRoutes) {
      if (failedRoutesByAgent.size >= MAX_AGENT_STATES) return
      failedRoutes = new Map()
      record = { agent, routes: failedRoutes }
      failedRoutesByAgent.set(agentId, record)
    }
    const key = routeKey(route.provider, route.model)
    if (!failedRoutes.has(key) && failedRoutes.size >= MAX_FAILED_ROUTES_PER_AGENT) return
    failedRoutes.set(key, time)
  }

  function findNextAvailableFallback(agent, state, time) {
    const failedRoutes = getActiveFailedRoutes(agent, time)
    const cooldownMs = policy.cooldownSeconds * 1000
    for (let index = state.fallbackIndex; index < state.chain.fallbacks.length; index += 1) {
      const route = state.chain.fallbacks[index]
      const failedAt = failedRoutes?.get(routeKey(route.provider, route.model))
      if (failedAt !== undefined && time - failedAt < cooldownMs) continue
      return { route, index }
    }
    return undefined
  }

  async function onRequest(payload, next) {
    if (typeof next !== 'function') throw new TypeError('agent/request requires next()')
    const base = await next()
    if (!policy.enabled || disposed || !validAgentId(payload) || !prepareAgent(payload.agent)) return base
    const agent = payload.agent
    const agentId = agent.id
    if (payload.signal?.aborted || !validPosition(payload)
      || !base || typeof base.provider !== 'string' || typeof base.model !== 'string') {
      const state = states.get(agentId)
      if (state?.agent === agent) states.delete(agentId)
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
      state = { agent, turn: payload.turn, step: payload.step, primaryKey, chain, fallbackIndex: 0, sameRouteRetries: 0 }
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
    if (!policy.enabled || disposed || !validAgentId(payload) || !prepareAgent(payload.agent)) return delegated
    const agent = payload.agent
    const agentId = agent.id
    const state = states.get(agentId)
    if (!state || state.agent !== agent) return delegated
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

    const time = currentTime()
    const candidate = findNextAvailableFallback(agent, state, time)
    if (!candidate) {
      state.blocked = true
      return delegated
    }
    const nextRoute = candidate.route
    markRouteFailed(agent, currentRoute, time)
    state.fallbackIndex = candidate.index + 1
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
    const agent = payload?.agent
    if (!isAgentObject(agent)) return
    disposedAgents.add(agent)
    const state = states.get(agent.id)
    if (state?.agent === agent) states.delete(agent.id)
    const failedRoutes = failedRoutesByAgent.get(agent.id)
    if (failedRoutes?.agent === agent) failedRoutesByAgent.delete(agent.id)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    states.clear()
    failedRoutesByAgent.clear()
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
