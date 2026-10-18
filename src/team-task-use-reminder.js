import { createUserMessage } from '@deepseek-ai/dsh-llm'

const REMINDER_INTERVAL = 10
const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const MAX_TEAM_ID_CHARS = 128
const TEAM_TASK_TOOLS = new Set([
  'team_create_task',
  'team_list_tasks',
  'team_get_task',
  'team_update_task',
])

export const TEAM_TASK_USE_REMINDER = `[DSH Team task-use reminder]

If this Team Agent's work should be tracked, use the Team task tools to create or update a task. This is a reminder only; it creates or changes no task and does not enforce planning.
`

function isAgentObject(agent) {
  return agent !== null && (typeof agent === 'object' || typeof agent === 'function')
}

function clearStateForAgent(states, agentId, agent) {
  const existing = states.get(agentId)
  if (existing?.agent === agent) states.delete(agentId)
}

function stateForAgent(states, agentId, agent, teamId) {
  const existing = states.get(agentId)
  if (existing?.agent === agent && existing.teamId === teamId) {
    states.delete(agentId)
    states.set(agentId, existing)
    return existing
  }
  states.delete(agentId)
  if (states.size >= MAX_AGENT_STATES) states.delete(states.keys().next().value)
  const state = { agent, teamId, count: 0 }
  states.set(agentId, state)
  return state
}

function resetExistingState(states, agentId, agent, teamId) {
  const existing = states.get(agentId)
  if (!existing || existing.agent !== agent) return
  if (existing.teamId !== teamId) {
    states.delete(agentId)
    return
  }
  existing.count = 0
  states.delete(agentId)
  states.set(agentId, existing)
}

/** Counts accepted non-task Tool results only for exact live Team Agents. */
export function createTeamTaskUseReminder(teamService) {
  const states = new Map()
  const clearGenerations = new WeakMap()
  let disposed = false

  function clearAgent(agent) {
    if (!isAgentObject(agent)) return
    clearGenerations.set(agent, (clearGenerations.get(agent) ?? 0) + 1)
    let agentId
    try {
      agentId = agent.id
    } catch {
      return
    }
    if (typeof agentId === 'string') clearStateForAgent(states, agentId, agent)
  }

  function dispose() {
    disposed = true
    states.clear()
  }

  async function listener(exec, _result, next) {
    const agent = exec?.agent
    const clearGeneration = isAgentObject(agent) ? clearGenerations.get(agent) ?? 0 : 0
    const decision = await next()
    if (disposed || !exec?.signal || exec.signal.aborted || !agent
      || (isAgentObject(agent) && (clearGenerations.get(agent) ?? 0) !== clearGeneration)) return decision

    const agentId = agent.id
    if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > MAX_AGENT_ID_CHARS) return decision

    let membership
    try {
      membership = teamService.membership(agent)
    } catch {
      clearStateForAgent(states, agentId, agent)
      return decision
    }
    const teamId = membership?.id
    if (typeof teamId !== 'string' || teamId.length === 0 || teamId.length > MAX_TEAM_ID_CHARS) {
      clearStateForAgent(states, agentId, agent)
      return decision
    }

    const existing = states.get(agentId)
    if (existing?.agent === agent && existing.teamId !== teamId) states.delete(agentId)
    if (TEAM_TASK_TOOLS.has(exec.name)) {
      resetExistingState(states, agentId, agent, teamId)
      return decision
    }
    if (decision?.kind !== 'accept') return decision

    const state = stateForAgent(states, agentId, agent, teamId)
    state.count += 1
    if (state.count < REMINDER_INTERVAL) return decision
    state.count = 0
    if (exec.signal.aborted) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const reminder = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: TEAM_TASK_USE_REMINDER }],
    })
    return { ...decision, additionalContexts: [...previousContexts, reminder] }
  }

  return { listener, clearAgent, dispose }
}
