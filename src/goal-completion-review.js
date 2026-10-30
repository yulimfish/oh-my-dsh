import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { quoteBoundedText } from './prompt-text.js'

const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const MAX_GOAL_ID_CHARS = 256
const MAX_OBJECTIVE_CHARS = 2_000
const CONTROL_OR_BIDI_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function validSignal(signal) {
  return isObject(signal) && typeof signal.aborted === 'boolean'
}

function exactLiveAgent(agents, agentId, agent) {
  try {
    return typeof agents?.get === 'function' && agents.get(agentId) === agent
  } catch {
    return false
  }
}

function livePosition(payload, agents) {
  try {
    const agent = payload?.agent
    const id = agent?.id
    const turn = payload?.turn
    const signal = payload?.signal
    if (!isObject(agent) || typeof id !== 'string' || id.length === 0 || id.length > MAX_AGENT_ID_CHARS
      || !Number.isSafeInteger(turn) || turn < 0 || !validSignal(signal) || signal.aborted
      || !exactLiveAgent(agents, id, agent)) return undefined
    return { agent, id, turn, signal }
  } catch {
    return undefined
  }
}

function activeGoal(goals, agent) {
  try {
    const goal = goals?.get(agent)
    if (!isObject(goal) || goal.phase !== 'active' || goal.activation !== 'armed'
      || !Number.isSafeInteger(goal.roundsStarted) || goal.roundsStarted < 0
      || !Number.isSafeInteger(goal.maxGoalRounds) || goal.maxGoalRounds < 1
      || goal.roundsStarted >= goal.maxGoalRounds
      || typeof goal.id !== 'string' || goal.id.length === 0 || goal.id.length > MAX_GOAL_ID_CHARS
      || !Number.isSafeInteger(goal.revision) || goal.revision < 1
      || typeof goal.objective !== 'string' || !goal.objective.trim()) return undefined
    const objective = goal.objective.slice(0, MAX_OBJECTIVE_CHARS + 1)
      .replace(CONTROL_OR_BIDI_GLOBAL, ' ').replace(/\s+/gu, ' ').trim()
    if (!objective) return undefined
    return {
      id: goal.id,
      revision: goal.revision,
      objective: quoteBoundedText(objective, MAX_OBJECTIVE_CHARS),
    }
  } catch {
    return undefined
  }
}

function reviewMessage(goal) {
  return createUserMessage({
    source: { kind: 'goal-completion-review', form: 'notice', summary: boundContextSummary('Review the active Goal before closing this turn') },
    content: [{
      type: 'text',
      text: `[DSH Goal completion review]\n\nBefore closing this turn, check the current native Goal against evidence already gathered: ${goal.objective}\n\nIf requested work remains, continue it now rather than merely describing it as done. If recent exploration has added no new information, change strategy instead of repeating it. If the objective is genuinely satisfied, finish concisely. This one-time review grants no permissions and does not change, complete, pause, resume, or clear the Goal.`,
    }],
  })
}

/** One bounded completion nudge per exact Agent and native Goal revision. */
export function createGoalCompletionReview(goals, agents) {
  const states = new Map()
  const disposedAgents = new WeakSet()
  let disposed = false

  function clearAgent(agent) {
    if (isObject(agent)) disposedAgents.add(agent)
    for (const [id, state] of states) {
      if (state.agent === agent) states.delete(id)
    }
    let id
    try { id = agent?.id } catch { return }
    if (typeof id === 'string' && states.get(id)?.agent === agent) states.delete(id)
  }

  function stateFor(agent, id) {
    const existing = states.get(id)
    if (existing?.agent === agent) return existing
    // A validated same-ID replacement owns the old slot; it must not also
    // consume a second slot or retain the previous Agent's review history.
    if (existing) states.delete(id)
    if (states.size >= MAX_AGENT_STATES) return undefined
    const state = { agent, reviewed: undefined }
    states.set(id, state)
    return state
  }

  const listener = async payload => {
    if (disposed) return
    const position = livePosition(payload, agents)
    if (!position || disposedAgents.has(position.agent)) return
    const goal = activeGoal(goals, position.agent)
    if (!goal || disposed || position.signal.aborted) return

    let steer
    try { steer = position.agent.steer } catch { return }
    if (typeof steer !== 'function') return
    const key = `${goal.id}:${goal.revision}`
    if (disposed || position.signal.aborted || disposedAgents.has(position.agent)
      || !exactLiveAgent(agents, position.id, position.agent)) return
    const state = stateFor(position.agent, position.id)
    if (!state || state.reviewed === key) return
    // Retain only the latest key: the native Goal has one current revision.
    state.reviewed = key
    try {
      steer.call(position.agent, reviewMessage(goal))
    } catch {
      // A failed/disposed driver closes normally; this advisory never forces a retry loop.
    }
  }

  function dispose() {
    disposed = true
    states.clear()
  }

  return { listener, clearAgent, dispose }
}

/** Register the default-off, one-shot completion review at the awaited boundary. */
export function registerGoalCompletionReview(ctx, services) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') {
    throw new TypeError('Goal completion review requires Cordis ctx.on and ctx.effect')
  }
  const review = createGoalCompletionReview(services?.goals, services?.agents)
  ctx.on('agent/turn-stopping', review.listener)
  ctx.on('agent/disposed', payload => review.clearAgent(payload?.agent))
  ctx.effect(() => review.dispose, 'dsh-omo Goal completion review')
  return review.dispose
}
