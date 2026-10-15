import assert from 'node:assert/strict'
import test from 'node:test'
import { posix as path } from 'node:path'
import { createWriteExistingFileGuard, registerWriteExistingFileGuard } from '../src/write-existing-file-guard.js'

const cwd = '/workspace'

function makeHarness(options = {}) {
  const agentIds = options.agentIds ?? ['agent-1']
  const agentsById = new Map(agentIds.map(id => [id, { id }]))
  const sessionsById = new Map(agentIds.map(id => [id, { header: { id, cwd: options.cwdById?.[id] ?? cwd } }]))
  const agents = { get: id => agentsById.get(id) }
  const sessions = { get: id => sessionsById.get(id) }
  const files = new Map([
    [cwd, { type: 'directory', version: 'root', size: 0 }],
    [`${cwd}/src/existing.txt`, { type: 'file', version: 'v1', size: 10 }],
    [`${cwd}/src/other.txt`, { type: 'file', version: 'v1', size: 11 }],
    [`${cwd}/.omo/config.json`, { type: 'file', version: 'v1', size: 5 }],
    [`${cwd}/src/link.txt`, { type: 'symlink', version: 'link-v1', size: 0 }],
    [`${cwd}/src/folder`, { type: 'directory', version: 'dir-v1', size: 0 }],
  ])
  const resolve = (value, resolveCwd = cwd) => {
    const absolute = path.normalize(path.isAbsolute(value) ? value : path.resolve(resolveCwd, value))
    return { targetKey: `opaque:${absolute}`, path: absolute }
  }
  const fs = {
    async resolve(value, opts = {}) {
      return resolve(value, opts.cwd ?? cwd)
    },
    contains(root, target) {
      return target.path === root.path || target.path.startsWith(`${root.path.replace(/\/$/u, '')}/`)
    },
    async lstat(value, opts = {}) {
      const absolute = resolve(value, opts.cwd ?? cwd).path
      const info = files.get(absolute)
      return info ? { ...info } : undefined
    },
    async stat(target) {
      const info = files.get(target.path)
      return info ? { ...info } : undefined
    },
  }
  const guard = createWriteExistingFileGuard(agents, sessions, fs, options.guardOptions)
  return { guard, agents, sessions, agentsById, sessionsById, files, fs }
}

test('registration helper returns an idempotent disposer that unregisters the global Tool guard', () => {
  const { agents, sessions, fs } = makeHarness()
  const events = new Map()
  const guards = new Set()
  let effectCleanup
  const ctx = {
    on: (event, listener) => { events.set(event, listener) },
    effect: execute => { effectCleanup = execute() },
    tools: { guard: guard => { guards.add(guard); return () => guards.delete(guard) } },
  }
  const dispose = registerWriteExistingFileGuard(ctx, agents, sessions, fs)
  assert.equal(typeof dispose, 'function')
  assert.equal(guards.size, 1)
  assert.deepEqual([...events.keys()], ['tools/pre-execute', 'tools/result', 'agent/created', 'agent/disposed'])
  dispose()
  dispose()
  effectCleanup()
  assert.equal(guards.size, 0)

  const failedGuards = new Set()
  assert.throws(() => registerWriteExistingFileGuard({
    ...ctx,
    tools: { guard: guard => { failedGuards.add(guard); return () => failedGuards.delete(guard) } },
    effect: () => { throw new Error('effect registration failed') },
  }, agents, sessions, fs), /effect registration failed/u)
  assert.equal(failedGuards.size, 0, 'failed effect registration still releases the global guard')
})

function makeExec(name, filePath, options = {}) {
  const agentId = options.agentId ?? 'agent-1'
  const args = { ...(options.arguments ?? {}), ...(filePath === undefined ? {} : { file_path: filePath }) }
  if (options.overwrite !== undefined) args.overwrite = options.overwrite
  const schema = options.schema === null ? undefined : options.schema ?? {
    name,
    parameters: { properties: { file_path: { type: 'string' } } },
  }
  return {
    name,
    arguments: args,
    ...(schema === undefined ? {} : { schema }),
    agent: { id: agentId },
    signal: options.signal ?? new AbortController().signal,
    token: options.token ?? Symbol(`${name}:${filePath ?? 'missing'}`),
  }
}

const allow = () => Promise.resolve({ kind: 'allow' })

function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

async function readSuccessfully(guard, filePath, options = {}) {
  const exec = makeExec('read', filePath, options)
  const decision = await guard.before(exec, allow)
  assert.equal(decision.kind, 'allow')
  guard.onResult(exec, { isError: false })
  return exec
}

async function attemptWrite(guard, filePath, options = {}) {
  const exec = makeExec('write', filePath, options)
  const decision = await guard.before(exec, allow)
  return { exec, decision, final: guard.guard(exec) }
}

test('grants one existing in-cwd write after a successful final read and consumes it once', async () => {
  const { guard } = makeHarness()
  await readSuccessfully(guard, 'src/existing.txt')

  const first = await attemptWrite(guard, 'src/existing.txt')
  assert.deepEqual(first.decision, { kind: 'allow' })
  assert.equal(first.final, undefined)
  guard.onResult(first.exec, { isError: true })

  const second = await attemptWrite(guard, 'src/existing.txt')
  assert.equal(second.decision.kind, 'deny')
  assert.equal(second.decision.reason, 'File already exists. Use edit tool instead.')
  assert.equal(second.final, second.decision.reason)
  guard.onResult(second.exec, { isError: true })
})

test('failed, blocked, malformed, and missing-file reads do not grant overwrite permission', async () => {
  const { guard } = makeHarness()
  const failed = makeExec('read', 'src/existing.txt')
  await guard.before(failed, allow)
  guard.onResult(failed, { isError: true })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')

  const blocked = makeExec('read', 'src/existing.txt')
  await guard.before(blocked, allow)
  guard.onResult(blocked, { isError: true, content: [{ type: 'text', text: 'blocked' }] })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')

  const wrongSchema = makeExec('read', 'src/existing.txt', {
    schema: { name: 'read', parameters: { properties: { file_path: { type: 'number' } } } },
  })
  await guard.before(wrongSchema, allow)
  guard.onResult(wrongSchema, { isError: false })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')

  const missing = makeExec('read', 'src/not-created.txt')
  await guard.before(missing, allow)
  guard.onResult(missing, { isError: false })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')
})

test('matches case-insensitive Tool names and accepts scalar file_path arguments without an optional schema', async () => {
  const { guard } = makeHarness()
  const read = makeExec('READ', 'src/existing.txt', { schema: null })
  assert.deepEqual(await guard.before(read, allow), { kind: 'allow' })
  guard.onResult(read, { isError: false })

  const write = makeExec('WRITE', 'src/existing.txt', { schema: null })
  assert.deepEqual(await guard.before(write, allow), { kind: 'allow' })
  assert.equal(guard.guard(write), undefined)
  guard.onResult(write, { isError: false })
})

test('does not grant when the final read Tool name changed after preflight', async () => {
  const { guard } = makeHarness()
  const read = makeExec('read', 'src/existing.txt')
  await guard.before(read, async () => {
    read.name = 'custom-reader'
    read.schema.name = 'custom-reader'
    return { kind: 'allow' }
  })
  guard.onResult(read, { isError: false })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')
})

test('rejects token reuse between an in-flight read and a write without minting a grant', async () => {
  const { guard } = makeHarness()
  const token = Symbol('aliased-execution-token')
  const read = makeExec('read', 'src/existing.txt', { token })
  assert.deepEqual(await guard.before(read, allow), { kind: 'allow' })

  const write = makeExec('write', 'src/existing.txt', { token })
  const decision = await guard.before(write, allow)
  assert.equal(decision.kind, 'deny')
  assert.equal(guard.guard(write), 'Write guard is busy; retry after rereading the file.')
  guard.onResult(write, { isError: true })
  guard.onResult(read, { isError: false })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')
})

test('rejects a completed token reused for another read before a stale result can mint a grant', async () => {
  const { guard } = makeHarness()
  const token = Symbol('recycled-execution-token')
  const oldRead = makeExec('read', 'src/existing.txt', { token })
  assert.deepEqual(await guard.before(oldRead, allow), { kind: 'allow' })
  guard.onResult(oldRead, { isError: true })

  const reusedRead = makeExec('read', 'src/other.txt', { token })
  assert.deepEqual(await guard.before(reusedRead, allow), { kind: 'allow' })
  oldRead.arguments.file_path = 'src/other.txt'
  guard.onResult(oldRead, { isError: false })
  guard.onResult(reusedRead, { isError: false })
  assert.equal((await attemptWrite(guard, 'src/other.txt')).decision.kind, 'deny')
})

test('shares completed-token history across listener instances for one DSH filesystem provider', async () => {
  const harness = makeHarness()
  const token = Symbol('cross-listener-token')
  const oldRead = makeExec('read', 'src/existing.txt', { token })
  assert.deepEqual(await harness.guard.before(oldRead, allow), { kind: 'allow' })
  harness.guard.onResult(oldRead, { isError: true })
  harness.guard.dispose()

  const replacement = createWriteExistingFileGuard(harness.agents, harness.sessions, harness.fs)
  const reusedRead = makeExec('read', 'src/other.txt', { token })
  assert.deepEqual(await replacement.before(reusedRead, allow), { kind: 'allow' })
  oldRead.arguments.file_path = 'src/other.txt'
  harness.guard.onResult(oldRead, { isError: false })
  replacement.onResult(reusedRead, { isError: false })
  assert.equal((await attemptWrite(replacement, 'src/other.txt')).decision.kind, 'deny')
})

test('fails all writes closed when the bounded collision tombstone ledger overflows', async () => {
  const { guard } = makeHarness()
  for (let index = 0; index < 65; index += 1) {
    const token = Symbol(`collision-${index}`)
    const firstRead = makeExec('read', 'src/existing.txt', { token })
    assert.deepEqual(await guard.before(firstRead, allow), { kind: 'allow' })
    guard.onResult(firstRead, { isError: true })
    const duplicateRead = makeExec('read', 'src/other.txt', { token })
    assert.deepEqual(await guard.before(duplicateRead, allow), { kind: 'allow' })
    guard.onResult(duplicateRead, { isError: false })
  }
  const bypassWrite = makeExec('write', '.omo/config.json')
  assert.deepEqual(await guard.before(bypassWrite, allow), {
    kind: 'deny', reason: 'Write guard is busy; retry after rereading the file.',
  })
  assert.equal(guard.guard(bypassWrite), 'Write guard is busy; retry after rereading the file.')
})

test('fails closed when the bounded token-use history saturates', async () => {
  const { guard } = makeHarness({ guardOptions: { maxSeenTokens: 1 } })
  const firstRead = makeExec('read', 'src/existing.txt')
  assert.deepEqual(await guard.before(firstRead, allow), { kind: 'allow' })
  guard.onResult(firstRead, { isError: true })

  const untrackedRead = makeExec('read', 'src/existing.txt')
  assert.deepEqual(await guard.before(untrackedRead, allow), { kind: 'allow' })
  guard.onResult(untrackedRead, { isError: false })
  const write = makeExec('write', '.omo/config.json')
  assert.deepEqual(await guard.before(write, allow), {
    kind: 'deny', reason: 'Write guard is busy; retry after rereading the file.',
  })
  assert.equal(guard.guard(write), 'Write guard is busy; retry after rereading the file.')
})

test('keeps the token-history ceiling hard even when a larger internal limit is requested', async () => {
  const { guard } = makeHarness({ guardOptions: { maxSeenTokens: 16_385 } })
  for (let index = 0; index < 16_384; index += 1) {
    await guard.before(makeExec('read', undefined), allow)
  }
  const read = makeExec('read', 'src/existing.txt')
  assert.deepEqual(await guard.before(read, allow), { kind: 'allow' })
  guard.onResult(read, { isError: false })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.reason, 'Write guard is busy; retry after rereading the file.')
})

test('rechecks mutable path and Agent fields after preflight before granting or allowing', async () => {
  const { guard } = makeHarness({ agentIds: ['agent-1', 'agent-2'] })
  const read = makeExec('read', 'src/existing.txt')
  await guard.before(read, async () => {
    read.arguments.file_path = 'src/other.txt'
    return { kind: 'allow' }
  })
  guard.onResult(read, { isError: false })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')

  await readSuccessfully(guard, 'src/existing.txt')
  const changedPath = makeExec('write', 'src/existing.txt')
  const pathDecision = await guard.before(changedPath, async () => {
    changedPath.arguments.file_path = 'src/other.txt'
    return { kind: 'allow' }
  })
  assert.deepEqual(pathDecision, { kind: 'allow' })
  assert.equal(guard.guard(changedPath), 'Write guard could not safely verify the target; write blocked.')
  guard.onResult(changedPath, { isError: true })

  const changedAgent = makeExec('write', 'src/existing.txt')
  const agentDecision = await guard.before(changedAgent, async () => {
    changedAgent.agent = { id: 'agent-2' }
    return { kind: 'allow' }
  })
  assert.deepEqual(agentDecision, { kind: 'allow' })
  assert.equal(guard.guard(changedAgent), 'Write guard could not safely verify the target; write blocked.')
  guard.onResult(changedAgent, { isError: true })

  const changedToken = makeExec('write', 'src/existing.txt')
  const tokenDecision = await guard.before(changedToken, async () => {
    changedToken.token = Symbol('mutated-token')
    return { kind: 'allow' }
  })
  assert.deepEqual(tokenDecision, { kind: 'allow' })
  assert.equal(guard.guard(changedToken), 'Write guard could not safely verify the target; write blocked.')
  guard.onResult(changedToken, { isError: true })
})

test('rechecks missing/outside pass-throughs and explicit bypasses after later argument mutation', async () => {
  const { guard } = makeHarness()
  const cases = [
    { path: 'src/new.txt', mutate: exec => { exec.arguments.file_path = 'src/existing.txt' } },
    { path: '/outside/file.txt', mutate: exec => { exec.arguments.file_path = 'src/existing.txt' } },
    { path: '.omo/state', mutate: exec => { exec.arguments.file_path = 'src/existing.txt' } },
    { path: 'src/existing.txt', overwrite: true, mutate: exec => { exec.arguments.overwrite = false } },
    { path: 'src/new.txt', mutate: exec => { exec.arguments.overwrite = true } },
    { path: 'src/new.txt', mutate: exec => { exec.schema.parameters.properties.file_path.type = 'integer' } },
    { path: 'src/new.txt', mutate: exec => { exec.name = 'custom-writer'; exec.schema.name = 'custom-writer' } },
  ]
  for (const scenario of cases) {
    const exec = makeExec('write', scenario.path, { overwrite: scenario.overwrite })
    const decision = await guard.before(exec, async () => {
      scenario.mutate(exec)
      return { kind: 'allow' }
    })
    assert.deepEqual(decision, { kind: 'allow' })
    assert.equal(guard.guard(exec), 'Write guard could not safely verify the target; write blocked.')
    guard.onResult(exec, { isError: true })
  }
})

test('new or out-of-cwd writes pass; in-cwd symlinks and directories fail closed', async () => {
  const { guard } = makeHarness()
  const created = await attemptWrite(guard, 'src/new.txt')
  assert.deepEqual(created.decision, { kind: 'allow' })
  assert.equal(created.final, undefined)

  const outside = await attemptWrite(guard, '/outside/file.txt')
  assert.deepEqual(outside.decision, { kind: 'allow' })
  assert.equal(outside.final, undefined)

  const externalLink = makeHarness()
  const originalResolve = externalLink.fs.resolve
  externalLink.fs.resolve = async (value, options = {}) => value === 'src/outside-link.txt'
    ? { targetKey: 'opaque:/outside/secret.txt', path: '/outside/secret.txt' }
    : originalResolve(value, options)
  const outsideViaLink = await attemptWrite(externalLink.guard, 'src/outside-link.txt')
  assert.deepEqual(outsideViaLink.decision, { kind: 'allow' }, 'a path canonically resolving outside is treated as outside even if its raw path resembles a symlink')
  assert.equal(outsideViaLink.final, undefined)

  const symlink = await attemptWrite(guard, 'src/link.txt')
  assert.equal(symlink.decision.kind, 'deny')
  assert.match(symlink.decision.reason, /symlink/u)
  assert.equal(symlink.final, symlink.decision.reason)

  const directory = await attemptWrite(guard, 'src/folder')
  assert.equal(directory.decision.kind, 'deny')
  assert.match(directory.decision.reason, /non-file/u)
})

test('preserves upstream .omo and overwrite bypasses without stripping Tool arguments', async () => {
  const { guard } = makeHarness()
  const omo = await attemptWrite(guard, '.omo/config.json')
  assert.deepEqual(omo.decision, { kind: 'allow' })
  assert.equal(omo.final, undefined)
  const rawOmoAlias = await attemptWrite(guard, 'src/.omo/../src/existing.txt')
  assert.deepEqual(rawOmoAlias.decision, { kind: 'allow' })
  assert.equal(rawOmoAlias.final, undefined, 'raw .omo path segments bypass before path normalization')

  const overwrite = makeExec('write', 'src/existing.txt', { overwrite: 'TRUE' })
  const decision = await guard.before(overwrite, allow)
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(guard.guard(overwrite), undefined)
  assert.equal(overwrite.arguments.overwrite, 'TRUE')
})

test('scopes grants by exact Agent and stable target identity across relative path aliases', async () => {
  const { guard } = makeHarness({ agentIds: ['agent-1', 'agent-2'] })
  await readSuccessfully(guard, 'src/existing.txt', { agentId: 'agent-1' })

  const otherAgent = await attemptWrite(guard, 'src/existing.txt', { agentId: 'agent-2' })
  assert.equal(otherAgent.decision.kind, 'deny')

  const alias = await attemptWrite(guard, 'src/unused/../existing.txt', { agentId: 'agent-1' })
  assert.deepEqual(alias.decision, { kind: 'allow' })
  assert.equal(alias.final, undefined)
})

test('reserves one read grant across concurrent write preflights', async () => {
  const { guard } = makeHarness()
  await readSuccessfully(guard, 'src/existing.txt')
  const first = makeExec('write', 'src/existing.txt')
  const second = makeExec('write', 'src/existing.txt')
  const decisions = await Promise.all([guard.before(first, allow), guard.before(second, allow)])
  assert.equal(decisions.filter(decision => decision.kind === 'allow').length, 1)
  assert.equal(decisions.filter(decision => decision.kind === 'deny').length, 1)
  const finals = [guard.guard(first), guard.guard(second)]
  assert.equal(finals.filter(result => result === undefined).length, 1)
  assert.equal(finals.filter(result => typeof result === 'string').length, 1)
})

test('clear/compact, Agent disposal, and plugin disposal erase grants', async () => {
  const { guard, agentsById } = makeHarness()
  const agent = agentsById.get('agent-1')
  await readSuccessfully(guard, 'src/existing.txt')
  guard.onAgentCreated({ agent, source: 'compact' })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')

  await readSuccessfully(guard, 'src/existing.txt')
  guard.onAgentDisposed({ agent })
  assert.equal((await attemptWrite(guard, 'src/existing.txt')).decision.kind, 'deny')

  const other = makeHarness()
  await readSuccessfully(other.guard, 'src/existing.txt')
  other.guard.dispose()
  assert.equal((await attemptWrite(other.guard, 'src/existing.txt')).decision.kind, 'allow')
})

test('bounds sessions, grants, and pending read candidates', async () => {
  const sessions = makeHarness({
    agentIds: ['agent-1', 'agent-2'],
    guardOptions: { maxSessions: 1 },
  })
  await readSuccessfully(sessions.guard, 'src/existing.txt', { agentId: 'agent-1' })
  await readSuccessfully(sessions.guard, 'src/existing.txt', { agentId: 'agent-2' })
  assert.equal((await attemptWrite(sessions.guard, 'src/existing.txt', { agentId: 'agent-1' })).decision.kind, 'deny')
  assert.equal((await attemptWrite(sessions.guard, 'src/existing.txt', { agentId: 'agent-2' })).decision.kind, 'allow')

  const pending = makeHarness({
    guardOptions: { maxPendingCalls: 1 },
  })
  const firstRead = makeExec('read', 'src/existing.txt')
  const secondRead = makeExec('read', 'src/other.txt')
  await pending.guard.before(firstRead, allow)
  await pending.guard.before(secondRead, allow)
  pending.guard.onResult(firstRead, { isError: false })
  pending.guard.onResult(secondRead, { isError: false })
  assert.equal((await attemptWrite(pending.guard, 'src/existing.txt')).decision.kind, 'allow')
  assert.equal((await attemptWrite(pending.guard, 'src/other.txt')).decision.kind, 'deny')

  const grants = makeHarness({ guardOptions: { maxGrantsPerSession: 1 } })
  await readSuccessfully(grants.guard, 'src/existing.txt')
  await readSuccessfully(grants.guard, 'src/other.txt')
  assert.equal((await attemptWrite(grants.guard, 'src/existing.txt')).decision.kind, 'deny')
  assert.equal((await attemptWrite(grants.guard, 'src/other.txt')).decision.kind, 'allow')
})

test('requires safe scalar file_path and fail-closes unknown filesystem metadata', async () => {
  const { guard } = makeHarness()
  const noPath = await attemptWrite(guard, undefined, { arguments: { path: 'src/existing.txt' } })
  assert.equal(noPath.decision.kind, 'deny')
  assert.equal(noPath.final, noPath.decision.reason)

  const malformed = await attemptWrite(guard, 'src/../existing.txt\u202e')
  assert.equal(malformed.decision.kind, 'deny')

  const badSchema = makeExec('write', 'src/existing.txt', {
    schema: { name: 'read', parameters: { properties: { file_path: { type: 'string' } } } },
  })
  assert.equal((await guard.before(badSchema, allow)).kind, 'deny')

  const brokenFs = makeHarness()
  brokenFs.fs.resolve = async () => { throw new Error('unavailable') }
  const denied = await attemptWrite(brokenFs.guard, 'src/existing.txt')
  assert.equal(denied.decision.kind, 'deny')
  assert.equal(denied.final, denied.decision.reason)

  for (const contains of [
    () => { throw new Error('uncertain containment') },
    () => undefined,
  ]) {
    const unknownContainment = makeHarness()
    unknownContainment.fs.contains = contains
    const unknown = await attemptWrite(unknownContainment.guard, 'src/existing.txt')
    assert.equal(unknown.decision.kind, 'deny')
    assert.equal(unknown.final, unknown.decision.reason)
  }

  for (const missingVersion of ['lstat', 'stat']) {
    const incompleteMetadata = makeHarness()
    const original = incompleteMetadata.fs[missingVersion]
    incompleteMetadata.fs[missingVersion] = async (...args) => {
      const value = await original(...args)
      return value ? { ...value, version: undefined } : value
    }
    const unknownVersion = await attemptWrite(incompleteMetadata.guard, 'src/existing.txt')
    assert.equal(unknownVersion.decision.kind, 'deny')
    assert.equal(unknownVersion.final, unknownVersion.decision.reason)
  }

  const inconsistent = makeHarness()
  const originalStat = inconsistent.fs.stat
  inconsistent.fs.stat = async (...args) => {
    const value = await originalStat(...args)
    return value ? { ...value, version: 'different-version' } : value
  }
  const versionMismatch = await attemptWrite(inconsistent.guard, 'src/existing.txt')
  assert.equal(versionMismatch.decision.kind, 'deny')
  assert.equal(versionMismatch.final, versionMismatch.decision.reason)
})

test('keeps overload denials token-keyed across capacity changes and latches excess overflow closed', async () => {
  const { guard } = makeHarness({ guardOptions: { maxPendingCalls: 1 } })
  const pendingRead = makeExec('read', 'src/existing.txt')
  assert.deepEqual(await guard.before(pendingRead, allow), { kind: 'allow' })

  const deniedWrites = []
  for (let index = 0; index < 65; index += 1) {
    const exec = makeExec('write', 'src/existing.txt')
    assert.deepEqual(await guard.before(exec, allow), {
      kind: 'deny', reason: 'Write guard is busy; retry after rereading the file.',
    })
    assert.equal(guard.guard(exec), 'Write guard is busy; retry after rereading the file.')
    deniedWrites.push(exec)
  }
  assert.equal(
    guard.guard({ ...deniedWrites[0] }),
    'Write guard is busy; retry after rereading the file.',
    'overflow token records enforce denial even when the guard receives a different execution object',
  )

  guard.onResult(pendingRead, { isError: false })
  for (const exec of deniedWrites.slice(0, 64)) guard.onResult(exec, { isError: true })
  const differentExecutionObject = { ...deniedWrites[64] }
  assert.equal(
    guard.guard(differentExecutionObject),
    'Write guard is busy; retry after rereading the file.',
    'overflow latch protects the denial even after regular/overflow token slots drain and object identity changes',
  )
  assert.equal((await attemptWrite(guard, '.omo/state')).final, undefined, 'literal .omo bypass remains available under the latch')
  assert.equal((await attemptWrite(guard, 'src/existing.txt', { overwrite: true })).final, undefined, 'overwrite bypass remains available under the latch')
})

test('caps concurrent FS preflights and releases the slot after completion', async () => {
  const harness = makeHarness({ guardOptions: { maxInFlightPreflights: 1, timeoutMs: 1_000 } })
  const originalResolve = harness.fs.resolve
  const gate = deferred()
  let blockNextResolve = true
  harness.fs.resolve = async (...args) => {
    if (blockNextResolve) {
      blockNextResolve = false
      await gate.promise
    }
    return originalResolve(...args)
  }

  const firstRead = makeExec('read', 'src/existing.txt')
  const firstReadPending = harness.guard.before(firstRead, allow)
  assert.equal(blockNextResolve, false, 'first call entered the async filesystem preflight')

  const skippedRead = makeExec('read', 'src/other.txt')
  assert.deepEqual(await harness.guard.before(skippedRead, allow), { kind: 'allow' })
  harness.guard.onResult(skippedRead, { isError: false })

  const busyWrite = makeExec('write', 'src/existing.txt')
  assert.deepEqual(await harness.guard.before(busyWrite, allow), {
    kind: 'deny', reason: 'Write guard is busy; retry after rereading the file.',
  })
  assert.equal(harness.guard.guard(busyWrite), 'Write guard is busy; retry after rereading the file.')
  harness.guard.onResult(busyWrite, { isError: true })

  gate.resolve()
  assert.deepEqual(await firstReadPending, { kind: 'allow' })
  harness.guard.onResult(firstRead, { isError: false })
  const write = await attemptWrite(harness.guard, 'src/existing.txt')
  assert.deepEqual(write.decision, { kind: 'allow' }, 'completion releases the in-flight slot and preserves the successful-read grant')
})

test('keeps the preflight cap reserved while a backend ignores abort', async () => {
  const harness = makeHarness({ guardOptions: { maxInFlightPreflights: 1, timeoutMs: 10 } })
  const originalResolve = harness.fs.resolve
  const gate = deferred()
  const entered = deferred()
  let calls = 0
  harness.fs.resolve = async (...args) => {
    calls += 1
    if (calls === 1) {
      entered.resolve()
      await gate.promise
    }
    return originalResolve(...args)
  }

  const firstRead = makeExec('read', 'src/existing.txt')
  const firstPending = harness.guard.before(firstRead, allow)
  await entered.promise
  assert.deepEqual(await firstPending, { kind: 'allow' }, 'the waiter still settles at the deadline')
  assert.equal(calls, 1)

  const reloadedGuard = createWriteExistingFileGuard(harness.agents, harness.sessions, harness.fs, {
    maxInFlightPreflights: 1, timeoutMs: 10,
  })
  const skippedRead = makeExec('read', 'src/other.txt')
  assert.deepEqual(await reloadedGuard.before(skippedRead, allow), { kind: 'allow' })
  const busyWrite = makeExec('write', 'src/new.txt')
  assert.deepEqual(await reloadedGuard.before(busyWrite, allow), {
    kind: 'deny', reason: 'Write guard is busy; retry after rereading the file.',
  })
  assert.equal(calls, 1, 'no new filesystem work starts in either listener while ignored work holds the shared lease')

  gate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  const nextRead = makeExec('read', 'src/existing.txt')
  assert.deepEqual(await reloadedGuard.before(nextRead, allow), { kind: 'allow' })
  assert.ok(calls > 1, 'the shared lease is released when the underlying operation finally settles')
  reloadedGuard.onResult(nextRead, { isError: false })
})

test('caller abort, deadline, and plugin unload settle pending filesystem preflights', async () => {
  const aborted = makeHarness({ guardOptions: { maxInFlightPreflights: 1, timeoutMs: 1_000 } })
  const originalAbortResolve = aborted.fs.resolve
  const abortGate = deferred()
  aborted.fs.resolve = async (...args) => {
    await abortGate.promise
    return originalAbortResolve(...args)
  }
  const controller = new AbortController()
  const abortedRead = makeExec('read', 'src/existing.txt', { signal: controller.signal })
  const abortedPending = aborted.guard.before(abortedRead, allow)
  controller.abort()
  assert.deepEqual(await abortedPending, { kind: 'allow' }, 'cancelled reads remain native and create no grant')
  abortGate.resolve()
  aborted.fs.resolve = originalAbortResolve
  await new Promise(resolve => setImmediate(resolve))
  await readSuccessfully(aborted.guard, 'src/existing.txt')
  assert.equal((await attemptWrite(aborted.guard, 'src/existing.txt')).decision.kind, 'allow', 'caller abort releases the slot')

  const timed = makeHarness({ guardOptions: { maxInFlightPreflights: 1, timeoutMs: 5 } })
  const originalTimedResolve = timed.fs.resolve
  const timeoutGate = deferred()
  timed.fs.resolve = async (...args) => {
    await timeoutGate.promise
    return originalTimedResolve(...args)
  }
  const timedRead = makeExec('read', 'src/existing.txt')
  assert.deepEqual(await timed.guard.before(timedRead, allow), { kind: 'allow' }, 'deadline lets a native read continue without a grant')
  timeoutGate.resolve()
  timed.fs.resolve = originalTimedResolve
  await new Promise(resolve => setImmediate(resolve))
  await readSuccessfully(timed.guard, 'src/existing.txt')
  assert.equal((await attemptWrite(timed.guard, 'src/existing.txt')).decision.kind, 'allow', 'deadline releases the in-flight slot')

  const unloaded = makeHarness({ guardOptions: { maxInFlightPreflights: 1, timeoutMs: 1_000 } })
  const originalUnloadResolve = unloaded.fs.resolve
  const unloadGate = deferred()
  unloaded.fs.resolve = async (...args) => {
    await unloadGate.promise
    return originalUnloadResolve(...args)
  }
  const pendingWrite = makeExec('write', 'src/existing.txt')
  const pendingWriteDecision = unloaded.guard.before(pendingWrite, allow)
  unloaded.guard.dispose()
  assert.deepEqual(await pendingWriteDecision, { kind: 'cancel' }, 'unload aborts and settles an active write preflight')
  unloadGate.resolve()
  unloaded.fs.resolve = originalUnloadResolve
})
