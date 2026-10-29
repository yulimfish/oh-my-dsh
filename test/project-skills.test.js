import assert from 'node:assert/strict'
import { lstat as lstatPath, mkdtemp, mkdir, readFile, realpath, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createProjectSkillProvider, normalizeProjectSkillDirs, normalizeUserSkillRoots, registerProjectSkillProvider, resolveCompatibleSkillReferences } from '../src/project-skills.js'

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
      if (watchErrorDuringInit && initErrorsSent === 0 && (typeof watchErrorDuringInit !== 'function' || watchErrorDuringInit(target))) {
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

test('discovers the singular OpenCode skill root after the plural root by default', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skill/singular-demo/SKILL.md'), { name: 'singular-demo', content: 'singular body' })
  await writeSkill(path.join(cwd, '.opencode/skill/shared/SKILL.md'), { name: 'shared-root', content: 'singular loses' })
  await writeSkill(path.join(cwd, '.opencode/skills/shared/SKILL.md'), { name: 'shared-root', content: 'plural wins' })
  await writeSkill(path.join(cwd, '.claude/skills/shared/SKILL.md'), { name: 'shared-root', content: 'later root loses' })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const registration = registerProjectSkillProvider(ctx, { formatCompatibility: true })
  t.after(() => registration.dispose())
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  const singular = await registry.get('singular-demo', { cwd })
  assert.equal(singular.content, 'singular body')
  assert.equal(singular.source, 'project-opencode')
  assert.equal(singular.description, '(opencode-project - Skill) Project skill')
  assert.equal((await registry.get('shared-root', { cwd })).content, 'plural wins')
})

test('loads explicitly configured user skill roots outside cwd with project-to-user-to-runtime precedence', async t => {
  const cwd = await makeWorkspace(t)
  const userRoot = path.join(await makeWorkspace(t), 'skills')
  const claudeRoot = path.join(await makeWorkspace(t), 'skills')
  await writeSkill(path.join(cwd, '.opencode/skills/shared/SKILL.md'), { name: 'shared-skill', content: 'project body' })
  await writeSkill(path.join(userRoot, 'shared/SKILL.md'), { name: 'shared-skill', content: 'opencode user body' })
  await writeSkill(path.join(userRoot, 'user-only/SKILL.md'), { name: 'user-only', content: 'user body' })
  await writeSkill(path.join(claudeRoot, 'shared/SKILL.md'), { name: 'shared-skill', content: 'claude user body' })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  registerProjectSkillProvider(ctx, { userOpenCodeSkillRoots: [userRoot], userClaudeSkillRoots: [claudeRoot] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.equal((await registry.get('shared-skill', { cwd })).content, 'project body')
  assert.equal((await registry.get('user-only', { cwd })).content, 'user body')
  const noCwd = await registry.get('user-only', {})
  assert.equal(noCwd.content, 'user body')
  assert.equal((await registry.get('user-only', { cwd: await makeWorkspace(t) })).content, 'user body')
})

test('user Agents roots retain existing ranks and follow OpenCode and Claude in registry priority', async t => {
  const cwd = await makeWorkspace(t)
  const roots = await Promise.all(Array.from({ length: 6 }, async () => path.join(await makeWorkspace(t), 'skills')))
  const [openA, openB, agentsA, agentsB, claudeA, claudeB] = roots
  for (const [index, root] of roots.entries()) {
    await writeSkill(path.join(root, 'shared/SKILL.md'), { name: 'shared-user', content: `body-${index}` })
    await writeSkill(path.join(root, `unique-${index}/SKILL.md`), { name: `unique-${index}` })
  }
  await writeSkill(path.join(agentsA, 'agent-fallback/SKILL.md'), { name: 'agent-fallback', content: 'agents loses' })
  await writeSkill(path.join(claudeA, 'agent-fallback/SKILL.md'), { name: 'agent-fallback', content: 'claude wins' })
  await writeSkill(path.join(agentsA, 'agents-shared/SKILL.md'), { name: 'agents-shared', content: 'first agents root' })
  await writeSkill(path.join(agentsB, 'agents-shared/SKILL.md'), { name: 'agents-shared', content: 'second agents root' })
  await writeSkill(path.join(cwd, '.opencode/skills/shared/SKILL.md'), { name: 'shared-user', content: 'project wins' })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const options = { userOpenCodeSkillRoots: [openA, openB], userAgentsSkillRoots: [agentsA, agentsB], userClaudeSkillRoots: [claudeA, claudeB] }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const direct = createProjectSkillProvider(ctx, { signal: lifetime.signal, invalidate() {} }, { ...options, projectSkillDirs: [] })
  const listed = await direct.list({})
  assert.equal(listed.complete, true)
  const expected = [246, 247, 249.5, 249.75, 248, 249]
  for (const [index, rank] of expected.entries()) {
    const candidate = listed.candidates.find(item => item.name === `unique-${index}`)
    assert.equal(candidate?.rank, rank)
    assert.equal(candidate.source, index < 2 ? 'user-opencode' : index < 4 ? 'user-agents' : 'user-claude')
  }
  const registration = registerProjectSkillProvider(ctx, options)
  t.after(() => registration.dispose())
  registry.register({ name: 'agent-fallback', description: 'runtime', provider: 'runtime', source: 'runtime', content: 'runtime loses' })
  registry.register({ name: 'unique-3', description: 'runtime', provider: 'runtime', source: 'runtime', content: 'runtime loses' })
  assert.equal((await registry.get('shared-user', { cwd })).content, 'project wins')
  assert.equal((await registry.get('shared-user', {})).content, 'body-0')
  const agent = await registry.get('agent-fallback', {})
  assert.equal(agent.content, 'claude wins')
  assert.equal(agent.source, 'user-claude')
  const overRuntime = await registry.get('unique-3', {})
  assert.equal(overRuntime.source, 'user-agents')
  assert.notEqual(overRuntime.content, 'runtime loses')
  assert.equal((await registry.get('agents-shared', {})).content, 'first agents root')
})

test('user Agents roots validate paths and reject forged locators and escaping or stale roots', async t => {
  const root = path.join(await makeWorkspace(t), 'skills')
  const other = path.join(await makeWorkspace(t), 'skills')
  const outside = await makeWorkspace(t)
  await writeSkill(path.join(root, 'good/SKILL.md'), { name: 'agent-good', content: 'safe' })
  await writeSkill(path.join(outside, 'secret/SKILL.md'), { name: 'agent-secret', content: 'secret' })
  await symlink(outside, path.join(root, 'secret'), 'dir')
  const { fs, calls } = makeFileSystem()
  const { ctx } = makeRegistry(fs)
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const control = { signal: lifetime.signal, invalidate() {} }
  for (const invalid of [['relative/skills'], ['~/skills'], ['/tmp/not-skills'], 'not-an-array']) {
    assert.throws(() => createProjectSkillProvider(ctx, control, { userAgentsSkillRoots: invalid }), /userAgentsSkillRoots|absolute|skills/u)
  }
  const provider = createProjectSkillProvider(ctx, control, { projectSkillDirs: [], userAgentsSkillRoots: [root] })
  const listed = await provider.list({})
  assert.deepEqual(listed.candidates.map(candidate => candidate.name), ['agent-good'])
  const good = listed.candidates[0]
  assert.equal((await provider.get(good, {})).content, 'safe')
  const otherProvider = createProjectSkillProvider(ctx, control, { projectSkillDirs: [], userAgentsSkillRoots: [other] })
  const before = calls.filter(call => call === 'readBytes').length
  assert.equal(await otherProvider.get(good, {}), undefined)
  assert.equal(await provider.get({ ...good, source: 'user-opencode' }, {}), undefined)
  assert.equal(await provider.get({ ...good, locator: { ...good.locator, userRoot: 'user-opencode' } }, {}), undefined)
  assert.equal(calls.filter(call => call === 'readBytes').length, before)
  await rename(root, `${root}.old`)
  await writeSkill(path.join(other, 'good/SKILL.md'), { name: 'agent-good', content: 'replacement' })
  await symlink(other, root, 'dir')
  assert.equal(await provider.get(good, {}), undefined)
})

test('project filters do not hide user Agents skills, while disabled skills affect invocation', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(await makeWorkspace(t), 'skills')
  await writeSkill(path.join(cwd, '.opencode/skills/shared/SKILL.md'), { name: 'agent-filtered', content: 'project' })
  await writeSkill(path.join(root, 'shared/SKILL.md'), { name: 'agent-filtered', content: 'user agents' })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const registration = registerProjectSkillProvider(ctx, {
    userAgentsSkillRoots: [root], enabledProjectSkills: [], disabledProjectSkills: ['agent-filtered'], disabledSkills: ['agent-filtered'],
  })
  t.after(() => registration.dispose())
  const skill = await registry.get('agent-filtered', { cwd })
  assert.equal(skill.content, 'user agents')
  assert.equal(skill.source, 'user-agents')
  assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: false })
})

test('an Agents user root watcher invalidates and reloads a changed skill', async t => {
  const root = path.join(await makeWorkspace(t), 'skills')
  const file = path.join(root, 'demo/SKILL.md')
  await writeSkill(file, { name: 'agents-watch', content: 'before' })
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const registration = registerProjectSkillProvider(ctx, { projectSkillDirs: [], userAgentsSkillRoots: [root] })
  t.after(() => registration.dispose())
  assert.equal((await registry.get('agents-watch', {})).content, 'before')
  const canonicalFile = await realpath(file)
  const fileWatchers = watchers.filter(watcher => watcher.target.targetKey === canonicalFile)
  assert.ok(fileWatchers.length > 0)
  await writeSkill(file, { name: 'agents-watch', content: 'after' })
  for (const watcher of fileWatchers) watcher.changed()
  assert.equal((await registry.get('agents-watch', {})).content, 'after')
})

test('rejects user-root symlink escape and stale file identity without reading outside content', async t => {
  const cwd = await makeWorkspace(t)
  const userRoot = path.join(await makeWorkspace(t), 'skills')
  const outside = await makeWorkspace(t)
  await writeSkill(path.join(outside, 'secret/SKILL.md'), { name: 'secret-skill', content: 'outside secret' })
  await mkdir(userRoot, { recursive: true })
  await symlink(outside, path.join(userRoot, 'secret'), 'dir')
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  registerProjectSkillProvider(ctx, { userOpenCodeSkillRoots: [userRoot] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.skills.some(skill => skill.name === 'secret-skill'), false)
  const userFile = path.join(userRoot, 'good/SKILL.md')
  await writeSkill(userFile, { name: 'good-skill', content: 'good body' })
  registry.invalidateCache()
  const listed = await registry.snapshot({ cwd })
  const good = listed.skills.find(skill => skill.name === 'good-skill')
  assert.ok(good)
  await rename(userFile, `${userFile}.old`)
  await symlink(outside, userFile, 'file')
  assert.equal(await registry.get('good-skill', { cwd }), undefined)
})

test('rejects a stale user root after an absolute-root retarget', async t => {
  const cwd = await makeWorkspace(t)
  const userRoot = path.join(await makeWorkspace(t), 'skills')
  const otherRoot = path.join(await makeWorkspace(t), 'skills')
  const filePath = path.join(userRoot, 'demo/SKILL.md')
  await writeSkill(filePath, { name: 'demo-skill', content: 'old body' })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { userOpenCodeSkillRoots: [userRoot] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.skills[0].name, 'demo-skill')
  await rm(userRoot, { recursive: true, force: true })
  await symlink(otherRoot, userRoot, 'dir')
  await writeSkill(path.join(otherRoot, 'demo/SKILL.md'), { name: 'demo-skill', content: 'new body' })
  assert.equal(await registry.get('demo-skill', { cwd }), undefined)
  provider.dispose()
})

test('watches a missing absolute user root without treating its path as cwd-relative', async t => {
  const cwd = await makeWorkspace(t)
  const parent = await makeWorkspace(t)
  const userRoot = path.join(parent, 'skills')
  const { fs, watchers } = makeFileSystem({ failMissingResolve: true })
  const { ctx, registry } = makeRegistry(fs)
  registerProjectSkillProvider(ctx, { projectSkillDirs: [], userOpenCodeSkillRoots: [userRoot] })
  const initial = await registry.snapshot({ cwd })
  assert.equal(initial.complete, true)
  const canonicalParent = await realpath(parent)
  assert.ok(watchers.some(watcher => watcher.target.targetKey === canonicalParent))
  await writeSkill(path.join(userRoot, 'demo/SKILL.md'), { name: 'demo-skill', content: 'new body' })
  for (const watcher of watchers) watcher.changed()
  const next = await registry.snapshot({ cwd })
  assert.equal(next.skills[0].name, 'demo-skill')
})

test('rejects a user locator from another provider configuration without reading it', async t => {
  const rootA = path.join(await makeWorkspace(t), 'skills')
  const rootB = path.join(await makeWorkspace(t), 'skills')
  await writeSkill(path.join(rootA, 'demo/SKILL.md'), { name: 'demo-skill', content: 'root A body' })
  const { fs, calls } = makeFileSystem()
  const { ctx } = makeRegistry(fs)
  const control = { signal: new AbortController().signal, invalidate() {} }
  const providerA = createProjectSkillProvider(ctx, control, { projectSkillDirs: [], userOpenCodeSkillRoots: [rootA] })
  const providerB = createProjectSkillProvider(ctx, control, { projectSkillDirs: [], userOpenCodeSkillRoots: [rootB] })
  const listed = await providerA.list({})
  const before = calls.filter(call => call === 'readBytes').length
  assert.equal(await providerB.get(listed.candidates[0], {}), undefined)
  assert.equal(calls.filter(call => call === 'readBytes').length, before)
})

test('configured user skills outrank runtime after project filters remove the project copy', async t => {
  const cwd = await makeWorkspace(t)
  const userRoot = path.join(await makeWorkspace(t), 'skills')
  await writeSkill(path.join(cwd, '.opencode/skills/shared/SKILL.md'), { name: 'shared-skill', content: 'project body' })
  await writeSkill(path.join(userRoot, 'shared/SKILL.md'), { name: 'shared-skill', content: 'user body' })
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  registry.register({ name: 'shared-skill', description: 'Runtime copy', provider: 'runtime', source: 'runtime', content: 'runtime body' })
  registerProjectSkillProvider(ctx, {
    userOpenCodeSkillRoots: [userRoot], enabledProjectSkills: [], disabledProjectSkills: ['shared-skill'],
  })
  assert.equal((await registry.get('shared-skill', { cwd })).content, 'user body')
})

test('invalidates an existing user root when its lexical parent replaces it with a symlink', async t => {
  const cwd = await makeWorkspace(t)
  const parent = await makeWorkspace(t)
  const userRoot = path.join(parent, 'skills')
  const otherRoot = path.join(await makeWorkspace(t), 'skills')
  await writeSkill(path.join(userRoot, 'old/SKILL.md'), { name: 'old-skill', content: 'old body' })
  await writeSkill(path.join(otherRoot, 'new/SKILL.md'), { name: 'new-skill', content: 'new body' })
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  registerProjectSkillProvider(ctx, { projectSkillDirs: [], userOpenCodeSkillRoots: [userRoot] })
  assert.equal((await registry.snapshot({})).skills[0].name, 'old-skill')
  const canonicalParent = await realpath(parent)
  const parentWatchers = watchers.filter(watcher => watcher.target.targetKey === canonicalParent)
  assert.ok(parentWatchers.length > 0)
  await rename(userRoot, `${userRoot}.old`)
  await symlink(otherRoot, userRoot, 'dir')
  for (const watcher of parentWatchers) watcher.changed()
  const next = await registry.snapshot({})
  assert.equal(next.skills.some(skill => skill.name === 'old-skill'), false)
  assert.equal(next.complete, false)
})

test('invalidates no-cwd user skills when an intermediate absolute-root symlink retargets', async t => {
  const base = await makeWorkspace(t)
  const targetA = await makeWorkspace(t)
  const targetB = await makeWorkspace(t)
  const link = path.join(base, 'config')
  const userRoot = path.join(link, 'skills')
  await writeSkill(path.join(targetA, 'skills/old/SKILL.md'), { name: 'old-skill', content: 'old body' })
  await writeSkill(path.join(targetB, 'skills/new/SKILL.md'), { name: 'new-skill', content: 'new body' })
  await symlink(targetA, link, 'dir')
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  registerProjectSkillProvider(ctx, { projectSkillDirs: [], userOpenCodeSkillRoots: [userRoot] })
  assert.equal((await registry.snapshot({})).skills[0].name, 'old-skill')
  const canonicalBase = await realpath(base)
  const lexicalWatchers = watchers.filter(watcher => watcher.target.targetKey === canonicalBase)
  assert.ok(lexicalWatchers.length > 0)
  await unlink(link)
  await symlink(targetB, link, 'dir')
  for (const watcher of lexicalWatchers) watcher.changed()
  const next = await registry.snapshot({})
  assert.equal(next.skills.some(skill => skill.name === 'old-skill'), false)
  assert.equal(next.skills.some(skill => skill.name === 'new-skill'), true)
  assert.equal(next.complete, true)
})

test('loads configured user roots independently of a stale lookup cwd', async t => {
  const userRoot = path.join(await makeWorkspace(t), 'skills')
  await writeSkill(path.join(userRoot, 'demo/SKILL.md'), { name: 'demo-skill', content: 'user body' })
  const { fs } = makeFileSystem()
  const { ctx } = makeRegistry(fs)
  const provider = createProjectSkillProvider(ctx, { signal: new AbortController().signal, invalidate() {} }, { projectSkillDirs: [], userOpenCodeSkillRoots: [userRoot] })
  const staleCwd = path.join(await makeWorkspace(t), 'missing')
  const listed = await provider.list({ cwd: staleCwd })
  assert.equal(listed.candidates[0].name, 'demo-skill')
  assert.equal((await provider.get(listed.candidates[0], { cwd: staleCwd })).content, 'user body')
})

test('isolates absolute-root anchor watch failures without rejecting the provider', async t => {
  const userRoot = path.join(await makeWorkspace(t), 'skills')
  await writeSkill(path.join(userRoot, 'demo/SKILL.md'), { name: 'demo-skill', content: 'user body' })
  const { fs } = makeFileSystem()
  const resolve = fs.resolve.bind(fs)
  fs.resolve = async (filePath, options) => {
    if (filePath === '/') {
      const error = new Error('anchor unavailable')
      error.code = 'FS_IO_ERROR'
      throw error
    }
    return resolve(filePath, options)
  }
  const { ctx } = makeRegistry(fs)
  const provider = createProjectSkillProvider(ctx, { signal: new AbortController().signal, invalidate() {} }, { projectSkillDirs: [], userOpenCodeSkillRoots: [userRoot] })
  const listed = await provider.list({})
  assert.equal(listed.complete, false)
  assert.equal(listed.candidates[0].name, 'demo-skill')
})

test('validates normalized absolute user skill roots', () => {
  assert.deepEqual(normalizeUserSkillRoots(undefined, 'userRoots'), [])
  assert.throws(() => normalizeUserSkillRoots(['.opencode/skills'], 'userRoots'), /absolute/u)
  assert.throws(() => normalizeUserSkillRoots(['~/skills'], 'userRoots'), /absolute/u)
  assert.throws(() => normalizeUserSkillRoots(['/tmp/not-skills'], 'userRoots'), /skills/u)
})

test('discovers cwd-relative OpenCode, Claude, and Agents skill roots through the DSH registry', async t => {
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
  await writeSkill(path.join(cwdA, '.agents/skills/agent-skill/SKILL.md'), {
    name: 'agent-project-skill',
    description: 'Agents-root skill',
    content: 'Agents body.',
  })
  await writeSkill(path.join(cwdA, '.agents/skills/shared/SKILL.md'), {
    name: 'shared-project-skill',
    description: 'Agents fallback',
    content: 'Agents body.',
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
  assert.deepEqual(snapshotA.skills.map(skill => skill.name).sort(), ['agent-project-skill', 'flat-project-skill', 'project-review', 'shared-project-skill'])
  const review = await registry.get('project-review', { cwd: cwdA })
  assert.equal(review.content, 'Use the project review rubric.')
  assert.deepEqual(review.invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(review.source, 'project-opencode')
  assert.equal(review.metadata.agent, 'reviewer')
  assert.deepEqual(review.metadata.tools, ['read', 'grep'])
  assert.equal((await registry.get('shared-project-skill', { cwd: cwdA })).content, 'OpenCode body.')
  const agentSkill = await registry.get('agent-project-skill', { cwd: cwdA })
  assert.equal(agentSkill.content, 'Agents body.')
  assert.equal(agentSkill.source, 'project-agents')

  const snapshotB = await registry.snapshot({ cwd: cwdB })
  assert.equal(snapshotB.complete, true)
  assert.deepEqual(snapshotB.skills.map(skill => skill.name), ['ship-project'])
  assert.equal((await registry.get('ship-project', { cwd: cwdB })).source, 'project-claude')
  assert.ok(calls.includes('resolve') && calls.includes('lstat') && calls.includes('stat') && calls.includes('listDir') && calls.includes('readBytes') && calls.includes('watch'))
  provider.dispose()
})

test('project skill enable/disable filters are provider-scoped with exact list semantics', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/allowed/SKILL.md'), { name: 'allowed-project-skill', content: 'Allowed project skill.' })
  await writeSkill(path.join(cwd, '.opencode/skills/blocked/SKILL.md'), { name: 'blocked-project-skill', content: 'Blocked project skill.' })
  const { fs, watchers, calls } = makeFileSystem()
  const ctx = { fs, logger: { warn() {} } }
  const lifetime = new AbortController()
  const control = { signal: lifetime.signal, invalidate() {} }
  const unrestricted = createProjectSkillProvider(ctx, control, { projectSkillDirs: ['.opencode/skills'] })
  const all = await unrestricted.list({ cwd })
  assert.equal(all.complete, true)
  assert.deepEqual(all.candidates.map(candidate => candidate.name).sort(), ['allowed-project-skill', 'blocked-project-skill'])
  const nullUnrestricted = createProjectSkillProvider(ctx, control, {
    projectSkillDirs: ['.opencode/skills'],
    enabledProjectSkills: null,
  })
  const nullList = await nullUnrestricted.list({ cwd })
  assert.deepEqual(nullList.candidates.map(candidate => candidate.name).sort(), ['allowed-project-skill', 'blocked-project-skill'])
  const nullCandidate = nullList.candidates.find(candidate => candidate.name === 'allowed-project-skill')
  assert.equal((await nullUnrestricted.get(nullCandidate, { cwd })).content, 'Allowed project skill.')
  const blockedCandidate = all.candidates.find(candidate => candidate.name === 'blocked-project-skill')

  const allowlisted = createProjectSkillProvider(ctx, control, {
    projectSkillDirs: ['.opencode/skills'],
    enabledProjectSkills: ['allowed-project-skill'],
  })
  const filtered = await allowlisted.list({ cwd })
  assert.equal(filtered.complete, true)
  assert.deepEqual(filtered.candidates.map(candidate => candidate.name), ['allowed-project-skill'])
  assert.equal((await allowlisted.get(filtered.candidates[0], { cwd })).content, 'Allowed project skill.')
  const denylisted = createProjectSkillProvider(ctx, control, {
    projectSkillDirs: ['.opencode/skills'],
    disabledProjectSkills: ['blocked-project-skill'],
  })
  const denied = await denylisted.list({ cwd })
  assert.deepEqual(denied.candidates.map(candidate => candidate.name), ['allowed-project-skill'])
  assert.equal(await denylisted.get(blockedCandidate, { cwd }), undefined)

  const { ctx: registryCtx, registry } = makeRegistry(fs)
  registry.register({
    name: 'blocked-project-skill',
    description: 'External runtime copy',
    provider: 'other-plugin',
    source: 'custom',
    content: 'External runtime skill.',
  })
  const registeredFilters = registerProjectSkillProvider(registryCtx, {
    projectSkillDirs: ['.opencode/skills'],
    enabledProjectSkills: ['allowed-project-skill', 'blocked-project-skill'],
    disabledProjectSkills: ['blocked-project-skill'],
  })
  const registryView = await registry.snapshot({ cwd })
  assert.deepEqual(registryView.skills.map(skill => skill.name).sort(), ['allowed-project-skill', 'blocked-project-skill'])
  assert.equal((await registry.get('blocked-project-skill', { cwd })).provider, 'other-plugin', 'other providers remain visible when the project candidate is filtered')
  registeredFilters.dispose()
  assert.equal(await allowlisted.get(blockedCandidate, { cwd }), undefined, 'stale/direct candidates outside the allowlist cannot load')

  const allowNone = createProjectSkillProvider(ctx, control, {
    projectSkillDirs: ['.opencode/skills'],
    enabledProjectSkills: [],
  })
  const readsBeforeEmptyList = calls.filter(call => call === 'readBytes').length
  const empty = await allowNone.list({ cwd })
  assert.equal(calls.filter(call => call === 'readBytes').length - readsBeforeEmptyList, 2, 'the allowlist filters visibility after frontmatter scanning')
  assert.equal(empty.complete, true)
  assert.deepEqual(empty.candidates, [])
  assert.equal(await allowNone.get(all.candidates[0], { cwd }), undefined)

  lifetime.abort()
  assert.ok(watchers.length > 0)
  assert.ok(watchers.every(watcher => watcher.closed))
})

test('deduplicates concurrent watcher initialization and bounds live handles', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'concurrent-skill' })
  const { fs, watchers, watchCalls, watchStarted, releaseWatch, waitForResolveCount } = makeFileSystem({ delayWatch: true })
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'] })

  const first = provider.list({ cwd })
  const second = provider.list({ cwd })
  await watchStarted
  await waitForResolveCount('.', 2)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(watchCalls.length, 1)
  assert.equal(watchCalls[0].target.targetKey, await realpath(cwd))
  releaseWatch()
  const observations = await Promise.all([first, second])
  assert.ok(observations.every(observation => observation.complete))
  assert.equal(watchers.length, 5)
  lifetime.abort()
  assert.ok(watchers.every(watcher => watcher.closed))
})

test('canceling one lookup does not cancel another lookup shared on watcher initialization', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'shared-cancel-skill' })
  const { fs, watchers, watchCalls, watchStarted, releaseWatch, waitForResolveCount } = makeFileSystem({ delayWatch: true })
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
  await waitForResolveCount('.', 2)
  await new Promise(resolve => setImmediate(resolve))
  firstCaller.abort(new Error('first lookup cancelled'))
  await assert.rejects(first, /first lookup cancelled/u)
  assert.equal(watchCalls[0].signal.aborted, false)
  releaseWatch()
  const observation = await second
  assert.equal(observation.complete, true)
  assert.equal(watchers.length, 5)
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
  const { fs, watchCalls, watchStarted, releaseWatch, waitForResolveCount } = makeFileSystem({
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
  await waitForResolveCount('.', 2)
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
  const { fs, watchCalls, disposeStarted, releaseDispose } = makeFileSystem({ watchErrorDuringInit: target => target.targetKey.endsWith(`${path.sep}first${path.sep}SKILL.md`), delayDispose: true })
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 6 })

  const firstListing = provider.list({ cwd: firstCwd })
  await disposeStarted
  const secondObservation = await provider.list({ cwd: secondCwd })
  assert.equal(secondObservation.complete, false)
  assert.equal(watchCalls.length, 6)
  releaseDispose()
  await firstListing
  lifetime.abort()
})

test('retains watcher capacity when an uninstalled handle refuses disposal', async t => {
  const firstCwd = await makeWorkspace(t)
  const secondCwd = await makeWorkspace(t)
  await writeSkill(path.join(firstCwd, '.opencode/skills/first/SKILL.md'), { name: 'uninstalled-first' })
  await writeSkill(path.join(secondCwd, '.opencode/skills/second/SKILL.md'), { name: 'uninstalled-second' })
  const { fs, watchCalls, watchers } = makeFileSystem({ watchErrorDuringInit: target => target.targetKey.endsWith(`${path.sep}first${path.sep}SKILL.md`), failDispose: true })
  const lifetime = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal,
    invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 5 })

  await provider.list({ cwd: firstCwd })
  assert.equal(watchCalls.length, 5)
  assert.equal(watchers[4].closed, false)
  await provider.list({ cwd: secondCwd })
  assert.equal(watchCalls.length, 5)
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

test('watches the last existing parent across missing skill-root component races', async t => {
  for (const mode of ['lstat-missing', 'resolve-missing', 'stat-missing']) {
    const cwd = await makeWorkspace(t)
    const targetA = path.join(cwd, 'skill-target-a')
    const targetB = path.join(cwd, 'skill-target-b')
    const canonicalCwd = await realpath(cwd)
    const symlinkPath = path.join(canonicalCwd, '.opencode')
    await writeSkill(path.join(targetA, 'skills/race-a/SKILL.md'), { name: 'race-a' })
    await writeSkill(path.join(targetB, 'skills/race-b/SKILL.md'), { name: 'race-b' })

    const { fs, watchers } = makeFileSystem({ failMissingResolve: mode === 'resolve-missing' })
    let injected = false
    if (mode === 'lstat-missing') {
      const originalLstat = fs.lstat
      fs.lstat = async (filePath, options, signal) => {
        const info = await originalLstat(filePath, options, signal)
        if (!injected && filePath === '.opencode' && info === undefined) {
          injected = true
          await symlink(targetA, symlinkPath)
        }
        return info
      }
    } else if (mode === 'resolve-missing') {
      const originalLstat = fs.lstat
      fs.lstat = async (filePath, options, signal) => {
        const info = await originalLstat(filePath, options, signal)
        if (!injected && filePath === '.opencode' && info === undefined) {
          return { type: 'directory', size: 0, version: 'race-injection' }
        }
        return info
      }
      const originalResolve = fs.resolve
      fs.resolve = async (filePath, options) => {
        try {
          return await originalResolve(filePath, options)
        } catch (error) {
          if (!injected && filePath === '.opencode' && error?.code === 'FS_NOT_FOUND') {
            injected = true
            await symlink(targetA, symlinkPath)
          }
          throw error
        }
      }
    } else {
      await mkdir(symlinkPath)
      const originalStat = fs.stat
      fs.stat = async (target, signal) => {
        if (!injected && path.resolve(target.targetKey) === path.resolve(symlinkPath)) {
          injected = true
          await rm(symlinkPath, { recursive: true, force: true })
          await symlink(targetA, symlinkPath)
          return undefined
        }
        return originalStat(target, signal)
      }
    }

    const { ctx, registry } = makeRegistry(fs)
    const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 5 })
    const first = await registry.snapshot({ cwd })
    assert.equal(injected, true, `${mode}: race injection should run`)
    assert.equal(first.complete, true, `${mode}: watching should keep discovery complete`)
    assert.deepEqual(first.skills.map(skill => skill.name), ['race-a'], `${mode}: initial target should be discovered`)

    const parentWatcher = watchers.find(watcher => watcher.target.displayPath === canonicalCwd)
    assert.ok(parentWatcher, `${mode}: last existing parent should be watched`)
    await unlink(symlinkPath)
    await symlink(targetB, symlinkPath)
    parentWatcher.changed()

    const second = await registry.snapshot({ cwd })
    assert.equal(second.complete, true, `${mode}: retarget should recover capacity`)
    assert.deepEqual(second.skills.map(skill => skill.name), ['race-b'], `${mode}: retarget should refresh the catalog`)
    provider.dispose()
  }
})

test('observes an intermediate component replaced by a symlink between lstat and resolve', async t => {
  const cwd = await makeWorkspace(t)
  const link = path.join(cwd, '.opencode')
  const targetA = path.join(cwd, 'config-a')
  const targetB = path.join(cwd, 'config-b')
  await mkdir(link)
  await writeSkill(path.join(targetA, 'skills/old/SKILL.md'), { name: 'race-old', content: 'Old body.' })
  await writeSkill(path.join(targetB, 'skills/new/SKILL.md'), { name: 'race-new', content: 'New body.' })

  const { fs, watchers, calls } = makeFileSystem()
  const originalLstat = fs.lstat
  let injected = false
  fs.lstat = async (filePath, options, signal) => {
    const info = await originalLstat(filePath, options, signal)
    if (!injected && filePath === '.opencode') {
      assert.equal(info?.type, 'directory')
      injected = true
      await rename(link, path.join(cwd, 'original-directory'))
      await symlink(targetA, link)
    }
    return info
  }
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  t.after(() => provider.dispose())

  const raced = await registry.snapshot({ cwd })
  assert.equal(injected, true)
  // A conservative implementation may reject the raced scan and retry it.
  const initial = raced.complete ? raced : await registry.snapshot({ cwd })
  assert.equal(initial.complete, true)
  assert.deepEqual(initial.skills.map(skill => skill.name), ['race-old'])
  assert.equal((await registry.get('race-old', { cwd })).content, 'Old body.')
  const readsBeforeCachedSnapshot = calls.filter(call => call === 'listDir').length
  await registry.snapshot({ cwd })
  assert.equal(calls.filter(call => call === 'listDir').length, readsBeforeCachedSnapshot, 'complete initial snapshot is cached')

  const parentPath = await realpath(cwd)
  const parent = watchers.find(watcher => watcher.target.targetKey === parentPath && !watcher.closed)
  await unlink(link)
  await symlink(targetB, link)
  // Only a live watcher on the lexical parent receives the retarget event.
  parent?.changed()
  const updated = await registry.snapshot({ cwd })
  const loaded = await registry.get('race-new', { cwd })
  assert.deepEqual({
    parentWatched: Boolean(parent),
    complete: updated.complete,
    names: updated.skills.map(skill => skill.name),
    content: loaded?.content,
  }, {
    parentWatched: true,
    complete: true,
    names: ['race-new'],
    content: 'New body.',
  }, 'a cacheable observation must watch the lexical parent and invalidate on retarget')
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

test('reclaims a missing-root ancestor watcher after the root appears', async t => {
  const cwd = await makeWorkspace(t)
  const { fs, watchers } = makeFileSystem({ failMissingResolve: true })
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 5 })
  t.after(() => provider.dispose())
  assert.equal((await registry.snapshot({ cwd })).complete, true)
  const canonicalCwd = await realpath(cwd)
  const ancestor = watchers.find(watcher => watcher.target.targetKey === canonicalCwd)
  assert.ok(ancestor)
  await writeSkill(path.join(cwd, '.opencode/skills/new/SKILL.md'), { name: 'new-skill' })
  ancestor.changed()
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['new-skill'])
})

test('reestablishes shared missing-root and symlink-parent observation after reclamation', async t => {
  const cwd = await makeWorkspace(t)
  const firstRoot = path.join(cwd, 'first')
  const secondRoot = path.join(cwd, 'second')
  await writeSkill(path.join(firstRoot, 'skills/a/SKILL.md'), { name: 'first-skill' })
  await writeSkill(path.join(secondRoot, 'skills/b/SKILL.md'), { name: 'second-skill' })
  await symlink(firstRoot, path.join(cwd, 'link'))
  const { fs, watchers } = makeFileSystem({ failMissingResolve: true })
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['link/skills', 'missing/skills'] })
  t.after(() => provider.dispose())
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['first-skill'])
  const parent = await realpath(cwd)
  const oldWatcher = watchers.find(watcher => watcher.target.targetKey === parent && !watcher.closed)
  await writeSkill(path.join(cwd, 'missing/skills/c/SKILL.md'), { name: 'third-skill' })
  oldWatcher.changed()
  assert.equal(oldWatcher.closed, true)
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['first-skill', 'third-skill'])
  const newWatcher = watchers.find(watcher => watcher.target.targetKey === parent && !watcher.closed)
  assert.ok(newWatcher)
  await unlink(path.join(cwd, 'link'))
  await symlink(secondRoot, path.join(cwd, 'link'))
  newWatcher.changed()
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['second-skill', 'third-skill'])
})

test('retired missing-root handles cannot make concurrent scans cacheable', async t => {
  const cwd = await makeWorkspace(t)
  const { fs, watchers } = makeFileSystem({ failMissingResolve: true })
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, { signal: lifetime.signal, invalidate() {} }, { projectSkillDirs: ['missing/skills'] })
  assert.equal((await provider.list({ cwd })).complete, true)
  const originalResolve = fs.resolve
  let release
  let started
  const entered = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  fs.resolve = async (filePath, options) => {
    if (filePath === 'missing/skills') { started(); await gate }
    return originalResolve(filePath, options)
  }
  const scan = provider.list({ cwd })
  await entered
  await mkdir(path.join(cwd, 'missing/skills'), { recursive: true })
  watchers[0].changed()
  release()
  assert.equal((await scan).complete, false)
  assert.equal((await provider.list({ cwd })).complete, true)
})

test('reclaims an ancestor event delivered during watch initialization', async t => {
  const cwd = await makeWorkspace(t)
  const { fs, watchers } = makeFileSystem({ failMissingResolve: true })
  const originalWatch = fs.watch
  let first = true
  fs.watch = async (target, changed, signal) => {
    if (first) { first = false; changed() }
    return originalWatch(target, changed, signal)
  }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, { signal: lifetime.signal, invalidate() {} }, { projectSkillDirs: ['missing/skills'], watcherLimit: 1 })
  assert.equal((await provider.list({ cwd })).complete, false)
  assert.ok(watchers.every(watcher => watcher.closed))
  assert.equal((await provider.list({ cwd })).complete, true)
})

test('counts a reclaimed ancestor until asynchronous disposal settles or fails', async t => {
  for (const failDispose of [false, true]) {
    const cwd = await makeWorkspace(t)
    const { fs, watchers, watchCalls, releaseDispose } = makeFileSystem({ failMissingResolve: true, delayDispose: true, failDispose })
    const lifetime = new AbortController()
    t.after(() => lifetime.abort())
    const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, { signal: lifetime.signal, invalidate() {} }, { projectSkillDirs: ['missing/skills'], watcherLimit: 3 })
    await provider.list({ cwd })
    await mkdir(path.join(cwd, 'missing/skills'), { recursive: true })
    watchers[0].changed()
    assert.equal((await provider.list({ cwd })).complete, false)
    assert.equal(watchCalls.length, 3)
    releaseDispose()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await provider.list({ cwd })).complete, !failDispose)
    assert.equal(watchCalls.length, failDispose ? 3 : 4)
  }
})

test('ordinary watcher events make a concurrent provider observation incomplete', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await mkdir(root, { recursive: true })
  const { fs, watchers } = makeFileSystem()
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'] })
  assert.equal((await provider.list({ cwd })).complete, true)
  const rootTarget = await realpath(root)
  const originalList = fs.listDir
  let notify
  let resume
  const entered = new Promise(resolve => { notify = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  fs.listDir = async (target, signal) => {
    const entries = await originalList(target, signal)
    if (target.targetKey === rootTarget) { notify(); await gate }
    return entries
  }
  const stale = provider.list({ cwd })
  await entered
  await writeSkill(path.join(root, 'new/SKILL.md'), { name: 'new-observed-skill' })
  const rootWatcher = watchers.find(watcher => watcher.target.targetKey === rootTarget && !watcher.closed)
  assert.ok(rootWatcher)
  rootWatcher.changed()
  resume()
  assert.equal((await stale).complete, false)
  assert.equal(rootWatcher.closed, true, 'directory changes conservatively retire potentially stale descendants')
  fs.listDir = originalList
  assert.deepEqual((await provider.list({ cwd })).candidates.map(candidate => candidate.name), ['new-observed-skill'])
})

test('rebinds inode-bound watches after a skill path is recreated', async t => {
  for (const kind of ['root', 'directory', 'file']) {
    await t.test(kind, async t => {
      const cwd = await realpath(await makeWorkspace(t))
      const root = path.join(cwd, '.opencode/skills')
      const directory = path.join(root, 'review')
      const file = path.join(directory, 'SKILL.md')
      await writeSkill(file, { name: 'inode-skill', description: 'Original' })
      const { fs, watchers, calls } = makeFileSystem()
      const originalWatch = fs.watch
      fs.watch = async (target, changed, signal) => {
        const { dev, ino } = await stat(target.targetKey)
        const dispose = await originalWatch(target, changed, signal)
        const watcher = watchers.find(entry => entry.target === target && entry.changed === changed)
        assert.ok(watcher)
        watcher.identity = `${dev}:${ino}`
        return dispose
      }
      // Events are delivered only to handles bound to the current inode, not
      // stale handles whose original object was renamed away from this path.
      const emit = async targetPath => {
        const { dev, ino } = await stat(targetPath)
        const identity = `${dev}:${ino}`
        const recipients = watchers.filter(watcher => !watcher.closed && watcher.target.targetKey === targetPath && watcher.identity === identity)
        for (const watcher of recipients) watcher.changed()
        return recipients.length
      }
      const { ctx, registry } = makeRegistry(fs)
      const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
      t.after(() => provider.dispose())
      const initial = await registry.snapshot({ cwd })
      assert.equal(initial.complete, true)
      assert.equal(initial.skills[0].description, 'Original')
      const replaced = kind === 'root' ? root : kind === 'directory' ? directory : file
      const parent = kind === 'root' ? path.dirname(root) : kind === 'directory' ? root : directory
      const oldIdentity = watchers.find(watcher => watcher.target.targetKey === replaced && !watcher.closed)?.identity
      assert.ok(oldIdentity, 'the original path has a watch')
      await rename(replaced, path.join(cwd, `old-${kind}`))
      await writeSkill(file, { name: 'inode-skill', description: 'Recreated' })
      const newStat = await stat(replaced)
      assert.notEqual(`${newStat.dev}:${newStat.ino}`, oldIdentity)
      assert.equal(await emit(parent), 1, 'the unchanged parent receives the replacement event')
      const recreated = await registry.snapshot({ cwd })
      assert.equal(recreated.complete, true)
      assert.equal(recreated.skills[0].description, 'Recreated')
      const reads = calls.filter(call => call === 'listDir').length
      await registry.snapshot({ cwd })
      assert.equal(calls.filter(call => call === 'listDir').length, reads, 'the rebuilt snapshot is cached')
      await writeSkill(file, { name: 'inode-skill', description: 'Changed after recreation' })
      const recipients = await emit(file)
      assert.equal(recipients, 1, 'the recreated file has a current-inode watcher')
      const updated = await registry.snapshot({ cwd })
      assert.equal(updated.skills[0].description, 'Changed after recreation',
        `${kind}: subsequent event must invalidate the cached snapshot (delivered to ${recipients} current-inode handles)`)
    })
  }
})

test('refresh rebinds inode-bound watches after a missed replacement event', async t => {
  for (const kind of ['root', 'directory', 'file']) {
    await t.test(kind, async t => {
      const cwd = await realpath(await makeWorkspace(t))
      const root = path.join(cwd, '.opencode/skills')
      const directory = path.join(root, 'review')
      const file = path.join(directory, 'SKILL.md')
      await writeSkill(file, { name: 'inode-skill', description: 'Original' })
      const { fs, watchers, calls } = makeFileSystem()
      const watch = fs.watch
      fs.watch = async (target, changed, signal) => {
        const { dev, ino } = await stat(target.targetKey)
        const dispose = await watch(target, changed, signal)
        const watcher = watchers.find(entry => entry.target === target && entry.changed === changed)
        watcher.identity = `${dev}:${ino}`
        return dispose
      }
      const { ctx, registry } = makeRegistry(fs)
      const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
      t.after(() => provider.dispose())
      assert.equal((await registry.snapshot({ cwd })).complete, true)
      const replaced = kind === 'root' ? root : kind === 'directory' ? directory : file
      await rename(replaced, path.join(cwd, `old-${kind}`))
      await writeSkill(file, { name: 'inode-skill', description: 'Recreated' })
      // Deliberately omit the replacement notification, then refresh manually.
      provider.refresh()
      let snapshot = await registry.snapshot({ cwd })
      if (!snapshot.complete) snapshot = await registry.snapshot({ cwd })
      assert.equal(snapshot.complete, true)
      assert.equal(snapshot.skills[0].description, 'Recreated')
      const count = calls.filter(call => call === 'listDir').length
      await registry.snapshot({ cwd })
      assert.equal(calls.filter(call => call === 'listDir').length, count)
      await writeSkill(file, { name: 'inode-skill', description: 'Changed again' })
      const { dev, ino } = await stat(file)
      const active = watchers.filter(watcher => !watcher.closed && watcher.target.targetKey === file && watcher.identity === `${dev}:${ino}`)
      assert.equal(active.length, 1, 'replacement file has an active watch bound to its inode')
      active[0].changed()
      assert.equal((await registry.snapshot({ cwd })).skills[0].description, 'Changed again')
    })
  }
})

test('refresh reserves capacity while watcher disposal is delayed or fails', async t => {
  for (const failDispose of [false, true]) {
    await t.test(failDispose ? 'failed close' : 'delayed close', async t => {
      const cwd = await makeWorkspace(t)
      await writeSkill(path.join(cwd, '.opencode/skills/review/SKILL.md'), { name: 'refresh-capacity' })
      const { fs, watchers, watchCalls, disposeStarted, releaseDispose } = makeFileSystem({ delayDispose: true, failDispose })
      const lifetime = new AbortController()
      t.after(() => { releaseDispose(); lifetime.abort() })
      const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
        signal: lifetime.signal, invalidate() {},
      }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 5 })
      assert.equal((await provider.list({ cwd })).complete, true)
      assert.equal(watchCalls.length, 5)
      provider.refresh()
      provider.refresh()
      await disposeStarted
      assert.equal((await provider.list({ cwd })).complete, false)
      assert.equal(watchCalls.length, 5, 'closing handles retain capacity')
      releaseDispose()
      await new Promise(resolve => setImmediate(resolve))
      if (failDispose) {
        assert.equal((await provider.list({ cwd })).complete, false)
        assert.equal(watchCalls.length, 5, 'failed close remains charged')
      } else {
        assert.ok(watchers.slice(0, 5).every(watcher => watcher.closed))
        assert.equal((await provider.list({ cwd })).complete, true)
        assert.equal(watchCalls.length, 10)
      }
    })
  }
})

test('a file event retires only its watcher, not another workspace', async t => {
  const firstCwd = await makeWorkspace(t)
  const secondCwd = await makeWorkspace(t)
  const firstFile = path.join(firstCwd, '.opencode/skills/one/SKILL.md')
  const secondFile = path.join(secondCwd, '.opencode/skills/two/SKILL.md')
  await writeSkill(firstFile, { name: 'first-file-event' })
  await writeSkill(secondFile, { name: 'second-file-event' })
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'] })
  t.after(() => provider.dispose())
  assert.equal((await registry.snapshot({ cwd: firstCwd })).complete, true)
  assert.equal((await registry.snapshot({ cwd: secondCwd })).complete, true)
  const firstTarget = await realpath(firstFile)
  const secondTarget = await realpath(secondFile)
  const first = watchers.find(watcher => watcher.target.targetKey === firstTarget && !watcher.closed)
  const second = watchers.find(watcher => watcher.target.targetKey === secondTarget && !watcher.closed)
  assert.ok(first && second)
  first.changed()
  assert.equal(first.closed, true)
  assert.equal(second.closed, false)
  assert.equal((await registry.snapshot({ cwd: firstCwd })).complete, true)
  assert.ok(watchers.some(watcher => watcher !== first && watcher.target.targetKey === firstTarget && !watcher.closed))
})

test('direct provider normalizes disabledSkills for native registry list and get', async t => {
  const cwd = await makeWorkspace(t)
  for (const name of ['ops-skill', 'other-skill']) {
    await writeSkill(path.join(cwd, `.opencode/skills/${name}/SKILL.md`), { name })
  }
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { disabledSkills: ['OpS-SkIlL', 'OPS-SKILL'] })
  const list = await registry.list({ cwd })
  assert.deepEqual(list.map(skill => skill.name), ['ops-skill', 'other-skill'])
  for (const skill of list) {
    const expected = skill.name !== 'ops-skill'
    assert.deepEqual(skill.invocation, { modelInvocable: expected, userInvocable: expected })
    assert.deepEqual((await registry.get(skill.name, { cwd })).invocation, skill.invocation)
  }
  provider.dispose()
})

test('direct provider rejects invalid disabledSkills before scanning', () => {
  const { ctx } = makeRegistry(makeFileSystem().fs)
  for (const invalid of ['', ' bad', 'bad ', 'a/b', 'a\\b', 'a_b', 'a--b', 'K', 'İ']) {
    assert.throws(() => registerProjectSkillProvider(ctx, { disabledSkills: [invalid] }), /disabledSkills/u, invalid)
  }
  assert.throws(() => registerProjectSkillProvider(ctx, { disabledSkills: Array(257).fill('a') }), /disabledSkills/u)
  // Host isSkillName has no name-length limit; retain previously valid long names.
  const provider = registerProjectSkillProvider(ctx, { disabledSkills: ['A'.repeat(257)] })
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

test('reclaims stale watchers across repeated root symlink retargets at exact capacity', async t => {
  const cwd = await makeWorkspace(t)
  const roots = ['a', 'b', 'c'].map(name => path.join(cwd, `skills-${name}`))
  const lexicalRoot = path.join(cwd, '.opencode/skills')
  for (const [index, root] of roots.entries()) {
    await writeSkill(path.join(root, 'skill/SKILL.md'), { name: `redirect-${index}`, content: `Target ${index} body.` })
  }
  await mkdir(path.dirname(lexicalRoot), { recursive: true })
  await symlink(roots[0], lexicalRoot)
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  // One watcher each for cwd, the symlink parent, target root, skill directory, and skill file.
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 5 })
  t.after(() => provider.dispose())
  const parentPath = await realpath(path.dirname(lexicalRoot))

  for (const [index, root] of roots.entries()) {
    if (index > 0) {
      const parent = watchers.find(watcher => watcher.target.targetKey === parentPath && !watcher.closed)
      assert.ok(parent, `target ${index}: symlink parent is watched`)
      await unlink(lexicalRoot)
      await symlink(root, lexicalRoot)
      parent.changed()
    }
    const snapshot = await registry.snapshot({ cwd })
    assert.equal(snapshot.complete, true, `target ${index}: snapshot is complete at exact watcher capacity`)
    assert.deepEqual(snapshot.skills.map(skill => skill.name), [`redirect-${index}`])
    assert.equal((await registry.get(`redirect-${index}`, { cwd })).content, `Target ${index} body.`)
    const expected = [await realpath(cwd), parentPath, await realpath(root), await realpath(path.join(root, 'skill')), await realpath(path.join(root, 'skill/SKILL.md'))].sort()
    assert.deepEqual(watchers.filter(watcher => !watcher.closed).map(watcher => watcher.target.targetKey).sort(), expected)
    for (const previous of roots.slice(0, index)) {
      const previousPaths = [await realpath(previous), await realpath(path.join(previous, 'skill')), await realpath(path.join(previous, 'skill/SKILL.md'))]
      for (const previousPath of previousPaths) {
        const stale = watchers.filter(watcher => watcher.target.targetKey === previousPath)
        assert.ok(stale.length > 0, `previous target ${previousPath} was watched`)
        assert.ok(stale.every(watcher => watcher.closed), `previous target ${previousPath} is closed`)
      }
    }
  }
})

test('a stale scan cannot recreate old-target watchers after a symlink reset', async t => {
  const cwd = await makeWorkspace(t)
  const firstRoot = path.join(cwd, 'old-root')
  const secondRoot = path.join(cwd, 'new-root')
  const link = path.join(cwd, '.opencode/skills')
  await mkdir(firstRoot)
  await mkdir(secondRoot)
  await mkdir(path.dirname(link), { recursive: true })
  await symlink(firstRoot, link)
  const { fs, watchers } = makeFileSystem()
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 3 })
  assert.equal((await provider.list({ cwd })).complete, true)
  let resume
  let notify
  const gate = new Promise(resolve => { resume = resolve })
  const blocked = new Promise(resolve => { notify = resolve })
  const originalResolve = fs.resolve
  fs.resolve = async (filePath, options) => {
    const target = await originalResolve(filePath, options)
    if (filePath === '.opencode/skills') { notify(); await gate }
    return target
  }
  const stale = provider.list({ cwd })
  await blocked
  await unlink(link)
  await symlink(secondRoot, link)
  const parentPath = await realpath(path.dirname(link))
  const oldTarget = await realpath(firstRoot)
  const parent = watchers.find(watcher => watcher.target.targetKey === parentPath && !watcher.closed)
  assert.ok(parent)
  parent.changed()
  resume()
  assert.equal((await stale).complete, false)
  assert.equal(watchers.some(watcher => watcher.target.targetKey === oldTarget && !watcher.closed), false)
  fs.resolve = originalResolve
  assert.equal((await provider.list({ cwd })).complete, true)
})

test('symlink reset retains capacity for a late watcher ignoring abort', async t => {
  const cwd = await makeWorkspace(t)
  const firstRoot = path.join(cwd, 'old-target')
  const secondRoot = path.join(cwd, 'new-target')
  const link = path.join(cwd, '.opencode/skills')
  await mkdir(firstRoot)
  await mkdir(secondRoot)
  await mkdir(path.dirname(link), { recursive: true })
  await symlink(firstRoot, link)
  const { fs, watchers, watchCalls } = makeFileSystem()
  const oldTarget = await realpath(firstRoot)
  const originalWatch = fs.watch
  let release
  let notify
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { notify = resolve })
  fs.watch = async (target, changed, signal) => {
    if (target.targetKey !== oldTarget) return originalWatch(target, changed, signal)
    notify()
    await gate
    // Simulate a backend that accepted the operation but ignored cancellation.
    return originalWatch(target, changed, new AbortController().signal)
  }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 3 })
  const first = provider.list({ cwd })
  await entered
  await unlink(link)
  await symlink(secondRoot, link)
  const parentPath = await realpath(path.dirname(link))
  const parent = watchers.find(watcher => watcher.target.targetKey === parentPath && !watcher.closed)
  assert.ok(parent)
  parent.changed()
  assert.equal((await provider.list({ cwd })).complete, false)
  const newTarget = await realpath(secondRoot)
  assert.equal(watchCalls.filter(call => call.target.targetKey === newTarget).length, 0)
  release()
  assert.equal((await first).complete, false)
  assert.ok(watchers.filter(watcher => watcher.target.targetKey === oldTarget).every(watcher => watcher.closed))
  assert.equal((await provider.list({ cwd })).complete, true)
})

test('refresh retires an acquisition that ignores abort without freeing its reservation', async t => {
  const cwd = await realpath(await makeWorkspace(t))
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'review/SKILL.md'), { name: 'pending-refresh' })
  const { fs, watchers, watchCalls } = makeFileSystem()
  const originalWatch = fs.watch
  let release
  let notify
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { notify = resolve })
  let blocked = false
  fs.watch = async (target, changed, signal) => {
    if (target.targetKey !== root || blocked) return originalWatch(target, changed, signal)
    blocked = true
    notify()
    await gate
    return originalWatch(target, changed, new AbortController().signal)
  }
  const lifetime = new AbortController()
  t.after(() => { release(); lifetime.abort() })
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], watcherLimit: 3 })
  const first = provider.list({ cwd })
  await entered
  provider.refresh()
  assert.equal((await provider.list({ cwd })).complete, false)
  assert.equal(watchCalls.filter(call => call.target.targetKey === root).length, 0)
  release()
  assert.equal((await first).complete, false)
  assert.ok(watchers.filter(watcher => watcher.target.targetKey === root).every(watcher => watcher.closed))
  // Allow the retired watch's finally block to release its reservation.
  await new Promise(resolve => setImmediate(resolve))
  // A full skill scan needs more than three watches; verify fresh acquisition, not completeness.
  await provider.list({ cwd })
  assert.ok(watchers.some(watcher => watcher.target.targetKey === root && !watcher.closed))
})

test('symlink reset invalidates and rebuilds watchers for other workspace caches', async t => {
  const firstCwd = await makeWorkspace(t)
  const secondCwd = await makeWorkspace(t)
  for (const cwd of [firstCwd, secondCwd]) {
    await mkdir(path.join(cwd, 'actual'))
    await symlink(path.join(cwd, 'actual'), path.join(cwd, 'link'))
  }
  const { fs, watchers } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['link'], watcherLimit: 4 })
  t.after(() => provider.dispose())
  assert.equal((await registry.snapshot({ cwd: firstCwd })).complete, true)
  assert.equal((await registry.snapshot({ cwd: secondCwd })).complete, true)
  const firstParentPath = await realpath(firstCwd)
  const firstParent = watchers.find(watcher => watcher.target.targetKey === firstParentPath && !watcher.closed)
  assert.ok(firstParent)
  firstParent.changed()
  assert.ok(watchers.every(watcher => watcher.closed))
  const second = await registry.snapshot({ cwd: secondCwd })
  assert.equal(second.complete, true)
  const secondParent = await realpath(secondCwd)
  assert.ok(watchers.some(watcher => watcher.target.targetKey === secondParent && !watcher.closed))
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
  const defaultRoots = ['.opencode/skills', '.opencode/skill', '.claude/skills', '.agents/skills']
  assert.deepEqual(normalizeProjectSkillDirs(), defaultRoots)
  assert.deepEqual(normalizeProjectSkillDirs(defaultRoots), defaultRoots)
  assert.throws(() => normalizeProjectSkillDirs(['../outside']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['/tmp/skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['C:\\skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['https://example.test/skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(['~/.config/opencode/skills']), /stay relative/)
  assert.throws(() => normalizeProjectSkillDirs(Array.from({ length: 17 }, (_, index) => `root-${index}`)), /at most 16/)
})

async function writeCompatibilityDocument(cwd, relativePath, source) {
  const target = path.join(cwd, '.opencode/skills', relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, source, 'utf8')
  return target
}

function compatibilityRegistry(t, fs, options = {}) {
  const fixture = makeRegistry(fs)
  const provider = registerProjectSkillProvider(fixture.ctx, {
    projectSkillDirs: ['.opencode/skills'], formatCompatibility: true, ...options,
  })
  t.after(() => provider.dispose())
  return { ...fixture, provider }
}

test('format compatibility prioritizes directory candidates within each root through native SkillRegistry', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  const laterRoot = path.join(cwd, '.claude/skills')
  const documents = [
    ['first.md', 'shared', 'flat first'], ['second.md', 'shared', 'flat second'],
    ['dir-a/SKILL.md', 'shared', 'directory a canonical'], ['dir-a/dir-a.md', 'shared', 'directory a named'],
    ['dir-b/dir-b.md', 'shared', 'directory b named'],
    ['fallback.md', 'fallback', 'flat fallback'], ['fallback/SKILL.md', 'invalid/name', 'invalid directory'],
    ['rank.md', 'ranked', 'earlier root flat'],
  ]
  for (const [relative, name, content] of documents) await writeSkill(path.join(root, relative), { name, content })
  await writeSkill(path.join(laterRoot, 'rank/SKILL.md'), { name: 'ranked', content: 'later root directory' })

  for (const reverse of [false, true]) {
    const { fs } = makeFileSystem()
    const listDir = fs.listDir
    const canonicalRoot = await realpath(root)
    const order = reverse
      ? ['second.md', 'dir-b', 'first.md', 'dir-a', 'fallback.md', 'fallback', 'rank.md']
      : ['first.md', 'dir-a', 'second.md', 'dir-b', 'fallback.md', 'fallback', 'rank.md']
    const reads = []
    fs.listDir = async (target, signal) => {
      const entries = await listDir(target, signal)
      return target.targetKey === canonicalRoot ? entries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : entries
    }
    const readBytes = fs.readBytes
    fs.readBytes = async (target, signal, limit) => {
      reads.push(path.relative(canonicalRoot, target.targetKey))
      return readBytes(target, signal, limit)
    }
    const { registry } = compatibilityRegistry(t, fs, { projectSkillDirs: ['.opencode/skills', '.claude/skills'] })
    const snapshot = await registry.snapshot({ cwd })
    assert.equal(snapshot.complete, true)
    assert.equal((await registry.get('shared', { cwd })).content, reverse ? 'directory b named' : 'directory a canonical')
    assert.equal((await registry.get('fallback', { cwd })).content, 'flat fallback')
    assert.equal((await registry.get('ranked', { cwd })).content, 'earlier root flat')
    assert.equal(reads[0], reverse ? 'dir-b/dir-b.md' : 'dir-a/SKILL.md', 'directory scanning retains relative fs.listDir order')

    const lifetime = new AbortController()
    t.after(() => lifetime.abort())
    const control = { signal: lifetime.signal, invalidate() {} }
    const options = { projectSkillDirs: ['.opencode/skills'] }
    const compatible = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, { ...options, formatCompatibility: true })
    const strict = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, options)
    const paths = listing => listing.candidates.map(candidate => path.relative(canonicalRoot, candidate.locator.fileTarget.targetKey))
    assert.deepEqual(paths(await compatible.list({ cwd })), reverse
      ? ['dir-b/dir-b.md', 'dir-a/SKILL.md', 'second.md', 'first.md', 'fallback.md', 'rank.md']
      : ['dir-a/SKILL.md', 'dir-b/dir-b.md', 'first.md', 'second.md', 'fallback.md', 'rank.md'])
    assert.deepEqual(paths(await strict.list({ cwd })), reverse
      ? ['second.md', 'first.md', 'dir-a/SKILL.md', 'fallback.md', 'rank.md']
      : ['first.md', 'dir-a/SKILL.md', 'second.md', 'fallback.md', 'rank.md'])
  }
})

test('compatibility classifies an in-root directory symlink before flat files without changing strict order', async t => {
  const cwd = await realpath(await makeWorkspace(t))
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'flat.md'), { name: 'shared', content: 'flat' })
  await writeSkill(path.join(root, 'target/SKILL.md'), { name: 'shared', content: 'linked directory' })
  await symlink(path.join(root, 'target'), path.join(root, 'link'))
  const { fs } = makeFileSystem()
  const listDir = fs.listDir
  fs.listDir = async (target, signal) => {
    const entries = await listDir(target, signal)
    if (target.targetKey !== root) return entries
    const flat = entries.find(entry => entry.name === 'flat.md')
    const link = entries.find(entry => entry.name === 'link')
    assert.equal(link.type, 'other')
    return [flat, link]
  }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const control = { signal: lifetime.signal, invalidate() {} }
  const options = { projectSkillDirs: ['.opencode/skills'] }
  const strict = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, options)
  const compatible = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, { ...options, formatCompatibility: true })
  const paths = result => result.candidates.map(candidate => candidate.locator.resolverPath)
  const strictResult = await strict.list({ cwd })
  assert.equal(strictResult.complete, true)
  assert.deepEqual(paths(strictResult), ['.opencode/skills/flat.md', '.opencode/skills/link/SKILL.md'])
  const result = await compatible.list({ cwd })
  assert.equal(result.complete, true)
  assert.deepEqual(paths(result), ['.opencode/skills/link/SKILL.md', '.opencode/skills/flat.md'])
})

test('compatibility skips a classified entry whose type changes before processing', async t => {
  const cwd = await realpath(await makeWorkspace(t))
  const external = await realpath(await makeWorkspace(t))
  const root = path.join(cwd, '.opencode/skills')
  const raced = path.join(root, 'raced')
  const outside = path.join(external, 'outside.md')
  await writeSkill(path.join(raced, 'SKILL.md'), { name: 'inside' })
  await writeSkill(outside, { name: 'outside' })
  await writeSkill(path.join(root, 'safe.md'), { name: 'safe' })
  const { fs } = makeFileSystem()
  const originalStat = fs.stat
  const originalRead = fs.readBytes
  const reads = []
  let racedStats = 0
  fs.stat = async (target, signal) => {
    if (target.targetKey === raced && ++racedStats === 2) {
      await rename(raced, path.join(cwd, 'old-directory'))
      await symlink(outside, raced)
    }
    return originalStat(target, signal)
  }
  fs.readBytes = async (target, signal, limit) => {
    reads.push(target.targetKey)
    return originalRead(target, signal, limit)
  }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
  const result = await provider.list({ cwd })
  assert.equal(racedStats, 2)
  assert.equal(result.complete, false)
  assert.deepEqual(result.candidates.map(candidate => candidate.name), ['safe'])
  assert.deepEqual(reads, [path.join(root, 'safe.md')], 'neither the changed path nor the external file is read')
})

test('compatibility continues after a prioritized directory becomes inaccessible or disappears', async t => {
  for (const failure of ['stat-eacces', 'stat-missing', 'list-eacces', 'list-missing']) {
    await t.test(failure, async t => {
      const cwd = await realpath(await makeWorkspace(t))
      const root = path.join(cwd, '.opencode/skills')
      const broken = path.join(root, 'broken')
      await writeSkill(path.join(broken, 'SKILL.md'), { name: 'broken' })
      await writeSkill(path.join(root, 'healthy/SKILL.md'), { name: 'healthy-directory' })
      await writeSkill(path.join(root, 'flat.md'), { name: 'healthy-flat' })
      const { fs } = makeFileSystem()
      const originalStat = fs.stat
      const originalListDir = fs.listDir
      let brokenStats = 0
      let injected = 0
      fs.stat = async (target, signal) => {
        if (target.targetKey === broken && ++brokenStats === (compatibleMode ? 2 : 1) && failure.startsWith('stat-')) {
          injected += 1
          if (failure === 'stat-missing') return undefined
          throw Object.assign(new Error('stat denied'), { code: 'EACCES' })
        }
        return originalStat(target, signal)
      }
      fs.listDir = async (target, signal) => {
        if (target.targetKey === broken && failure.startsWith('list-')) {
          injected += 1
          throw Object.assign(new Error('directory unavailable'), { code: failure === 'list-eacces' ? 'EACCES' : 'ENOENT' })
        }
        const entries = await originalListDir(target, signal)
        if (target.targetKey !== root) return entries
        const order = ['broken', 'healthy', 'flat.md']
        return entries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
      }
      const lifetime = new AbortController()
      t.after(() => lifetime.abort())
      const control = { signal: lifetime.signal, invalidate() {} }
      const options = { projectSkillDirs: ['.opencode/skills'] }
      let compatibleMode = false
      const strict = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, options)
      const strictResult = await strict.list({ cwd })
      assert.equal(injected, 1, 'strict scan reaches the injected failure')
      assert.equal(strictResult.complete, false)
      assert.deepEqual(strictResult.candidates.map(candidate => candidate.name), failure === 'stat-missing' ? ['healthy-directory', 'healthy-flat'] : [], 'strict preserves its existing root-stop behavior on errors')

      compatibleMode = true
      brokenStats = 0
      injected = 0
      const compatible = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, { ...options, formatCompatibility: true })
      const result = await compatible.list({ cwd })
      assert.equal(injected, 1, 'failure occurs after directory classification')
      assert.equal(result.complete, false)
      assert.deepEqual(result.candidates.map(candidate => candidate.name), ['healthy-directory', 'healthy-flat'])
    })
  }
})

test('compatibility isolates malformed entries and containment errors during preclassification', async t => {
  for (const failure of ['null-entry', 'contains-throws']) {
    await t.test(failure, async t => {
      const cwd = await realpath(await makeWorkspace(t))
      const external = await realpath(await makeWorkspace(t))
      const root = path.join(cwd, '.opencode/skills')
      const broken = path.join(root, 'broken.md')
      const outside = path.join(external, 'outside.md')
      await writeSkill(path.join(root, 'healthy/SKILL.md'), { name: 'healthy-directory' })
      await writeSkill(path.join(root, 'flat.md'), { name: 'healthy-flat' })
      await writeSkill(broken, { name: 'broken' })
      await writeSkill(outside, { name: 'outside' })
      const { fs } = makeFileSystem()
      const contains = fs.contains
      let injected = 0
      const operations = []
      for (const method of ['stat', 'listDir', 'readBytes', 'watch']) {
        const original = fs[method]
        fs[method] = (...args) => {
          operations.push({ method, target: args[0].targetKey })
          return original(...args)
        }
      }
      const listDir = fs.listDir
      fs.listDir = async (target, signal) => {
        const entries = await listDir(target, signal)
        if (target.targetKey !== root) return entries
        const healthy = entries.find(entry => entry.name === 'healthy')
        const flat = entries.find(entry => entry.name === 'flat.md')
        const bad = entries.find(entry => entry.name === 'broken.md')
        const escaped = { name: 'outside.md', type: 'file', target: { targetKey: outside, displayPath: outside } }
        if (failure === 'null-entry') injected += 1
        return [failure === 'null-entry' ? null : bad, escaped, healthy, flat]
      }
      fs.contains = (parent, child) => {
        if (failure === 'contains-throws' && parent.targetKey === root && child?.targetKey === broken) {
          injected += 1
          throw new Error('host containment failure')
        }
        return contains(parent, child)
      }
      const lifetime = new AbortController()
      t.after(() => lifetime.abort())
      const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
        signal: lifetime.signal, invalidate() {},
      }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
      const result = await provider.list({ cwd })
      assert.equal(injected, 1, 'the contract violation is exercised during classification')
      assert.equal(result.complete, false)
      assert.deepEqual(result.candidates.map(candidate => candidate.name), ['healthy-directory', 'healthy-flat'])
      assert.deepEqual(operations.filter(({ target }) => isWithin(external, target)), [], 'no filesystem operation touches the escaped target')
      if (failure === 'contains-throws') {
        assert.deepEqual(operations.filter(({ target }) => target === broken), [], 'the entry rejected by containment is never operated on')
      }
    })
  }
})

test('classification errors remain incomplete when valid candidates exactly fill the processing budget', async t => {
  for (const failure of ['error', 'undefined']) {
    await t.test(failure, async t => {
      const cwd = await realpath(await makeWorkspace(t))
      const root = path.join(cwd, '.opencode/skills')
      await Promise.all(Array.from({ length: 256 }, (_, i) => writeSkill(path.join(root, `skill-${i}.md`), { name: `skill-${i}` })))
      await writeFile(path.join(root, 'failed.txt'), 'x')
      const { fs } = makeFileSystem()
      const originalStat = fs.stat
      let failed = 0
      fs.stat = async (target, signal) => {
        if (target.targetKey === path.join(root, 'failed.txt')) {
          failed += 1
          if (failure === 'error') throw new Error('classification failure')
          return undefined
        }
        return originalStat(target, signal)
      }
      const lifetime = new AbortController()
      t.after(() => lifetime.abort())
      const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
        signal: lifetime.signal, invalidate() {},
      }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
      const result = await provider.list({ cwd })
      assert.equal(failed, 1)
      assert.equal(result.candidates.length, 256)
      assert.equal(result.complete, false)
    })
  }
})

test('cancellation while awaiting compatibility classification publishes no partial result', async t => {
  const cwd = await realpath(await makeWorkspace(t))
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'flat.md'), { name: 'flat' })
  await writeSkill(path.join(root, 'directory/SKILL.md'), { name: 'directory' })
  const { fs } = makeFileSystem()
  const originalStat = fs.stat
  let notify, resume
  const entered = new Promise(resolve => { notify = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  let blocked = false
  fs.stat = async (target, signal) => {
    if (!blocked && target.targetKey === path.join(root, 'directory')) {
      blocked = true
      notify()
      await gate
    }
    return originalStat(target, signal)
  }
  const lifetime = new AbortController()
  t.after(() => { resume(); lifetime.abort() })
  const caller = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
  const pending = provider.list({ cwd, signal: caller.signal })
  await entered
  caller.abort(new Error('cancel classification'))
  resume()
  await assert.rejects(pending, /cancel classification/u)
  const result = await provider.list({ cwd })
  assert.equal(result.complete, true)
  assert.deepEqual(result.candidates.map(candidate => candidate.name), ['directory', 'flat'])
})

test('format compatibility preserves bounded scanning and incomplete snapshots', async t => {
  for (const mode of ['entries', 'skills', 'bytes']) {
    await t.test(mode, async t => {
      const cwd = await makeWorkspace(t)
      const root = path.join(cwd, '.opencode/skills')
      await mkdir(root, { recursive: true })
      const count = mode === 'entries' ? 520 : mode === 'skills' ? 257 : 41
      await Promise.all(Array.from({ length: count }, (_, index) => {
        const file = path.join(root, `skill-${index}.md`)
        return mode === 'entries'
          ? writeFile(file, '---\nname: [invalid\n---\n', 'utf8')
          : writeSkill(file, { name: `skill-${index}`, content: mode === 'bytes' ? 'x'.repeat(200 * 1024) : 'body' })
      }))
      const { fs, calls } = makeFileSystem()
      const { registry } = compatibilityRegistry(t, fs)
      const snapshot = await registry.snapshot({ cwd })
      assert.equal(snapshot.complete, false)
      assert.equal(snapshot.skills.length, mode === 'entries' ? 0 : mode === 'skills' ? 256 : 40)
      assert.equal(calls.filter(call => call === 'readBytes').length, mode === 'entries' ? 512 : mode === 'skills' ? 256 : 40)
    })
  }
})

test('format compatibility prioritizes discovered directories before flat files under processing budgets', async t => {
  for (const mode of ['skills', 'bytes']) {
    await t.test(mode, async t => {
      const cwd = await makeWorkspace(t)
      const root = path.join(cwd, '.opencode/skills')
      const flatCount = mode === 'skills' ? 256 : 40
      const body = mode === 'bytes' ? 'x'.repeat(200 * 1024) : 'body'
      await Promise.all(Array.from({ length: flatCount }, (_, i) =>
        writeSkill(path.join(root, `flat-${i}.md`), { name: `flat-${i}`, content: body })))
      await writeSkill(path.join(root, 'winner/SKILL.md'), { name: 'winner', content: body })
      const canonicalRoot = await realpath(root)
      const { fs } = makeFileSystem()
      const listDir = fs.listDir
      fs.listDir = async (target, signal) => {
        const entries = await listDir(target, signal)
        if (target.targetKey === canonicalRoot) {
          return entries.sort((a, b) => Number(a.name === 'winner') - Number(b.name === 'winner'))
        }
        return entries
      }
      const readBytes = fs.readBytes
      const reads = []
      fs.readBytes = async (target, signal, limit) => {
        reads.push(path.relative(canonicalRoot, target.targetKey))
        return readBytes(target, signal, limit)
      }
      const lifetime = new AbortController()
      t.after(() => lifetime.abort())
      const control = { signal: lifetime.signal, invalidate() {} }
      const options = { projectSkillDirs: ['.opencode/skills'] }
      const compatible = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, { ...options, formatCompatibility: true })
      const strict = createProjectSkillProvider({ fs, logger: { warn() {} } }, control, options)
      const strictListing = await strict.list({ cwd })
      assert.equal(strictListing.complete, false)
      assert.equal(strictListing.candidates.length, flatCount)
      assert.ok(reads[0].startsWith('flat-'))
      assert.equal(strictListing.candidates.some(candidate => candidate.name === 'winner'), false)
      reads.length = 0
      const listing = await compatible.list({ cwd })
      assert.equal(listing.complete, false)
      assert.equal(listing.candidates.length, flatCount)
      assert.equal(reads[0], 'winner/SKILL.md')
      assert.equal(listing.candidates[0].name, 'winner')
      assert.equal(listing.candidates.filter(candidate => candidate.name.startsWith('flat-')).length, flatCount - 1)
    })
  }
})

test('format compatibility reorders only discovered candidates at mixed scan limits', async t => {
  for (const mode of ['skills', 'entries', 'bytes']) {
    await t.test(mode, async t => {
      const cwd = await makeWorkspace(t)
      const root = path.join(cwd, '.opencode/skills')
      const body = mode === 'bytes' ? 'x'.repeat(200 * 1024) : 'body'
      await writeSkill(path.join(root, 'first.md'), { name: 'shared', content: body })
      await writeSkill(path.join(root, 'found/SKILL.md'), { name: 'shared', content: body })
      await writeSkill(path.join(root, 'unscanned/SKILL.md'), { name: 'shared', content: body })
      const fillerCount = mode === 'skills' ? 254 : mode === 'bytes' ? 38 : 0
      for (let i = 0; i < fillerCount; i += 1) {
        await writeSkill(path.join(root, `filler-${i}.md`), { name: `filler-${i}`, content: body })
      }
      if (mode === 'entries') {
        await Promise.all(Array.from({ length: 509 }, (_, i) => writeFile(path.join(root, 'found', `extra-${i}.txt`), 'x')))
      }
      const { fs } = makeFileSystem()
      const canonicalRoot = await realpath(root)
      const listDir = fs.listDir
      const readBytes = fs.readBytes
      const reads = []
      fs.listDir = async (target, signal) => {
        const entries = await listDir(target, signal)
        if (target.targetKey === canonicalRoot) {
          const order = ['first.md', 'found', ...Array.from({ length: fillerCount }, (_, i) => `filler-${i}.md`), 'unscanned']
          return entries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
        }
        if (target.targetKey === path.join(canonicalRoot, 'found')) {
          return entries.sort((a, b) => Number(b.name === 'SKILL.md') - Number(a.name === 'SKILL.md'))
        }
        return entries
      }
      fs.readBytes = async (target, signal, limit) => {
        reads.push(path.relative(canonicalRoot, target.targetKey))
        return readBytes(target, signal, limit)
      }
      const lifetime = new AbortController()
      t.after(() => lifetime.abort())
      const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
        signal: lifetime.signal, invalidate() {},
      }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
      const listing = await provider.list({ cwd })
      const paths = listing.candidates.map(candidate => path.relative(canonicalRoot, candidate.locator.fileTarget.targetKey))
      assert.equal(listing.complete, false)
      assert.equal(reads.length, mode === 'skills' ? 256 : mode === 'bytes' ? 40 : 2)
      if (mode === 'entries') {
        assert.deepEqual(reads, ['found/SKILL.md', 'first.md'])
        assert.equal(paths.includes('unscanned/SKILL.md'), false, 'child entries beyond the entry budget cannot be discovered')
      } else {
        assert.deepEqual(reads.slice(0, 3), ['found/SKILL.md', 'unscanned/SKILL.md', 'first.md'])
        assert.deepEqual(paths.slice(0, 3), ['found/SKILL.md', 'unscanned/SKILL.md', 'first.md'])
      }
      assert.equal(paths.length, reads.length)
    })
  }
})

test('format compatibility cannot prioritize directories beyond the root entry budget', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'winner/SKILL.md'), { name: 'winner' })
  await Promise.all(Array.from({ length: 512 }, (_, i) => writeFile(path.join(root, `other-${i}.txt`), 'x')))
  const canonicalRoot = await realpath(root)
  const { fs } = makeFileSystem()
  const listDir = fs.listDir
  fs.listDir = async (target, signal) => {
    const entries = await listDir(target, signal)
    return target.targetKey === canonicalRoot
      ? entries.sort((a, b) => Number(a.name === 'winner') - Number(b.name === 'winner'))
      : entries
  }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
  const listing = await provider.list({ cwd })
  assert.equal(listing.complete, false)
  assert.deepEqual(listing.candidates, [], 'entries excluded by root truncation have no priority guarantee')
})

test('format compatibility cancellation during a mixed scan publishes no partial result', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'flat.md'), { name: 'shared', content: 'flat' })
  await writeSkill(path.join(root, 'directory/SKILL.md'), { name: 'shared', content: 'directory' })
  const { fs } = makeFileSystem()
  const read = fs.readBytes
  let notify
  let resume
  let blocked = false
  const entered = new Promise(resolve => { notify = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  fs.readBytes = async (target, signal, limit) => {
    if (!blocked) { blocked = true; notify(); await gate }
    return read(target, signal, limit)
  }
  const lifetime = new AbortController()
  t.after(() => { resume(); lifetime.abort() })
  const caller = new AbortController()
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
  const pending = provider.list({ cwd, signal: caller.signal })
  await entered
  caller.abort(new Error('cancel mixed scan'))
  resume()
  await assert.rejects(pending, /cancel mixed scan/u)
  const listing = await provider.list({ cwd })
  assert.equal(listing.complete, true)
  assert.deepEqual(listing.candidates.map(candidate => candidate.locator.resolverPath), [
    '.opencode/skills/directory/SKILL.md', '.opencode/skills/flat.md',
  ])
})

test('format compatibility discovers nested skill directories to depth three without namespace names', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/review/SKILL.md', 'Canonical nested review body.')
  await writeCompatibilityDocument(cwd, 'team/review/review.md', 'Named fallback must not shadow the canonical file.')
  await writeCompatibilityDocument(cwd, 'team/guides/guides.md', 'Nested named fallback body.')
  await writeCompatibilityDocument(cwd, 'team/reference/operations/SKILL.md', 'Three-level canonical body.')
  await writeCompatibilityDocument(cwd, 'team/reference/operations/operations.md', 'Three-level fallback must not shadow canonical.')
  await writeCompatibilityDocument(cwd, 'team/reference/checklists/checklists.md', 'Three-level fallback body.')
  await writeCompatibilityDocument(cwd, 'team/too/deep/deeper/SKILL.md', 'Beyond the bounded directory depth.')
  await writeCompatibilityDocument(cwd, 'team/.hidden/secret/SKILL.md', 'Hidden nested body.')

  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills.map(skill => skill.name).sort(), ['checklists', 'guides', 'operations', 'review'])
  assert.equal((await registry.get('review', { cwd })).content, 'Canonical nested review body.')
  assert.equal((await registry.get('guides', { cwd })).content, 'Nested named fallback body.')
  assert.equal((await registry.get('operations', { cwd })).content, 'Three-level canonical body.')
  assert.equal((await registry.get('checklists', { cwd })).content, 'Three-level fallback body.')
  assert.equal(await registry.get('deeper', { cwd }), undefined, 'four directory components stay excluded')
  assert.equal(await registry.get('team/review', { cwd }), undefined, 'local skills retain flat kebab-case names rather than upstream slash namespaces')
  const canonicalCwd = await realpath(cwd)
  assert.deepEqual(snapshot.skills.map(skill => path.relative(canonicalCwd, skill.path)).sort(), [
    '.opencode/skills/team/guides/guides.md',
    '.opencode/skills/team/reference/checklists/checklists.md',
    '.opencode/skills/team/reference/operations/SKILL.md',
    '.opencode/skills/team/review/SKILL.md',
  ])

  const strictFixture = makeRegistry(makeFileSystem().fs)
  const strictRegistration = registerProjectSkillProvider(strictFixture.ctx, { projectSkillDirs: ['.opencode/skills'] })
  t.after(() => strictRegistration.dispose())
  assert.deepEqual((await strictFixture.registry.snapshot({ cwd })).skills, [], 'strict discovery remains non-recursive')
})

test('format compatibility ignores mixed-case Markdown extensions without shadowing valid skills', async t => {
  const cwd = await makeWorkspace(t)
  await writeSkill(path.join(cwd, '.opencode/skills/Shadow.MD'), { name: 'shadow', content: 'uppercase must not win' })
  await writeSkill(path.join(cwd, '.claude/skills/shadow/SKILL.md'), { name: 'shadow', content: 'valid lowercase fallback' })
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs, { projectSkillDirs: ['.opencode/skills', '.claude/skills'] })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.equal((await registry.get('shadow', { cwd })).content, 'valid lowercase fallback')
  assert.equal((await registry.get('shadow', { cwd })).source, 'project-claude')
  await writeCompatibilityDocument(cwd, 'team/Team.MD', 'Ignored mixed-case ancestor.')
  await writeCompatibilityDocument(cwd, 'team/reference/checklist.md', 'Valid nested flat body.')
  const nestedSnapshot = await registry.snapshot({ cwd })
  assert.equal(nestedSnapshot.complete, true)
  assert.equal((await registry.get('checklist', { cwd })).content, 'Valid nested flat body.')
  await writeCompatibilityDocument(cwd, 'team/SKILL.MD', 'Ignored mixed-case canonical.')
  const canonicalSnapshot = await registry.snapshot({ cwd })
  assert.equal(canonicalSnapshot.complete, true)
  assert.equal((await registry.get('checklist', { cwd })).content, 'Valid nested flat body.')
})

test('format compatibility discovers bounded nested flat Markdown with container resource bases', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/review.md', 'One-level flat body.')
  await writeCompatibilityDocument(cwd, 'team/reference/checklist.md', 'Two-level flat body.')
  await writeCompatibilityDocument(cwd, 'team/reference/deep/excluded.md', 'Too deep.')
  await writeCompatibilityDocument(cwd, 'team/.hidden.md', 'Hidden.')
  await writeCompatibilityDocument(cwd, 'terminal/SKILL.md', 'Terminal body.')
  await writeCompatibilityDocument(cwd, 'terminal/ignored.md', 'Shadowed.')
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills.map(skill => skill.name).sort(), ['checklist', 'review', 'terminal'])
  assert.equal((await registry.get('review', { cwd })).content, 'One-level flat body.')
  assert.equal((await registry.get('checklist', { cwd })).content, 'Two-level flat body.')
  const canonicalCwd = await realpath(cwd)
  assert.deepEqual(snapshot.skills.find(skill => skill.name === 'checklist').resourceBase, {
    kind: 'directory', path: path.join(canonicalCwd, '.opencode/skills/team/reference'),
  })
  assert.equal(await registry.get('excluded', { cwd }), undefined)
  const strict = makeRegistry(makeFileSystem().fs)
  const registration = registerProjectSkillProvider(strict.ctx, { projectSkillDirs: ['.opencode/skills'] })
  t.after(() => registration.dispose())
  assert.deepEqual((await strict.registry.snapshot({ cwd })).skills, [])
})

test('nested flat discovery rejects file symlinks and escaping container symlinks', async t => {
  const cwd = await makeWorkspace(t)
  const outside = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/valid.md', 'Contained.')
  await writeCompatibilityDocument(outside, 'secret.md', 'Outside.')
  const root = path.join(cwd, '.opencode/skills')
  await symlink(path.join(outside, '.opencode/skills/secret.md'), path.join(root, 'team/linked.md'))
  await symlink(path.join(outside, '.opencode/skills'), path.join(root, 'escape'), 'dir')
  const { fs } = makeFileSystem()
  const reads = []
  const readBytes = fs.readBytes.bind(fs)
  fs.readBytes = async (target, signal, limit) => {
    reads.push(target.targetKey)
    return readBytes(target, signal, limit)
  }
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['valid'])
  assert.equal(reads.some(key => key.includes('secret.md')), false)
})

for (const timing of ['before', 'during']) {
  test(`delivered directory change ${timing} provider loading rejects the stale candidate`, async t => {
    const cwd = await makeWorkspace(t)
    await writeCompatibilityDocument(cwd, 'team/flat.md', 'Old flat body.')
    const { fs, watchers } = makeFileSystem()
    const lifetime = new AbortController()
    t.after(() => lifetime.abort())
    let invalidations = 0
    const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
      signal: lifetime.signal, invalidate() { invalidations += 1 },
    }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
    const listing = await provider.list({ cwd })
    assert.equal(listing.complete, true)
    const candidate = listing.candidates.find(item => item.name === 'flat')
    const root = await realpath(path.join(cwd, '.opencode/skills'))
    const watcher = watchers.find(item => item.target.targetKey === root && !item.closed)
    assert.ok(watcher)
    const change = async () => {
      await writeSkill(path.join(root, 'competitor/SKILL.md'), { name: 'flat', content: 'New directory body.' })
      watcher.changed()
    }
    const readBytes = fs.readBytes.bind(fs)
    if (timing === 'before') await change()
    else fs.readBytes = async (target, signal, limit) => {
      const result = await readBytes(target, signal, limit)
      if (target.targetKey.endsWith(`${path.sep}flat.md`)) await change()
      return result
    }
    assert.equal(await provider.get(candidate, { cwd }), undefined)
    assert.ok(invalidations > 0)
    fs.readBytes = readBytes
    const fresh = await provider.list({ cwd })
    assert.equal(fresh.candidates.find(item => item.name === 'flat').locator.resolverPath, '.opencode/skills/competitor/SKILL.md')
  })
}

test('explicit refresh fences a selected native-registry skill during loading', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeCompatibilityDocument(cwd, 'team/flat.md', 'Old flat body.')
  const { fs } = makeFileSystem()
  const { ctx, registry } = makeRegistry(fs)
  const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
  t.after(() => provider.dispose())
  assert.equal((await registry.snapshot({ cwd })).complete, true)
  let resume, started
  const gate = new Promise(resolve => { resume = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const readBytes = fs.readBytes.bind(fs)
  fs.readBytes = async (target, signal, limit) => {
    const bytes = await readBytes(target, signal, limit)
    if (target.targetKey.endsWith(`${path.sep}flat.md`)) {
      started()
      await gate
    }
    return bytes
  }
  const load = registry.get('flat', { cwd })
  await entered
  try {
    await writeSkill(path.join(root, 'competitor/SKILL.md'), { name: 'flat', content: 'New directory body.' })
    provider.refresh()
  } finally {
    resume()
  }
  assert.equal(await load, undefined)
  fs.readBytes = readBytes
  assert.equal((await registry.get('flat', { cwd })).content, 'New directory body.')
})

test('stale candidate invalidation fences another concurrent provider load', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'first/SKILL.md'), { name: 'first', content: 'First body.' })
  await writeSkill(path.join(root, 'second/SKILL.md'), { name: 'second', content: 'Second body.' })
  const { fs } = makeFileSystem()
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  let invalidations = 0
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() { invalidations += 1 },
  }, { projectSkillDirs: ['.opencode/skills'] })
  const candidates = (await provider.list({ cwd })).candidates
  const first = candidates.find(item => item.name === 'first')
  const second = candidates.find(item => item.name === 'second')
  let resume, started
  const gate = new Promise(resolve => { resume = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const readBytes = fs.readBytes.bind(fs)
  fs.readBytes = async (target, signal, limit) => {
    const bytes = await readBytes(target, signal, limit)
    if (target.targetKey === first.locator.fileTarget.targetKey) {
      started()
      await gate
    }
    return bytes
  }
  const load = provider.get(first, { cwd })
  await entered
  try {
    await writeSkill(path.join(root, 'second/SKILL.md'), { name: 'renamed', content: 'Changed body.' })
    assert.equal(await provider.get(second, { cwd }), undefined)
    assert.ok(invalidations > 0)
  } finally {
    resume()
  }
  assert.equal(await load, undefined)
})

test('direct provider load honors cancellation after final containment resolution', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/flat.md', 'Body.')
  const { fs } = makeFileSystem()
  const lifetime = new AbortController()
  const lookup = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills'], formatCompatibility: true })
  const candidate = (await provider.list({ cwd })).candidates[0]
  const readBytes = fs.readBytes.bind(fs)
  const resolve = fs.resolve.bind(fs)
  let readCompleted = false
  fs.readBytes = async (...args) => {
    const result = await readBytes(...args)
    readCompleted = true
    return result
  }
  const reason = new Error('lookup cancelled')
  fs.resolve = async (filePath, options) => {
    const result = await resolve(filePath, options)
    if (readCompleted && filePath === candidate.locator.resolverPath) lookup.abort(reason)
    return result
  }
  await assert.rejects(provider.get(candidate, { cwd, signal: lookup.signal }), error => error === reason)
})

test('nested flat files follow directory skills and preserve same-root collision priority', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, 'team/flat.md'), { name: 'shared', content: 'Nested flat.' })
  await writeSkill(path.join(root, 'other/SKILL.md'), { name: 'shared', content: 'Directory wins.' })
  const { fs } = makeFileSystem()
  const reads = []
  const readBytes = fs.readBytes.bind(fs)
  fs.readBytes = async (target, signal, limit) => {
    reads.push(target.targetKey)
    return readBytes(target, signal, limit)
  }
  const { registry } = compatibilityRegistry(t, fs)
  assert.equal((await registry.get('shared', { cwd })).content, 'Directory wins.')
  assert.ok(reads.findIndex(key => key.endsWith(`${path.sep}other${path.sep}SKILL.md`)) < reads.findIndex(key => key.endsWith(`${path.sep}flat.md`)))
})

test('nested flat scan becomes incomplete when a containing skill appears during reading', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/reference/review.md', 'Nested flat.')
  const { fs } = makeFileSystem()
  const readBytes = fs.readBytes.bind(fs)
  let appeared = false
  fs.readBytes = async (target, signal, limit) => {
    const result = await readBytes(target, signal, limit)
    if (!appeared && target.targetKey.endsWith(`${path.sep}review.md`)) {
      appeared = true
      await writeCompatibilityDocument(cwd, 'team/reference/reference.md', 'New container skill.')
    }
    return result
  }
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['reference'])
})

for (const ancestorFile of ['team/SKILL.md', 'team/team.md', 'team/reference/SKILL.md', 'team/reference/reference.md']) {
  for (const timing of ['before', 'during']) {
    test(`nested flat locator rejects ancestor appearing ${timing} loading: ${ancestorFile}`, async t => {
      const cwd = await makeWorkspace(t)
      await writeCompatibilityDocument(cwd, 'team/reference/review.md', 'Nested flat body.')
      const { fs } = makeFileSystem()
      const readBytes = fs.readBytes.bind(fs)
      const { registry } = compatibilityRegistry(t, fs)
      assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['review'])
      let appeared = false
      const appear = async () => {
        if (appeared) return
        appeared = true
        await writeCompatibilityDocument(cwd, ancestorFile, 'New ancestor body.')
      }
      if (timing === 'before') await appear()
      fs.readBytes = async (target, signal, limit) => {
        const result = await readBytes(target, signal, limit)
        if (timing === 'during' && target.targetKey.endsWith(`${path.sep}review.md`)) await appear()
        return result
      }
      assert.equal(await registry.get('review', { cwd }), undefined)
      const refreshed = await registry.snapshot({ cwd })
      assert.equal(refreshed.complete, true)
      assert.deepEqual(refreshed.skills.map(skill => skill.name), [ancestorFile.startsWith('team/reference/') ? 'reference' : 'team'])
    })
  }
}

test('format compatibility keeps earlier roots ahead of later directories', async t => {
  const cwd = await makeWorkspace(t)
  const firstRoot = path.join(cwd, '.opencode/skills')
  const secondRoot = path.join(cwd, '.claude/skills')
  await writeSkill(path.join(firstRoot, 'flat.md'), { name: 'shared', content: 'Earlier flat.' })
  await writeSkill(path.join(secondRoot, 'directory/SKILL.md'), { name: 'shared', content: 'Later directory.' })
  const { fs } = makeFileSystem()
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider({ fs, logger: { warn() {} } }, {
    signal: lifetime.signal, invalidate() {},
  }, { projectSkillDirs: ['.opencode/skills', '.claude/skills'], formatCompatibility: true })
  const listing = await provider.list({ cwd })
  assert.equal(listing.complete, true)
  assert.deepEqual(listing.candidates.map(candidate => candidate.locator.resolverPath), [
    '.opencode/skills/flat.md', '.claude/skills/directory/SKILL.md',
  ])
})

test('format compatibility excludes hidden root entries and rejects their stale locators', async t => {
  const cwd = await makeWorkspace(t)
  const root = path.join(cwd, '.opencode/skills')
  await writeSkill(path.join(root, '.hidden-dir/SKILL.md'), { name: 'hidden-directory' })
  await writeSkill(path.join(root, '.hidden-flat.md'), { name: 'hidden-flat' })
  await writeSkill(path.join(root, 'visible/SKILL.md'), { name: 'visible-directory' })
  await writeSkill(path.join(root, 'visible.md'), { name: 'visible-flat' })
  const { fs } = makeFileSystem()
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  let invalidations = 0
  const control = { signal: lifetime.signal, invalidate() { invalidations += 1 } }
  const ctx = { fs, logger: { warn() {} } }
  const options = { projectSkillDirs: ['.opencode/skills'] }
  const strict = createProjectSkillProvider(ctx, control, options)
  const compatible = createProjectSkillProvider(ctx, control, { ...options, formatCompatibility: true })
  const strictListing = await strict.list({ cwd })
  assert.equal(strictListing.complete, true)
  assert.deepEqual(strictListing.candidates.map(candidate => candidate.name).sort(), ['hidden-directory', 'hidden-flat', 'visible-directory', 'visible-flat'])
  for (const candidate of strictListing.candidates) assert.ok(await strict.get(candidate, { cwd }))

  await t.test('list skips hidden entries', async () => {
    const listing = await compatible.list({ cwd })
    assert.equal(listing.complete, true)
    assert.deepEqual(listing.candidates.map(candidate => candidate.name).sort(), ['visible-directory', 'visible-flat'])
    for (const candidate of listing.candidates) assert.ok(await compatible.get(candidate, { cwd }))
  })
  await t.test('get rejects stale hidden locators', async () => {
    for (const candidate of strictListing.candidates.filter(candidate => candidate.name.startsWith('hidden-'))) {
      const before = invalidations
      const freshCompatible = createProjectSkillProvider(ctx, control, { ...options, formatCompatibility: true })
      assert.equal(await freshCompatible.get(candidate, { cwd }), undefined)
      assert.equal(invalidations, before + 1)
    }
  })
})

test('format compatibility derives flat and directory names for absent or falsy metadata through the native registry', async t => {
  const cwd = await makeWorkspace(t)
  const documents = [
    ['flat-guide.md', 'Plain Markdown body.', 'flat-guide'],
    ['indented-guide.md', '\uFEFF    body.\r\n\tindented line\r\n', 'indented-guide'],
    ['empty-yaml.md', '---\n---\nEmpty metadata body.', 'empty-yaml'],
    ['comment-yaml.md', '---\n# metadata intentionally absent\n---\nComment metadata body.', 'comment-yaml'],
    ['scalar-yaml.md', '---\nplain scalar\n---\nScalar frontmatter body.', 'scalar-yaml'],
    ['sequence-yaml.md', '---\n- one\n- two\n---\nSequence frontmatter body.', 'sequence-yaml'],
    ['directory-guide/SKILL.md', 'Canonical plain body.', 'directory-guide'],
    ['named-guide/named-guide.md', 'Named fallback body.', 'named-guide'],
    ['explicit-name.md', '---\nname: selected-name\n---\nNamed body.', 'selected-name'],
    ['Bad Filename.md', '---\nname: safe-explicit-name\n---\nExplicit metadata body.', 'safe-explicit-name'],
    ['description-only.md', '---\ndescription: Explicit description\n---\nDescription body.', 'description-only'],
    ['falsy-name.md', '---\nname: null\ndescription: null\n---\nFalsy body.', 'falsy-name'],
    ['falsy-values.md', '---\nname: false\ndescription: 0\n---\nFalsy body.', 'falsy-values'],
    ['empty-name.md', '---\nname: ""\ndescription: ""\n---\nFalsy body.', 'empty-name'],
  ]
  for (const [relative, source] of documents) await writeCompatibilityDocument(cwd, relative, source)
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills.map(skill => skill.name).sort(), documents.map(([, , name]) => name).sort())
  for (const [relative, , name] of documents) {
    const skill = await registry.get(name, { cwd })
    assert.ok(skill, relative)
    assert.equal(skill.description, `(opencode-project - Skill) ${name === 'description-only' ? 'Explicit description' : `Project skill ${name}`}`)
    assert.ok(skill.content.includes('body.'))
  }
  assert.equal((await registry.get('indented-guide', { cwd })).content, 'body.\r\n\tindented line')
  const crlfFs = makeFileSystem().fs
  const { registry: crlfRegistry } = compatibilityRegistry(t, crlfFs)
  await writeCompatibilityDocument(cwd, 'crlf-frontmatter.md', '---\r\ndescription: Demo\r\n---\r\nfirst\r\nsecond\r\n')
  assert.equal((await crlfRegistry.get('crlf-frontmatter', { cwd })).content, 'first\r\nsecond')
  await writeCompatibilityDocument(cwd, 'cr-frontmatter.md', '---\rdescription: Demo\r---\rfirst\rsecond\r')
  const { registry: crRegistry } = compatibilityRegistry(t, makeFileSystem().fs)
  assert.equal((await crRegistry.get('cr-frontmatter', { cwd })).content, 'first\rsecond')
  await writeCompatibilityDocument(cwd, 'inline-delimiter.md', '---\ndescription: Demo---\nname: inline-delimiter\n---\nfirst\nsecond\n')
  const { registry: inlineRegistry } = compatibilityRegistry(t, makeFileSystem().fs)
  const inlineSkill = await inlineRegistry.get('inline-delimiter', { cwd })
  assert.equal(inlineSkill.description, '(opencode-project - Skill) Demo')
  assert.equal(inlineSkill.content, 'name: inline-delimiter\n---\nfirst\nsecond')
  for (const [name, source, expected] of [
    ['inline-only', '---\ndescription: Demo---\nbody only\n', 'body only'],
    ['inline-only-crlf', '---\r\ndescription: Demo---\r\nbody only\r\n', 'body only'],
  ]) {
    await writeCompatibilityDocument(cwd, `${name}.md`, source)
    const { registry } = compatibilityRegistry(t, makeFileSystem().fs)
    const skill = await registry.get(name, { cwd })
    assert.equal(skill.description, '(opencode-project - Skill) Demo')
    assert.equal(skill.content, expected)
  }
  const strict = makeRegistry(makeFileSystem().fs)
  registerProjectSkillProvider(strict.ctx, { projectSkillDirs: ['.opencode/skills'] })
  for (const name of ['scalar-yaml', 'sequence-yaml']) {
    assert.equal(await strict.registry.get(name, { cwd }), undefined)
  }
})

test('format compatibility rewrites only bounded nonescaping file-like references', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'guide/SKILL.md', 'Consult @references/guide.md and @docs/.\nKeep @../outside.md, @not-a-path, and mail@example.com.\nKeep @data/#/../../../../outside.txt and @data/file.md\\..\\..\\outside.txt.\nKeep @docs/../..cache/file.md now.\nConsult @references/guide.md now.\n')
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  const loaded = await registry.get('guide', { cwd })
  const canonicalDirectory = await realpath(path.join(cwd, '.opencode/skills/guide'))
  assert.equal(loaded.content, `Consult ${canonicalDirectory}/references/guide.md and @docs/.\nKeep @../outside.md, @not-a-path, and mail@example.com.\nKeep @data/#/../../../../outside.txt and @data/file.md\\..\\..\\outside.txt.\nKeep ${canonicalDirectory}/..cache/file.md now.\nConsult ${canonicalDirectory}/references/guide.md now.`)
  const padded = `${'@references/guide.md '.repeat(65)}`
  await writeCompatibilityDocument(cwd, 'many/SKILL.md', padded)
  const { fs: manyFs } = makeFileSystem()
  const { registry: manyRegistry } = compatibilityRegistry(t, manyFs)
  assert.equal((await manyRegistry.get('many', { cwd })).content, padded.trim())
  const strictFs = makeFileSystem().fs
  const { ctx: strictCtx, registry: strictRegistry } = makeRegistry(strictFs)
  registerProjectSkillProvider(strictCtx, { projectSkillDirs: ['.opencode/skills'] })
  assert.equal(await strictRegistry.get('guide', { cwd }), undefined)
  const oversized = `${'@r/a.md '.repeat(64)}${'x'.repeat(261_000)}`
  await writeCompatibilityDocument(cwd, 'oversized/SKILL.md', oversized)
  const { fs: oversizedFs } = makeFileSystem()
  const { registry: oversizedRegistry } = compatibilityRegistry(t, oversizedFs)
  const oversizedSnapshot = await oversizedRegistry.snapshot({ cwd })
  const oversizedCandidate = oversizedSnapshot.skills.find(skill => skill.name === 'oversized')
  assert.ok(oversizedCandidate, 'oversized source remains within the raw skill byte cap')
  const oversizedContent = (await oversizedRegistry.get('oversized', { cwd })).content
  assert.equal(oversizedContent, oversized.trim(), `expanded output length ${oversizedContent.length} should remain literal`)
})

test('reference compatibility refuses Windows alternate-stream suffixes while preserving POSIX colons', () => {
  for (const base of ['C:\\skills\\guide', '\\\\server\\share\\skills\\guide']) {
    for (const token of ['@docs/readme.md:secret:$DATA', '@docs/readme.md::$DATA']) {
      assert.equal(resolveCompatibleSkillReferences(`See ${token} now.`, base), `See ${token} now.`)
    }
    assert.equal(resolveCompatibleSkillReferences('See @docs/readme.md now.', base), `See ${base.replaceAll('\\', '/')}/docs/readme.md now.`)
  }
  assert.equal(resolveCompatibleSkillReferences('See @docs/readme.md:note now.', '/skills/guide'), 'See /skills/guide/docs/readme.md:note now.')
})

test('format compatibility preserves literal POSIX backslashes in canonical display bases', async t => {
  const cwd = await makeWorkspace(t)
  const backslashCwd = `${cwd}\\area`
  await mkdir(backslashCwd, { recursive: true })
  await writeCompatibilityDocument(backslashCwd, 'guide/SKILL.md', 'Run @scripts/search.py now.')
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  const canonicalDirectory = await realpath(path.join(backslashCwd, '.opencode/skills/guide'))
  assert.ok(canonicalDirectory.includes('\\area'))
  assert.equal((await registry.get('guide', { cwd: backslashCwd })).content, `Run ${canonicalDirectory}/scripts/search.py now.`)
})

test('compatibility descriptions reflect source scopes in list and get', async t => {
  const cwd = await makeWorkspace(t)
  const open = path.join(await makeWorkspace(t), 'skills')
  const claude = path.join(await makeWorkspace(t), 'skills')
  const agents = path.join(await makeWorkspace(t), 'skills')
  const sources = [
    [path.join(cwd, '.opencode/skills/open.md'), 'open-project', '(opencode-project - Skill)'],
    [path.join(cwd, '.claude/skills/claude.md'), 'claude-project', '(project - Skill)'],
    [path.join(cwd, '.agents/skills/agents.md'), 'agents-project', '(project - Skill)'],
    [path.join(open, 'open.md'), 'open-user', '(opencode - Skill)'],
    [path.join(claude, 'claude.md'), 'claude-user', '(user - Skill)'],
    [path.join(agents, 'agents.md'), 'agents-user', '(user - Skill)'],
  ]
  for (const [file, name] of sources) await writeSkill(file, { name, description: 'Useful guidance' })
  const { registry } = compatibilityRegistry(t, makeFileSystem().fs, {
    projectSkillDirs: ['.opencode/skills', '.claude/skills', '.agents/skills'],
    userOpenCodeSkillRoots: [open], userClaudeSkillRoots: [claude], userAgentsSkillRoots: [agents],
  })
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  for (const [, name, prefix] of sources) {
    assert.equal(snapshot.skills.find(skill => skill.name === name)?.description, `${prefix} Useful guidance`)
    assert.equal((await registry.get(name, { cwd }))?.description, `${prefix} Useful guidance`)
  }
})

test('formatted compatibility descriptions retain the 2000-character bound', async t => {
  const cwd = await makeWorkspace(t)
  const prefix = '(opencode-project - Skill) '
  await writeSkill(path.join(cwd, '.opencode/skills/at-limit.md'), { name: 'at-limit', description: 'x'.repeat(2_000 - prefix.length) })
  await writeSkill(path.join(cwd, '.opencode/skills/over-limit.md'), { name: 'over-limit', description: 'x'.repeat(2_001 - prefix.length) })
  const { registry } = compatibilityRegistry(t, makeFileSystem().fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, true)
  assert.equal(snapshot.skills.find(skill => skill.name === 'at-limit')?.description.length, 2_000)
  assert.equal(snapshot.skills.some(skill => skill.name === 'over-limit'), false)
  assert.equal((await registry.get('at-limit', { cwd }))?.description.length, 2_000)
  await writeSkill(path.join(cwd, '.opencode/skills/over-limit/fallback.md'), { name: 'over-limit', content: 'fallback body' })
  const { registry: fallbackRegistry } = compatibilityRegistry(t, makeFileSystem().fs)
  const fallbackSnapshot = await fallbackRegistry.snapshot({ cwd })
  assert.equal(fallbackSnapshot.complete, true)
  assert.equal((await fallbackRegistry.get('over-limit', { cwd }))?.content, 'fallback body')
})

test('format compatibility is opt-in and validates its option without weakening strict documents', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'plain.md', 'Plain body.')
  await writeCompatibilityDocument(cwd, 'named/named.md', 'Named body.')
  await writeSkill(path.join(cwd, '.opencode/skills/strict/SKILL.md'), { name: 'strict-skill' })
  await writeCompatibilityDocument(cwd, 'strict-falsy.md', '---\nname: null\ndescription: ""\n---\nStrict rejects falsy metadata.')
  for (const options of [{}, { formatCompatibility: false }]) {
    const { fs } = makeFileSystem()
    const { ctx, registry } = makeRegistry(fs)
    const provider = registerProjectSkillProvider(ctx, { projectSkillDirs: ['.opencode/skills'], ...options })
    t.after(() => provider.dispose())
    assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['strict-skill'])
    assert.equal((await registry.get('strict-skill', { cwd }))?.description, 'Project skill')
  }
  for (const value of [null, 'true', 1]) {
    const { fs } = makeFileSystem()
    const { ctx } = makeRegistry(fs)
    assert.throws(() => registerProjectSkillProvider(ctx, { formatCompatibility: value }), /formatCompatibility/iu)
  }
})

test('format compatibility rejects explicit invalid metadata, malformed YAML, controls, and invalid derived names', async t => {
  const cwd = await makeWorkspace(t)
  const invalid = [
    ['blank-name.md', '---\nname: "   "\n---\nPrivate body.'],
    ['null-name.md', '---\nname: 1\n---\nPrivate body.'],
    ['bad-name.md', '---\nname: invalid/name\n---\nPrivate body.'],
    ['blank-description.md', '---\ndescription: "   "\n---\nPrivate body.'],
    ['null-description.md', '---\ndescription: true\n---\nPrivate body.'],
    ['malformed.md', '---\nname: [invalid\n---\nPrivate body.'],
    ['duplicate.md', '---\nname: first\nname: second\n---\nPrivate body.'],
    ['control.md', '---\nname: "bad\\u202evalue"\n---\nPrivate body.'],
    ['Bad Name.md', '---\nname: null\n---\nPrivate body.'],
    ['bad name/bad name.md', '---\nname: ""\n---\nPrivate body.'],
  ]
  for (const [relative, source] of invalid) await writeCompatibilityDocument(cwd, relative, source)
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  assert.deepEqual((await registry.snapshot({ cwd })).skills, [])
})

test('format compatibility gives canonical SKILL.md priority over named files including invalid and symlink primaries', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'valid/valid.md', 'Named lower priority body.')
  await writeCompatibilityDocument(cwd, 'valid/SKILL.md', 'Canonical winner body.')
  await writeCompatibilityDocument(cwd, 'invalid/invalid.md', 'Must not fallback body.')
  await writeCompatibilityDocument(cwd, 'invalid/SKILL.md', '---\nname: "   "\n---\nInvalid primary body.')
  await writeCompatibilityDocument(cwd, 'linked/linked.md', 'Must not follow body.')
  const external = await makeWorkspace(t)
  const target = path.join(external, 'outside.md')
  await writeFile(target, 'External private body.', 'utf8')
  await symlink(target, path.join(cwd, '.opencode/skills/linked/SKILL.md'))
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['valid'])
  assert.equal((await registry.get('valid', { cwd })).content, 'Canonical winner body.')
  assert.equal(await registry.get('invalid', { cwd }), undefined)
  assert.equal(await registry.get('linked', { cwd }), undefined)
})

test('format compatibility cached named fallback is invalidated when a canonical SKILL.md appears without watcher delivery', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'review/review.md', 'Original named fallback body.')
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['review'])
  assert.equal((await registry.get('review', { cwd })).content, 'Original named fallback body.')
  await writeCompatibilityDocument(cwd, 'review/SKILL.md', 'New canonical primary body.')
  assert.equal(await registry.get('review', { cwd }), undefined, 'stale lower-priority locator must not load')
  assert.equal((await registry.get('review', { cwd })).content, 'New canonical primary body.', 'the invalidated catalog must recover with the canonical document')
})

test('three-level fallback invalidates its stale locator when a canonical file appears', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/reference/operations/operations.md', 'Original nested fallback.')
  const { fs } = makeFileSystem()
  const { registry } = compatibilityRegistry(t, fs)
  assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['operations'])
  assert.equal((await registry.get('operations', { cwd })).content, 'Original nested fallback.')
  await writeCompatibilityDocument(cwd, 'team/reference/operations/SKILL.md', 'New nested canonical.')
  assert.equal(await registry.get('operations', { cwd }), undefined)
  assert.equal((await registry.get('operations', { cwd })).content, 'New nested canonical.')
})

for (const ancestorFile of ['team/SKILL.md', 'team/team.md', 'team/reference/SKILL.md', 'team/reference/reference.md']) {
  for (const timing of ['before', 'during']) {
    test(`nested skill rejects an ancestor skill appearing ${timing} loading: ${ancestorFile}`, async t => {
      const cwd = await makeWorkspace(t)
      await writeCompatibilityDocument(cwd, 'team/reference/operations/SKILL.md', 'Nested operations body.')
      const { fs } = makeFileSystem()
      const { registry } = compatibilityRegistry(t, fs)
      assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), ['operations'])
      let nestedReads = 0
      const readBytes = fs.readBytes.bind(fs)
      fs.readBytes = async (target, signal, maxBytes) => {
        const bytes = await readBytes(target, signal, maxBytes)
        if (target.targetKey.endsWith(`${path.sep}operations${path.sep}SKILL.md`)) {
          nestedReads += 1
          if (timing === 'during') await writeCompatibilityDocument(cwd, ancestorFile, 'Ancestor skill body.')
        }
        return bytes
      }
      if (timing === 'before') await writeCompatibilityDocument(cwd, ancestorFile, 'Ancestor skill body.')
      assert.equal(await registry.get('operations', { cwd }), undefined, 'stale nested locator must be invalidated even without a watcher event')
      assert.equal(nestedReads, timing === 'before' ? 0 : 1)
      const ancestorName = ancestorFile.startsWith('team/reference/') ? 'reference' : 'team'
      assert.deepEqual((await registry.snapshot({ cwd })).skills.map(skill => skill.name), [ancestorName])
      assert.equal((await registry.get(ancestorName, { cwd })).content, 'Ancestor skill body.')
    })
  }
}

for (const ancestorFile of ['team/SKILL.md', 'team/reference/reference.md']) {
  for (const timing of ['before', 'during']) {
    test(`nested scan becomes incomplete when ancestor appears ${timing} reading: ${ancestorFile}`, async t => {
      const cwd = await makeWorkspace(t)
      await writeCompatibilityDocument(cwd, 'team/reference/operations/SKILL.md', 'Nested operations body.')
      const { fs } = makeFileSystem()
      const listDir = fs.listDir.bind(fs)
      const readBytes = fs.readBytes.bind(fs)
      let appeared = false
      let nestedReads = 0
      const appear = async () => {
        if (appeared) return
        appeared = true
        await writeCompatibilityDocument(cwd, ancestorFile, 'Ancestor skill body.')
      }
      fs.listDir = async (target, signal) => {
        const entries = await listDir(target, signal)
        if (timing === 'before' && target.targetKey.endsWith(`${path.sep}operations`)) await appear()
        return entries
      }
      fs.readBytes = async (target, signal, maxBytes) => {
        const bytes = await readBytes(target, signal, maxBytes)
        if (target.targetKey.endsWith(`${path.sep}operations${path.sep}SKILL.md`)) {
          nestedReads += 1
          if (timing === 'during') await appear()
        }
        return bytes
      }
      const { registry } = compatibilityRegistry(t, fs)
      const snapshot = await registry.snapshot({ cwd })
      assert.equal(snapshot.complete, false)
      assert.deepEqual(snapshot.skills, [])
      assert.equal(nestedReads, timing === 'before' ? 0 : 1)
      const ancestorName = ancestorFile.startsWith('team/reference/') ? 'reference' : 'team'
      const refreshed = await registry.snapshot({ cwd })
      assert.equal(refreshed.complete, true)
      assert.deepEqual(refreshed.skills.map(skill => skill.name), [ancestorName])
      assert.equal((await registry.get(ancestorName, { cwd })).content, 'Ancestor skill body.')
    })
  }
}

test('a canonical skill appearing after directory enumeration makes the scan incomplete', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/review/SKILL.md', 'Nested review body.')
  const { fs } = makeFileSystem()
  const listDir = fs.listDir.bind(fs)
  let appeared = false
  fs.listDir = async (target, signal) => {
    const entries = await listDir(target, signal)
    if (!appeared && target.targetKey.endsWith(`${path.sep}team`)) {
      appeared = true
      await writeCompatibilityDocument(cwd, 'team/SKILL.md', 'New canonical team body.')
    }
    return entries
  }
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
  const refreshed = await registry.snapshot({ cwd })
  assert.equal(refreshed.complete, true)
  assert.deepEqual(refreshed.skills.map(skill => skill.name), ['team'])
  assert.equal((await registry.get('team', { cwd })).content, 'New canonical team body.')
})

test('format compatibility preserves byte limits, strict UTF-8, named-file symlink containment, and read version checks', async t => {
  const cwd = await makeWorkspace(t)
  const oversized = await writeCompatibilityDocument(cwd, 'oversized.md', 'x'.repeat(256 * 1024 + 1))
  const badUtf8 = await writeCompatibilityDocument(cwd, 'invalid-utf8.md', 'placeholder')
  await writeFile(badUtf8, Buffer.from([0xff, 0xfe]))
  const changing = await realpath(await writeCompatibilityDocument(cwd, 'changing.md', 'Changing body.'))
  const external = await makeWorkspace(t)
  const externalFile = path.join(external, 'private.md')
  await writeFile(externalFile, 'External secret body.', 'utf8')
  await mkdir(path.join(cwd, '.opencode/skills/linked-fallback'), { recursive: true })
  await symlink(externalFile, path.join(cwd, '.opencode/skills/linked-fallback/linked-fallback.md'))
  const { fs } = makeFileSystem()
  const originalStat = fs.stat.bind(fs)
  const originalRead = fs.readBytes.bind(fs)
  let changed = false
  const reads = []
  fs.readBytes = async (target, signal, maxBytes) => {
    reads.push(target.targetKey)
    const bytes = await originalRead(target, signal, maxBytes)
    if (target.targetKey === changing) changed = true
    return bytes
  }
  fs.stat = async target => {
    const info = await originalStat(target)
    return target.targetKey === changing && changed ? { ...info, version: `${info.version}:changed` } : info
  }
  const { registry } = compatibilityRegistry(t, fs)
  assert.deepEqual((await registry.snapshot({ cwd })).skills, [])
  assert.ok(reads.includes(await realpath(badUtf8)) && reads.includes(changing))
  assert.equal(reads.includes(await realpath(oversized)), false)
  assert.equal(reads.includes(await realpath(externalFile)), false)
})

test('three-level discovery fails closed when an intermediate listing is truncated', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'team/reference/operations/SKILL.md', 'Must not be discovered through an uncertain listing.')
  const { fs } = makeFileSystem()
  const listDir = fs.listDir.bind(fs)
  fs.listDir = async target => {
    const entries = await listDir(target)
    if (target.targetKey.endsWith(`${path.sep}reference`)) {
      const child = entries.find(entry => entry.name === 'operations')
      return [child, ...Array.from({ length: 512 }, (_, i) => ({ name: `ignored-${i}.txt`, type: 'file', target: child.target }))]
    }
    return entries
  }
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
})

test('format compatibility refuses named fallback when bounded child listing cannot establish primary absence', async t => {
  const cwd = await makeWorkspace(t)
  await writeCompatibilityDocument(cwd, 'uncertain/uncertain.md', 'Must not load uncertain fallback body.')
  const { fs } = makeFileSystem()
  const listDir = fs.listDir.bind(fs)
  fs.listDir = async target => {
    const entries = await listDir(target)
    if (target.targetKey.endsWith(`${path.sep}uncertain`)) {
      const named = entries.find(entry => entry.name === 'uncertain.md')
      return [named, ...Array.from({ length: 512 }, (_, i) => ({ name: `ignored-${i}.txt`, type: 'file', target: named.target }))]
    }
    return entries
  }
  const { registry } = compatibilityRegistry(t, fs)
  const snapshot = await registry.snapshot({ cwd })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills, [])
})
