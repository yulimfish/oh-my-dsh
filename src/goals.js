const ACTIONS = new Set(['pause', 'resume', 'complete', 'clear'])
const MAX_OBJECTIVE_CHARS = 4_000
const MAX_DISPLAY_CHARS = 1_600
const CONTROL_OR_BIDI_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

const USAGE = 'Usage: /goal [status | <objective> | pause | resume | complete | clear]'
const UNAVAILABLE = 'The native DSH Goal service is unavailable in this profile.'
const INVALID_AGENT = 'An active agent is required for /goal.'

function result(kind, text) {
  return { kind, text: text.slice(0, MAX_DISPLAY_CHARS) }
}

function cleanText(value, maxChars, fallback = 'unknown') {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(CONTROL_OR_BIDI_GLOBAL, ' ').replace(/\s+/gu, ' ').trim()
  if (!clean) return fallback
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean
}

function displayValue(value, maxChars = 100) {
  if (typeof value === 'string') return cleanText(value, maxChars)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, maxChars)
  if (typeof value === 'boolean') return String(value)
  if (value instanceof Date) {
    try {
      return cleanText(value.toISOString(), maxChars)
    } catch {
      return 'unknown'
    }
  }
  return 'unknown'
}

function displayGoal(goal) {
  const phase = ['active', 'paused', 'blocked', 'complete'].includes(goal.phase) ? goal.phase : 'unknown'
  const activation = ['armed', 'disarmed'].includes(goal.activation) ? goal.activation : 'unknown'
  const maxRounds = goal.maxGoalRounds === undefined || goal.maxGoalRounds === null
    ? 'not specified'
    : displayValue(goal.maxGoalRounds, 40)

  return result('success', [
    'Current native DSH Goal',
    `Objective: ${cleanText(goal.objective, 700)}`,
    `Phase: ${phase}; activation: ${activation}`,
    `Rounds started: ${displayValue(goal.roundsStarted, 40)}; maximum: ${maxRounds}`,
    `Revision: ${displayValue(goal.revision, 40)}; ID: ${displayValue(goal.id, 100)}`,
    `Created: ${displayValue(goal.createdAt, 100)}; updated: ${displayValue(goal.updatedAt, 100)}`,
    'DSH retains authority over Goal persistence and continuation.',
  ].join('\n'))
}

function validAgent(agent) {
  return agent !== null && typeof agent === 'object'
}

function serviceHas(goals, method) {
  try {
    return goals !== null && goals !== undefined && typeof goals[method] === 'function'
  } catch {
    return false
  }
}

async function showGoal(goals, agent) {
  if (!serviceHas(goals, 'get')) return result('error', UNAVAILABLE)
  try {
    const current = await goals.get(agent)
    if (current === undefined || current === null) {
      return result('success', 'No current native DSH Goal. Create one with /goal <objective>. DSH retains persistence and continuation authority.')
    }
    return displayGoal(current)
  } catch {
    return result('error', 'Could not read the native DSH Goal (service error).')
  }
}

async function mutateGoal(goals, agent, action) {
  if (!serviceHas(goals, 'get')) return result('error', UNAVAILABLE)
  try {
    const current = await goals.get(agent)
    if (current === undefined || current === null) {
      return result('error', `There is no current DSH Goal to ${action}.`)
    }
    const id = current.id
    const revision = current.revision
    if (id === undefined || id === null || id === '' || revision === undefined || revision === null) {
      return result('error', 'The current DSH Goal has no valid revision reference; no change was made.')
    }
    if (!serviceHas(goals, action)) return result('error', UNAVAILABLE)
    await goals[action](agent, { id, revision })
    return result('success', `Native DSH Goal ${action} requested. DSH retains authority over Goal persistence and continuation.`)
  } catch {
    return result('error', `Could not ${action} the native DSH Goal (service error).`)
  }
}

/** Build the standalone /goal command registration for an optional native DSH Goal service. */
export function createGoalCommand(goals) {
  return {
    name: 'goal',
    description: 'Display or manage the current agent’s native DSH Goal.',
    input: { hint: '[status | <objective> | pause | resume | complete | clear]' },
    async handler(args = {}) {
      const agent = args?.agent
      const rawInput = args?.rawInput
      if (!validAgent(agent)) return result('error', INVALID_AGENT)
      if (typeof rawInput !== 'string') return result('error', USAGE)

      if (rawInput.length > MAX_OBJECTIVE_CHARS) {
        return result('error', `Goal objective is too long (maximum ${MAX_OBJECTIVE_CHARS} characters).`)
      }
      const input = rawInput.trim()
      if (input.length === 0) return showGoal(goals, agent)
      const command = input.toLowerCase()
      if (command === 'status') return showGoal(goals, agent)
      if (ACTIONS.has(command)) return mutateGoal(goals, agent, command)

      if (/^status(?:\s|$)/u.test(command)) return result('error', USAGE)
      if (!input.trim()) return result('error', 'Goal objective must not be empty.')
      if (!serviceHas(goals, 'create')) return result('error', UNAVAILABLE)
      try {
        await goals.create(agent, { objective: input })
        return result('success', 'Native DSH Goal created. DSH retains authority over Goal persistence and continuation.')
      } catch {
        return result('error', 'Could not create the native DSH Goal (service error).')
      }
    },
  }
}

async function clearGoalForStop(goals, agent) {
  if (!serviceHas(goals, 'get') || !serviceHas(goals, 'clear')) return result('error', UNAVAILABLE)
  try {
    const current = await goals.get(agent)
    if (current === undefined || current === null) {
      return result('success', 'No current native DSH Goal was present. No Goal changed; DSH continuable children and OMO todo/boulder state are unaffected.')
    }
    const id = current.id
    const revision = current.revision
    if (id === undefined || id === null || id === '' || revision === undefined || revision === null) {
      return result('error', 'The current DSH Goal has no valid revision reference; no change was made.')
    }
    await goals.clear(agent, { id, revision })
    return result('success', 'Current native DSH Goal cleared. This stops Goal continuation only; DSH continuable children and OMO todo/boulder state are not changed.')
  } catch {
    return result('error', 'Could not clear the native DSH Goal (service error).')
  }
}

/** Map /stop-continuation to native Goal clearing when DSH exposes that exact mutation. */
export function createStopContinuationCommand(goals) {
  if (!serviceHas(goals, 'get') || !serviceHas(goals, 'clear')) return undefined
  return {
    name: 'stop-continuation',
    description: 'Clear only the current native DSH Goal; this does not stop DSH child sessions or OMO todo/boulder state.',
    input: { hint: '(no arguments)' },
    async handler(args = {}) {
      const agent = args?.agent
      const rawInput = args?.rawInput
      if (!validAgent(agent)) return result('error', INVALID_AGENT)
      if (typeof rawInput !== 'string' || rawInput.length > 128 || rawInput.trim()) {
        return result('error', 'Usage: /stop-continuation (no arguments)')
      }
      return clearGoalForStop(goals, agent)
    },
  }
}
