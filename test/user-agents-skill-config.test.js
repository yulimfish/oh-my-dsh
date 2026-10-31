import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { apply, Config } from '../src/index.js'
import { createProjectSkillProvider } from '../src/project-skills.js'

// Real file reads and identity checks; inert watches suffice for an immutable fixture.
function fileSystem() {
  const info = value => ({
    type: value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other',
    size: value.size,
    version: `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`,
  })
  async function canonical(candidate) {
    const missing = []
    while (true) {
      try { return path.join(await realpath(candidate), ...missing) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const parent = path.dirname(candidate)
        if (parent === candidate) throw error
        missing.unshift(path.basename(candidate))
        candidate = parent
      }
    }
  }
  const fs = {
    async resolve(value, options = {}) {
      const key = await canonical(path.resolve(options.cwd ?? process.cwd(), value))
      return { targetKey: key, displayPath: key }
    },
    contains(parent, child) {
      const relative = path.relative(parent.targetKey, child.targetKey)
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    },
    async lstat(value, options = {}) {
      try { return info(await lstat(path.resolve(options.cwd ?? process.cwd(), value))) } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    async stat(target) {
      try { return info(await stat(target.targetKey)) } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    async listDir(target) {
      return Promise.all((await readdir(target.targetKey, { withFileTypes: true })).map(async entry => ({
        name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: await fs.resolve(entry.name, { cwd: target.targetKey }),
      })))
    },
    async readBytes(target, signal, maxBytes) {
      if (signal?.aborted) throw signal.reason
      const bytes = await readFile(target.targetKey)
      if (bytes.length > maxBytes) { const error = new Error('file too large'); error.code = 'FS_TOO_LARGE'; throw error }
      return bytes
    },
    async watch() { return () => {} },
  }
  return fs
}

function makeContext(t) {
  const registryContext = new Context()
  registryContext.logger = { warn() {} }
  const skills = new SkillRegistry(registryContext)
  const effects = []
  const ctx = {
    fs: fileSystem(), skills,
    get: () => undefined,
    tools: { register: () => () => {}, get() {} },
    subagents: { getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }), startActivation() {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    on() { return ctx },
    effect(execute) { const dispose = execute(); effects.push(dispose); return dispose },
    logger: { warn() {} },
  }
  t.after(async () => { for (const dispose of effects.reverse()) if (typeof dispose === 'function') await dispose() })
  return { ctx, skills }
}

async function skill(root, name, body) {
  const directory = path.join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n\n${body}\n`)
}

test('full Config defaults userAgentsSkillRoots to an empty list and preserves explicit roots', () => {
  const defaults = Config({})
  assert.deepEqual(defaults.userAgentsSkillRoots, [])
  assert.deepEqual(Config(JSON.parse(JSON.stringify(defaults))).userAgentsSkillRoots, [])
  const roots = ['/example/.agents/skills']
  assert.deepEqual(Config({ userAgentsSkillRoots: roots }).userAgentsSkillRoots, roots)
})

test('Config loads an explicit shared skills root without cwd or vendored content', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'dsh-shared-skill-config-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'shared', 'skills')
  await skill(root, 'ast-grep', 'SHARED_BODY')
  const { ctx, skills } = makeContext(t)
  apply(ctx, Config({ projectSkillDirs: [], sharedSkillsRootPath: root, enableProjectSkillFormatCompatibility: true }))
  const loaded = await skills.get('ast-grep', {})
  assert.equal(loaded.source, 'shared')
  assert.equal(loaded.description, '(shared - Skill) Fixture ast-grep')
  assert.equal(loaded.content.trim(), 'SHARED_BODY')
  const userRoot = path.join(temp, 'user', 'skills')
  await skill(userRoot, 'ast-grep', 'USER_BODY')
  const precedence = makeContext(t)
  apply(precedence.ctx, Config({ projectSkillDirs: [], sharedSkillsRootPath: root, userClaudeSkillRoots: [userRoot], enableProjectSkillFormatCompatibility: true }))
  assert.equal((await precedence.skills.get('ast-grep', {})).content.trim(), 'USER_BODY')
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const provider = createProjectSkillProvider(ctx, { signal: lifetime.signal, invalidate() {} }, { projectSkillDirs: [], sharedSkillsRootPath: root, formatCompatibility: true })
  const sharedCandidate = (await provider.list({})).candidates.find(candidate => candidate.name === 'ast-grep')
  assert.equal(sharedCandidate.rank, 249.95)
  assert.equal(await provider.get({ ...sharedCandidate, locator: { ...sharedCandidate.locator, userRoot: 'user-claude' } }, {}), undefined)
  assert.equal(Config({}).sharedSkillsRootPath, '')
  const invalid = makeContext(t)
  assert.throws(() => apply(invalid.ctx, Config({ sharedSkillsRootPath: 'relative/skills' })), /sharedSkillsRootPath/u)
})

test('Config ignores remote skill sources without setup failure or file reads', async t => {
  const { ctx, skills } = makeContext(t)
  apply(ctx, Config({ projectSkillDirs: [], configSkillPaths: ['https://example.invalid/skill.md'], enableProjectSkillFormatCompatibility: true }))
  const snapshot = await skills.snapshot({})
  assert.equal(snapshot.skills.some(skill => skill.source === 'config'), false)
  assert.equal(snapshot.complete, true)
})

test('Config preserves kebab inline tools and from-file metadata fallback', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'dsh-inline-skill-config-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  await writeFile(path.join(temp, 'from.md'), '---\ndescription: File description\nlicense: Apache-2.0\nallowed-tools: write\nargument-hint: from-file\n---\nFROM_BODY')
  const { ctx, skills } = makeContext(t)
  const config = Config({
    projectSkillDirs: [], configSkillPaths: [], configSkillBase: { configDir: temp },
    enableProjectSkillFormatCompatibility: true,
    configSkillEntries: { inline: { description: '', from: 'from.md', 'allowed-tools': '' } },
  })
  assert.equal(config.configSkillEntries.inline.allowedTools, undefined)
  apply(ctx, config)
  const loaded = await skills.get('inline', { cwd: temp })
  assert.equal(loaded.description, '(config - Skill) File description')
  assert.deepEqual(loaded.allowedTools, ['write'])
  assert.equal(loaded.license, 'Apache-2.0')
  assert.equal(loaded.argumentHint, 'from-file')
})

test('apply forwards agents roots to the real registry, with OpenCode > Claude > Agents', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'dsh-agents-skill-config-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const cwd = path.join(temp, 'project')
  await mkdir(cwd)
  const [open, claude, agents] = ['open', 'claude', 'agents'].map(name => path.join(temp, name, 'skills'))
  for (const [root, body] of [[open, 'OpenCode'], [claude, 'Claude'], [agents, 'Agents']]) {
    await skill(root, 'all-sources', body)
  }
  await skill(claude, 'claude-agents', 'Claude wins')
  await skill(agents, 'claude-agents', 'Agents loses')
  await skill(agents, 'agents-only', 'Agents only')
  const { ctx, skills } = makeContext(t)
  apply(ctx, Config({ projectSkillDirs: [], userOpenCodeSkillRoots: [open], userClaudeSkillRoots: [claude], userAgentsSkillRoots: [agents] }))
  for (const [name, source, content] of [
    ['all-sources', 'user-opencode', 'OpenCode'],
    ['claude-agents', 'user-claude', 'Claude wins'],
    ['agents-only', 'user-agents', 'Agents only'],
  ]) {
    const loaded = await skills.get(name, { cwd })
    assert.ok(loaded, `expected ${name} to load`)
    assert.equal(loaded.source, source)
    assert.equal(loaded.content.trim(), content)
  }
})

test('invalid userAgentsSkillRoots are rejected by Config or real provider during apply', t => {
  for (const value of ['not-an-array', [1]]) {
    assert.throws(() => Config({ userAgentsSkillRoots: value }), /userAgentsSkillRoots|array|string/iu)
  }
  for (const value of [['relative/skills'], ['/example/not-skills'], ['/example/skills', '/example/skills'], ['/a/skills', '/b/skills', '/c/skills']]) {
    const { ctx } = makeContext(t)
    assert.throws(() => apply(ctx, Config({ userAgentsSkillRoots: value })), /userAgentsSkillRoots/u)
  }
})
