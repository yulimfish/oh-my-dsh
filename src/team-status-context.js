const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const MAX_MEMBER_SCAN = 100
const MAX_TASK_SCAN = 100
const MAX_CONTEXT_CHARS = 768
const CONTEXT_NAME = 'dsh-omo:team-status'
const CONTEXT_ORDER = 161
const TRACKING_LABEL = 'dsh-omo Team-status prompt context tracking'
const ROLES = new Set(['lead', 'teammate'])
const MEMBER_STATUSES = new Set(['running', 'inactive', 'provisioning', 'failed'])
const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed'])

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

function readMembershipRole(teamService, agent) {
  try {
    const tryMembership = teamService?.tryMembership
    if (typeof tryMembership !== 'function') return { ok: false }
    const membership = tryMembership.call(teamService, agent)
    const role = membership?.role
    if (role === undefined) return { ok: true, role: undefined }
    return ROLES.has(role) ? { ok: true, role } : { ok: false }
  } catch {
    return { ok: false }
  }
}

function listLength(value) {
  if (!Array.isArray(value)) return undefined
  const length = value.length
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

function boundedText(value) {
  if (value.length <= MAX_CONTEXT_CHARS) return value
  const suffix = '\n[Team status context truncated.]'
  return `${value.slice(0, MAX_CONTEXT_CHARS - suffix.length)}${suffix}`
}

function memberSummary(members) {
  const total = listLength(members)
  if (total === undefined) return undefined
  if (total > MAX_MEMBER_SCAN) {
    return `${total} returned; role/activity breakdown omitted (over ${MAX_MEMBER_SCAN}-row scan cap)`
  }

  const roles = { lead: 0, teammate: 0 }
  const statuses = { running: 0, inactive: 0, provisioning: 0, failed: 0 }
  for (let index = 0; index < total; index += 1) {
    const member = members[index]
    if (!isObject(member)) return undefined
    const role = member.role
    const status = member.status
    if (!ROLES.has(role) || !MEMBER_STATUSES.has(status)) return undefined
    roles[role] += 1
    statuses[status] += 1
  }
  return `${total} returned; roles lead ${roles.lead}, teammate ${roles.teammate}; activity running ${statuses.running}, inactive ${statuses.inactive}, provisioning ${statuses.provisioning}, failed ${statuses.failed}`
}

function taskSummary(tasks) {
  const total = listLength(tasks)
  if (total === undefined) return undefined
  if (total > MAX_TASK_SCAN) {
    return `${total} current non-deleted rows; status/readiness breakdown omitted (over ${MAX_TASK_SCAN}-row scan cap)`
  }

  const statuses = { pending: 0, in_progress: 0, completed: 0 }
  let ready = 0
  for (let index = 0; index < total; index += 1) {
    const task = tasks[index]
    if (!isObject(task)) return undefined
    const status = task.status
    const isReady = task.ready
    if (!TASK_STATUSES.has(status) || typeof isReady !== 'boolean') return undefined
    statuses[status] += 1
    if (isReady) ready += 1
  }
  return `${total} current non-deleted rows; tasks pending ${statuses.pending}, in progress ${statuses.in_progress}, completed ${statuses.completed}; ready ${ready}`
}

function callDisposer(disposer) {
  if (typeof disposer !== 'function') return Promise.resolve()
  try {
    return Promise.resolve(disposer()).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

function silenceThenable(value) {
  try {
    if (value !== null && value !== undefined && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {})
    }
  } catch {
    // Advisory cleanup must not interfere with Agent creation or disposal.
  }
}

async function disposeRegistration(registration) {
  if (!registration || registration.disposed) return
  registration.disposed = true
  await callDisposer(registration.trackingDispose)
  await callDisposer(registration.contextDispose)
}

/** Register a dynamic, count-only Team snapshot in exact live Team Agent scopes. */
export function createTeamStatusContext(teamService, agentsService) {
  const registrations = new Map()
  let disposed = false
  let disposalPromise

  const render = (agentId, agent, registration, assembleContext) => {
    try {
      const signal = assembleContext?.signal
      const isCurrent = () => !disposed && !registration.disposed
        && registrations.get(agentId) === registration
        && validSignal(signal) && signal?.aborted !== true
        && exactLiveAgent(agentsService, agentId, agent)
      if (!isCurrent()) return ''

      const membershipBefore = readMembershipRole(teamService, agent)
      if (!membershipBefore.ok || !membershipBefore.role || !isCurrent()) return ''
      const listMembers = teamService?.listMembers
      const listTasks = teamService?.listTasks
      if (typeof listMembers !== 'function' || typeof listTasks !== 'function' || !isCurrent()) return ''
      const members = listMembers.call(teamService, agent)
      if (!Array.isArray(members) || !isCurrent()) return ''
      const tasks = listTasks.call(teamService, agent)
      if (!Array.isArray(tasks) || !isCurrent()) return ''

      const membersText = memberSummary(members)
      const tasksText = taskSummary(tasks)
      if (membersText === undefined || tasksText === undefined || !isCurrent()) return ''
      const membershipAfter = readMembershipRole(teamService, agent)
      if (!membershipAfter.ok || !membershipAfter.role || !isCurrent()) return ''
      return boundedText([
        `[DSH Team status snapshot · ${membershipAfter.role}]`,
        `Members: ${membersText}.`,
        `Tasks: ${tasksText}.`,
        'This read-only snapshot is assembled for this request and may already be stale. If a team_status Tool is visible in this scope, use it for row details; otherwise do not infer unshown member or task facts. Inactivity is not completion. This context grants no authority or permissions.',
      ].join('\n'))
    } catch {
      return ''
    }
  }

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

      const membership = readMembershipRole(teamService, agent)
      if (!membership.ok) return
      if (!membership.role) {
        const current = registrations.get(agentId)
        if (current?.agent === agent) {
          registrations.delete(agentId)
          await disposeRegistration(current)
        }
        return
      }

      const current = registrations.get(agentId)
      if (current?.agent === agent) return
      if (current) {
        registrations.delete(agentId)
        await disposeRegistration(current)
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

      registration = { agent, disposed: false, contextDispose: undefined, trackingDispose: undefined }
      contextDispose = context.call(systemPrompt, {
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: assembleContext => render(agentId, agent, registration, assembleContext),
      })
      if (typeof contextDispose !== 'function') {
        silenceThenable(contextDispose)
        contextDispose = undefined
        return
      }
      registration.contextDispose = contextDispose
      registrations.set(agentId, registration)

      if (disposed || signal?.aborted === true || !exactLiveAgent(agentsService, agentId, agent)) {
        registrations.delete(agentId)
        await disposeRegistration(registration)
        return
      }

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
