import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createTaskListTool, createTaskResultRegistry, createTaskResultTool, TASK_RESULT_TTL_MS } from '../src/task-result-tool.js'
import {
  TASK_RESULT_STORAGE_DOMAIN_SPEC,
  TASK_RESULT_STORAGE_MAX_ROWS,
  TASK_RESULT_STORAGE_MAX_PENDING_OPERATIONS,
  createTaskResultStorage,
} from '../src/task-result-storage.js'

function agent(id) {
  return Object.freeze({ id })
}

function backend(sharedRows = new Map()) {
  let closeCount = 0
  let openedSpec
  const table = {
    get(key) {
      const value = sharedRows.get(key)
      return value === undefined ? undefined : structuredClone(value)
    },
    entries() {
      return [...sharedRows.entries()].map(([key, value]) => [key, structuredClone(value)])[Symbol.iterator]()
    },
    async put(key, value) {
      const parsed = TASK_RESULT_STORAGE_DOMAIN_SPEC.tables.results.valueSchema.parse(value)
      sharedRows.set(key, structuredClone(parsed))
    },
    async delete(key) { return sharedRows.delete(key) },
    get size() { return sharedRows.size },
  }
  const handle = {
    table(name) {
      assert.equal(name, 'results')
      return table
    },
    async close() { closeCount += 1 },
  }
  return {
    rows: sharedRows,
    table,
    handle,
    storageDomain: {
      async open(spec) {
        openedSpec = spec
        return handle
      },
    },
    get closeCount() { return closeCount },
    get openedSpec() { return openedSpec },
  }
}

function result(status, output = `${status} output`) {
  return {
    status,
    output,
    truncated: false,
    omittedNonText: false,
    ...(status === 'failed' ? {} : { stopReason: status }),
  }
}

function createPersistedRegistry(store, now) {
  return createTaskResultRegistry({ persistentStore: store, now })
}

test('declares a bounded versioned domain schema for terminal snapshots only', async () => {
  assert.equal(TASK_RESULT_STORAGE_DOMAIN_SPEC.name, 'dsh-omo-task-results')
  assert.equal(TASK_RESULT_STORAGE_DOMAIN_SPEC.version, 1)
  assert.equal(TASK_RESULT_STORAGE_DOMAIN_SPEC.invalidRecords, undefined, 'malformed rows are not automatically backed up or skipped')
  assert.equal(TASK_RESULT_STORAGE_MAX_ROWS, 256)
  const schema = TASK_RESULT_STORAGE_DOMAIN_SPEC.tables.results.valueSchema
  assert.equal(schema.safeParse({
    version: 1,
    parentId: 'session-a',
    childId: 'child-a',
    status: 'completed',
    output: 'result',
    truncated: false,
    omittedNonText: false,
    settledAt: 10,
    expiresAt: 20,
  }).success, true)
  assert.equal(schema.safeParse({
    version: 1,
    parentId: 'session-a',
    childId: 'child-a',
    status: 'running',
    output: '',
    truncated: false,
    omittedNonText: false,
    settledAt: 10,
    expiresAt: 20,
  }).success, false)
  assert.equal(schema.safeParse({
    version: 1,
    parentId: 'session-a',
    childId: 'child-a',
    status: 'completed',
    output: 'x'.repeat(8_193),
    truncated: false,
    omittedNonText: false,
    settledAt: 10,
    expiresAt: 20,
  }).success, false)
  assert.equal(schema.safeParse({
    version: 1,
    parentId: 'session-a',
    childId: 'child-a',
    status: 'completed',
    output: 'result',
    truncated: false,
    omittedNonText: false,
    settledAt: 10,
    expiresAt: 10 + TASK_RESULT_TTL_MS + 1,
  }).success, false, 'stored rows cannot extend beyond the documented 30-minute TTL')
  assert.equal(schema.safeParse({
    version: 2,
    parentId: 'session-a',
    childId: 'child-a',
    status: 'completed',
    output: 'result',
    truncated: false,
    omittedNonText: false,
    settledAt: 10,
    expiresAt: 20,
  }).success, false, 'unsupported schema versions are rejected')
  assert.equal(schema.safeParse({
    version: 1,
    parentId: 'session-a',
    childId: 'child-a',
    status: 'completed',
    output: 'result',
    truncated: false,
    omittedNonText: false,
    settledAt: 10,
    expiresAt: 20,
    extra: 'untrusted',
  }).success, false, 'unknown persisted fields are rejected')
  assert.equal(schema.safeParse({
    version: 1,
    parentId: 'session-a',
    childId: 'child-a',
    status: 'completed',
    output: 'é'.repeat(12_289),
    truncated: false,
    omittedNonText: false,
    settledAt: 10,
    expiresAt: 20,
  }).success, false, 'multibyte output is bounded by UTF-8 bytes as well as characters')

  const storage = backend()
  const store = createTaskResultStorage({ storageDomain: storage.storageDomain })
  assert.equal(await store.put({
    parentId: 'session-a',
    childId: 'child-a',
    ...result('completed'),
    settledAt: Date.now() + 10_000,
    expiresAt: Date.now() + 10_000 + TASK_RESULT_TTL_MS,
  }), false, 'future settlement timestamps cannot be written')
  assert.equal(storage.openedSpec, undefined, 'invalid direct writes do not open a domain')
  await store.dispose()
})

test('opens lazily and lets disposal close a late-opened domain', async () => {
  const first = backend()
  const unused = createTaskResultStorage({ storageDomain: first.storageDomain })
  await unused.dispose()
  assert.equal(first.openedSpec, undefined, 'unopened stores do not acquire a Host domain')

  let resolveOpen
  const delayedBackend = backend()
  const delayed = createTaskResultStorage({
    storageDomain: { open: () => new Promise(resolve => { resolveOpen = resolve }) },
  })
  const ready = delayed.ready()
  await new Promise(resolve => setImmediate(resolve))
  await delayed.dispose()
  resolveOpen(delayedBackend.handle)
  assert.equal(await ready, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(delayedBackend.closeCount, 1)
})

test('terminal results round-trip across recreated stores for the same session and child IDs', async () => {
  const rows = new Map()
  const owner = agent('session-round-trip')
  const stored = backend(rows)
  let time = 100
  const firstStore = createTaskResultStorage({ storageDomain: stored.storageDomain, now: () => time })
  const first = createPersistedRegistry(firstStore, () => time)
  assert.equal(await firstStore.ready(), true)
  assert.equal(first.recordStart(owner, 'child-complete'), true)
  assert.equal(first.recordResult(owner, 'child-complete', result('completed')), true)
  assert.equal(first.recordStart(owner, 'child-incomplete'), true)
  assert.equal(first.recordResult(owner, 'child-incomplete', result('incomplete')), true)
  assert.equal(first.recordStart(owner, 'child-failed'), true)
  assert.equal(first.recordFailure(owner, 'child-failed'), true)
  assert.equal(first.recordStart(owner, 'child-running'), true)
  await first.flushPersistence()
  assert.equal(rows.size, 3, 'running work is never stored')

  await first.dispose()
  assert.equal(stored.closeCount, 1)

  const reopenedBackend = backend(rows)
  const reopenedStore = createTaskResultStorage({ storageDomain: reopenedBackend.storageDomain, now: () => time })
  const reopened = createPersistedRegistry(reopenedStore, () => time)
  const resumedAgent = agent(owner.id)
  assert.deepEqual(await reopened.readAsync(resumedAgent, 'child-complete'), {
    childId: 'child-complete', ...result('completed'),
  })
  assert.deepEqual(await reopened.readAsync(resumedAgent, 'child-incomplete'), {
    childId: 'child-incomplete', ...result('incomplete'),
  })
  assert.deepEqual(await reopened.readAsync(resumedAgent, 'child-failed'), {
    childId: 'child-failed', status: 'failed', output: '', truncated: false, omittedNonText: false,
  })
  const resultTool = createTaskResultTool(reopened, { persistent: true })
  assert.deepEqual(await resultTool.execute({ childId: 'child-incomplete' }, { agent: resumedAgent }), {
    childId: 'child-incomplete', ...result('incomplete'),
  })
  const expectedChildren = [
    { childId: 'child-complete', status: 'completed' },
    { childId: 'child-failed', status: 'failed' },
    { childId: 'child-incomplete', status: 'incomplete' },
  ]
  const sortChildren = children => [...children].sort((left, right) => left.childId.localeCompare(right.childId))
  const listTool = createTaskListTool(reopened, { persistent: true })
  assert.deepEqual(sortChildren((await listTool.execute({}, { agent: resumedAgent })).children), expectedChildren)
  assert.deepEqual(sortChildren(await reopened.listAsync(resumedAgent)), expectedChildren)
  assert.equal(await reopened.readAsync(agent('other-session'), 'child-complete'), undefined)
  assert.equal(await reopened.readAsync(agent(owner.id), 'child-incomplete'), undefined,
    'a same-ID replacement cannot take over an already-bound Agent in one plugin instance')
  await reopened.dispose()
})

test('expires persisted results from settlement time and cleans rows during reads', async () => {
  const rows = new Map()
  const owner = agent('session-expiry')
  let time = 1_000
  const firstBackend = backend(rows)
  const firstStore = createTaskResultStorage({ storageDomain: firstBackend.storageDomain, now: () => time })
  const first = createPersistedRegistry(firstStore, () => time)
  first.recordStart(owner, 'child-expiry')
  first.recordResult(owner, 'child-expiry', result('completed'))
  await first.flushPersistence()
  await first.dispose()

  time += 30 * 60 * 1_000
  const nextBackend = backend(rows)
  const nextStore = createTaskResultStorage({ storageDomain: nextBackend.storageDomain, now: () => time })
  const next = createPersistedRegistry(nextStore, () => time)
  assert.equal(await next.readAsync(agent(owner.id), 'child-expiry'), undefined)
  assert.equal(rows.size, 0)
  await next.dispose()
})

test('bounds pending persistence operations while backend open is stalled and recovers after drain', async () => {
  const storage = backend()
  let releaseOpen
  let getCalls = 0
  const get = storage.table.get.bind(storage.table)
  storage.table.get = key => { getCalls += 1; return get(key) }
  const errors = []
  const store = createTaskResultStorage({
    storageDomain: { open: () => new Promise(resolve => { releaseOpen = () => resolve(storage.handle) }) },
    onStorageError: error => errors.push(error),
  })
  const accepted = Array.from({ length: TASK_RESULT_STORAGE_MAX_PENDING_OPERATIONS }, (_, index) => store.read('parent', `child-${index}`))
  const registry = createTaskResultRegistry({ persistentStore: store })
  const parent = agent('parent-at-capacity')
  try {
    const overflow = await Promise.race([
      store.read('parent', 'overflow-child'),
      new Promise(resolve => setImmediate(() => resolve('still-pending'))),
    ])
    assert.equal(overflow, undefined, 'overflow should fail locally without joining the blocked queue')
    assert.equal(await store.list('parent'), undefined)
    assert.equal(registry.recordStart(parent, 'local-child'), true)
    assert.equal(registry.recordResult(parent, 'local-child', result('completed')), true)
    assert.equal((await registry.readAsync(parent, 'local-child')).status, 'completed')
    assert.deepEqual(await registry.listAsync(parent), [{ childId: 'local-child', status: 'completed' }])
    assert.equal(errors.length, 1, 'report saturation once until capacity is released')
  } finally {
    releaseOpen()
    await Promise.all(accepted)
    await store.flush()
  }
  assert.equal(getCalls, TASK_RESULT_STORAGE_MAX_PENDING_OPERATIONS, 'overflow operations never reach the backend')
  await store.read('parent', 'after-drain')
  assert.equal(getCalls, TASK_RESULT_STORAGE_MAX_PENDING_OPERATIONS + 1)
  await registry.dispose()
})

test('caps persistence, evicts oldest terminal snapshots, and serializes concurrent writes', async () => {
  const rows = new Map()
  const storage = backend(rows)
  let time = 10
  const store = createTaskResultStorage({ storageDomain: storage.storageDomain, now: () => time++ })
  await store.ready()
  // Exercise concurrent writes within the separate bounded admission window.
  const totalWrites = TASK_RESULT_STORAGE_MAX_ROWS + 8
  for (let offset = 0; offset < totalWrites; offset += 32) {
    const written = await Promise.all(Array.from({ length: Math.min(32, totalWrites - offset) }, (_, batchIndex) => {
      const index = offset + batchIndex
      return store.put({
        parentId: `parent-${index}`,
        childId: `child-${index}`,
        ...result('completed', `result-${index}`),
        settledAt: index + 1,
        expiresAt: index + 1 + 30 * 60 * 1_000,
      })
    }))
    assert.ok(written.every(value => value === true))
  }
  await store.flush()
  assert.equal(rows.size, TASK_RESULT_STORAGE_MAX_ROWS)
  assert.equal(await store.read('parent-0', 'child-0'), undefined, 'oldest snapshots are evicted first')
  assert.equal((await store.read('parent-263', 'child-263'))?.output, 'result-263')
  await store.dispose()
  assert.equal(storage.closeCount, 1)
})

test('oversized existing tables fail bounded list/write scans but retain exact-key reads', async () => {
  const rows = new Map()
  for (let index = 0; index < TASK_RESULT_STORAGE_MAX_ROWS * 2 + 1; index += 1) {
    const parentId = `parent-${index}`
    const childId = `child-${index}`
    const record = {
      version: 1,
      parentId,
      childId,
      ...result('completed', `result-${index}`),
      settledAt: index + 1,
      expiresAt: index + 1 + TASK_RESULT_TTL_MS,
    }
    const key = createHash('sha256').update(JSON.stringify([parentId, childId])).digest('hex')
    rows.set(key, record)
  }
  const shared = backend(rows)
  const store = createTaskResultStorage({ storageDomain: shared.storageDomain, now: () => 100_000 })
  assert.equal(await store.ready(), true)
  assert.equal((await store.read('parent-0', 'child-0'))?.output, 'result-0')
  assert.deepEqual(await store.list('parent-0'), [])
  assert.equal(await store.put({
    parentId: 'parent-new',
    childId: 'child-new',
    ...result('completed'),
    settledAt: 50_000,
    expiresAt: 50_000 + TASK_RESULT_TTL_MS,
  }), false)
  assert.equal(rows.size, TASK_RESULT_STORAGE_MAX_ROWS * 2 + 1)
  await store.dispose()
})

test('failed writes preserve the old durable rows during full-table eviction', async () => {
  const shared = backend()
  let rejectNextPut = false
  const storageDomain = {
    async open(spec) {
      const handle = await shared.storageDomain.open(spec)
      const table = handle.table('results')
      return {
        table: name => {
          assert.equal(name, 'results')
          return {
            get: key => table.get(key),
            entries: () => table.entries(),
            get size() { return table.size },
            async put(key, value) {
              if (rejectNextPut) {
                rejectNextPut = false
                throw new Error('injected put failure')
              }
              return table.put(key, value)
            },
            delete: key => table.delete(key),
          }
        },
        close: () => handle.close(),
      }
    },
  }
  const store = createTaskResultStorage({ storageDomain, now: () => 100_000 })
  await store.ready()
  for (let index = 0; index < TASK_RESULT_STORAGE_MAX_ROWS; index += 1) {
    assert.equal(await store.put({
      parentId: `parent-${index}`,
      childId: `child-${index}`,
      ...result('completed', `result-${index}`),
      settledAt: index + 1,
      expiresAt: index + 1 + TASK_RESULT_TTL_MS,
    }), true)
  }
  assert.equal(shared.rows.size, TASK_RESULT_STORAGE_MAX_ROWS)

  rejectNextPut = true
  assert.equal(await store.put({
    parentId: 'parent-new',
    childId: 'child-new',
    ...result('completed', 'new result'),
    settledAt: 50_000,
    expiresAt: 50_000 + TASK_RESULT_TTL_MS,
  }), undefined)
  assert.equal(shared.rows.size, TASK_RESULT_STORAGE_MAX_ROWS)
  assert.equal((await store.read('parent-0', 'child-0'))?.output, 'result-0',
    'the oldest snapshot is not evicted before the new put succeeds')
  assert.equal(await store.read('parent-new', 'child-new'), undefined)
  await store.dispose()
})

test('immediate disposal safely abandons a queued first write before its microtask', async () => {
  const shared = backend()
  let putCount = 0
  const storageDomain = {
    async open(spec) {
      const handle = await shared.storageDomain.open(spec)
      const table = handle.table('results')
      return {
        table: name => {
          assert.equal(name, 'results')
          return {
            get: key => table.get(key),
            entries: () => table.entries(),
            get size() { return table.size },
            async put(key, value) { putCount += 1; return table.put(key, value) },
            delete: key => table.delete(key),
          }
        },
        close: () => handle.close(),
      }
    },
  }
  const store = createTaskResultStorage({ storageDomain, now: () => 1 })
  const writing = store.put({
    parentId: 'session-immediate-dispose',
    childId: 'child-immediate-dispose',
    ...result('completed'),
    settledAt: 1,
    expiresAt: 1 + 30 * 60 * 1_000,
  })
  const disposing = store.dispose()
  await disposing
  assert.equal(await writing, undefined)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(putCount, 0, 'a queued operation is discarded rather than racing a closed domain')
  assert.equal(shared.rows.size, 0)
  assert.equal(shared.closeCount, 1)
})

test('disposal drains an accepted write before closing an opened domain', async () => {
  const shared = backend()
  let announceWrite
  let releaseWrite
  const writeStarted = new Promise(resolve => { announceWrite = resolve })
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  const storageDomain = {
    async open(spec) {
      const handle = await shared.storageDomain.open(spec)
      const table = handle.table('results')
      return {
        table: name => {
          assert.equal(name, 'results')
          return {
            get: key => table.get(key),
            entries: () => table.entries(),
            get size() { return table.size },
            async put(key, value) {
              announceWrite()
              await writeGate
              return table.put(key, value)
            },
            delete: key => table.delete(key),
          }
        },
        close: () => handle.close(),
      }
    },
  }
  const store = createTaskResultStorage({ storageDomain, now: () => 1 })
  await store.ready()
  const writing = store.put({
    parentId: 'session-drain',
    childId: 'child-drain',
    ...result('completed'),
    settledAt: 1,
    expiresAt: 1 + 30 * 60 * 1_000,
  })
  await writeStarted
  const disposing = store.dispose()
  releaseWrite()
  assert.equal(await writing, true)
  await disposing
  assert.equal(shared.rows.size, 1)
  assert.equal(shared.closeCount, 1)
})

test('unload bounds a hung KV drain, closes the domain, and allows late operation settlement', async () => {
  const shared = backend()
  let announceWrite
  let releaseWrite
  const writeStarted = new Promise(resolve => { announceWrite = resolve })
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  const storageDomain = {
    async open(spec) {
      const handle = await shared.storageDomain.open(spec)
      const table = handle.table('results')
      return {
        table: name => {
          assert.equal(name, 'results')
          return {
            get: key => table.get(key),
            entries: () => table.entries(),
            get size() { return table.size },
            async put(key, value) {
              announceWrite()
              await writeGate
              return table.put(key, value)
            },
            delete: key => table.delete(key),
          }
        },
        close: () => handle.close(),
      }
    },
  }
  const store = createTaskResultStorage({ storageDomain, now: () => 1 })
  await store.ready()
  const writing = store.put({
    parentId: 'session-hung-write',
    childId: 'child-hung-write',
    ...result('completed'),
    settledAt: 1,
    expiresAt: 1 + TASK_RESULT_TTL_MS,
  })
  await writeStarted
  const startedAt = Date.now()
  await store.dispose()
  assert.ok(Date.now() - startedAt < 2_000, 'shutdown is bounded instead of waiting forever for KV')
  assert.equal(shared.closeCount, 1)
  releaseWrite()
  assert.equal(await writing, true, 'the Host method may still settle after the bounded close')
  assert.equal(shared.rows.size, 1, 'late persistence outcome is backend-dependent after close')
})

test('storage failures leave current one-shot results available in memory and keep diagnostics generic', async () => {
  const diagnostics = []
  const store = createTaskResultStorage({
    storageDomain: { async open() { throw Object.assign(new Error('private backend path'), { name: 'BackendError' }) } },
    onStorageError: error => diagnostics.push(error.name),
  })
  assert.equal(await store.ready(), false)
  const registry = createPersistedRegistry(store, () => 1_000)
  const owner = agent('session-storage-failure')
  registry.recordStart(owner, 'child-failure')
  assert.equal(registry.recordResult(owner, 'child-failure', result('completed')), true)
  assert.equal((await registry.readAsync(owner, 'child-failure')).output, 'completed output')
  assert.ok(diagnostics.includes('BackendError'))
  assert.ok(!diagnostics.includes('private backend path'))
  await registry.dispose()
})

test('invalid stored rows fail domain open without disrupting the in-memory result cache', async () => {
  const rows = new Map([['invalid-key', { secret: 'malformed child output' }]])
  let openCalls = 0
  const errors = []
  const store = createTaskResultStorage({
    storageDomain: {
      async open(spec) {
        openCalls += 1
        for (const value of rows.values()) spec.tables.results.valueSchema.parse(value)
        return backend().handle
      },
    },
    onStorageError: error => errors.push(error.name),
  })
  const registry = createPersistedRegistry(store, () => 1_000)
  const owner = agent('session-invalid-storage')
  assert.equal(registry.recordStart(owner, 'child-memory-only'), true)
  assert.equal(registry.recordResult(owner, 'child-memory-only', result('completed')), true)
  await registry.flushPersistence()
  assert.equal((await registry.readAsync(owner, 'child-memory-only')).output, 'completed output')
  assert.equal(openCalls, 1)
  assert.ok(errors.includes('ZodError'))
  assert.ok(!errors.includes('malformed child output'))
  await registry.dispose()
})

test('domain-open failure closes invalid handles and late open after disposal is closed', async () => {
  let closeCount = 0
  const invalidStore = createTaskResultStorage({
    storageDomain: {
      async open() {
        return { table: () => ({}), async close() { closeCount += 1 } }
      },
    },
  })
  assert.equal(await invalidStore.ready(), false)
  await invalidStore.dispose()
  assert.equal(closeCount, 1)

  let resolveOpen
  const delayed = createTaskResultStorage({ storageDomain: { open: () => new Promise(resolve => { resolveOpen = resolve }) } })
  const delayedReady = delayed.ready()
  await new Promise(resolve => setImmediate(resolve))
  await delayed.dispose()
  const store = backend()
  resolveOpen(store.handle)
  assert.equal(await delayedReady, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.closeCount, 1)
})
