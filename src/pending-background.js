import { PendingCapacityError } from './global-admission.js'

/** Single-flight process-local scheduler; execution and capacity remain launcher-owned. */
export function createPendingBackgroundScheduler({
  registry, launchTask, isParentCurrent, withoutInitiator = fn => fn(), notifyFailure, notifyExpiry, interruptChild,
} = {}) {
  if (!registry || typeof registry.enqueue !== 'function' || typeof registry.read !== 'function'
    || typeof registry.start !== 'function' || typeof registry.settle !== 'function'
    || typeof registry.cancel !== 'function' || typeof registry.clearAgent !== 'function'
    || typeof registry.dispose !== 'function') throw new TypeError('pending scheduler requires a pending task registry')
  if (typeof launchTask !== 'function' || typeof isParentCurrent !== 'function' || typeof withoutInitiator !== 'function') {
    throw new TypeError('pending scheduler requires the admitted launcher and exact parent checks')
  }
  if (interruptChild !== undefined && typeof interruptChild !== 'function') {
    throw new TypeError('pending scheduler interruptChild must be a function when provided')
  }

  const entries = new Map()
  let scheduled = false
  let inFlight = false
  let flight
  let wakeRequested = false
  let notificationGeneration = 0
  let disposed = false
  let disposePromise

  function present(entry) { return !disposed && entries.get(entry.taskId) === entry }
  function currentParent(entry) {
    try { return isParentCurrent(entry.parent) === true } catch { return false }
  }
  function current(entry) { return present(entry) && !entry.controller.signal.aborted && currentParent(entry) }

  function schedule() {
    if (disposed) return
    if (inFlight) { wakeRequested = true; return }
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      try { withoutInitiator(pump) } catch (error) { failAll(error) }
    })
  }

  function notify() {
    notificationGeneration += 1
    for (const entry of entries.values()) if (entry.phase === 'queued') entry.blocked = false
    schedule()
  }

  function settleEntry(entry, status) {
    if (entries.get(entry.taskId) !== entry) return undefined
    entries.delete(entry.taskId)
    entry.phase = status
    let result
    try { result = registry.settle(entry.parent, entry.taskId, status === 'completed' ? 'completed' : 'failed') } catch {}
    notify()
    return result
  }

  function recordOutcome(entry, status) {
    if (!present(entry)) return
    const normalized = status === 'completed' ? 'completed' : 'failed'
    if (entry.phase === 'starting') {
      entry.earlyOutcome = normalized
      return
    }
    if (entry.phase === 'bound') settleEntry(entry, normalized)
  }

  function fail(entry, error) {
    if (entries.get(entry.taskId) !== entry) return
    const shouldNotify = !disposed && !entry.controller.signal.aborted && currentParent(entry)
    entries.delete(entry.taskId)
    entry.phase = 'failed'
    try { registry.settle(entry.parent, entry.taskId, 'failed') } catch {}
    if (shouldNotify) {
      try { notifyFailure?.(entry, error) } catch {}
    }
  }

  function failAll(error) {
    for (const entry of [...entries.values()]) {
      if (entry.phase === 'queued') fail(entry, error)
    }
  }

  function disposeRun(run) {
    if (!run || typeof run.dispose !== 'function') return Promise.resolve()
    try { return Promise.resolve(run.dispose()).catch(() => {}) } catch { return Promise.resolve() }
  }

  async function bind(entry, launched) {
    const childId = launched?.childId
    if (!launched || launched.status !== 'started' || typeof childId !== 'string' || childId.length === 0) {
      throw new TypeError('Admitted launcher returned an invalid child identity for a pending task.')
    }
    if (!current(entry)) {
      // The launcher normally performs this late-activation cleanup itself,
      // but retain an exact-run cleanup fallback for stale parents or cancellation.
      if (entries.get(entry.taskId) === entry) {
        entries.delete(entry.taskId)
        entry.phase = 'cancelled'
        entry.controller.abort()
        try { registry.cancel(entry.parent, entry.taskId) } catch {}
      }
      if (entry.run) await disposeRun(entry.run)
      return
    }
    if (!entry.run) throw new Error('Pending task child handle was not published by the admitted launcher.')
    const bound = registry.start(entry.parent, entry.taskId, childId)
    if (!bound) throw new Error('Pending task child identity could not be bound.')
    entry.childId = childId
    entry.phase = 'bound'
    if (entry.earlyOutcome) settleEntry(entry, entry.earlyOutcome)
  }

  async function attempt(entry) {
    if (entry.phase !== 'queued') return
    const attemptGeneration = notificationGeneration
    const state = registry.read(entry.parent, entry.taskId)
    if (state?.status !== 'pending') {
      entries.delete(entry.taskId)
      entry.controller.abort()
      return
    }
    if (!current(entry)) {
      entries.delete(entry.taskId)
      entry.controller.abort()
      try { registry.cancel(entry.parent, entry.taskId) } catch {}
      return
    }
    entry.phase = 'starting'
    try {
      const launched = await launchTask(entry.args, {
        agent: entry.parent,
        signal: entry.controller.signal,
        pendingBackground: true,
        pendingTaskId: entry.taskId,
        pendingOutcome: outcome => recordOutcome(entry, outcome),
        onPendingRun: run => {
          entry.run = run
          if (!current(entry)) void disposeRun(run)
        },
      })
      await bind(entry, launched)
    } catch (error) {
      let capacityStillPending = false
      if (error instanceof PendingCapacityError && !entry.run) {
        try {
          capacityStillPending = current(entry) && registry.read(entry.parent, entry.taskId)?.status === 'pending'
        } catch {}
      }
      if (capacityStillPending) {
        entry.phase = 'queued'
        // A saturated route must not head-of-line block unrelated pending work.
        // Retry this entry only after a later capacity notification.
        entry.blocked = notificationGeneration === attemptGeneration
        return
      }
      fail(entry, error)
      entry.controller.abort()
      if (entry.run) await disposeRun(entry.run)
    }
  }

  function pump() {
    if (inFlight || disposed) return
    for (const entry of entries.values()) {
      if (entry.phase !== 'queued' || entry.blocked) continue
      inFlight = true
      const operation = Promise.resolve().then(() => attempt(entry))
      flight = operation
      void operation.catch(error => fail(entry, error)).finally(() => {
        if (flight === operation) flight = undefined
        inFlight = false
        const hasRunnable = [...entries.values()].some(candidate => candidate.phase === 'queued' && !candidate.blocked)
        if (entry.phase !== 'queued' || wakeRequested || hasRunnable) {
          wakeRequested = false
          schedule()
        }
      })
      return
    }
  }

  function enqueue(args, exec) {
    if (disposed) throw new Error('dsh-omo is shutting down.')
    const parent = exec?.agent
    if (exec?.signal?.aborted) throw Object.assign(new Error('Pending task was cancelled before it started.'), { name: 'AbortError' })
    if (!currentParent({ parent })) throw new Error('dsh-omo_task requires a live parent agent.')
    const controller = new AbortController()
    const pending = registry.enqueue(parent)
    const entry = {
      taskId: pending.id,
      args: { ...args, load_skills: Array.isArray(args?.load_skills) ? [...args.load_skills] : args?.load_skills },
      parent,
      controller,
      phase: 'queued',
      blocked: false,
      childId: undefined,
      interruptRequested: false,
      run: undefined,
      earlyOutcome: undefined,
    }
    entries.set(entry.taskId, entry)
    if (exec?.signal?.aborted || !currentParent(entry)) {
      entries.delete(entry.taskId)
      controller.abort()
      registry.cancel(parent, entry.taskId)
      if (exec?.signal?.aborted) throw Object.assign(new Error('Pending task was cancelled before it started.'), { name: 'AbortError' })
      throw new Error('dsh-omo_task requires a live parent agent.')
    }
    schedule()
    return Object.freeze({ taskId: entry.taskId, role: args.role, status: 'pending' })
  }

  function cancel(parent, taskId) {
    const entry = entries.get(taskId)
    if (!entry || entry.parent !== parent) return undefined
    if (entry.phase === 'bound') {
      if (!entry.childId || !current(entry)) return undefined
      if (entry.interruptRequested) return Object.freeze({ id: entry.taskId, status: 'interrupt-requested' })
      if (!interruptChild) return undefined
      interruptChild(entry.childId, parent)
      if (entries.get(taskId) === entry) entry.interruptRequested = true
      return Object.freeze({ id: entry.taskId, status: 'interrupt-requested' })
    }
    entries.delete(taskId)
    entry.controller.abort()
    const cancelled = registry.cancel(parent, taskId)
    if (entry.run) void disposeRun(entry.run)
    schedule()
    return cancelled
  }

  function onRegistryChange(snapshot) {
    const entry = entries.get(snapshot?.id)
    if (!entry || ['pending', 'running'].includes(snapshot.status)) return
    if (entry.phase === 'bound' && snapshot.status === 'completed') return
    const startupInProgress = entry.phase !== 'queued'
    const notifyExpired = snapshot.status === 'expired' && currentParent(entry)
    entries.delete(entry.taskId)
    entry.controller.abort()
    if (entry.run) void disposeRun(entry.run)
    if (notifyExpired) {
      try { notifyExpiry?.(entry, { startupInProgress }) } catch {}
    }
    schedule()
  }

  function clearAgent(parent) {
    const detached = []
    for (const entry of [...entries.values()]) {
      if (entry.parent !== parent) continue
      entries.delete(entry.taskId)
      entry.controller.abort()
      if (entry.run) detached.push(entry.run)
    }
    return detached
  }

  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    for (const entry of entries.values()) entry.controller.abort()
    const draining = flight
    disposePromise = (async () => {
      if (draining) try { await draining } catch {}
      const runs = [...new Set([...entries.values()].filter(entry => entry.phase === 'bound').map(entry => entry.run).filter(Boolean))]
      entries.clear()
      await Promise.allSettled(runs.map(disposeRun))
    })()
    return disposePromise
  }

  function settle(parent, taskId, status) {
    const entry = entries.get(taskId)
    if (!entry || entry.parent !== parent) return undefined
    recordOutcome(entry, status)
    return true
  }

  return Object.freeze({ enqueue, cancel, clearAgent, dispose, notify, settle, onRegistryChange })
}
