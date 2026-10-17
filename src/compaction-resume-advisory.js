const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const CONTEXT_NAME = 'dsh-omo:compaction-resume-advisory'
const CONTEXT_ORDER = 150

export const COMPACTION_RESUME_ADVISORY = `[DSH compact-resume advisory]

A compacted summary may be incomplete. Recheck the current user request and constraints, verify claims before continuing, and ask the user if essential context is missing. This reminder grants no new permissions; follow the current user request and existing controls.
`

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

async function callDisposer(disposer) {
  if (typeof disposer !== 'function') return
  try {
    await disposer()
  } catch {
    // Advisory cleanup must not interfere with Agent creation or disposal.
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

async function disposeRegistration(registration) {
  if (!registration || registration.disposed) return
  registration.disposed = true
  await callDisposer(registration.trackingDispose)
  await callDisposer(registration.contextDispose)
}

/** Register fixed compact-resume guidance only in the exact live Agent's prompt scope. */
export function createCompactionResumeAdvisory(agentsService) {
  const registrations = new Map()
  let disposed = false
  let disposalPromise

  const listener = async payload => {
    let agentId
    let agent
    let contextDispose
    let registration

    try {
      if (disposed || !isObject(payload) || payload.source !== 'compact') return
      agent = payload.agent
      const signal = payload.signal
      if (!isObject(agent) || !validSignal(signal) || signal?.aborted === true) return

      agentId = agent.id
      if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > MAX_AGENT_ID_CHARS
        || !exactLiveAgent(agentsService, agentId, agent)) return

      const existing = registrations.get(agentId)
      if (existing?.agent === agent) return
      if (existing) {
        registrations.delete(agentId)
        await disposeRegistration(existing)
        if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) return
      }
      // Never evict a live Agent's registration merely to admit another Agent.
      if (registrations.size >= MAX_AGENT_STATES) return

      const agentContext = agent.ctx
      if (!isObject(agentContext)) return
      const systemPrompt = agentContext.systemPrompt
      const context = systemPrompt?.context
      const effect = agentContext.effect
      if (!isObject(systemPrompt) || typeof context !== 'function' || typeof effect !== 'function') return

      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) return
      contextDispose = context.call(systemPrompt, {
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: COMPACTION_RESUME_ADVISORY,
      })
      if (typeof contextDispose !== 'function') {
        silenceThenable(contextDispose)
        contextDispose = undefined
        return
      }

      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) {
        await callDisposer(contextDispose)
        contextDispose = undefined
        return
      }

      registration = { agent, contextDispose, trackingDispose: undefined, disposed: false }
      registrations.set(agentId, registration)
      const trackingDispose = effect.call(agentContext, () => () => {
        if (registrations.get(agentId) === registration) registrations.delete(agentId)
      }, 'dsh-omo compaction-resume advisory tracking')
      if (typeof trackingDispose !== 'function') {
        silenceThenable(trackingDispose)
        throw new TypeError('Agent scope did not return an effect disposer')
      }
      registration.trackingDispose = trackingDispose

      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)
        || registrations.get(agentId) !== registration) {
        if (registrations.get(agentId) === registration) registrations.delete(agentId)
        await disposeRegistration(registration)
      }
    } catch {
      if (registration) {
        if (registrations.get(agentId) === registration) registrations.delete(agentId)
        await disposeRegistration(registration)
      } else {
        await callDisposer(contextDispose)
      }
      // The agent/created event is awaited, so every failure is intentionally fail-open.
    }
  }

  const dispose = () => {
    if (disposalPromise) return disposalPromise
    disposed = true
    const active = [...registrations.values()]
    registrations.clear()
    disposalPromise = Promise.all(active.map(disposeRegistration)).then(() => undefined, () => undefined)
    return disposalPromise
  }

  return { listener, dispose }
}
