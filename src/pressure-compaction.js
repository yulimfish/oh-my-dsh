function validSignal(signal) {
  try {
    return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean'
  } catch {
    return false
  }
}

function livePosition(payload) {
  try {
    const agent = payload?.agent
    const id = agent?.id
    const signal = payload?.signal
    const turn = payload?.turn
    if (!agent || typeof agent !== 'object' || typeof id !== 'string' || id.length === 0 || id.length > 256
      || !Number.isSafeInteger(turn) || turn < 0 || !validSignal(signal) || signal.aborted) return undefined
    return { agent, id, signal }
  } catch {
    return undefined
  }
}

function warn(logger) {
  try {
    logger?.warn?.('[dsh-omo] pressure compaction failed')
  } catch {
    // Diagnostics must not interfere with an Agent turn.
  }
}

/** Run DSH's pressure policy at the safe, awaited turn-stopping boundary. */
export function createPressureCompactionListener({ agents, sessions, compaction, logger } = {}) {
  if (typeof agents?.get !== 'function' || typeof sessions?.get !== 'function'
    || typeof compaction?.compactIfNeeded !== 'function') {
    throw new TypeError('pressure compaction requires DSH agents.get, sessions.get, and compaction.compactIfNeeded')
  }

  const lifetime = new AbortController()
  const activeBySession = new Map()
  let disposed = false

  const listener = async payload => {
    if (disposed) return
    const position = livePosition(payload)
    if (!position) return
    const { agent, id, signal } = position

    let liveAgent
    let session
    try {
      liveAgent = agents.get(id)
      if (liveAgent !== agent) return
      session = sessions.get(id)
      if (!session || session.header?.id !== id) return
    } catch {
      return
    }
    if (activeBySession.has(id)) return

    let operationSignal
    try {
      operationSignal = AbortSignal.any([signal, lifetime.signal])
    } catch {
      return
    }
    if (operationSignal.aborted) return

    const operation = Object.freeze({ agent, session })
    activeBySession.set(id, operation)
    try {
      await compaction.compactIfNeeded({ session, options: {} }, 'pressure', operationSignal)
    } catch {
      warn(logger)
    } finally {
      if (activeBySession.get(id) === operation) activeBySession.delete(id)
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    lifetime.abort()
  }
  listener.dispose = dispose
  return listener
}

/** Register automatic pressure compaction without transforming tool results. */
export function registerPressureCompaction(ctx, services) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') {
    throw new TypeError('pressure compaction requires Cordis ctx.on and ctx.effect')
  }
  const listener = createPressureCompactionListener(services)
  try {
    ctx.on('agent/turn-stopping', listener)
    ctx.effect(() => listener.dispose, 'dsh-omo pressure compaction')
  } catch (error) {
    listener.dispose()
    throw error
  }
  return listener.dispose
}
