import { PendingCapacityError } from './global-admission.js'

const WAIT_MS = 8_000

/** One bounded in-memory queue for a global and resolved-route lease pair. */
export function createRouteAdmission({
  active, maxConcurrent, maxPending = 16, describeRoute,
  isParentLive, lifecycleSignal, withoutInitiator = fn => fn(), onRelease, pendingCount, onWaitingChange, sharedChildOwners,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (!(active instanceof Set)) throw new TypeError('active must be a Set')
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be positive')
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 16) throw new RangeError('maxPending must be from 1 to 16')
  if ([describeRoute, isParentLive, withoutInitiator, now, setTimer, clearTimer].some(fn => typeof fn !== 'function')) throw new TypeError('admission callbacks must be functions')
  const queue = []
  const leases = new Map()
  const childOwners = sharedChildOwners ?? new Map()
  let disposed = false
  let pumping = false
  const error = text => new Error(text)
  const parentError = () => error('dsh-omo_task requires a live parent agent.')
  const abortError = () => Object.assign(error('Admission aborted.'), { name: 'AbortError' })
  const shutdownError = () => error('dsh-omo is shutting down.')
  const timeoutError = () => error('Admission wait timed out after 8000ms.')
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
      if (!completed) dispose()
      return value
    }
  }
  function finish(entry, reason, lease) {
    if (entry.done) return
    entry.done = true
    if (entry.countedWaiting) onWaitingChange?.(-1)
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    if (entry.timerSet) clearTimer(entry.timer)
    try { entry.signal?.removeEventListener('abort', entry.abort) } catch {}
    if (lease) entry.resolve(lease)
    else entry.reject(reason)
  }
  function available(entry) {
    if (active.size >= maxConcurrent) return false
    for (const older of queue) {
      if (older === entry) break
      if (!older.done && older.bucket === entry.bucket) return false
    }
    return true
  }
  function pumpWithoutInitiator() {
    if (disposed) return
    if (pumping) return
    pumping = true
    try {
      for (const entry of [...queue]) {
        if (entry.done || disposed) continue
        if (entry.signal?.aborted) { finish(entry, abortError()); continue }
        if (entry.waiting && now() >= entry.deadline) { finish(entry, timeoutError()); continue }
        if (!available(entry)) { armWaiting(entry); continue }
        let live = true
        if (entry.done || disposed) continue
        if (entry.signal?.aborted) { finish(entry, abortError()); continue }
        if (entry.waiting && now() >= entry.deadline) { finish(entry, timeoutError()); continue }
        if (!live) { finish(entry, parentError()); continue }
        if (!available(entry)) continue
        const token = Symbol('dsh-omo combined worker reservation')
        let routeRelease
        try { routeRelease = entry.reserveRoute() } catch (reason) {
          let capacityFailure = true
          if (entry.isCapacityError) {
            try { capacityFailure = entry.isCapacityError(reason) === true } catch { capacityFailure = false }
          }
          if (!capacityFailure) finish(entry, reason instanceof Error ? reason : error('Route reservation failed.'))
          else armWaiting(entry)
          continue
        }
        if (entry.done || disposed || entry.signal?.aborted) {
          try { routeRelease?.() } catch {}
          if (entry.signal?.aborted) finish(entry, abortError())
          continue
        }
        let stillLive = true
        try { stillLive = isParentLive(entry.parent) === true } catch {}
        if (entry.done || disposed || entry.signal?.aborted || (entry.waiting && now() >= entry.deadline)
          || !available(entry) || !stillLive) {
          try { routeRelease?.() } catch {}
          if (!entry.done && entry.signal?.aborted) finish(entry, abortError())
          else if (!entry.done && !stillLive) finish(entry, parentError())
          else if (!entry.done && entry.waiting && now() >= entry.deadline) finish(entry, timeoutError())
          else armWaiting(entry)
          continue
        }
        active.add(token)
        const lease = { token, parent: entry.parent, signal: entry.signal, routeRelease, routeReleased: false, released: false, childId: undefined }
        leases.set(token, lease)
        finish(entry, undefined, lease)
        onRelease?.()
      }
    } finally { pumping = false }
  }
  function pump() {
    if (pumping) {
      setTimer(() => schedule(pumpWithoutInitiator), 0)
      return
    }
    return schedule(pumpWithoutInitiator)
  }
  function armWaiting(entry) {
    if (entry.done || entry.timerSet) return
    if (!entry.canWait) { finish(entry, new PendingCapacityError()); return }
    if ((pendingCount?.() ?? queue.filter(candidate => !candidate.done && candidate !== entry).length) >= maxPending) {
      finish(entry, error('dsh-omo pending launch limit reached.'))
      return
    }
    entry.waiting = true
    entry.countedWaiting = true
    onWaitingChange?.(1)
    entry.deadline = now() + WAIT_MS
    entry.timer = schedule(() => setTimer(() => schedule(() => { finish(entry, timeoutError()); pump() }), WAIT_MS))
    entry.timerSet = true
    if (entry.done) clearTimer(entry.timer)
  }
  function acquire({ parent, signal, route, canWait = true, isCapacityError, reserveRoute }) {
    if (disposed) return Promise.reject(shutdownError())
    if (!parent || typeof parent !== 'object' || typeof reserveRoute !== 'function') return Promise.reject(parentError())
    if (signal?.aborted) return Promise.reject(abortError())
    if (isCapacityError !== undefined && typeof isCapacityError !== 'function') {
      return Promise.reject(new TypeError('isCapacityError must be a function when provided.'))
    }
    let initialLive = false
    try { initialLive = schedule(() => isParentLive(parent)) === true } catch { return Promise.reject(parentError()) }
    if (!initialLive) return Promise.reject(disposed ? shutdownError() : parentError())
    const description = describeRoute(route)
    const bucket = description?.bucket ?? 'unrestricted'
    pump()
    if (disposed) return Promise.reject(shutdownError())
    const waiting = queue.length > 0 || active.size >= maxConcurrent

    if (signal?.aborted) return Promise.reject(abortError())
    let entry
    const promise = new Promise((resolve, reject) => {
      entry = { parent, signal, bucket, reserveRoute, isCapacityError, resolve, reject, waiting, canWait, done: false, timerSet: false }
    })
    entry.abort = () => { finish(entry, abortError()); pump() }
    queue.push(entry)

    try {
      signal?.addEventListener('abort', entry.abort, { once: true })
      if (signal?.aborted) finish(entry, abortError())
      if (waiting && !entry.done && active.size >= maxConcurrent) armWaiting(entry)
    } catch (reason) { finish(entry, reason) }
    pump()
    return promise
  }
  function releaseRoute(lease) {
    if (!lease || leases.get(lease.token) !== lease || lease.routeReleased) return false
    try { lease.routeRelease?.() } finally {
      Object.defineProperty(lease, 'routeReleased', { value: true })
      pump()
    }
    return true
  }
  function release(lease) {
    if (!lease || leases.get(lease.token) !== lease || lease.released) return false
    Object.defineProperty(lease, 'released', { value: true, configurable: true })
    active.delete(lease.token)
    leases.delete(lease.token)
    if (lease.childId !== undefined && childOwners.get(lease.childId) === lease.token) childOwners.delete(lease.childId)
    pump()
    onRelease?.()
    return true
  }
  function bind(lease, childId) {
    if (!lease || leases.get(lease.token) !== lease || !active.has(lease.token)) throw error('Unknown admission reservation.')
    if (typeof childId !== 'string' || !childId.trim()) throw new TypeError('childId must be a non-empty string')
    if (lease.childId !== undefined || childOwners.has(childId)) throw error('childId already has an admission reservation.')
    Object.defineProperty(lease, 'childId', { value: childId })
    childOwners.set(childId, lease.token)
    return lease
  }
  function clearParent(parent) {
    for (const entry of [...queue]) if (entry.parent === parent) finish(entry, parentError())
    queueMicrotask(() => schedule(pumpWithoutInitiator))
  }
  function releaseAllRoutes() {
    for (const lease of leases.values()) if (!lease.routeReleased) releaseRoute(lease)
  }
  function dispose() {
    if (disposed) return
    disposed = true
    for (const entry of [...queue]) finish(entry, shutdownError())
  }
  const onDispose = () => schedule(dispose)
  lifecycleSignal?.addEventListener('abort', onDispose, { once: true })
  if (lifecycleSignal?.aborted) dispose()
  return Object.freeze({ acquire, releaseRoute, release, bind, clearParent, releaseAllRoutes, dispose, notify: pump })
}
