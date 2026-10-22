const PRUNE_USAGE = 'Usage: /omo prune-context'

/** Human-invoked, exact-current-Agent session pruning; never accepts a session id. */
export function createManualContextPruningHandler({ agents, sessions, pruner }) {
  return invocation => {
    if (invocation?.rawInput !== '') return { kind: 'error', text: PRUNE_USAGE }
    const { agent, signal } = invocation ?? {}
    if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string' || !agent.id
      || !signal || typeof signal.aborted !== 'boolean') {
      return { kind: 'error', text: 'Cannot prune context without a valid current Agent and live command signal.' }
    }
    if (signal.aborted) return { kind: 'error', text: 'Context pruning was canceled before it started.' }
    if (!agents || typeof agents.get !== 'function'
      || !sessions || typeof sessions.get !== 'function'
      || !pruner || typeof pruner.pruneSession !== 'function') {
      return { kind: 'error', text: 'Manual context pruning is unavailable because a required Host service is missing.' }
    }

    let session
    try {
      if (agents.get(agent.id) !== agent) {
        return { kind: 'error', text: 'Cannot prune context: the invoking Agent is no longer the exact live Agent.' }
      }
      session = sessions.get(agent.id)
    } catch {
      return { kind: 'error', text: 'Cannot resolve the invoking Agent’s live DSH Session.' }
    }
    if (!session || session.id !== agent.id) {
      return { kind: 'error', text: 'Cannot prune context: the invoking Agent’s live DSH Session is unavailable.' }
    }
    if (signal.aborted) return { kind: 'error', text: 'Context pruning was canceled before it started.' }

    try {
      pruner.pruneSession(session)
    } catch {
      return {
        kind: 'error',
        text: 'Host context pruning did not finish. Earlier replacements may already have landed; inspect the current session before retrying.',
      }
    }

    let stillCurrent = false
    try {
      stillCurrent = !signal.aborted && agents.get(agent.id) === agent && sessions.get(agent.id) === session
    } catch {
      // A Host lookup failure after pruning cannot undo replacements already committed.
    }
    if (!stillCurrent) {
      return {
        kind: 'error',
        text: 'The Host pruning call may have changed the session, but the invoking Agent/session is no longer current or the command was canceled; inspect the session before retrying.',
      }
    }
    return {
      kind: 'success',
      text: 'Host context pruning completed for the invoking Agent’s current session. Review the current conversation to see whether content changed.',
    }
  }
}
