import { createUserMessage } from '@deepseek-ai/dsh-llm'

const REMINDER_INTERVAL = 10
const MAX_REMINDERS_PER_AGENT = 3
const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const GOAL_TOOLS = new Set(['dsh_omo_goal_get', 'dsh_omo_goal_create', 'dsh_omo_goal_update'])

export const GOAL_USE_REMINDER = `[DSH Goal-use reminder]

If a user-requested multi-step outcome is not already tracked, check the current DSH Goal with dsh_omo_goal_get and use dsh_omo_goal_create or dsh_omo_goal_update only as explicitly appropriate. A DSH Goal tracks one durable objective, not a task list. Create a Goal only for an explicit user-requested outcome; this reminder itself never authorizes creating, editing, completing, pausing, or resuming a Goal.
`

function resetCadence(states, agentId) {
  const state = states.get(agentId)
  if (state) state.count = 0
}

function stateForAgent(states, agentId) {
  const existing = states.get(agentId)
  if (existing) return existing
  // Do not evict live state: an eviction could reset the per-Agent reminder cap.
  if (states.size >= MAX_AGENT_STATES) return undefined
  const state = { count: 0, remindersSent: 0 }
  states.set(agentId, state)
  return state
}

/** Adds a bounded DSH Goal-use reminder for non-Team Agents; this is not task-list parity. */
export function createGoalUseReminder(teamService, agentsService) {
  const states = new Map()
  const disposedAgents = new WeakSet()
  let disposed = false

  function clearAgent(agent) {
    if (agent && typeof agent === 'object') disposedAgents.add(agent)
    if (typeof agent?.id === 'string') states.delete(agent.id)
  }

  function dispose() {
    disposed = true
    states.clear()
  }

  async function listener(exec, _result, next) {
    const decision = await next()
    if (disposed || !exec?.signal || !exec.agent) return decision
    if (typeof exec.agent === 'object' && disposedAgents.has(exec.agent)) return decision

    const agentId = exec.agent.id
    if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > MAX_AGENT_ID_CHARS) return decision
    // `tryMembership` also returns undefined for stale identities, so verify exact liveness first.
    if (typeof agentsService?.get !== 'function') return decision
    let liveAgent
    try {
      liveAgent = agentsService.get(agentId)
    } catch {
      return decision
    }
    if (liveAgent !== exec.agent) return decision

    if (typeof teamService?.tryMembership !== 'function') {
      resetCadence(states, agentId)
      return decision
    }
    let membership
    try {
      membership = teamService.tryMembership(exec.agent)
    } catch {
      resetCadence(states, agentId)
      return decision
    }
    // Only undefined is an affirmative non-Team result; malformed or present membership fails closed.
    if (membership !== undefined) {
      resetCadence(states, agentId)
      return decision
    }

    // Goal-tool attempts reset cadence even if another listener ultimately blocks or the Tool errors.
    if (GOAL_TOOLS.has(exec.name)) {
      resetCadence(states, agentId)
      return decision
    }
    if (exec.signal.aborted || decision?.kind !== 'accept') return decision

    const state = stateForAgent(states, agentId)
    if (!state || state.remindersSent >= MAX_REMINDERS_PER_AGENT) return decision
    state.count += 1
    if (state.count < REMINDER_INTERVAL) return decision
    state.count = 0
    state.remindersSent += 1
    if (exec.signal.aborted || disposed) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const reminder = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: GOAL_USE_REMINDER }],
    })
    return { ...decision, additionalContexts: [...previousContexts, reminder] }
  }

  return { listener, clearAgent, dispose }
}
