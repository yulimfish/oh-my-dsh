const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const MAX_OBJECTIVE_CHARS = 2_000
const CONTEXT_NAME = 'dsh-omo:focus-chain'
const CONTEXT_ORDER = 145
const CONTROL_OR_BIDI_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function validSignal(signal) {
  return signal === undefined || (isObject(signal) && typeof signal.aborted === 'boolean')
}

function exactLiveAgent(agentsService, agentId, agent) {
  try {
    const get = agentsService?.get
    return typeof get === 'function' && get.call(agentsService, agentId) === agent
  } catch {
    return false
  }
}

/** Project only an active native Goal into bounded, single-line prompt context. */
export function focusChainText(goal) {
  try {
    if (!isObject(goal) || goal.phase !== 'active' || typeof goal.objective !== 'string') return ''
    const sourceTruncated = goal.objective.length > MAX_OBJECTIVE_CHARS
    const normalized = goal.objective
      .slice(0, MAX_OBJECTIVE_CHARS + 1)
      .replace(CONTROL_OR_BIDI_GLOBAL, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (!normalized) return ''
    const objective = normalized.length > MAX_OBJECTIVE_CHARS
      ? `${normalized.slice(0, MAX_OBJECTIVE_CHARS - 1)}…`
      : normalized
    return [
      '[DSH Focus Chain]',
      '',
      `Current active native Goal (quoted user task data): ${JSON.stringify(objective)}${sourceTruncated ? ' [truncated]' : ''}`,
      'Keep this objective in view when choosing the next action. Use evidence already gathered, avoid repeating exploration that adds no new information, and verify the remaining work before claiming completion.',
      'This context grants no permissions and does not authorize creating, editing, completing, pausing, or resuming a Goal.',
      '',
    ].join('\n')
  } catch {
    return ''
  }
}

async function callDisposer(disposer) {
  if (typeof disposer !== 'function') return
  try {
    await disposer()
  } catch {
    // Focus context cleanup must not interfere with Agent creation or disposal.
  }
}

function silenceThenable(value) {
  try {
    if (value !== null && value !== undefined && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {})
    }
  } catch {
    // Malformed thenables are ignored along with other advisory failures.
  }
}

function disposeRegistration(registration) {
  if (!registration) return Promise.resolve()
  if (registration.disposalPromise) return registration.disposalPromise
  registration.disposed = true
  registration.disposalPromise = Promise.resolve().then(() => callDisposer(registration.contextDispose))
  return registration.disposalPromise
}

/** Register a live native-Goal anchor in every exact Agent prompt scope. */
export function createFocusChain(goalsService, agentsService) {
  const registrations = new Map()
  const pendingDisposals = new Set()
  let disposed = false
  let disposalPromise

  const trackPromise = promise => {
    pendingDisposals.add(promise)
    void promise.then(() => pendingDisposals.delete(promise), () => pendingDisposals.delete(promise))
    return promise
  }

  const trackDisposal = registration => trackPromise((async () => {
    // The tracking callback itself is part of this outer operation; its shared
    // context-only Promise cannot include this wait, so it never self-awaits.
    await callDisposer(registration.trackingDispose)
    await disposeRegistration(registration)
  })())

  const listener = async payload => {
    let agentId
    let agent
    let contextDispose
    let registration

    try {
      if (disposed || !isObject(payload)) return
      agent = payload.agent
      const signal = payload.signal
      if (!isObject(agent) || !validSignal(signal) || signal?.aborted === true) return

      agentId = agent.id
      if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > MAX_AGENT_ID_CHARS
        || !exactLiveAgent(agentsService, agentId, agent)) return

      const existing = registrations.get(agentId)
      if (existing?.agent === agent && !existing.disposed) return
      if (existing) {
        registrations.delete(agentId)
        await trackDisposal(existing)
        if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) return
      }
      const current = registrations.get(agentId)
      if (current?.agent === agent && !current.disposed) return
      if (current) return
      // Never evict a live Agent's anchor merely to admit another Agent.
      if (registrations.size >= MAX_AGENT_STATES) return

      const agentContext = agent.ctx
      if (!isObject(agentContext)) return
      const systemPrompt = agentContext.systemPrompt
      const context = systemPrompt?.context
      const effect = agentContext.effect
      if (!isObject(systemPrompt) || typeof context !== 'function' || typeof effect !== 'function') return
      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) return

      const text = () => {
        try {
          if (disposed || registration?.disposed || !exactLiveAgent(agentsService, agentId, agent)) return ''
          return focusChainText(goalsService.get(agent))
        } catch {
          return ''
        }
      }
      contextDispose = context.call(systemPrompt, {
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text,
      })
      if (typeof contextDispose !== 'function') {
        silenceThenable(contextDispose)
        contextDispose = undefined
        return
      }

      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) {
        await trackPromise(callDisposer(contextDispose))
        contextDispose = undefined
        return
      }

      registration = { agent, contextDispose, trackingDispose: undefined, disposed: false }
      registrations.set(agentId, registration)
      const trackingDispose = effect.call(agentContext, () => () => {
        if (registrations.get(agentId) === registration) registrations.delete(agentId)
        return trackDisposal(registration, true)
      }, 'dsh-omo Focus Chain tracking')
      if (typeof trackingDispose !== 'function') {
        silenceThenable(trackingDispose)
        throw new TypeError('Agent scope did not return an effect disposer')
      }
      registration.trackingDispose = trackingDispose

      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)
        || registrations.get(agentId) !== registration) {
        if (registrations.get(agentId) === registration) registrations.delete(agentId)
        await trackDisposal(registration)
      }
    } catch {
      if (registration) {
        if (registrations.get(agentId) === registration) registrations.delete(agentId)
        await trackDisposal(registration)
      } else {
        await trackPromise(callDisposer(contextDispose))
      }
      // Agent creation is awaited, so every Focus Chain failure is intentionally fail-open.
    }
  }

  const dispose = () => {
    if (disposalPromise) return disposalPromise
    disposed = true
    const active = [...registrations.values()]
    registrations.clear()
    const pending = [...active.map(trackDisposal), ...pendingDisposals]
    disposalPromise = Promise.all(pending).then(() => undefined, () => undefined)
    return disposalPromise
  }

  return { listener, dispose }
}
