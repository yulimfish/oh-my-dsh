const WAIT_MS = 8_000

export class PendingCapacityError extends Error {
  constructor(message = 'dsh-omo queued launch arguments exceed the waiting payload limit.') {
    super(message)
    this.name = 'PendingCapacityError'
  }
}

/**
 * In-memory capacity reservation; no Host or child lifecycle operations.
 * withoutInitiator must synchronously invoke and return its callback. Timers and
 * now use milliseconds; waiters have an 8,000 ms deadline, subject to event-loop scheduling.
 * acquire always returns a Promise, reserving synchronously when possible;
 * canWait=false rejects only if immediate admission is unavailable.
 * bind records a child ID while preserving the unique lease token for release.
 */
export function createGlobalAdmission({
  active, maxConcurrent, maxPending, isParentLive, lifecycleSignal,
  withoutInitiator = fn => fn(), onRelease, pendingCount, onWaitingChange, sharedChildOwners, setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout, now = () => performance.now(),
}) {
  if (!(active instanceof Set)) throw new TypeError('active must be a Set')
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be a positive integer')
  if (!Number.isInteger(maxPending) || maxPending < 0 || maxPending > 16) throw new RangeError('maxPending must be an integer from 0 to 16')
  if ([isParentLive, withoutInitiator, setTimer, clearTimer, now].some(fn => typeof fn !== 'function')) throw new TypeError('admission callbacks must be functions')
  const validSignal = signal => signal == null || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function')
  if (!validSignal(lifecycleSignal)) throw new TypeError('invalid lifecycle signal')

  const queue = []
  const owned = new Set()
  const childOwners = sharedChildOwners ?? new Map()
  const tokenChildren = new Map()
  let disposed = false
  let pumping = false
  const limitError = () => new Error(`dsh-omo one-shot worker limit reached (${maxConcurrent}); wait for a child to finish.`)
  const abortError = () => Object.assign(new Error('Admission aborted.'), { name: 'AbortError' })
  const shutdownError = () => new Error('dsh-omo is shutting down.')
  const timeoutError = () => new Error('Admission wait timed out after 8000ms.')
  const parentError = () => new Error('dsh-omo_task requires a live parent agent.')
  const schedule = fn => {
    let invoked = false
    let completed = false
    let value
    try {
      const result = withoutInitiator(() => {
        invoked = true
        value = fn()
        completed = true
        return value
      })
      if (!invoked) dispose()
      return result
    } catch {
      // The wrapper may fail during teardown. Never pump without isolation;
      // close the queue directly if it did not complete its callback. If it
      // threw after a completed callback, preserve the callback's outcome.
      if (!completed) dispose()
      return value
    }
  }

  function finish(entry, error, token) {
    if (entry.done) return
    entry.done = true
    if (entry.countedWaiting) onWaitingChange?.(-1)
    const index = queue.indexOf(entry)
    if (index !== -1) queue.splice(index, 1)
    try { entry.signal?.removeEventListener('abort', entry.onAbort) } catch {}
    if (entry.timerSet) { try { clearTimer(entry.timer) } catch {} }
    if (token === undefined) entry.reject(error instanceof Error ? error : new Error('Admission failed.'))
    else entry.resolve(token)
  }

  function pump() { return schedule(pumpWithoutInitiator) }

  function pumpWithoutInitiator() {
    if (pumping || disposed) return
    pumping = true
    try {
      while (!disposed && queue.length) {
        const entry = queue[0]
        if (entry.signal?.aborted) { finish(entry, abortError()); continue }
        if (entry.waiting && now() >= entry.deadline) { finish(entry, timeoutError()); continue }
        if (active.size >= maxConcurrent) break
        let live
        try { live = isParentLive(entry.parent) === true } catch { finish(entry, parentError()); continue }
        // The callback may synchronously abort, dispose, release, or acquire.
        if (entry.done || disposed) continue
        if (entry.signal?.aborted) { finish(entry, abortError()); continue }
        if (entry.waiting && now() >= entry.deadline) { finish(entry, timeoutError()); continue }
        if (!live) { finish(entry, parentError()); continue }
        if (active.size >= maxConcurrent) continue
        const token = Symbol('dsh-omo worker reservation')
        active.add(token)
        owned.add(token)
        finish(entry, null, token)
      }
    } finally { pumping = false }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    try { lifecycleSignal?.removeEventListener('abort', onDispose) } catch {}
    while (queue.length) finish(queue[0], shutdownError())
  }
  const onDispose = () => schedule(dispose)
  lifecycleSignal?.addEventListener('abort', onDispose, { once: true })
  if (lifecycleSignal?.aborted) dispose()

  function acquire(parent, signal, canWait = true) {
    if (disposed) return Promise.reject(shutdownError())
    let parentId
    try { parentId = parent?.id } catch { return Promise.reject(parentError()) }
    if (!parent || typeof parent !== 'object' || typeof parentId !== 'string' || !parentId.trim()) return Promise.reject(parentError())
    try {
      if (!validSignal(signal)) return Promise.reject(new TypeError('invalid admission signal'))
    } catch { return Promise.reject(new TypeError('invalid admission signal')) }
    try { if (signal?.aborted) return Promise.reject(abortError()) } catch { return Promise.reject(new TypeError('invalid admission signal')) }
    // Pump older waiters first even if capacity was freed outside release().
    pump()
    if (disposed) return Promise.reject(shutdownError())
    const waiting = pumping || queue.length > 0 || active.size >= maxConcurrent
    if (waiting && !canWait) return Promise.reject(new PendingCapacityError())
    if (waiting && (pendingCount?.() ?? queue.length) >= maxPending) return Promise.reject(limitError())
    let entry
    const promise = new Promise((resolve, reject) => {
      entry = { parent, signal, resolve, reject, waiting, done: false, timerSet: false }
    })
    entry.onAbort = () => schedule(() => { finish(entry, abortError()); pump() })
    queue.push(entry)
    try {
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      if (signal?.aborted) finish(entry, abortError())
      if (waiting && !entry.done) {
        entry.deadline = now() + WAIT_MS
        entry.countedWaiting = true
        onWaitingChange?.(1)
        const timer = schedule(() => setTimer(() => schedule(() => { finish(entry, timeoutError()); pump() }), WAIT_MS))
        entry.timer = timer
        entry.timerSet = true
        if (entry.done) clearTimer(timer)
      }
    } catch (error) { finish(entry, error) }
    pump()
    return promise
  }

  function release(token, { notify = true } = {}) {
    if (!owned.delete(token)) return false
    active.delete(token)
    const childId = tokenChildren.get(token)
    if (childId !== undefined && childOwners.get(childId) === token) childOwners.delete(childId)
    tokenChildren.delete(token)
    pump()
    if (notify) onRelease?.()
    return true
  }

  function bind(token, childId) {
    if (!owned.has(token) || !active.has(token)) throw new Error('Unknown admission reservation.')
    if (typeof childId !== 'string' || !childId.trim()) throw new TypeError('childId must be a non-empty string')
    if (tokenChildren.has(token) || childOwners.has(childId) || active.has(childId)) throw new Error('childId already has an admission reservation.')
    // Keep the unique token as the release handle, even if a child ID is reused.
    tokenChildren.set(token, childId)
    childOwners.set(childId, token)
    return token
  }

  function clearParent(parent) {
    for (const entry of [...queue]) if (entry.parent === parent) finish(entry, parentError())
    pump()
  }
  return { acquire, release, bind, clearParent, dispose, notify: pump }
}
