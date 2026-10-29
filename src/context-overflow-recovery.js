const MAX_PROVIDERS = 32
const MAX_CODES_PER_PROVIDER = 16
const MAX_TEXT_BYTES = 128
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
const encoder = new TextEncoder()
const POLICY_FIELDS = new Set(['enabled', 'codesByProvider'])

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function assertFields(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unsupported field ${String(key)}`)
    }
  }
}

function ownDataValue(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) throw new TypeError(`${label} must be a plain data value`)
  return descriptor.value
}

function normalizeExactText(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || CONTROL_CHARACTERS.test(value) || encoder.encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new TypeError(`${label} must be a non-empty exact string of at most ${MAX_TEXT_BYTES} UTF-8 bytes without controls or surrounding whitespace`)
  }
  return value
}

/** Normalize explicit provider-specific error-code allowlists; no message matching is performed. */
export function normalizeContextOverflowRecovery(input) {
  const value = input === undefined ? {} : input
  if (!isRecord(value)) throw new TypeError('contextOverflowRecovery must be a plain object')
  assertFields(value, POLICY_FIELDS, 'contextOverflowRecovery')

  const enabledInput = Object.hasOwn(value, 'enabled')
    ? ownDataValue(value, 'enabled', 'contextOverflowRecovery enabled')
    : false
  if (typeof enabledInput !== 'boolean') throw new TypeError('contextOverflowRecovery enabled must be a boolean')

  const codesInput = Object.hasOwn(value, 'codesByProvider')
    ? ownDataValue(value, 'codesByProvider', 'contextOverflowRecovery codesByProvider')
    : Object.create(null)
  if (!isRecord(codesInput)) throw new TypeError('contextOverflowRecovery codesByProvider must be a plain object')
  const providerKeys = Reflect.ownKeys(codesInput)
  if (providerKeys.length > MAX_PROVIDERS) {
    throw new TypeError(`contextOverflowRecovery codesByProvider must contain at most ${MAX_PROVIDERS} providers`)
  }

  const codesByProvider = Object.create(null)
  for (const providerKey of providerKeys) {
    if (typeof providerKey !== 'string') throw new TypeError('contextOverflowRecovery provider keys must be strings')
    const provider = normalizeExactText(providerKey, 'contextOverflowRecovery provider')
    const inputCodes = ownDataValue(codesInput, providerKey, `contextOverflowRecovery codesByProvider.${provider}`)
    if (!Array.isArray(inputCodes) || inputCodes.length < 1 || inputCodes.length > MAX_CODES_PER_PROVIDER) {
      throw new TypeError(`contextOverflowRecovery codesByProvider.${provider} must contain between 1 and ${MAX_CODES_PER_PROVIDER} exact error codes`)
    }
    const codes = []
    const seen = new Set()
    for (let index = 0; index < inputCodes.length; index += 1) {
      const code = normalizeExactText(
        ownDataValue(inputCodes, String(index), `contextOverflowRecovery codesByProvider.${provider}[${index}]`),
        `contextOverflowRecovery codesByProvider.${provider}[${index}]`,
      )
      if (seen.has(code)) throw new TypeError(`contextOverflowRecovery codesByProvider.${provider} must not repeat error codes`)
      seen.add(code)
      codes.push(code)
    }
    Object.defineProperty(codesByProvider, provider, {
      configurable: false,
      enumerable: true,
      value: Object.freeze(codes),
      writable: false,
    })
  }

  if (enabledInput && providerKeys.length === 0) {
    throw new TypeError('contextOverflowRecovery requires at least one exact provider error code when enabled')
  }
  return Object.freeze({ enabled: enabledInput, codesByProvider: Object.freeze(codesByProvider) })
}

function validAgentPosition(payload) {
  let agent
  let id
  try {
    agent = payload?.agent
    id = agent?.id
  } catch {
    return undefined
  }
  if (!agent || typeof agent !== 'object' || typeof id !== 'string' || !id
    || !Number.isSafeInteger(payload?.turn) || payload.turn < 0
    || !Number.isSafeInteger(payload?.step) || payload.step < 0) return undefined
  return { agent, id, turn: payload.turn }
}

function isAbortSignalLive(signal) {
  try {
    return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean' && !signal.aborted
  } catch {
    return false
  }
}

/** One exact Agent turn can be consumed by an existing retry or by this recovery, never both. */
export function createContextOverflowRecoveryController(input, { agents, sessions, pruner, compaction } = {}) {
  const policy = normalizeContextOverflowRecovery(input)
  if (!policy.enabled) return Object.freeze({
    onRequestError: async (_payload, next) => {
      if (typeof next !== 'function') throw new TypeError('agent/request-error requires next()')
      return next()
    },
    onAgentDisposed() {},
    dispose() {},
  })
  if (!agents || typeof agents.get !== 'function') throw new TypeError('contextOverflowRecovery requires DSH agents.get')
  if (!sessions || typeof sessions.get !== 'function') throw new TypeError('contextOverflowRecovery requires DSH sessions.get')
  if (!pruner || typeof pruner.pruneSession !== 'function') throw new TypeError('contextOverflowRecovery requires DSH toolResultPruner.pruneSession')

  const consumedTurnByAgent = new WeakMap()
  let disposed = false

  function consumeTurn(agent, turn) {
    const previous = consumedTurnByAgent.get(agent)
    if (Number.isSafeInteger(previous) && turn <= previous) return false
    consumedTurnByAgent.set(agent, turn)
    return true
  }

  async function onRequestError(payload, next) {
    if (typeof next !== 'function') throw new TypeError('agent/request-error requires next()')
    const delegated = await next()
    if (disposed) return delegated

    const position = validAgentPosition(payload)
    if (!position) return delegated
    const { agent, id, turn } = position

    if (delegated?.kind === 'retry') {
      consumeTurn(agent, turn)
      return delegated
    }
    if (delegated !== undefined || !isAbortSignalLive(payload.signal)) return delegated

    let provider
    let code
    try {
      provider = payload.provider
      code = payload.failure?.code
    } catch {
      return delegated
    }
    const allowedCodes = typeof provider === 'string' ? policy.codesByProvider[provider] : undefined
    if (!Array.isArray(allowedCodes) || typeof code !== 'string' || !allowedCodes.includes(code)) return delegated

    let session
    try {
      if (agents.get(id) !== agent) return delegated
      session = sessions.get(id)
    } catch {
      return delegated
    }
    if (!session || typeof session !== 'object' || session.id !== id || !isAbortSignalLive(payload.signal)) return delegated
    if (!consumeTurn(agent, turn)) return delegated

    let result
    try {
      result = pruner.pruneSession(session)
    } catch {
      // The synchronous Host pass may have committed earlier replacements; retrying is unsafe.
      return delegated
    }

    if (!isAbortSignalLive(payload.signal)) return delegated
    try {
      if (agents.get(id) !== agent || sessions.get(id) !== session) return delegated
    } catch {
      return delegated
    }
    let pruned = false
    try { pruned = Array.isArray(result?.pruned) && result.pruned.length > 0 } catch { return delegated }
    if (pruned) return { kind: 'retry' }
    if (typeof compaction?.compactIfNeeded !== 'function') return delegated
    let compacted
    try {
      compacted = await compaction.compactIfNeeded({ session, options: {} }, 'context-overflow', payload.signal)
    } catch {
      return delegated
    }
    if (!isAbortSignalLive(payload.signal)) return delegated
    try {
      if (agents.get(id) !== agent || sessions.get(id) !== session) return delegated
    } catch {
      return delegated
    }
    return compacted ? { kind: 'retry' } : delegated
  }

  function onAgentDisposed(payload) {
    const agent = payload?.agent
    if (agent && typeof agent === 'object') consumedTurnByAgent.delete(agent)
  }

  function dispose() {
    disposed = true
  }

  return Object.freeze({ onRequestError, onAgentDisposed, dispose })
}

export function registerContextOverflowRecovery(ctx, input, dependencies) {
  const policy = normalizeContextOverflowRecovery(input)
  if (!policy.enabled) return () => {}
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') {
    throw new TypeError('enabled contextOverflowRecovery requires Cordis ctx.on and ctx.effect')
  }
  const controller = createContextOverflowRecoveryController(policy, dependencies)
  try {
    ctx.on('agent/request-error', controller.onRequestError)
    ctx.on('agent/disposed', controller.onAgentDisposed)
    ctx.effect(() => controller.dispose, 'dsh-omo context overflow recovery')
  } catch (error) {
    controller.dispose()
    throw error
  }
  return controller.dispose
}
