import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const MAX_AGENT_USAGE_REMINDERS = 3
export const MAX_TRACKED_AGENT_STATES = 256
export const MAX_AGENT_ID_LENGTH = 256
export const MAX_ROOTS_TO_SCAN = 256
export const MAX_TOOL_NAME_LENGTH = 128

export const AGENT_USAGE_TARGET_TOOLS = Object.freeze([
  'grep',
  'safe_grep',
  'glob',
  'safe_glob',
  'webfetch',
  'context7_resolve-library-id',
  'context7_query-docs',
  'websearch_web_search_exa',
  'grep_app_searchgithub',
  'web_search',
  'web_fetch',
])

export const AGENT_USAGE_TASK_TOOLS = Object.freeze([
  'dsh_omo_call_agent',
  'dsh_omo_task',
  'dsh_omo_task_continuable',
  'dsh_omo_task_followup',
])

export const AGENT_USAGE_DELEGATION_TOOLS = Object.freeze([
  'dsh_omo_call_agent',
  'dsh_omo_task',
  'dsh_omo_task_continuable',
  'dsh_omo_task_followup',
])

export const AGENT_USAGE_REMINDER = `[DSH partial agent-usage reminder]

For independent work within the current user request, consider an available one-shot DSH delegation Tool for a bounded task; preserve scope and constraints, and verify child evidence. Use durable continuation or DSH Goal tracking only when the user explicitly requests it. This reminder neither starts a child nor grants new permissions.
`

const TARGET_TOOL_NAMES = new Set(AGENT_USAGE_TARGET_TOOLS)
const TASK_TOOL_NAMES = new Set(AGENT_USAGE_TASK_TOOLS)

function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function isValidAgentId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_AGENT_ID_LENGTH
}

function liveRootId(agentsService, agent) {
  if (!isObjectLike(agent)) return undefined

  try {
    const agentId = agent.id
    if (!isValidAgentId(agentId) || agentsService.get(agentId) !== agent) return undefined

    const roots = agentsService.roots()
    if (!Array.isArray(roots)) return undefined

    const limit = Math.min(roots.length, MAX_ROOTS_TO_SCAN)
    let found = false
    for (let index = 0; index < limit; index += 1) {
      const root = roots[index]
      if (!isObjectLike(root) || typeof root.id !== 'string' || root.id.length === 0) return undefined
      if (root === agent) found = true
    }
    return found ? agentId : undefined
  } catch {
    return undefined
  }
}

function isCallerCanceled(signal) {
  try {
    return !signal || typeof signal.aborted !== 'boolean' || signal.aborted
  } catch {
    return true
  }
}

/**
 * Creates a process-local reminder for exact live runtime-root Agents. State belongs to the exact
 * Agent scope and is cleared on disposal/recreation; compaction resets it when the runtime creates a new scope. State is never persisted.
 */
export function createAgentUsageReminder(agentsService, toolsService) {
  if (typeof agentsService?.get !== 'function' || typeof agentsService?.roots !== 'function') {
    throw new TypeError('agent usage reminder requires agents.get and agents.roots')
  }
  if (typeof toolsService?.get !== 'function') {
    throw new TypeError('agent usage reminder requires tools.get')
  }

  const states = new Map()
  const disposedAgents = new WeakSet()
  let disposed = false

  function clearAgent(agent) {
    if (isObjectLike(agent)) disposedAgents.add(agent)
    for (const [agentId, state] of states) {
      if (state.agent === agent) states.delete(agentId)
    }
  }

  function dispose() {
    disposed = true
    states.clear()
  }

  function stateFor(agentId, agent) {
    let state = states.get(agentId)
    if (state && state.agent !== agent) {
      states.delete(agentId)
      state = undefined
    }
    if (state) return state
    // Never evict a live Agent: doing so could reset its per-Agent reminder cap.
    if (states.size >= MAX_TRACKED_AGENT_STATES) return undefined
    state = { agent, remindersSent: 0, agentUsed: false }
    states.set(agentId, state)
    return state
  }

  function hasVisibleDelegationTool(agent) {
    try {
      for (const name of AGENT_USAGE_DELEGATION_TOOLS) {
        const definition = toolsService.get(name, agent)
        if (definition !== null && typeof definition === 'object' && !Array.isArray(definition)
          && definition.name === name) return true
      }
    } catch {
      return false
    }
    return false
  }

  async function listener(exec, _result, next) {
    // Cordis post-execute is a waterfall: always call downstream once and use its decision.
    const decision = await next()
    if (disposed) return decision

    let parent
    let agent
    let name
    try {
      parent = exec?.parent
      agent = exec?.agent
      name = exec?.name
    } catch {
      return decision
    }
    if (parent !== undefined || !isObjectLike(agent) || disposedAgents.has(agent)
      || typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) {
      return decision
    }

    const agentId = liveRootId(agentsService, agent)
    if (agentId === undefined || disposed || disposedAgents.has(agent)) return decision

    // An ID can be reused, but only a fully validated live root may replace stale identity state.
    const previous = states.get(agentId)
    if (previous && previous.agent !== agent) states.delete(agentId)

    // A delegation attempt suppresses future reminders regardless of its outcome or cancellation.
    if (TASK_TOOL_NAMES.has(name)) {
      const state = stateFor(agentId, agent)
      if (state) state.agentUsed = true
      return decision
    }

    let normalizedName
    try {
      normalizedName = name.toLowerCase()
    } catch {
      return decision
    }
    if (!TARGET_TOOL_NAMES.has(normalizedName) || decision?.kind !== 'accept') return decision

    let signal
    try {
      signal = exec.signal
    } catch {
      return decision
    }
    if (isCallerCanceled(signal)) return decision

    const current = states.get(agentId)
    if (current?.agent === agent && (current.agentUsed || current.remindersSent >= MAX_AGENT_USAGE_REMINDERS)) {
      return decision
    }
    if (current && current.agent !== agent) return decision
    if (!hasVisibleDelegationTool(agent)) return decision
    if (disposed || disposedAgents.has(agent) || isCallerCanceled(signal)) return decision

    const state = stateFor(agentId, agent)
    if (!state || state.agentUsed || state.remindersSent >= MAX_AGENT_USAGE_REMINDERS) return decision

    state.remindersSent += 1
    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const reminder = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: AGENT_USAGE_REMINDER }],
    })
    return { ...decision, additionalContexts: [...previousContexts, reminder] }
  }

  return { listener, clearAgent, dispose }
}
