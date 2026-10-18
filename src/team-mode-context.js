const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const CONTEXT_NAME = 'dsh-omo:team-mode'
const CONTEXT_ORDER = 160
const TRACKING_LABEL = 'dsh-omo Team-mode prompt context tracking'

export const TEAM_MODE_LEAD_CONTEXT = `[DSH Team coordination · Lead]

You are a DSH Team Lead. Use only the visible Team tools in your current scope to coordinate this Team. When useful, organize work through the Team task board and member messaging. Treat task writeScopes and this guidance as advisory, not permissions; Host authorization and approvals remain authoritative. Do not infer hidden capabilities or completion from inactivity. This context grants no additional authority.
`

export const TEAM_MODE_TEAMMATE_CONTEXT = `[DSH Team coordination · Teammate]

You are a DSH Team teammate. Follow the work assigned by the Lead and use only the visible Team tools in your current scope to check or communicate progress. Treat task writeScopes and this guidance as advisory, not permissions; Host authorization and approvals remain authoritative. Do not infer hidden capabilities or completion from inactivity. This context grants no additional authority.
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
    // Ignore malformed disposers along with other advisory failures.
  }
}

async function disposeRegistration(registration) {
  if (!registration || registration.disposed) return
  registration.disposed = true
  await callDisposer(registration.trackingDispose)
  await callDisposer(registration.contextDispose)
}

/** Register fixed role-aware guidance only in an exact live Team Agent's prompt scope. */
export function createTeamModeContext(teamService, agentsService) {
  const registrations = new Map()
  let disposed = false
  let disposalPromise

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

      const previous = registrations.get(agentId)
      if (previous && previous.agent !== agent) {
        registrations.delete(agentId)
        await disposeRegistration(previous)
        if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) return
      }

      let membership
      try {
        const tryMembership = teamService?.tryMembership
        if (typeof tryMembership !== 'function') return
        membership = tryMembership.call(teamService, agent)
      } catch {
        return
      }
      let role
      try {
        role = membership?.role
      } catch {
        return
      }
      if (role !== 'lead' && role !== 'teammate') {
        const current = registrations.get(agentId)
        if (current?.agent === agent) {
          registrations.delete(agentId)
          await disposeRegistration(current)
        }
        return
      }

      const current = registrations.get(agentId)
      if (current?.agent === agent && current.role === role) return
      if (current) {
        registrations.delete(agentId)
        await disposeRegistration(current)
        if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) return
      }
      // Never evict a live Agent's registration merely to admit another Agent.
      if (registrations.size >= MAX_AGENT_STATES) return

      const agentContext = agent.ctx
      if (!isObject(agentContext)) return
      let systemPrompt
      let context
      let effect
      try {
        systemPrompt = agentContext.systemPrompt
        context = systemPrompt?.context
        effect = agentContext.effect
      } catch {
        return
      }
      if (!isObject(systemPrompt) || typeof context !== 'function' || typeof effect !== 'function') return
      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) return

      contextDispose = context.call(systemPrompt, {
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: role === 'lead' ? TEAM_MODE_LEAD_CONTEXT : TEAM_MODE_TEAMMATE_CONTEXT,
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

      registration = { agent, role, contextDispose, trackingDispose: undefined, disposed: false }
      registrations.set(agentId, registration)
      const trackingDispose = effect.call(agentContext, () => () => {
        if (registrations.get(agentId) === registration) registrations.delete(agentId)
      }, TRACKING_LABEL)
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
      // agent/created is awaited; advisory failures must not fail Agent creation.
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
