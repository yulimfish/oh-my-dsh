import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TASK_RESULT_MAX_CHARS, TASK_RESULT_TTL_MS } from './task-result-tool.js'

const MAX_ID_CHARS = 256
const MAX_STOP_REASON_CHARS = 80
export const TASK_RESULT_STORAGE_MAX_ROWS = 256
export const TASK_RESULT_STORAGE_MAX_PENDING_OPERATIONS = 64
const MAX_STORAGE_SCAN_ROWS = TASK_RESULT_STORAGE_MAX_ROWS * 2
const TASK_RESULT_OUTPUT_MAX_BYTES = TASK_RESULT_MAX_CHARS * 3
const STORAGE_DRAIN_TIMEOUT_MS = 1_000
const TASK_RESULT_STATUS = Object.freeze(['completed', 'incomplete', 'failed'])

const StoredTaskResultSchema = z.object({
  version: z.literal(1),
  parentId: z.string().min(1).max(MAX_ID_CHARS),
  childId: z.string().min(1).max(MAX_ID_CHARS),
  status: z.enum(TASK_RESULT_STATUS),
  output: z.string().max(TASK_RESULT_MAX_CHARS)
    .refine(value => Buffer.byteLength(value, 'utf8') <= TASK_RESULT_OUTPUT_MAX_BYTES),
  truncated: z.boolean(),
  omittedNonText: z.boolean(),
  stopReason: z.string().max(MAX_STOP_REASON_CHARS).optional(),
  settledAt: z.number().int().min(0).refine(Number.isSafeInteger),
  expiresAt: z.number().int().min(0).refine(Number.isSafeInteger),
}).strict().refine(record => record.expiresAt > record.settledAt
  && record.expiresAt - record.settledAt <= TASK_RESULT_TTL_MS)

export const TASK_RESULT_STORAGE_DOMAIN_SPEC = Object.freeze({
  name: 'dsh-omo-task-results',
  version: 1,
  tables: Object.freeze({
    results: Object.freeze({ valueSchema: StoredTaskResultSchema }),
  }),
})

function storageKey(parentId, childId) {
  return createHash('sha256').update(JSON.stringify([parentId, childId])).digest('hex')
}

function parseStoredRecord(value) {
  const parsed = StoredTaskResultSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function report(onStorageError, error) {
  try { onStorageError?.(error) } catch {}
}

function validateTable(table) {
  if (!table || typeof table.get !== 'function' || typeof table.put !== 'function'
    || typeof table.delete !== 'function' || typeof table.entries !== 'function'
    || !Number.isSafeInteger(table.size) || table.size < 0) {
    throw new TypeError('storageDomain returned an incompatible task-results table.')
  }
  return table
}

/** Open the caller-owned KV domain. The store returned below owns its close. */
export async function openTaskResultStorageDomain(storageDomain) {
  if (!storageDomain || typeof storageDomain.open !== 'function') {
    throw new TypeError('Persistent task results require the Host storageDomain Service.')
  }
  let domain
  try {
    domain = await storageDomain.open(TASK_RESULT_STORAGE_DOMAIN_SPEC)
    if (!domain || typeof domain.table !== 'function' || typeof domain.close !== 'function') {
      throw new TypeError('storageDomain returned an invalid task-results domain handle.')
    }
    const table = validateTable(domain.table('results'))
    return { domain, table }
  } catch (error) {
    try { await domain?.close?.() } catch {}
    throw error
  }
}

/**
 * Best-effort, serialized persistence for terminal one-shot result snapshots.
 * It never records active work, caps its own KV table at 256 rows, and admits
 * at most 64 queued/in-flight operations; saturation preserves local results.
 */
export function createTaskResultStorage({ storageDomain, now = Date.now, onStorageError } = {}) {
  if (!storageDomain || typeof storageDomain.open !== 'function') {
    throw new TypeError('Persistent task-result storage requires storageDomain.open.')
  }
  if (typeof now !== 'function') throw new TypeError('Persistent task-result storage requires a clock.')
  if (onStorageError !== undefined && typeof onStorageError !== 'function') {
    throw new TypeError('Persistent task-result storage requires a storage error callback when provided.')
  }

  const state = { status: 'unopened', domain: undefined, closePromise: undefined, disposed: false, abandonPending: false }
  let queue = Promise.resolve()
  let pendingOperations = 0
  let capacityWarned = false
  let opening
  let disposePromise

  function abandoning() {
    return state.disposed && state.abandonPending
  }

  function closeDomain() {
    if (!state.domain) return Promise.resolve()
    if (!state.closePromise) {
      state.closePromise = Promise.resolve().then(() => state.domain.close()).catch(error => {
        report(onStorageError, error)
      })
    }
    return state.closePromise
  }

  function ensureOpen() {
    if (!opening) {
      state.status = 'pending'
      opening = openTaskResultStorageDomain(storageDomain).then(({ domain, table }) => {
        state.status = 'opened'
        state.domain = domain
        if (state.disposed) void closeDomain()
        return table
      }, error => {
        state.status = 'failed'
        report(onStorageError, error)
        return undefined
      })
    }
    return opening
  }

  function enqueue(operation) {
    if (state.disposed) return Promise.resolve(undefined)
    if (pendingOperations >= TASK_RESULT_STORAGE_MAX_PENDING_OPERATIONS) {
      if (!capacityWarned) {
        capacityWarned = true
        report(onStorageError, new Error('task-result persistence queue capacity is full'))
      }
      return Promise.resolve(undefined)
    }
    pendingOperations += 1
    const release = () => {
      pendingOperations -= 1
      capacityWarned = false
    }
    const openingAtEnqueue = ensureOpen()
    const next = queue.then(async () => {
      const table = await openingAtEnqueue
      if (!table || (state.disposed && state.abandonPending)) return undefined
      return operation(table)
    })
    queue = next.then(() => {
      release()
    }, error => {
      release()
      report(onStorageError, error)
      return undefined
    })
    return next.catch(error => {
      report(onStorageError, error)
      return undefined
    })
  }

  function snapshotRows(table) {
    if (!Number.isSafeInteger(table.size) || table.size < 0 || table.size > MAX_STORAGE_SCAN_ROWS) return undefined
    const rows = []
    for (const [key, raw] of table.entries()) {
      if (rows.length >= MAX_STORAGE_SCAN_ROWS) return undefined
      const record = parseStoredRecord(raw)
      rows.push({ key, record })
    }
    return rows.length === table.size ? rows : undefined
  }

  async function trimTable(table, targetSize) {
    if (abandoning()) return false
    const rows = snapshotRows(table)
    if (!rows) {
      report(onStorageError, new Error('task-result table exceeds its bounded scan limit'))
      return false
    }
    const time = now()
    const valid = []
    for (const row of rows) {
      if (abandoning()) return false
      if (!row.record || storageKey(row.record.parentId, row.record.childId) !== row.key
        || row.record.settledAt > time || row.record.expiresAt <= time) {
        await table.delete(row.key)
        if (abandoning()) return false
      } else {
        valid.push(row)
      }
    }
    valid.sort((left, right) => left.record.settledAt - right.record.settledAt || left.key.localeCompare(right.key))
    while (valid.length > targetSize) {
      if (abandoning()) return false
      const oldest = valid.shift()
      await table.delete(oldest.key)
      if (abandoning()) return false
    }
    return table.size <= targetSize
  }

  function normalizeForWrite(record) {
    const candidate = { version: 1, ...record }
    const parsed = StoredTaskResultSchema.safeParse(candidate)
    if (!parsed.success) return undefined
    const time = now()
    return Number.isSafeInteger(time) && parsed.data.settledAt <= time && parsed.data.expiresAt > time
      ? parsed.data
      : undefined
  }

  return {
    ready() {
      if (state.disposed) return Promise.resolve(false)
      return ensureOpen().then(table => Boolean(table))
    },
    put(record) {
      const value = normalizeForWrite(record)
      if (!value) return Promise.resolve(false)
      const key = storageKey(value.parentId, value.childId)
      return enqueue(async table => {
        const existing = parseStoredRecord(table.get(key))
        if (existing && (existing.parentId !== value.parentId || existing.childId !== value.childId)) {
          report(onStorageError, new Error('task-result storage key collision'))
          return false
        }
        const time = now()
        if (!Number.isSafeInteger(time) || value.settledAt > time || value.expiresAt <= time) return false
        const rows = snapshotRows(table)
        if (!rows) {
          report(onStorageError, new Error('task-result table exceeds its bounded scan limit'))
          return false
        }
        for (const row of rows) {
          if (abandoning()) return false
          if (!row.record || storageKey(row.record.parentId, row.record.childId) !== row.key
            || row.record.settledAt > time || row.record.expiresAt <= time) {
            await table.delete(row.key)
            if (abandoning()) return false
          }
        }
        const stillStored = parseStoredRecord(table.get(key))
        if (table.size >= MAX_STORAGE_SCAN_ROWS && !stillStored) return false
        await table.put(key, value)
        if (abandoning()) return true
        try {
          if (!await trimTable(table, TASK_RESULT_STORAGE_MAX_ROWS)) {
            report(onStorageError, new Error('task-result table could not be reduced to its storage cap'))
          }
        } catch (error) {
          // The KV contract has no multi-record transaction. Preserve the new
          // result if the best-effort post-write eviction cannot finish.
          report(onStorageError, error)
        }
        return true
      })
    },
    delete(parentId, childId) {
      if (typeof parentId !== 'string' || typeof childId !== 'string') return Promise.resolve(false)
      return enqueue(table => table.delete(storageKey(parentId, childId)))
    },
    read(parentId, childId) {
      if (typeof parentId !== 'string' || typeof childId !== 'string') return Promise.resolve(undefined)
      const key = storageKey(parentId, childId)
      return enqueue(async table => {
        const record = parseStoredRecord(table.get(key))
        if (!record || record.parentId !== parentId || record.childId !== childId
          || storageKey(record.parentId, record.childId) !== key) return undefined
        const time = now()
        if (record.settledAt > time || record.expiresAt <= time) {
          await table.delete(key)
          return undefined
        }
        return record
      })
    },
    list(parentId) {
      if (typeof parentId !== 'string') return Promise.resolve([])
      return enqueue(async table => {
        if (!await trimTable(table, TASK_RESULT_STORAGE_MAX_ROWS)) return []
        const rows = snapshotRows(table)
        if (!rows) {
          report(onStorageError, new Error('task-result table exceeds its bounded scan limit'))
          return []
        }
        return rows
          .filter(row => row.record && row.record.parentId === parentId
            && row.record.settledAt <= now()
            && row.record.expiresAt > now()
            && storageKey(row.record.parentId, row.record.childId) === row.key)
          .map(row => row.record)
          .sort((left, right) => left.settledAt - right.settledAt || left.childId.localeCompare(right.childId))
      })
    },
    flush() {
      return queue
    },
    dispose() {
      if (disposePromise) return disposePromise
      state.disposed = true
      if (state.status === 'unopened') {
        disposePromise = Promise.resolve()
        return disposePromise
      }
      if (state.status === 'pending') {
        state.abandonPending = true
        disposePromise = Promise.resolve()
        void ensureOpen().then(() => closeDomain())
        return disposePromise
      }
      const drainAndClose = queue.then(() => closeDomain(), error => {
        report(onStorageError, error)
        return closeDomain()
      })
      let timer
      const drainTimeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), STORAGE_DRAIN_TIMEOUT_MS)
      })
      disposePromise = Promise.race([drainAndClose.then(() => true), drainTimeout]).then(didDrain => {
        clearTimeout(timer)
        if (!didDrain) {
          state.abandonPending = true
          report(onStorageError, new Error('task-result storage shutdown drain timed out'))
          // A Host KV method has no cancellation signal; close best-effort and
          // never let one stuck operation block plugin unload indefinitely.
          void closeDomain()
        }
      })
      return disposePromise
    },
  }
}
