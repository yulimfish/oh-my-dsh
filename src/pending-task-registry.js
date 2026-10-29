import { randomUUID } from 'node:crypto'

export const PENDING_TASK_ID_PREFIX = 'bg_'
export const PENDING_TASK_TTL_MS = 30 * 60 * 1_000
export const PENDING_TASK_TERMINAL_TTL_MS = 10 * 60 * 1_000

const MAX_PENDING = 16
const MAX_RETAINED = 64
const MAX_PARENTS = 64
const MAX_ID_CHARS = 256
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired'])

function isAgent(agent) {
  return agent !== null && typeof agent === 'object'
    && typeof agent.id === 'string' && agent.id.length > 0 && agent.id.length <= MAX_ID_CHARS
}

function isId(value, prefix = false) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
    && (!prefix || value.startsWith(PENDING_TASK_ID_PREFIX))
}

function isSignal(value) {
  return value === undefined || (value !== null && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function')
}

function abortError() {
  return Object.assign(new Error('Pending task was cancelled before it started.'), { name: 'AbortError' })
}

/**
 * Bounded, process-local pending task identity and lifecycle registry.
 * It owns no child execution and provides no cross-reload persistence. A
 * running task detached by clearAgent/dispose is handed back to its caller;
 * detaching never claims that its child stopped.
 */
export function createPendingTaskRegistry({
  maxPending = MAX_PENDING,
  maxRetained = MAX_RETAINED,
  pendingTtlMs = PENDING_TASK_TTL_MS,
  terminalTtlMs = PENDING_TASK_TERMINAL_TTL_MS,
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  createId = () => `${PENDING_TASK_ID_PREFIX}${randomUUID()}`,
  withoutInitiator = fn => fn(),
  onChange,
} = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING) {
    throw new RangeError(`maxPending must be an integer from 1 to ${MAX_PENDING}`)
  }
  if (!Number.isSafeInteger(maxRetained) || maxRetained < maxPending || maxRetained > 256) {
    throw new RangeError('maxRetained must be an integer from maxPending to 256')
  }
  if (!Number.isSafeInteger(pendingTtlMs) || pendingTtlMs < 1 || pendingTtlMs > PENDING_TASK_TTL_MS) {
    throw new RangeError('pendingTtlMs must be an integer from 1 to 1800000')
  }
  if (!Number.isSafeInteger(terminalTtlMs) || terminalTtlMs < 1 || terminalTtlMs > PENDING_TASK_TERMINAL_TTL_MS) {
    throw new RangeError('terminalTtlMs must be an integer from 1 to 600000')
  }
  if ([now, setTimer, clearTimer, createId, withoutInitiator].some(fn => typeof fn !== 'function')) {
    throw new TypeError('pending task registry callbacks must be functions')
  }
  if (onChange !== undefined && typeof onChange !== 'function') throw new TypeError('onChange must be a function')

  const tasks = new Map()
  const parents = new Map()
  const childOwners = new Map()
  const clearedAgents = new WeakSet()
  const detachedEntries = new WeakSet()
  let disposed = false
  let disposing = false
  let pruning = false

  function time() {
    const value = now()
    if (!Number.isFinite(value) || value < 0) throw new RangeError('pending task clock must return a non-negative finite number')
    return value
  }

  function snapshot(entry) {
    return Object.freeze({
      id: entry.id,
      status: entry.status,
      queuedAt: entry.queuedAt,
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry.settledAt !== undefined ? { settledAt: entry.settledAt } : {}),
      ...(entry.childId !== undefined ? { childId: entry.childId } : {}),
    })
  }

  function notify(entry) {
    if (!onChange) return
    try { onChange(snapshot(entry)) } catch {}
  }

  function clearEntryTimer(entry) {
    if (entry.timer === undefined) return
    const timer = entry.timer
    entry.timer = undefined
    try { clearTimer(timer) } catch {}
  }

  function detachAbort(entry) {
    if (!entry.signal || !entry.onAbort) return
    try { entry.signal.removeEventListener('abort', entry.onAbort) } catch {}
    entry.onAbort = undefined
  }

  function remove(entry) {
    if (tasks.get(entry.id) !== entry) return false
    clearEntryTimer(entry)
    detachAbort(entry)
    tasks.delete(entry.id)
    if (entry.childId !== undefined && childOwners.get(entry.childId) === entry) childOwners.delete(entry.childId)
    const parent = entry.owner
    parent?.tasks.delete(entry.id)
    if (parent && parent.tasks.size === 0 && parents.get(entry.parent.id) === parent) parents.delete(entry.parent.id)
    return true
  }

  function arm(entry) {
    clearEntryTimer(entry)
    if (disposed || tasks.get(entry.id) !== entry || entry.status === 'running') return
    const target = entry.status === 'pending' ? entry.expiresAt : entry.retainUntil
    if (!Number.isFinite(target)) return
    try {
      const timer = withoutInitiator(() => setTimer(() => {
        entry.timer = undefined
        if (disposed || tasks.get(entry.id) !== entry) return
        prune()
      }, Math.max(0, target - time())))
      entry.timer = timer
      timer?.unref?.()
      if (disposed || tasks.get(entry.id) !== entry) clearEntryTimer(entry)
    } catch {
      // Lazy pruning on the next registry operation remains authoritative.
      entry.timer = undefined
    }
  }

  function transition(entry, status, settledAt) {
    if (tasks.get(entry.id) !== entry) return undefined
    clearEntryTimer(entry)
    detachAbort(entry)
    entry.status = status
    if (status === 'running') {
      entry.startedAt = settledAt
      entry.expiresAt = undefined
    } else if (TERMINAL.has(status)) {
      entry.settledAt = settledAt
      entry.retainUntil = settledAt + terminalTtlMs
    }
    arm(entry)
    notify(entry)
    return snapshot(entry)
  }

  function prune() {
    if (pruning || disposed) return
    pruning = true
    try {
      const current = time()
      for (const entry of [...tasks.values()]) {
        if (tasks.get(entry.id) !== entry) continue
        if (entry.status === 'pending' && current >= entry.expiresAt) {
          transition(entry, 'expired', current)
        }
        if (tasks.get(entry.id) === entry && TERMINAL.has(entry.status) && current >= entry.retainUntil) remove(entry)
      }
    } finally {
      pruning = false
    }
  }

  function parentRecord(parent, create = false) {
    if (disposed || !isAgent(parent) || clearedAgents.has(parent)) return undefined
    const existing = parents.get(parent.id)
    if (existing) return existing.agent === parent ? existing : undefined
    if (!create || parents.size >= MAX_PARENTS) return undefined
    const created = { agent: parent, tasks: new Map() }
    parents.set(parent.id, created)
    return created
  }

  function ownedEntry(parent, id) {
    if (!isId(id, true)) return undefined
    const entry = tasks.get(id)
    if (!entry || entry.parent !== parent) return undefined
    const owner = parentRecord(parent)
    return owner?.tasks.get(id) === entry ? entry : undefined
  }

  function enqueue(parent, { signal } = {}) {
    prune()
    const owner = parentRecord(parent, true)
    if (!owner) throw new Error('Pending task requires an exact live parent and available parent capacity.')
    try {
      if (!isSignal(signal)) throw new TypeError('Pending task received an invalid cancellation signal.')
      if (signal?.aborted) throw abortError()
      const pendingForParent = [...owner.tasks.values()].filter(entry => entry.status === 'pending').length
      if (pendingForParent >= maxPending || tasks.size >= maxRetained) throw new Error('Pending task capacity is full.')

      let entry
      for (let attempt = 0; attempt < 8 && !entry; attempt += 1) {
        const id = createId()
        if (!isId(id, true) || tasks.has(id)) continue
        const queuedAt = time()
        entry = {
          id, parent, owner, status: 'pending', queuedAt,
          expiresAt: queuedAt + pendingTtlMs,
          signal, timer: undefined, onAbort: undefined,
        }
      }
      if (!entry) throw new Error('Could not allocate a unique pending task ID.')
      tasks.set(entry.id, entry)
      owner.tasks.set(entry.id, entry)
      entry.onAbort = () => {
        if (tasks.get(entry.id) === entry && entry.status === 'pending') transition(entry, 'cancelled', time())
      }
      try {
        signal?.addEventListener('abort', entry.onAbort, { once: true })
        if (signal?.aborted) {
          remove(entry)
          throw abortError()
        }
      } catch (error) {
        remove(entry)
        throw error
      }
      if (entry.status === 'pending') {
        arm(entry)
        notify(entry)
      }
      return snapshot(entry)
    } catch (error) {
      try {
        if (owner.tasks.size === 0 && parents.get(parent.id) === owner) parents.delete(parent.id)
      } catch {}
      throw error
    }
  }

  function read(parent, id) {
    prune()
    const entry = ownedEntry(parent, id)
    return entry ? snapshot(entry) : undefined
  }

  function list(parent) {
    prune()
    const owner = parentRecord(parent)
    return owner ? [...owner.tasks.values()].map(snapshot) : []
  }

  function start(parent, id, childId) {
    prune()
    const entry = ownedEntry(parent, id)
    if (!entry || entry.status !== 'pending' || !isId(childId) || tasks.has(childId) || childOwners.has(childId)) return undefined
    const startedAt = time()
    entry.childId = childId
    childOwners.set(childId, entry)
    const result = transition(entry, 'running', startedAt)
    if (!result && childOwners.get(childId) === entry) childOwners.delete(childId)
    return result
  }

  function settle(parent, id, status) {
    prune()
    const entry = ownedEntry(parent, id)
    if (!entry || (entry.status !== 'running' && !(entry.status === 'pending' && status === 'failed'))
      || (status !== 'completed' && status !== 'failed')) return undefined
    return transition(entry, status, time())
  }

  function cancel(parent, id) {
    prune()
    const entry = ownedEntry(parent, id)
    if (!entry || entry.status !== 'pending') return undefined
    return transition(entry, 'cancelled', time())
  }

  function clearAgent(parent) {
    if (!isAgent(parent)) return []
    clearedAgents.add(parent)
    const owner = parents.get(parent.id)
    if (!owner || owner.agent !== parent) return []
    // Fence reentrant clearAgent calls from cancellation observers before any
    // notification or detach. The same running child must be handed off once.
    parents.delete(parent.id)
    const detached = []
    for (const entry of [...owner.tasks.values()]) {
      if (entry.status === 'pending') {
        transition(entry, 'cancelled', time())
      } else if (entry.status === 'running' && !disposing && !detachedEntries.has(entry)) {
        detachedEntries.add(entry)
        detached.push(snapshot(entry))
      }
      remove(entry)
    }
    if (parents.get(parent.id) === owner) parents.delete(parent.id)
    return detached
  }

  function dispose() {
    if (disposed) return []
    disposed = true
    disposing = true
    const detached = []
    for (const entry of [...tasks.values()]) {
      if (entry.status === 'running' && !detachedEntries.has(entry)) {
        detachedEntries.add(entry)
        detached.push(snapshot(entry))
      }
      else if (entry.status === 'pending') {
        clearEntryTimer(entry)
        detachAbort(entry)
        entry.status = 'cancelled'
        entry.settledAt = time()
        notify(entry)
      }
      remove(entry)
    }
    parents.clear()
    childOwners.clear()
    return detached
  }

  return Object.freeze({
    enqueue, read, list, start, settle, cancel, clearAgent, dispose,
    pendingCount(parent) {
      prune()
      if (parent !== undefined) {
        const owner = parentRecord(parent)
        return owner ? [...owner.tasks.values()].filter(entry => entry.status === 'pending').length : 0
      }
      return [...tasks.values()].filter(entry => entry.status === 'pending').length
    },
    size() {
      prune()
      return tasks.size
    },
  })
}
