const MAX_ROOTS = 20
const MAX_DESCENDANTS_PER_ROOT = 100
const MAX_CONCURRENT_ROOT_READS = 4
const DESCENDANT_READ_TIMEOUT_MS = 2_000
const MAX_IDENTIFIER_LENGTH = 256
const MAX_LABEL_LENGTH = 160
const MAX_OBJECTIVE_LENGTH = 500

const UNSAFE_TEXT = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u
const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete'])
const CHILD_MODES = new Set(['one-shot', 'external', 'continuable'])
const DIAGNOSTIC_REASONS = new Set(['corrupt', 'unsupported', 'unavailable'])

const NOTE = 'Shows current runtime roots only; nonresident historical roots are omitted. Inactive means no resident DSH Session was observed; it does not encode completion, success, or external-process state. Prompts and results are not included.'

async function mapConcurrent(values, limit, worker) {
  const results = new Array(values.length)
  let cursor = 0
  const workers = Math.min(limit, values.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(values[index], index)
    }
  }))
  return results
}

function boundedText(value, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return undefined

  let bounded = ''
  let length = 0
  for (const character of value) {
    if (UNSAFE_TEXT.test(character)) continue
    if (!bounded && /^\s$/u.test(character)) continue
    if (length >= maxLength) break
    bounded += character
    length += 1
  }

  bounded = bounded.trim()
  return bounded || allowEmpty ? bounded : undefined
}

function identifier(value) {
  return boundedText(value, MAX_IDENTIFIER_LENGTH)
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function projectGoal(goals, agent) {
  try {
    if (typeof goals?.get !== 'function') return undefined
    const goal = goals.get(agent)
    if (!goal || typeof goal !== 'object') return undefined

    const objective = boundedText(goal.objective, MAX_OBJECTIVE_LENGTH, { allowEmpty: true })
    if (objective === undefined
      || !GOAL_PHASES.has(goal.phase)
      || !validCount(goal.roundsStarted)
      || !validCount(goal.maxGoalRounds)) return undefined

    return {
      objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
    }
  } catch {
    return undefined
  }
}

function projectDescendant(entry) {
  try {
    if (!entry || typeof entry !== 'object') return undefined

    const id = identifier(entry.id)
    const parentId = identifier(entry.parentId)
    if (id === undefined || parentId === undefined
      || !Number.isSafeInteger(entry.depth) || entry.depth < 1) return undefined

    if (entry.kind === 'diagnostic') {
      if (!DIAGNOSTIC_REASONS.has(entry.reason)) return undefined
      return {
        kind: 'diagnostic',
        id,
        parentId,
        depth: entry.depth,
        reason: entry.reason,
      }
    }

    if (entry.kind !== 'child'
      || !['running', 'inactive'].includes(entry.activity)
      || !CHILD_MODES.has(entry.mode)
      || typeof entry.hasChildren !== 'boolean') return undefined

    const label = boundedText(entry.label, MAX_LABEL_LENGTH)
    return {
      kind: 'child',
      id,
      parentId,
      depth: entry.depth,
      activity: entry.activity,
      mode: entry.mode,
      ...(label !== undefined ? { label } : {}),
      hasChildren: entry.hasChildren,
    }
  } catch {
    return undefined
  }
}

function readTimestamp(now) {
  try {
    const value = typeof now === 'function' ? now() : now
    return Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}

function makeSnapshot({ available, roots, truncated, now }) {
  return {
    available,
    scope: 'live-roots',
    updatedAt: readTimestamp(now),
    truncated,
    limits: {
      maxRoots: MAX_ROOTS,
      maxDescendantsPerRoot: MAX_DESCENDANTS_PER_ROOT,
    },
    note: available ? NOTE : `${NOTE} Required snapshot APIs are unavailable.`,
    roots,
  }
}

/**
 * Create a read-only, bounded view of resident runtime roots and their catalogs.
 * Only selected identifiers, goal summary fields, and descendant status fields
 * are copied into the returned plain-JSON snapshot.
 */
export function createAgentTreeSnapshot({ agents, subagents, goals, now } = {}) {
  return {
    async read() {
      let rootsMethod
      let descendantsMethod
      try {
        rootsMethod = agents?.roots
        descendantsMethod = subagents?.listDescendants
      } catch {
        return makeSnapshot({ available: false, roots: [], truncated: false, now })
      }

      if (typeof rootsMethod !== 'function') {
        return makeSnapshot({ available: false, roots: [], truncated: false, now })
      }

      let liveRoots
      try {
        liveRoots = rootsMethod.call(agents)
      } catch {
        return makeSnapshot({ available: false, roots: [], truncated: false, now })
      }
      if (!Array.isArray(liveRoots)) {
        return makeSnapshot({ available: false, roots: [], truncated: false, now })
      }

      let truncated = liveRoots.length > MAX_ROOTS
      const rootsToRead = liveRoots.slice(0, MAX_ROOTS)
      const descendantsAvailable = typeof descendantsMethod === 'function'

      const roots = await mapConcurrent(rootsToRead, MAX_CONCURRENT_ROOT_READS, async agent => {
        try {
          const id = identifier(agent?.id)
          if (id === undefined) {
            truncated = true
            return undefined
          }

          const goal = projectGoal(goals, agent)
          if (!descendantsAvailable) {
            return {
              id,
              ...(goal ? { goal } : {}),
              descendants: [],
              unavailable: true,
            }
          }

          let entries
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), DESCENDANT_READ_TIMEOUT_MS)
          try {
            entries = await descendantsMethod.call(subagents, agent.id, controller.signal)
          } catch {
            return {
              id,
              ...(goal ? { goal } : {}),
              descendants: [],
              unavailable: true,
            }
          } finally {
            clearTimeout(timeout)
          }

          if (!Array.isArray(entries)) {
            return {
              id,
              ...(goal ? { goal } : {}),
              descendants: [],
              unavailable: true,
            }
          }

          if (entries.length > MAX_DESCENDANTS_PER_ROOT) truncated = true
          const descendants = []
          const rowLimit = Math.min(entries.length, MAX_DESCENDANTS_PER_ROOT)
          for (let index = 0; index < rowLimit; index += 1) {
            const descendant = projectDescendant(entries[index])
            if (descendant) descendants.push(descendant)
            else truncated = true
          }

          return {
            id,
            ...(goal ? { goal } : {}),
            descendants,
          }
        } catch {
          // A malformed root must not prevent other live roots from appearing.
          truncated = true
          return undefined
        }
      })

      return makeSnapshot({
        available: descendantsAvailable,
        roots: roots.filter(Boolean),
        truncated,
        now,
      })
    },
  }
}
