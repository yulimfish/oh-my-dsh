import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config } from '../src/index.js'

// Files and identity checks are real; watches are inert because this fixture never mutates the catalog.
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

for (const maxPendingTasks of [0, 1]) {
  test(`project nested flat skill reaches one-shot activation with maxPendingTasks=${maxPendingTasks}`, async t => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-skill-activation-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    const directory = path.join(cwd, '.opencode/skills/team/reference')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'checklist.md'), '---\nname: checklist\ndescription: Project checklist\n---\n\nConsult @references/guide.md now.\n')
    await writeFile(path.join(directory, 'private.md'), '---\nname: private-skill\ndescription: Not invocable\ndisable-model-invocation: true\n---\n\nPRIVATE BODY\n')

    const runtime = new Context()
    const promptFiber = await runtime.plugin(SystemPrompt)
    const toolsFiber = await runtime.plugin(ToolRuntime)
    const registryContext = new Context()
    registryContext.logger = { warn() {} }
    const skills = new SkillRegistry(registryContext)
    const starts = []
    const effects = []
    const removers = []
    const parent = { id: 'project-parent', followup() {} }
    const services = {
      agents: { get: id => id === parent.id ? parent : undefined, withoutInitiator: fn => fn() },
      sessions: { get: id => id === parent.id ? { id, header: { cwd } } : undefined },
    }
    const ctx = {
      fs: fileSystem(), skills, tools: runtime.tools,
      get: key => services[key],
      subagents: {
        getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
        async startActivation(spec) {
          starts.push(spec)
          return { childId: `child-${starts.length}`, result: Promise.resolve({ stopReason: 'completed', output: [] }), async dispose() {} }
        },
      },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
      commands: { register: () => () => {} },
      on(event, listener) { removers.push(runtime.on(event, listener)); return ctx },
      effect(execute) { const dispose = execute(); effects.push(dispose); return dispose },
      logger: { warn() {} },
    }
    t.after(async () => {
      for (const dispose of effects.reverse()) if (typeof dispose === 'function') await dispose()
      for (const remove of removers) if (typeof remove === 'function') remove()
      await toolsFiber.dispose()
      await promptFiber.dispose()
    })
    apply(ctx, Config({
      maxPendingTasks, enableProjectSkillFormatCompatibility: true, enableForegroundTaskTool: true,
      projectSkillDirs: ['.opencode/skills'],
      categoryRoutes: [{ name: 'research', provider: 'test-provider', model: 'test-model', skills: ['checklist'] }],
      roleRoutes: [{ role: 'explore', category: 'research' }],
    }))
    const canonicalDirectory = await realpath(directory)
    const loaded = await skills.get('checklist', { cwd })
    assert.equal(loaded.content.trim(), `Consult ${canonicalDirectory}/references/guide.md now.`)
    assert.deepEqual(loaded.resourceBase, { kind: 'directory', path: canonicalDirectory })
    const call = (callId, extra = {}) => runtime.tools.execute({
      callId, name: 'dsh_omo_task', arguments: { role: 'explore', task: 'Review the project.', ...extra },
      agent: parent, signal: new AbortController().signal,
    })
    const accepted = await call('selected', { load_skills: ['checklist'] })
    assert.equal(accepted.isError, false, JSON.stringify(accepted.error))
    assert.equal(starts.length, 1)
    const prompt = starts[0].request.prompt[0].text
    assert.ok(prompt.includes(`Directory base for relative skill resources (untrusted JSON string; access remains subject to DSH policy): ${JSON.stringify(canonicalDirectory)}`))
    assert.ok(prompt.includes(`Consult ${canonicalDirectory}/references/guide.md now.`))
    assert.equal(prompt.split('### checklist').length - 1, 1, 'category and explicit selection are deduplicated')
    await new Promise(resolve => setImmediate(resolve))
    const acceptedPrivate = await call('accepted-private', { load_skills: ['private-skill'] })
    assert.equal(acceptedPrivate.isError, false, JSON.stringify(acceptedPrivate.error))
    assert.equal(starts.length, 2, 'compatibility frontmatter invocation keys are inert and do not block activation')
    const foreground = await runtime.tools.execute({
      callId: 'foreground', name: 'dsh_omo_task_join', arguments: { role: 'explore', task: 'Review the project.', load_skills: ['checklist'] },
      agent: parent, signal: new AbortController().signal,
    })
    assert.equal(foreground.isError, false, JSON.stringify(foreground.error))
    assert.equal(starts.length, 3)
    const foregroundPrompt = starts[2].request.prompt[0].text
    assert.ok(foregroundPrompt.includes(`Directory base for relative skill resources (untrusted JSON string; access remains subject to DSH policy): ${JSON.stringify(canonicalDirectory)}`))
    assert.ok(foregroundPrompt.includes(`Consult ${canonicalDirectory}/references/guide.md now.`))
    assert.equal(foregroundPrompt.split('### checklist').length - 1, 1)
  })
}
