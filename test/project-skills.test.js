import assert from 'node:assert/strict'
import { lstat as lstatPath, mkdtemp, mkdir, readFile, realpath, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createProjectSkillProvider, normalizeProjectSkillDirs, registerProjectSkillProvider } from '../src/project-skills.js'

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function canonicalOrFuture(candidate) {
  let current = candidate
  const missing = []
  while (true) {
    try {
      const resolved = await realpath(current)
      return path.join(resolved, ...missing)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

function makeFileSystem(options = {}) {
  let failWatch = options.failWatch ?? false
  let failMissingResolve = options.failMissingResolve ?? false
  const failDispose = options.failDispose ?? false
  const watchErrorDuringInit = options.watchErrorDuringInit ?? false
  let initErrorsSent = 0
  const watchers = []
  const watchCalls = []
  const calls = []
  let releaseWatch
  const watchGate = options.delayWatch ? new Promise(resolve => { releaseWatch = resolve }) : undefined
  let releaseDispose
  const disposeGate = options.delayDispose ? new Promise(resolve => { releaseDispose = resolve }) : undefined
  let resolveDisposeStarted
  const disposeStarted = new Promise(resolve => { resolveDisposeStarted = resolve })
  let resolveWatchStarted
  const watchStarted = new Promise(resolve => { resolveWatchStarted = resolve })
  let lstatCount = 0
  const lstatWaiters = []
  const waitForLstatCount = targetCount => {
    if (lstatCount >= targetCount) return Promise.resolve()
    return new Promise(resolve => lstatWaiters.push({ targetCount, resolve }))
  }
  const notifyLstatWaiters = () => {
    for (let index = lstatWaiters.length - 1; index >= 0; index -= 1) {
      if (lstatCount >= lstatWaiters[index].targetCount) lstatWaiters.splice(index, 1)[0].resolve()
    }
  }
  const resolveCounts = new Map()
  const resolveWaiters = []
  const waitForResolveCount = (filePath, targetCount) => {
    if ((resolveCounts.get(filePath) ?? 0) >= targetCount) return Promise.resolve()
    return new Promise(resolve => resolveWaiters.push({ filePath, targetCount, resolve }))
  }
  const notifyResolveWaiters = filePath => {
    for (let index = resolveWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = resolveWaiters[index]
      if (waiter.filePath === filePath && (resolveCounts.get(filePath) ?? 0) >= waiter.targetCount) resolveWaiters.splice(index, 1)[0].resolve()
    }
  }
  const toTarget = targetPath => ({
    targetKey: targetPath,
    displayPath: options.displayPrefix ? `${options.displayPrefix}${targetPath}` : targetPath,
  })
  const fs = {
    async resolve(filePath, options = {}) {
      calls.push('resolve')
      const base = options.cwd ?? process.cwd()
      const candidate = path.resolve(base, filePath)
      if (failMissingResolve) {
        try {
          await stat(candidate)
        } catch (error) {
          if (error?.code === 'ENOENT') error.code = 'FS_NOT_FOUND'
          throw error
        }
      }
      const target = toTarget(await canonicalOrFuture(candidate))
      resolveCounts.set(filePath, (resolveCounts.get(filePath) ?? 0) + 1)
      notifyResolveWaiters(filePath)
      return target
    },
    contains(parent, child) {
      calls.push('contains')
      return isWithin(parent.targetKey, child.targetKey)
    },
    async lstat(filePath, options = {}, signal) {
      calls.push('lstat')
      lstatCount += 1
      notifyLstatWaiters()
      if (signal?.aborted) throw signal.reason ?? new Error('lstat aborted')
      try {
        const info = await lstatPath(path.resolve(options.cwd ?? process.cwd(), filePath))
        return {
          type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
          version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        }
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    async stat(target) {
      calls.push('stat')
      try {
        const info = await stat(target.targetKey)
        return {
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
          version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        }
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    async listDir(target) {
      calls.push('listDir')
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      return Promise.all(entries.map(async entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: await fs.resolve(entry.name, { cwd: target.targetKey }),
      })))
    },
    async readBytes(target, signal, maxBytes) {
      calls.push('readBytes')
      if (signal?.aborted) throw signal.reason ?? new Error('read aborted')
      const bytes = await readFile(target.targetKey)
      if (bytes.length > maxBytes) {
        const error = new Error('file too large')
        error.code = 'FS_TOO_LARGE'
        throw error
      }
      return bytes
    },
    async watch(target, changed, signal) {
      calls.push('watch')
      const watchCall = { target, signal }
      watchCalls.push(watchCall)
      resolveWatchStarted()
      if (failWatch) {
        const error = new Error('watch unsupported')
        error.code = 'FS_IO_ERROR'
        throw error
      }
      if (signal.aborted) throw signal.reason ?? new Error('watch aborted')
      if (watchErrorDuringInit && initErrorsSent === 0) {
        initErrorsSent += 1
        changed(new Error('watch failed during initialization'))
      }
      if (watchGate) {
        await new Promise((resolve, reject) => {
          const cleanup = () => signal.removeEventListener('abort', onAbort)
          const onAbort = () => {
            cleanup()
            reject(signal.reason ?? new Error('watch aborted'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          watchGate.then(() => {
            cleanup()
            resolve()
          })
        })
      }
      if (signal.aborted) throw signal.reason ?? new Error('watch aborted')
      const watcher = { target, changed, closed: false }
      watchCall.watcher = watcher
      watchers.push(watcher)
      return async () => {
        resolveDisposeStarted()
        if (disposeGate) await disposeGate
        if (failDispose) throw new Error('watch dispose failed')
        watcher.closed = true
      }
    },
  }
  return {
    fs,
    watchers,
    watchCalls,
    watchStarted,
    releaseWatch,
    releaseDispose,
    disposeStarted,
    waitForLstatCount,
    waitForResolveCount,
    calls,
    setFailWatch: value => { failWatch = value },
    setFailMissingResolve: value => { failMissingResolve = value },
  }
}

async function makeWorkspace(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-omo-project-skills-'))
  t.after(async () => rm(cwd, { recursive: true, force: true }))
  return cwd
}

async function writeSkill(filePath, { name, description = 'Project skill', frontmatter = '', content = 'Skill body.' }) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n${frontmatter}---\n\n${content}`, 'utf8')
}

function makeRegistry(fs) {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  ctx.fs = fs
  ctx.skills = registry
  ctx.logger = { warn() {} }
  return { ctx, registry }
}

test('discovers cwd-relative OpenCode and Claude skills through the DSH registry', async t => {
  const cwdA = await makeWorkspace(t)
  const cwdB = await makeWorkspace(t)
  await writeSkill(path.join(cwdA, '.opencode/skills/review/SKILL.md'), {
    name: 'project-review',
    description: 'Review local changes',
    frontmatter: 'whenToUse: Use for code review.\ndisable-model-invocation: true\nuser-invocable: false\nagent: reviewer\ntools: [read, grep]\n',
    content: 'Use the project review rubric.',
  })
  await writeSkill(path.join(cwdA, '.opencode/skills/shared/SKILL.md'), {
    name: 'shared-project-skill',
    description: 'OpenCode winner',
    content: 'OpenCode body.',
  })
  await writeSkill(path.join(cwdA, '.claude/skills/shared/SKILL.md'), {
    name: 'shared-project-skill',
    description: 'Claude fallback',
    content: 'Claude body.',
  })
  await writeSkill(path.join(cwdA, '.opencode/skills/flat-project-skill.md'), {
    name: 'flat-project-skill',
    content: 'Flat skill body.',
  })
  await writeSkill(path.join(cwdB, '.claude/skills/ship/SKILL.md'), {
    name: 'ship-project',
    description: 'Only in workspace B',
    content: 'Ship the project.',
  })

  const { fs, calls } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx)
  const snapshotA = await registry.snapshot({ cwd: cwdA })
  assert.equal(snapshotA.complete, true)
  assert.deepEqual(snapshotA.skills.map(skill => skill.name).sort(), ['flat-project-skill', 'project-review', 'shared-project-skill'])
  const review = await registry.get('project-review', { cwd: cwdA })
  assert.equal(review.content, 'Use the project review rubric.')
  assert.deepEqual(review.invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(review.source, 'project-opencode')
  assert.equal(review.metadata.agent, 'reviewer')
  assert.deepEqual(review.metadata.tools, ['read', 'grep'])
  assert.equal((await registry.get('shared-project-skill', { cwd: cwdA })).content, 'OpenCode body.')

  const snapshotB = await registry.snapshot({ cwd: cwdB })
  assert.equal(snapshotB.complete, true)
  assert.deepEqual(snapshotB.skills.map(skill => skill.name), ['ship-project'])
  assert.equal((await registry.get('ship-project', { cwd: cwdB })).source, 'project-claude')
  assert.ok(calls.includes('resolve') && calls.includes('lstat') && calls.includes('stat') && calls.includes('listDir') && calls.includes('readBytes') && calls.includes('watch'))
  provider.dispose()
})

test('deduplicates concurrent watcher initialization and bounds live handles', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'concurrent-skill' })
  const { fs, watchers, watchCalls, watchStarted, releaseWatch, waitForLstatCount, waitForResolveCount } = makeFileSystem({ delayWatch: true })
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'] })

  const first = provider.list({ cwd })
  const second = provider.list({ cwd })
  await watchStarted
  await waitForLstatCount(4)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(watchCalls.filter(call => call.target.targetKey.endsWith('/.opencode/skills')).length, 1)
  releaseWatch()
  const observations = await Promise.all([first, second])
  assert.ok(observations.every(observation => observation.complete))
  assert.equal(watchers.length, 3)
  lifetime.abort()
  assert.ok(watchers.every(watcher => watcher.closed))
})

test('canceling one lookup does not cancel another lookup shared on watcher initialization', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'shared-cancel-skill' })
  const { fs, watchers, watchCalls, watchStarted, releaseWatch, waitForLstatCount, waitForResolveCount } = makeFileSystem({ delayWatch: true })
  const lifetime = new AbortController()
  const firstCaller = new AbortController()
  const secondCaller = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'] })

  const first = provider.list({ cwd, signal: firstCaller.signal })
  const second = provider.list({ cwd, signal: secondCaller.signal })
  await watchStarted
  await waitForLstatCount(4)
  await waitForResolveCount('.opencode/skills', 2)
  await new Promise(resolve => setImmediate(resolve))
  firstCaller.abort(new Error('first lookup cancelled'))
  await assert.rejects(first, /first lookup cancelled/u)
  assert.equal(watchCalls[0].signal.aborted, false)
  releaseWatch()
  const observation = await second
  assert.equal(observation.complete, true)
  assert.equal(watchers.length, 3)
  lifetime.abort()
})

test('caller cancellation aborts pending watcher initialization and leaves no handle', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'cancelled-skill' })
  const { fs, watchers, watchCalls, watchStarted } = makeFileSystem({ delayWatch: true })
  const lifetime = new AbortController()
  const caller = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'] })

  const listing = provider.list({ cwd, signal: caller.signal })
  await watchStarted
  caller.abort(new Error('lookup cancelled'))
  await assert.rejects(listing, /lookup cancelled/u)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(watchCalls.length, 1)
  assert.equal(watchCalls[0].signal.aborted, true)
  assert.deepEqual(watchers, [])
  lifetime.abort()
})

test('retries watcher initialization after a synchronous filesystem throw', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'sync-watch-retry' })
  const { fs, watchCalls } = makeFileSystem()
  const originalWatch = fs.watch.bind(fs)
  let failedTargetKey
  fs.watch = (target, changed, signal) => {
    if (!failedTargetKey) {
      failedTargetKey = target.targetKey
      throw new Error('synchronous watch failure')
    }
    return originalWatch(target, changed, signal)
  }
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'] })

  const first = await provider.list({ cwd })
  assert.equal(first.complete, false)
  assert.equal(watchCalls.filter(call => call.target.targetKey === failedTargetKey).length, 0)
  const second = await provider.list({ cwd })
  assert.equal(second.complete, true)
  assert.equal(watchCalls.filter(call => call.target.targetKey === failedTargetKey).length, 1)
  lifetime.abort()
})

test('publishes the shared promise before synchronous watcher invalidation re-enters', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'reentrant-watch-init' })
  const { fs, watchCalls, watchStarted, releaseWatch, waitForLstatCount, waitForResolveCount } = makeFileSystem({
    watchErrorDuringInit: true,
    delayWatch: true,
  })
  const lifetime = new AbortController()
  let provider
  let reentrantListing
  provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {
      if (!reentrantListing) reentrantListing = provider.list({ cwd })
    },
  }, { projectSkillDirs: ['.opencode/skills'] })

  const firstListing = provider.list({ cwd })
  await watchStarted
  await waitForLstatCount(4)
  await waitForResolveCount('.opencode/skills', 2)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(reentrantListing)
  assert.equal(watchCalls.length, 1)
  releaseWatch()
  const first = await firstListing
  const reentrant = await reentrantListing
  assert.equal(first.complete, false)
  assert.equal(reentrant.complete, false)
  lifetime.abort()
})

test('counts asynchronously closing watch handles against capacity', async t => {
  const firstCwd = await makeWorkspace(t)
  const secondCwd = await makeWorkspace(t)
  await writeSkill(path.join(firstCwd, '.opencode/skills/first/SKILL.md'), { name: 'first-closing-skill' })
  await writeSkill(path.join(secondCwd, '.opencode/skills/second/SKILL.md'), { name: 'second-closing-skill' })
  const { fs, watchers, watchCalls, releaseDispose } = makeFileSystem({ delayDispose: true })
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 1 })

  await provider.list({ cwd: firstCwd })
  assert.equal(watchCalls.length, 1)
  watchers[0].changed(new Error('runtime watcher error'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(watchers[0].closed, false)
  await provider.list({ cwd: secondCwd })
  assert.equal(watchCalls.length, 1)

  releaseDispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(watchers[0].closed, true)
  await provider.list({ cwd: secondCwd })
  assert.equal(watchCalls.length, 2)
  lifetime.abort()
})

test('does not double-count an uninstalled handle while disposal is pending', async t => {
  const firstCwd = await makeWorkspace(t)
  const secondCwd = await makeWorkspace(t)
  await writeSkill(path.join(firstCwd, '.opencode/skills/first/SKILL.md'), { name: 'pending-close-first' })
  await writeSkill(path.join(secondCwd, '.opencode/skills/second/SKILL.md'), { name: 'pending-close-second' })
  const { fs, watchCalls, disposeStarted, releaseDispose } = makeFileSystem({ watchErrorDuringInit: true, delayDispose: true })
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 2 })

  const firstListing = provider.list({ cwd: firstCwd })
  await disposeStarted
  const secondObservation = await provider.list({ cwd: secondCwd })
  assert.equal(secondObservation.complete, false)
  assert.equal(watchCalls.length, 2)
  releaseDispose()
  await firstListing
  lifetime.abort()
})

test('retains watcher capacity when an uninstalled handle refuses disposal', async t => {
  const firstCwd = await makeWorkspace(t)
  const secondCwd = await makeWorkspace(t)
  await writeSkill(path.join(firstCwd, '.opencode/skills/first/SKILL.md'), { name: 'uninstalled-first' })
  await writeSkill(path.join(secondCwd, '.opencode/skills/second/SKILL.md'), { name: 'uninstalled-second' })
  const { fs, watchCalls, watchers } = makeFileSystem({ watchErrorDuringInit: true, failDispose: true })
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 1 })

  await provider.list({ cwd: firstCwd })
  assert.equal(watchCalls.length, 1)
  assert.equal(watchers[0].closed, false)
  await provider.list({ cwd: secondCwd })
  assert.equal(watchCalls.length, 1)
  lifetime.abort()
})

test('loads skills using a cwd-relative resolver path rather than UI displayPath', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), {
    name: 'display-safe-skill',
    content: 'Load from the opaque filesystem target.',
  })
  const { fs } = makeFileSystem({ displayPrefix: 'dsh-ui://' })
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.match(snapshot.skills[0].path, /^dsh-ui:\/\//u)
  const loaded = await registry.get('display-safe-skill', { cwd })
  assert.equal(loaded.content, 'Load from the opaque filesystem target.')
  provider.dispose()
})

test('project candidates override same-named runtime skills in DSH rank order', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/local/SKILL.md'), {
    name: 'same-name-skill',
    description: 'Project copy',
    content: 'Project skill body.',
  })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  registry.register({
    name: 'same-name-skill',
    description: 'Runtime copy',
    provider: 'dsh-omo-bundled',
    source: 'bundled',
    content: 'Runtime skill body.',
  })
  const configuredRoots = [...Array.from({ length: 15 }, (_, index) => `.missing-${index}`), '.opencode/skills']
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: configuredRoots })
  const loaded = await registry.get('same-name-skill', { cwd })
  assert.equal(loaded.content, 'Project skill body.')
  assert.equal(loaded.source, 'project-opencode')
  provider.dispose()
})

test('higher-priority native project candidates remain ahead of dsh-omo roots', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/local/SKILL.md'), {
    name: 'native-collision-skill',
    description: 'dsh-omo project copy',
    content: 'dsh-omo project body.',
  })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const nativeDisposer = registry.registerProvider(() => ({
    name: 'test-native-project',
    async list() {
      return {
        complete: true,
        candidates: [{
          name: 'native-collision-skill',
          description: 'Native project copy',
          path: '/native/project/SKILL.md',
          provider: 'test-native-project',
          source: 'project-dsh',
          invocation: { modelInvocable: true, userInvocable: true },
          rank: 200,
          locator: 'native-skill',
        }],
      }
    },
    async get(candidate) {
      return {
        name: candidate.name,
        description: candidate.description,
        path: candidate.path,
        provider: candidate.provider,
        source: candidate.source,
        invocation: candidate.invocation,
        content: 'Native project body.',
      }
    },
  }))
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const loaded = await registry.get('native-collision-skill', { cwd })
  assert.equal(loaded.content, 'Native project body.')
  assert.equal(loaded.source, 'project-dsh')
  provider.dispose()
  nativeDisposer()
})

test('watches the nearest existing parent when a project skill root is absent', async t => {
  const cwd = await makeWorkspace(t)
  const { fs, watchers } = makeFileSystem({ failMissingResolve: true })
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const empty = await registry.snapshot({ cwd })
  assert.equal(empty.complete, true)
  assert.deepEqual(empty.skills, [])
  const canonicalCwd = await realpath(cwd)
  const parentWatcher = watchers.find(watcher => watcher.target.displayPath === canonicalCwd)
  assert.ok(parentWatcher)

  await writeSkill(path.join(cwd, '.opencode/skills/new/SKILL.md'), { name: 'new-skill' })
  parentWatcher.changed()
  const updated = await registry.snapshot({ cwd })
  assert.deepEqual(updated.skills.map(skill => skill.name), ['new-skill'])
  provider.dispose()
})

test('honors disabledSkills, refreshes on DSH watch invalidation, and closes watchers', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'ops/SKILL.md'), { name: 'ops-skill' })
  await writeSkill(path.join(root, 'duplicate/SKILL.md'), { name: 'duplicate-skill', content: 'Project duplicate.' })
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  registry.register({
    name: 'duplicate-skill',
    description: 'External runtime copy',
    provider: 'other-plugin',
    source: 'custom',
    content: 'External runtime duplicate.',
  })
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'], disabledSkills: ['ops-skill', 'duplicate-skill'] })

  const first = await registry.snapshot({ cwd })
  assert.deepEqual(first.skills.map(skill => skill.name).sort(), ['duplicate-skill', 'ops-skill'])
  assert.ok(first.skills.every(skill => skill.invocation.modelInvocable === false && skill.invocation.userInvocable === false))
  const duplicate = await registry.get('duplicate-skill', { cwd })
  assert.equal(duplicate.content, 'Project duplicate.')
  assert.equal(duplicate.source, 'project-opencode')
  await writeSkill(path.join(root, 'new/SKILL.md'), { name: 'new-skill' })
  const canonicalRoot = await realpath(root)
  const rootWatcher = watchers.find(watcher => watcher.target.displayPath === canonicalRoot)
  assert.ok(rootWatcher)
  rootWatcher.changed()
  const second = await registry.snapshot({ cwd })
  assert.deepEqual(second.skills.map(skill => skill.name).sort(), ['duplicate-skill', 'new-skill', 'ops-skill'])

  provider.refresh()
  provider.dispose()
  assert.ok(watchers.length > 0)
  assert.ok(watchers.every(watcher => watcher.closed))
})

test('rejects symlinked project skills that escape the lookup cwd', async t => {
  const cwd = await makeWorkspace(t)
  const external = await makeWorkspace(t)
  await writeSkill(path.join(external, 'outside/SKILL.md'), { name: 'outside-skill', content: 'Must not load.' })
  const root = path.join(cwd, '.opencode/skills')
  await mkdir(root, { recursive: true })
  await symlink(path.join(external, 'outside'), path.join(root, 'linked-outside'))
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.deepEqual(snapshot.skills, [])
  assert.equal(await registry.get('outside-skill', { cwd }), undefined)
  provider.dispose()
})

test('keeps a root symlink outside cwd uncached and unread', async t => {
  const cwd = await makeWorkspace(t)
  const external = await makeWorkspace(t)
  const externalRoot = path.join(external, 'outside')
  await writeSkill(path.join(externalRoot, 'private/SKILL.md'), { name: 'private-skill' })
  await mkdir(path.join(cwd, '.opencode'), { recursive: true })
  await symlink(externalRoot, path.join(cwd, '.opencode/skills'))
  const { fs, calls } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })

  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
  assert.equal(calls.includes('readBytes'), false)
  provider.dispose()
})

test('invalidates cached skills when a configured root symlink is retargeted', async t => {
  const cwd = await makeWorkspace(t)
  const firstRoot = path.join(cwd, 'skills-v1')
  const secondRoot = path.join(cwd, 'skills-v2')
  const lexicalRoot = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(firstRoot, 'old/SKILL.md'), { name: 'old-skill' })
  await writeSkill(path.join(secondRoot, 'new/SKILL.md'), { name: 'new-skill' })
  await mkdir(path.dirname(lexicalRoot), { recursive: true })
  await symlink(firstRoot, lexicalRoot)
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })

  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['old-skill'])
  const parentPath = await realpath(path.join(cwd, '.opencode'))
  const parentWatcher = watchers.find(watcher => watcher.target.targetKey === parentPath)
  assert.ok(parentWatcher)
  await unlink(lexicalRoot)
  await symlink(secondRoot, lexicalRoot)
  parentWatcher.changed()
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['new-skill'])
  provider.dispose()
})

test('invalidates cached skills when an intermediate root symlink is retargeted', async t => {
  const cwd = await makeWorkspace(t)
  const configA = path.join(cwd, 'config-a')
  const configB = path.join(cwd, 'config-b')
  const lexicalParent = path.join(cwd, '.opencode')
  await writeSkill(path.join(configA, 'skills/old/SKILL.md'), { name: 'old-intermediate-skill' })
  await writeSkill(path.join(configB, 'skills/new/SKILL.md'), { name: 'new-intermediate-skill' })
  await symlink(configA, lexicalParent)
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })

  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['old-intermediate-skill'])
  const canonicalCwd = await realpath(cwd)
  const cwdWatcher = watchers.find(watcher => watcher.target.targetKey === canonicalCwd)
  assert.ok(cwdWatcher)
  await unlink(lexicalParent)
  await symlink(configB, lexicalParent)
  cwdWatcher.changed()
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['new-intermediate-skill'])
  provider.dispose()
})

test('re-resolves skill locators before loading to reject retargeted symlinks', async t => {
  const cwd = await makeWorkspace(t)
  const external = await makeWorkspace(t)
  const skillPath = path.join(cwd, '.opencode/skills/review/SKILL.md')
  const externalPath = path.join(external, 'outside.md')
  await writeSkill(skillPath, { name: 'local-skill', content: 'Local body.' })
  await writeSkill(externalPath, { name: 'outside-skill', content: 'External secret body.' })
  const { fs, calls } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['local-skill'])
  const readCount = calls.filter(call => call === 'readBytes').length

  await rename(skillPath, `${skillPath}.original`)
  await symlink(externalPath, skillPath)
  assert.equal(await registry.get('local-skill', { cwd }), undefined)
  assert.equal(calls.filter(call => call === 'readBytes').length, readCount)
  provider.dispose()
})

test('discards a project skill changed to an outside symlink during the read window', async t => {
  const cwd = await makeWorkspace(t)
  const external = await makeWorkspace(t)
  const skillPath = path.join(cwd, '.opencode/skills/review/SKILL.md')
  const externalPath = path.join(external, 'outside.md')
  await writeSkill(skillPath, { name: 'local-skill', content: 'Local body.' })
  await writeSkill(externalPath, { name: 'local-skill', content: 'OUTSIDE SECRET' })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['local-skill'])

  const readBytes = fs.readBytes.bind(fs)
  const canonicalSkillPath = await realpath(skillPath)
  let swapped = false
  fs.readBytes = async (target, signal, maxBytes) => {
    if (!swapped && target.targetKey === canonicalSkillPath) {
      swapped = true
      await rename(skillPath, `${skillPath}.original`)
      await symlink(externalPath, skillPath)
    }
    return readBytes(target, signal, maxBytes)
  }

  assert.equal(await registry.get('local-skill', { cwd }), undefined)
  assert.equal(swapped, true, 'test swapped the final path after containment was checked')
  provider.dispose()
})

test('caps directory-entry processing even when files are all malformed', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await mkdir(root, { recursive: true })
  await Promise.all(Array.from({ length: 520 }, (_, index) => writeFile(path.join(root, `invalid-${index}.md`), 'not frontmatter', 'utf8')))
  const { fs, calls } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
  assert.equal(calls.filter(call => call === 'readBytes').length, 512)
  provider.dispose()
})

test('caps accepted project skills at 256 per catalog scan', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await Promise.all(Array.from({ length: 257 }, (_, index) => writeSkill(path.join(root, `valid-${index}.md`), {
    name: `valid-${index}`,
  })))
  const { fs, calls } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.skills.length, 256)
  assert.equal(calls.filter(call => call === 'readBytes').length, 256)
  provider.dispose()
})

test('charges YAML alias parse failures against aggregate scan bytes', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  const scalar = 'x'.repeat(200 * 1024)
  const aliasSkill = index => `---\nname: alias-${index}\ndescription: Aliased metadata\npayload: &payload "${scalar}"\ncopy: *payload\n---\nBody.\n`
  await mkdir(root, { recursive: true })
  await Promise.all(Array.from({ length: 41 }, (_, index) => writeFile(path.join(root, `alias-${index}.md`), aliasSkill(index), 'utf8')))
  const { fs, calls } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
  assert.equal(calls.filter(call => call === 'readBytes').length, 40)
  provider.dispose()
})

test('caps aggregate project skill reads at the scan budget', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await Promise.all(Array.from({ length: 41 }, (_, index) => writeSkill(path.join(root, `skill-${index}.md`), {
    name: `skill-${index}`,
    content: 'x'.repeat(200 * 1024),
  })))
  const { fs, calls } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.skills.length, 40)
  assert.equal(calls.filter(call => call === 'readBytes').length, 40)
  provider.dispose()
})

test('charges bytes when project skills change during post-read version validation', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await Promise.all(Array.from({ length: 40 }, (_, index) => writeSkill(path.join(root, `changing-${index}.md`), {
    name: `changing-${index}`,
    content: 'x'.repeat(250_000),
  })))
  const { fs, calls } = makeFileSystem()
  const originalReadBytes = fs.readBytes.bind(fs)
  const originalStat = fs.stat.bind(fs)
  const readsByTarget = new Map()
  fs.readBytes = async (target, signal, maxBytes) => {
    const bytes = await originalReadBytes(target, signal, maxBytes)
    readsByTarget.set(target.targetKey, (readsByTarget.get(target.targetKey) ?? 0) + 1)
    return bytes
  }
  fs.stat = async target => {
    const info = await originalStat(target)
    const reads = readsByTarget.get(target.targetKey) ?? 0
    return reads > 0 ? { ...info, version: `${info.version}:changed-${reads}` } : info
  }
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
  assert.equal(calls.filter(call => call === 'readBytes').length, 33, 'failed post-read validations consume the aggregate budget')
  provider.dispose()
})

test('skips malformed and oversized skill files without exposing bodies', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'bad.md'), '---\nname: [bad\n---\ninvalid', 'utf8')
  await writeSkill(path.join(root, 'too-large.md'), {
    name: 'too-large-skill',
    content: 'x'.repeat(256 * 1024),
  })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills, [])
  provider.dispose()
})

test('marks the catalog incomplete when DSH filesystem watching is unavailable', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/local/SKILL.md'), { name: 'local-skill' })
  const { fs } = makeFileSystem({ failWatch: true })
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['local-skill'])
  assert.equal((await registry.get('local-skill', { cwd })).content, 'Skill body.')
  provider.dispose()
})

test('recovers from watcher runtime errors by retrying and reporting incomplete state', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'local/SKILL.md'), { name: 'local-skill' })
  const { fs, watchers, setFailWatch } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  assert.equal((await registry.snapshot({ cwd })).complete, true)
  const canonicalRoot = await realpath(root)
  const rootWatcher = watchers.find(watcher => watcher.target.displayPath === canonicalRoot && !watcher.closed)
  assert.ok(rootWatcher)

  setFailWatch(true)
  const runtimeError = new Error('watch backend stopped')
  rootWatcher.changed(runtimeError)
  const next = await registry.snapshot({ cwd })
  assert.equal(next.complete, false)
  assert.deepEqual(next.skills.map(skill => skill.name), ['local-skill'])
  assert.equal(rootWatcher.closed, true)
  provider.dispose()
})

test('accepts only relative project skill directories', () => {
  assert.deepEqual(normalizeProjectSkillDirs(['.opencode/skills', '.claude/skills']), ['.opencode/skills', '.claude/skills'])
  assert.throws(() => normalizeProjectSkillDirs(['../outside']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['/tmp/skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['C:\\skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['https://example.test/skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['~/.config/opencode/skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(Array.from({ length: 17 }, (_, index) => `root-${index}`)), /at most 16/)
})
