import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { posix as path } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  createClaudeRulesOnReadContextListener,
  normalizeProjectOmoRulesRoot,
  normalizeProjectClaudeRulesRoot,
  normalizeProjectCursorRulesRoot,
  normalizeProjectGitHubInstructionsRoot,
  normalizeProjectSisyphusRulesRoot,
  normalizeUserClaudeRulesRoots,
  normalizeUserOpenCodeRulesRoots,
  normalizeUserSisyphusRulesRoot,
  registerClaudeRulesOnReadContext,
} from '../src/claude-rules-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))

const CWD = '/workspace/project'
const USER_CLAUDE_RULES_ROOT = '/Users/alice/.claude/rules'
const USER_OMO_RULES_ROOT = '/Users/alice/.omo/rules'
const USER_OPENCODE_RULES_ROOT = '/Users/alice/.opencode/rules'
const USER_SISYPHUS_RULES_ROOT = '/Users/alice/.sisyphus/rules'
const encoder = new TextEncoder()

function rule(body, frontmatter = 'alwaysApply: true') {
  return `---\n${frontmatter}\n---\n${body}`
}

function makeRecord(value) {
  if (typeof value === 'string') {
    const bytes = encoder.encode(value)
    return { text: value, bytes, type: 'file', version: 'v1' }
  }
  const record = { type: 'file', version: 'v1', ...value }
  if (typeof record.text === 'string') record.bytes = encoder.encode(record.text)
  else if (!(record.bytes instanceof Uint8Array)) record.bytes = new Uint8Array()
  return record
}

function makeFileSystem({
  cwd = CWD,
  projectRoot,
  userClaudeRulesRoot = USER_CLAUDE_RULES_ROOT,
  userOpenCodeRulesRoots = [],
  userSisyphusRulesRoot = USER_SISYPHUS_RULES_ROOT,
  userRootTargetKey,
  targetKeys = {},
  symlinkTargets = {},
  rules = {},
  types = {},
  failListDir = false,
  failListDirPath,
  missingUserRoot = false,
  hangListDir = false,
} = {}) {
  const calls = []
  const records = new Map(Object.entries(rules).map(([relative, value]) => [relative, makeRecord(value)]))
  const extraTypes = new Map(Object.entries(types))
  const targetKeyAliases = new Map(Object.entries(targetKeys))
  const symlinkTargetAliases = new Map(Object.entries(symlinkTargets))
  const userRootMappings = [
    { path: userClaudeRulesRoot, relative: '@user' },
    { path: userSisyphusRulesRoot, relative: '@sisyphus' },
    ...userOpenCodeRulesRoots.map((root, index) => ({ path: root, relative: `@opencode${index}` })),
  ].sort((left, right) => right.path.length - left.path.length)
  const projectRootRelative = projectRoot ? '@project' : undefined
  const cwdWithinProjectRoot = typeof projectRoot === 'string'
    && (cwd === projectRoot || cwd.startsWith(`${projectRoot}/`))
  const cwdRelativeToProjectRoot = cwdWithinProjectRoot ? path.relative(projectRoot, cwd) : undefined
  const cwdVirtualRelative = cwdWithinProjectRoot
    ? cwdRelativeToProjectRoot ? `${projectRootRelative}/${cwdRelativeToProjectRoot}` : projectRootRelative
    : ''
  const directories = new Set(['', '.claude', '.claude/rules', ...(projectRootRelative ? [projectRootRelative] : [])])
  if (!missingUserRoot) for (const root of userRootMappings) directories.add(root.relative)
  const targets = new WeakMap()
  const targetCache = new Map()
  let activeReadPath = 'src/app.ts'
  let releaseListing

  function addParents(relative) {
    let parent = path.dirname(relative)
    while (parent !== '.' && parent !== '' && parent !== '/') {
      directories.add(parent)
      parent = path.dirname(parent)
    }
  }

  function addFile(relative, record = { type: 'file', text: 'source', version: 'read-v1' }) {
    const existing = records.get(relative)
    if (!existing) records.set(relative, makeRecord(record))
    addParents(relative)
    return records.get(relative)
  }

  for (const relative of records.keys()) addParents(relative)
  for (const [relative, type] of extraTypes) {
    if (type === 'directory') directories.add(relative)
    else if (!records.has(relative)) records.set(relative, makeRecord({ type, text: '' }))
    addParents(relative)
  }

  function currentTargetKey(relative, record, kind) {
    if (record?.replaced && record.afterTargetKey !== undefined) return record.afterTargetKey
    if (relative === '@user' && typeof userRootTargetKey === 'string') return userRootTargetKey
    if (targetKeyAliases.has(relative)) return targetKeyAliases.get(relative)
    return record?.targetKey ?? `${kind}:${cwd}:${relative}`
  }

  function makeTarget(relative, kind, record, { outside = false, key } = {}) {
    const targetKey = key ?? currentTargetKey(relative, record, kind)
    const after = record?.replaced === true
    const cacheKey = `${kind}|${relative}|${String(targetKey)}|${outside ? 'outside' : 'inside'}|${after ? 'after' : 'before'}`
    let target = targetCache.get(cacheKey)
    if (!target) {
      target = { targetKey, cwd, relative, kind, record, outside, after }
      targets.set(target, { cwd, relative, kind, record, outside, after })
      targetCache.set(cacheKey, target)
    }
    return target
  }

  const rootTarget = makeTarget('', 'directory', undefined, { key: `root:${cwd}` })

  function relativeFromPath(value, baseCwd = cwd) {
    if (typeof value !== 'string') return undefined
    if (projectRoot && path.isAbsolute(value)) {
      if (value === projectRoot) return projectRootRelative
      if (value.startsWith(`${projectRoot}/`)) {
        const relative = path.relative(projectRoot, value)
        return relative ? `${projectRootRelative}/${relative}` : projectRootRelative
      }
    }
    for (const root of userRootMappings) {
      if (value === root.path) return root.relative
      if (path.isAbsolute(value) && value.startsWith(`${root.path}/`)) {
        return `${root.relative}/${path.relative(root.path, value)}`
      }
    }
    if (path.isAbsolute(value)) {
      if (value === cwd) return cwdVirtualRelative
      const relative = path.relative(cwd, value)
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined
      return relative ? path.join(cwdVirtualRelative, relative) : cwdVirtualRelative
    }
    const userRoot = userRootMappings.find(root => root.path === baseCwd)
    if (userRoot) {
      const relative = path.normalize(value)
      if (relative === '.') return userRoot.relative
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined
      return `${userRoot.relative}/${relative}`
    }
    if (projectRoot && baseCwd === projectRoot) {
      const relative = path.normalize(value)
      if (relative === '.') return projectRootRelative
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined
      return `${projectRootRelative}/${relative}`
    }
    if (projectRoot && baseCwd === cwd) {
      const relative = path.normalize(value)
      if (relative === '.') return cwdVirtualRelative
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined
      return cwdVirtualRelative ? `${cwdVirtualRelative}/${relative}` : relative
    }
    return value
  }

  function typeAt(relative) {
    if (extraTypes.has(relative)) return extraTypes.get(relative)
    const record = records.get(relative)
    if (record) return record.type
    if (directories.has(relative)) return 'directory'
    return undefined
  }

  function targetAt(relative) {
    if (relative === '') return rootTarget
    const type = typeAt(relative)
    if (type === undefined) return undefined
    const record = records.get(relative)
    return makeTarget(relative, type, record)
  }

  function resolveSymlinks(relative) {
    let current = ''
    const visited = new Set()
    for (const segment of relative.split('/').filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment
      while (typeAt(current) === 'symlink') {
        if (visited.has(current)) return undefined
        visited.add(current)
        const target = symlinkTargetAliases.get(current)
        if (typeof target !== 'string' || target.length === 0) return undefined
        current = target
      }
    }
    return current
  }

  function metadataFor(record, type) {
    if (record?.afterStat !== undefined && record.replaced && record.statCalls > 1) return record.afterStat
    if (record?.stat !== undefined) return record.stat
    const info = { type: record?.type ?? type }
    if (record?.bytes instanceof Uint8Array) info.size = record.bytes.byteLength
    if (record?.version !== undefined) info.version = record.version
    return info
  }

  function childrenOf(relative) {
    const output = []
    for (const directory of directories) {
      if (directory === '' || directory === relative || records.has(directory)) continue
      if (path.dirname(directory) === (relative || '.')) {
        const name = path.basename(directory)
        const type = typeAt(directory) ?? 'directory'
        output.push({ name, type: type === 'symlink' ? 'other' : type, target: targetAt(directory), version: 'dir-v1' })
      }
    }
    for (const [filePath, record] of records) {
      if (path.dirname(filePath) !== (relative || '.')) continue
      output.push({
        name: path.basename(filePath),
        type: record.type === 'symlink' ? 'other' : record.type,
        target: targetAt(filePath),
        ...(record.bytes ? { size: record.bytes.byteLength } : {}),
        ...(record.version === undefined ? {} : { version: record.version }),
      })
    }
    return output
  }

  const fs = {
    async resolve(value, options = {}) {
      calls.push({ method: 'resolve', path: value, options })
      if (options.cwd !== undefined && options.cwd !== cwd && options.cwd !== projectRoot
        && !userRootMappings.some(root => root.path === options.cwd)) {
        return makeTarget(String(value), 'file', undefined, { outside: true, key: `outside:${String(value)}` })
      }
      const relative = relativeFromPath(value, options.cwd ?? cwd)
      if (relative === undefined) return makeTarget(String(value), 'file', undefined, { outside: true, key: `outside:${String(value)}` })
      const canonicalRelative = resolveSymlinks(relative)
      if (canonicalRelative === undefined) return makeTarget(String(value), 'file', undefined, { outside: true, key: `outside:${String(value)}` })
      const target = targetAt(canonicalRelative)
      if (!target) throw new Error(`missing test target: ${String(value)}`)
      const record = targets.get(target)?.record
      if (record?.resolveOutside) return makeTarget(relative, 'file', record, { outside: true, key: `outside:${relative}` })
      return target
    },
    contains(parent, child) {
      calls.push({ method: 'contains', parent, child })
      const parentInfo = targets.get(parent)
      const childInfo = targets.get(child)
      if (!parentInfo || !childInfo || parentInfo.cwd !== cwd || childInfo.cwd !== cwd || childInfo.outside
        || parentInfo.kind !== 'directory') return false
      if (childInfo.record?.afterContains !== undefined && childInfo.record.replaced && childInfo.after === true) {
        return childInfo.record.afterContains === true
      }
      const parentPath = parentInfo.relative
      const childPath = childInfo.relative
      return parentPath === '' || childPath === parentPath || childPath.startsWith(`${parentPath}/`)
    },
    async lstat(relative, options = {}, signal) {
      calls.push({ method: 'lstat', path: relative, options, signal })
      const resolvedPath = relativeFromPath(relative, options.cwd ?? cwd)
      if (resolvedPath === undefined) return undefined
      if (extraTypes.has(resolvedPath)) return { type: extraTypes.get(resolvedPath) }
      const record = records.get(resolvedPath)
      if (record) {
        record.lstatCalls = (record.lstatCalls ?? 0) + 1
        if (record.afterPathInfo !== undefined && record.replaced && record.lstatCalls > 1) return record.afterPathInfo
        if (record.pathInfo !== undefined) return record.pathInfo
        return { type: record.type, ...(record.bytes ? { size: record.bytes.byteLength } : {}), ...(record.version ? { version: record.version } : {}) }
      }
      if (directories.has(resolvedPath) || resolvedPath === '') return { type: 'directory', version: 'dir-v1' }
      return undefined
    },
    async stat(target, signal) {
      calls.push({ method: 'stat', target, signal })
      const info = targets.get(target)
      if (!info || info.outside) return undefined
      if (info.kind === 'directory') return info.record?.stat ?? { type: 'directory', version: 'dir-v1' }
      const record = info.record
      if (!record) return { type: info.kind }
      record.statCalls = (record.statCalls ?? 0) + 1
      return metadataFor(record, info.kind)
    },
    async listDir(target, signal) {
      const info = targets.get(target)
      calls.push({ method: 'listDir', path: info?.relative, target, signal })
      if (!info || info.kind !== 'directory' || info.outside) throw new Error('invalid test directory target')
      if (failListDir || info?.relative === failListDirPath) throw new Error('simulated listDir failure')
      if (hangListDir) return new Promise(resolve => { releaseListing = () => resolve(childrenOf(info.relative)) })
      const record = info.record
      if (record?.listError) throw new Error('simulated directory-list error')
      if (record?.listEntries) return record.listEntries
      return childrenOf(info.relative)
    },
    async readBytes(target, signal, maxBytes) {
      const info = targets.get(target)
      calls.push({ method: 'readBytes', target, signal, maxBytes })
      const record = info?.record
      if (!record || record.type !== 'file') throw new Error('missing test file bytes')
      record.readCalls = (record.readCalls ?? 0) + 1
      record.replaced = true
      record.onRead?.({ target, signal, maxBytes, record })
      if (typeof record.readBytes === 'function') return record.readBytes(target, signal, maxBytes)
      if (record.bytes.byteLength > maxBytes) throw new RangeError('readBytes limit exceeded')
      return record.bytes
    },
    setReadPath(value) {
      const relative = relativeFromPath(value)
      if (relative === undefined) {
        activeReadPath = value
        return
      }
      activeReadPath = relative
      addFile(relative)
    },
    setFileText(relative, text) {
      const record = records.get(relative)
      if (!record) throw new Error(`unknown test rule ${relative}`)
      record.text = text
      record.bytes = encoder.encode(text)
      record.statCalls = 0
      record.lstatCalls = 0
      record.replaced = false
    },
    calls,
    records,
    get releaseListing() { return releaseListing },
    get activeReadPath() { return activeReadPath },
  }
  fs.setReadPath(activeReadPath)
  return { fs, calls, records }
}

function userContext(text) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

async function makeHarness(options = {}) {
  const ctx = new Context()
  const systemPromptFiber = await ctx.plugin(SystemPrompt)
  const registryFiber = await ctx.plugin(AgentRegistry)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const agents = ctx.agents
  const sessions = new Map()
  const fileSystem = makeFileSystem(options)
  let outerPolicyFiber
  if (typeof options.outerPostExecute === 'function') {
    outerPolicyFiber = await ctx.plugin(pluginCtx => pluginCtx.on('tools/post-execute', async (_exec, _result, next) => {
      return options.outerPostExecute(await next())
    }))
  }
  const featureFiber = await ctx.plugin(pluginCtx => registerClaudeRulesOnReadContext(
    pluginCtx,
    agents,
    { get: id => sessions.get(id) },
    fileSystem.fs,
    options.userClaudeRulesRoots ?? [],
    {
      includeProjectOmoRoot: options.includeProjectOmoRoot ?? false,
      includeProjectClaudeRoot: options.includeProjectClaudeRoot ?? true,
      includeProjectCursorRoot: options.includeProjectCursorRoot ?? false,
      includeProjectGitHubInstructionsRoot: options.includeProjectGitHubInstructionsRoot ?? false,
      includeProjectGitHubCopilotInstructionsFile: options.includeProjectGitHubCopilotInstructionsFile ?? false,
      includeProjectSisyphusRoot: options.includeProjectSisyphusRoot ?? false,
      projectOmoRulesRoot: options.projectOmoRulesRoot,
      projectClaudeRulesRoot: options.projectClaudeRulesRoot,
      projectCursorRulesRoot: options.projectCursorRulesRoot,
      projectGitHubInstructionsRoot: options.projectGitHubInstructionsRoot,
      projectSisyphusRulesRoot: options.projectSisyphusRulesRoot,
      userOpenCodeRulesRoots: options.userOpenCodeRulesRoots ?? [],
      userSisyphusRulesRoot: options.userSisyphusRulesRoot,
    },
  ))
  let policyFiber
  const downstreamContext = options.downstreamContext ? userContext('downstream context') : undefined
  if (options.blockRead || options.blockTool || downstreamContext) {
    policyFiber = await ctx.plugin(pluginCtx => pluginCtx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name !== (options.blockTool ?? 'read')) return decision
      if (options.blockRead || options.blockTool) return { kind: 'block', feedback: [{ type: 'text', text: 'Blocked by test policy.' }] }
      return downstreamContext
        ? { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), downstreamContext] }
        : decision
    }))
  }

  const finalizerCalls = []
  const readTool = defineTool({
    name: 'read',
    description: 'Test-only canonical file reader.',
    parameters: { file_path: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { body: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `canonical:${value.body}` }],
    },
    async execute(args) {
      if (options.toolError) throw new Error('simulated read failure')
      return { body: `body:${String(args?.file_path ?? 'missing')}` }
    },
    finalizeContent(_exec, result) {
      finalizerCalls.push({ value: result.value, content: result.content, additionalContexts: result.additionalContexts })
      const rendered = result.content.map(block => block.type === 'text' ? block.text : '[non-text]').join('\n')
      return [{ type: 'text', text: `finalized:${rendered}` }]
    },
  })
  const fileOperationOutput = name => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { body: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: `${name}:${value.body}` }],
  })
  const writeTool = defineTool({
    name: 'write',
    description: 'Test-only file writer.',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: fileOperationOutput('write'),
    async execute(args) {
      if (options.toolErrorName === 'write') throw new Error('simulated write failure')
      fileSystem.fs.setReadPath(args?.file_path)
      return { body: String(args?.file_path ?? 'missing') }
    },
  })
  const editTool = defineTool({
    name: 'edit',
    description: 'Test-only file editor.',
    parameters: {
      file_path: { type: 'string', required: true },
      old_string: { type: 'string', required: true },
      new_string: { type: 'string', required: true },
      replace_all: { type: 'boolean' },
    },
    output: fileOperationOutput('edit'),
    async execute(args) {
      if (options.toolErrorName === 'edit') throw new Error('simulated edit failure')
      fileSystem.fs.setReadPath(args?.file_path)
      return { body: String(args?.file_path ?? 'missing') }
    },
  })
  const unregisterRead = ctx.tools.register(readTool)
  const unregisterWrite = ctx.tools.register(writeTool)
  const unregisterEdit = ctx.tools.register(editTool)
  const scopes = []
  const detachAgents = new Map()
  let callCount = 0

  async function createAgent(id = 'agent-1', cwd = options.cwd ?? CWD, source = 'startup') {
    const agent = { id, session: { id } }
    const scope = createScope(ctx, agent)
    scopes.push(scope)
    await scope.ctx.inject(['systemPrompt'], injected => { agent.ctx = injected })
    sessions.set(id, { header: { id, cwd } })
    const detach = agents.enter(agent, undefined)
    detachAgents.set(id, detach)
    await agents.announce(agent, source)
    return agent
  }

  async function reannounce(agent, source) {
    detachAgents.get(agent.id)?.()
    detachAgents.set(agent.id, agents.enter(agent, undefined))
    await agents.announce(agent, source)
  }

  async function executeFileOperation(agent, name, filePath = fileSystem.fs.activeReadPath, extraArgs = {}, { signal = new AbortController().signal } = {}) {
    if (name === 'read') fileSystem.fs.setReadPath(filePath)
    callCount++
    return ctx.tools.execute({
      callId: `${name}-${callCount}`,
      name,
      arguments: { file_path: filePath, ...extraArgs },
      agent,
      signal,
    })
  }

  async function executeRead(agent, filePath = fileSystem.fs.activeReadPath, options = {}) {
    return executeFileOperation(agent, 'read', filePath, {}, options)
  }

  async function disposeFeature() {
    await featureFiber.dispose()
  }

  async function dispose() {
    await featureFiber.dispose()
    await policyFiber?.dispose()
    await outerPolicyFiber?.dispose()
    unregisterRead()
    unregisterWrite()
    unregisterEdit()
    for (const detach of detachAgents.values()) detach()
    detachAgents.clear()
    for (const scope of scopes) await scope.dispose()
    await toolsFiber.dispose()
    await registryFiber.dispose()
    await systemPromptFiber.dispose()
  }

  return { ctx, agents, sessions, fileSystem, finalizerCalls, createAgent, reannounce, executeFileOperation, executeRead, disposeFeature, dispose }
}

function contextTexts(result) {
  return (result.additionalContexts ?? []).map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
}

test('validates one explicit normalized absolute user Claude rules root', () => {
  assert.deepEqual(normalizeUserClaudeRulesRoots(undefined), [])
  assert.deepEqual(normalizeUserClaudeRulesRoots([USER_CLAUDE_RULES_ROOT]), [USER_CLAUDE_RULES_ROOT])
  assert.deepEqual(normalizeUserClaudeRulesRoots([`${USER_CLAUDE_RULES_ROOT}/`]), [USER_CLAUDE_RULES_ROOT])
  assert.ok(Object.isFrozen(normalizeUserClaudeRulesRoots([USER_CLAUDE_RULES_ROOT])))
  assert.throws(() => normalizeUserClaudeRulesRoots(USER_CLAUDE_RULES_ROOT), /must be an array/u)
  assert.throws(() => normalizeUserClaudeRulesRoots([`${USER_CLAUDE_RULES_ROOT}`, `${USER_CLAUDE_RULES_ROOT}`]), /at most one/u)
  for (const invalid of [
    '.claude/rules',
    '~/.claude/rules',
    '/Users/alice/.claude/commands',
    '/Users/alice/.claude/../.claude/rules',
    `${USER_CLAUDE_RULES_ROOT}\\`,
    ` ${USER_CLAUDE_RULES_ROOT}`,
  ]) {
    assert.throws(() => normalizeUserClaudeRulesRoots([invalid]), /normalized absolute path/u, invalid)
  }
})

test('validates one explicit normalized absolute non-root project OMO rules root', () => {
  assert.equal(normalizeProjectOmoRulesRoot(undefined), undefined)
  assert.equal(normalizeProjectOmoRulesRoot(''), undefined)
  assert.equal(normalizeProjectOmoRulesRoot('/repo'), '/repo')
  assert.equal(normalizeProjectOmoRulesRoot('/repo/'), '/repo')
  for (const invalid of ['relative/path', '/', '/repo/../other', '/repo\\rules', ' /repo']) {
    assert.throws(() => normalizeProjectOmoRulesRoot(invalid), /normalized absolute non-filesystem-root path/u, invalid)
  }
})

test('validates one explicit normalized absolute non-root project Claude rules root', () => {
  assert.equal(normalizeProjectClaudeRulesRoot(undefined), undefined)
  assert.equal(normalizeProjectClaudeRulesRoot(''), undefined)
  assert.equal(normalizeProjectClaudeRulesRoot('/repo'), '/repo')
  assert.equal(normalizeProjectClaudeRulesRoot('/repo/'), '/repo')
  for (const invalid of ['relative/path', '/', '/repo/../other', '/repo\\rules', ' /repo']) {
    assert.throws(() => normalizeProjectClaudeRulesRoot(invalid), /normalized absolute non-filesystem-root path/u, invalid)
  }
})

test('validates one explicit normalized absolute non-root project Cursor rules root', () => {
  assert.equal(normalizeProjectCursorRulesRoot(undefined), undefined)
  assert.equal(normalizeProjectCursorRulesRoot(''), undefined)
  assert.equal(normalizeProjectCursorRulesRoot('/repo'), '/repo')
  assert.equal(normalizeProjectCursorRulesRoot('/repo/'), '/repo')
  for (const invalid of ['relative/path', '/', '/repo/../other', '/repo\\rules', ' /repo']) {
    assert.throws(() => normalizeProjectCursorRulesRoot(invalid), /normalized absolute non-filesystem-root path/u, invalid)
  }
})

test('validates one explicit normalized absolute non-root project GitHub instructions root', () => {
  assert.equal(normalizeProjectGitHubInstructionsRoot(undefined), undefined)
  assert.equal(normalizeProjectGitHubInstructionsRoot(''), undefined)
  assert.equal(normalizeProjectGitHubInstructionsRoot('/repo'), '/repo')
  assert.equal(normalizeProjectGitHubInstructionsRoot('/repo/'), '/repo')
  for (const invalid of ['relative/path', '/', '/repo/../other', '/repo\\rules', ' /repo']) {
    assert.throws(() => normalizeProjectGitHubInstructionsRoot(invalid), /normalized absolute non-filesystem-root path/u, invalid)
  }
})

test('validates one explicit normalized absolute non-root project Sisyphus rules root', () => {
  assert.equal(normalizeProjectSisyphusRulesRoot(undefined), undefined)
  assert.equal(normalizeProjectSisyphusRulesRoot(''), undefined)
  assert.equal(normalizeProjectSisyphusRulesRoot('/repo'), '/repo')
  assert.equal(normalizeProjectSisyphusRulesRoot('/repo/'), '/repo')
  for (const invalid of ['relative/path', '/', '/repo/../other', '/repo\\rules', ' /repo']) {
    assert.throws(() => normalizeProjectSisyphusRulesRoot(invalid), /normalized absolute non-filesystem-root path/u, invalid)
  }
})

test('validates explicit OpenCode user roots and sorts sources in pinned priority', () => {
  assert.deepEqual(normalizeUserOpenCodeRulesRoots(undefined), [])
  assert.deepEqual(
    normalizeUserOpenCodeRulesRoots([USER_OPENCODE_RULES_ROOT, USER_OMO_RULES_ROOT]),
    [USER_OMO_RULES_ROOT, USER_OPENCODE_RULES_ROOT],
  )
  assert.deepEqual(normalizeUserOpenCodeRulesRoots([`${USER_OMO_RULES_ROOT}/`]), [USER_OMO_RULES_ROOT])
  assert.ok(Object.isFrozen(normalizeUserOpenCodeRulesRoots([USER_OMO_RULES_ROOT])))
  assert.throws(() => normalizeUserOpenCodeRulesRoots(USER_OMO_RULES_ROOT), /must contain/u)
  assert.throws(() => normalizeUserOpenCodeRulesRoots([
    USER_OMO_RULES_ROOT,
    '/Users/alice/other/.omo/rules',
  ]), /at most one root ending in .omo\/rules/u)
  assert.throws(() => normalizeUserOpenCodeRulesRoots([
    USER_OMO_RULES_ROOT,
    USER_OPENCODE_RULES_ROOT,
    USER_CLAUDE_RULES_ROOT,
  ]), /at most one absolute root/u)
  for (const invalid of [
    '.omo/rules',
    '~/.opencode/rules',
    '/Users/alice/.sisyphus/rules',
    '/Users/alice/.opencode/commands',
    '/Users/alice/.opencode/../.opencode/rules',
    `${USER_OPENCODE_RULES_ROOT}\\`,
    ` ${USER_OPENCODE_RULES_ROOT}`,
  ]) {
    assert.throws(() => normalizeUserOpenCodeRulesRoots([invalid]), /normalized absolute path/u, invalid)
  }
})

test('validates one explicit normalized absolute user Sisyphus rules root', () => {
  assert.equal(normalizeUserSisyphusRulesRoot(undefined), undefined)
  assert.equal(normalizeUserSisyphusRulesRoot(''), undefined)
  assert.equal(normalizeUserSisyphusRulesRoot(USER_SISYPHUS_RULES_ROOT), USER_SISYPHUS_RULES_ROOT)
  assert.equal(normalizeUserSisyphusRulesRoot(`${USER_SISYPHUS_RULES_ROOT}/`), USER_SISYPHUS_RULES_ROOT)
  for (const invalid of [
    'relative/.sisyphus/rules',
    '~/.sisyphus/rules',
    '/Users/alice/.sisyphus/commands',
    '/Users/alice/.sisyphus/rules/../other',
    '/Users/alice/.sisyphus\\rules',
    ` ${USER_SISYPHUS_RULES_ROOT}`,
  ]) {
    assert.throws(() => normalizeUserSisyphusRulesRoot(invalid), /normalized absolute path/u, invalid)
  }
})

test('injects alwaysApply and matching .md/.mdc rules while preserving native value/content and UserMessage shape', async () => {
  const harness = await makeHarness({ rules: {
    '.claude/rules/always.md': rule('always guidance', 'alwaysApply: true'),
    '.claude/rules/typescript.mdc': rule('typescript guidance', 'globs: "**/*.ts"'),
    '.claude/rules/no-pattern.md': rule('must not appear', 'description: no match'),
  } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/app.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/app.ts' }])
    assert.equal(harness.finalizerCalls.length, 1)
    assert.deepEqual(harness.finalizerCalls[0].value, result.value)
    assert.deepEqual(harness.finalizerCalls[0].content, [{ type: 'text', text: 'canonical:body:src/app.ts' }])
    const texts = contextTexts(result)
    assert.equal(texts.length, 2)
    assert.match(texts[0], /^\[Rule: \.claude\/rules\/always\.md\]\n\[Match: alwaysApply\]/u)
    assert.match(texts[1], /^\[Rule: \.claude\/rules\/typescript\.mdc\]\n\[Match: glob: /u)
    assert.match(texts[0], /always guidance/u)
    assert.match(texts[1], /Untrusted/u)
    assert.ok(result.additionalContexts.every(message => message.role === 'user' && message.source.kind === 'user'))
  } finally {
    await harness.dispose()
  }
})

test('sorts recursively scanned rule files by relative path rather than traversal order', async () => {
  const harness = await makeHarness({ rules: {
    '.claude/rules/a/child.md': rule('nested lexical path', 'alwaysApply: true'),
    '.claude/rules/a0.md': rule('sibling lexical path', 'alwaysApply: true'),
  } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.claude/rules/a/child.md',
      '.claude/rules/a0.md',
    ])
  } finally {
    await harness.dispose()
  }
})

test('session-cwd OMO project rules remain default-off', async () => {
  const harness = await makeHarness({
    rules: { '.omo/rules/disabled.md': rule('must not be read without the opt-in') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.omo'), false)
  } finally {
    await harness.dispose()
  }
})

test('session-cwd Cursor project rules remain default-off', async () => {
  const harness = await makeHarness({
    rules: { '.cursor/rules/disabled.mdc': rule('must not be read without the opt-in') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.cursor'), false)
  } finally {
    await harness.dispose()
  }
})

test('session-cwd GitHub instruction sources remain default-off', async () => {
  const harness = await makeHarness({
    rules: {
      '.github/instructions/disabled.instructions.md': rule('must remain unread without the opt-in', 'alwaysApply: true'),
      '.github/copilot-instructions.md': 'Copilot instructions must remain unread without the opt-in.',
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.github'), false)
  } finally {
    await harness.dispose()
  }
})

test('Cursor-only mode scans session-cwd .cursor/rules with .mdc glob matching', async () => {
  const harness = await makeHarness({
    includeProjectOmoRoot: false,
    includeProjectClaudeRoot: false,
    includeProjectCursorRoot: true,
    rules: {
      '.cursor/rules/typescript.mdc': rule('Cursor TypeScript guidance', 'description: Applies to TypeScript source\nglobs: "src/*.ts"'),
      '.cursor/rules/ignored.mdc': rule('nonmatching Cursor guidance', 'globs: "docs/*.ts"'),
      '.omo/rules/ignored.md': rule('OMO source is independently disabled'),
      '.claude/rules/ignored.md': rule('Claude source is independently disabled'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.cursor/rules/typescript.mdc',
    ])
    assert.ok(texts[0].includes('Cursor TypeScript guidance'))
    assert.ok(texts[0].includes('[Match: glob: src/*.ts]'))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.omo'), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.claude'), false)
  } finally {
    await harness.dispose()
  }
})

test('GitHub-only mode matches cwd-relative applyTo and ignores non-instruction filenames', async () => {
  const harness = await makeHarness({
    includeProjectOmoRoot: false,
    includeProjectClaudeRoot: false,
    includeProjectCursorRoot: false,
    includeProjectGitHubInstructionsRoot: true,
    rules: {
      '.github/instructions/always.instructions.md': rule('always-applied GitHub instruction', 'alwaysApply: true'),
      '.github/instructions/matching.instructions.md': rule('matching GitHub TypeScript instruction', 'description: Applies to TypeScript files\napplyTo: "src/*.ts"'),
      '.github/instructions/nonmatching.instructions.md': rule('nonmatching GitHub instruction', 'applyTo: "docs/*.ts"'),
      '.github/instructions/no-pattern.instructions.md': rule('instruction without a matcher', 'description: No applyTo value'),
      '.github/instructions/plain.md': rule('plain Markdown is not a GitHub instruction', 'alwaysApply: true'),
      '.github/instructions/plain.mdc': rule('plain MDC is not a GitHub instruction', 'alwaysApply: true'),
      '.github/instructions/wrong-extension.instructions.mdc': rule('MDC instructions are not pinned candidates', 'alwaysApply: true'),
      '.github/copilot-instructions.md': rule('the separate GitHub single-file source is unsupported', 'alwaysApply: true'),
      '.omo/rules/ignored.md': rule('OMO source is independently disabled', 'alwaysApply: true'),
      '.claude/rules/ignored.md': rule('Claude source is independently disabled', 'alwaysApply: true'),
      '.cursor/rules/ignored.mdc': rule('Cursor source is independently disabled', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.github/instructions/always.instructions.md',
      '.github/instructions/matching.instructions.md',
    ])
    assert.ok(texts[0].includes('[Match: alwaysApply]'))
    assert.ok(texts[1].includes('[Match: glob: src/*.ts]'))
    const ignoredPaths = [
      '.github/instructions/plain.md',
      '.github/instructions/plain.mdc',
      '.github/instructions/wrong-extension.instructions.mdc',
      '.github/copilot-instructions.md',
    ]
    for (const ignoredPath of ignoredPaths) {
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === ignoredPath), false, `${ignoredPath} must not be read`)
    }
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && (call.path === '.omo' || call.path === '.claude' || call.path === '.cursor')), false)
  } finally {
    await harness.dispose()
  }
})

test('always applies the Copilot single file after instructions and before user roots', async () => {
  const copilotBody = 'Copilot guidance is always applied'
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: true,
    includeProjectGitHubCopilotInstructionsFile: true,
    userOpenCodeRulesRoots: [USER_OPENCODE_RULES_ROOT, USER_OMO_RULES_ROOT],
    rules: {
      '.github/instructions/first.instructions.md': rule('GitHub directory source', 'alwaysApply: true'),
      '.github/copilot-instructions.md': rule(copilotBody, 'applyTo: "docs/*.ts"'),
      '@opencode0/duplicate.md': rule(copilotBody, 'alwaysApply: true'),
      '@opencode1/user.md': rule('explicit user source after Copilot', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.github/instructions/first.instructions.md',
      '.github/copilot-instructions.md',
      'user/.omo/rules/user.md',
    ])
    assert.ok(texts[1].includes('[Match: copilot-instructions (always apply)]'))
    assert.ok(texts[1].includes(copilotBody))
    assert.equal(texts[1].includes('applyTo:'), false, 'valid frontmatter is stripped from the injected body')
  } finally {
    await harness.dispose()
  }
})

test('injects plain Markdown Copilot instructions without requiring frontmatter', async () => {
  const body = '# Repository guidance\nUse the project formatter.'
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: { '.github/copilot-instructions.md': body },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.equal(texts.length, 1)
    assert.ok(texts[0].includes('[Rule: .github/copilot-instructions.md]'))
    assert.ok(texts[0].includes('[Match: copilot-instructions (always apply)]'))
    assert.ok(texts[0].includes(body))
  } finally {
    await harness.dispose()
  }
})

test('strips valid Copilot YAML frontmatter without applying rule-matcher pattern limits', async () => {
  const body = 'Copilot content after the valid YAML header.'
  const frontmatterValue = 'x'.repeat(4_097)
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: {
      '.github/copilot-instructions.md': `---\napplyTo: "${frontmatterValue}"\n---\n${body}`,
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.equal(texts.length, 1)
    assert.ok(texts[0].includes(body))
    assert.equal(texts[0].includes('applyTo:'), false)
  } finally {
    await harness.dispose()
  }
})

test('keeps default-off deprecated .sisyphus project rules omitted while loading the prioritized Copilot source', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: {
      '.github/copilot-instructions.md': rule('supported Copilot instructions', 'alwaysApply: true'),
      '.sisyphus/rules/deprecated.md': rule('deprecated Sisyphus rules must remain omitted', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.github/copilot-instructions.md',
    ])
    assert.ok(contextTexts(result)[0].includes('supported Copilot instructions'))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.sisyphus'), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.sisyphus/rules/deprecated.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('rejects a regular Copilot file whose resolved target escapes the .github parent', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: {
      '.github/copilot-instructions.md': rule('escaped Copilot file must not be read', 'alwaysApply: true'),
      'outside/copilot-instructions.md': rule('outside target', 'alwaysApply: true'),
    },
  })
  const resolve = harness.fileSystem.fs.resolve.bind(harness.fileSystem.fs)
  harness.fileSystem.fs.resolve = async (value, options = {}) => {
    if (value === '.github/copilot-instructions.md' && options.cwd === CWD) {
      return resolve('outside/copilot-instructions.md', { cwd: CWD })
    }
    return resolve(value, options)
  }
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.github/copilot-instructions.md'), true)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
      && call.target?.relative === '.github/copilot-instructions.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('does not inject a Copilot file after its resolved target identity changes during read', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: {
      '.github/copilot-instructions.md': {
        text: rule('stale Copilot file contents must not inject', 'alwaysApply: true'),
        afterTargetKey: 'file:replacement-after-read',
      },
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes'
      && call.target?.relative === '.github/copilot-instructions.md').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('keeps the session cwd as the matching root for files beneath a nested project path', async () => {
  const nestedFilePath = 'apps/appA/src/app.ts'
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: true,
    rules: {
      '.github/instructions/monorepo.instructions.md': rule('CWD-root instruction can match a nested project path', 'applyTo: "apps/appA/src/*.ts"'),
      'apps/appA/package.json': rule('marker data is not part of instruction discovery'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, nestedFilePath)
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.github/instructions/monorepo.instructions.md',
    ])
    assert.ok(texts[0].includes('[Match: glob: apps/appA/src/*.ts]'))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === 'apps/appA/package.json'), false)
  } finally {
    await harness.dispose()
  }
})

test('matches explicit project-root Claude rules for a nested session cwd', async () => {
  const projectRoot = '/repo'
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot,
    projectClaudeRulesRoot: projectRoot,
    includeProjectClaudeRoot: false,
    rules: {
      '@project/.claude/rules/monorepo.md': rule('project-root guidance matches from the configured root', 'applyTo: "apps/a/src/*.ts"'),
      '@project/.claude/rules/cwd-relative-only.md': rule('this root rule must not use cwd-relative matching', 'applyTo: "src/*.ts"'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.claude/rules/monorepo.md',
    ])
    assert.ok(texts[0].includes('[Match: glob: apps/a/src/*.ts]'))
    assert.ok(texts[0].includes('project-root guidance matches from the configured root'))
    assert.deepEqual(result.value, { body: 'body:src/x.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/x.ts' }])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat'
      && typeof call.path === 'string' && call.path.split('/').includes('..')), false, 'explicit-root scanning never probes ancestors')
  } finally {
    await harness.dispose()
  }
})

test('does not read explicit project-root rules for a sibling cwd or symlinked rules root', async t => {
  await t.test('sibling cwd is outside the configured project root', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/b',
      projectRoot: '/repo/apps/a',
      projectClaudeRulesRoot: '/repo/apps/a',
      includeProjectClaudeRoot: false,
      rules: { '@project/.claude/rules/always.md': rule('sibling guidance must not inject') },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && String(call.path).startsWith('@project/.claude/rules')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked project rules directory fails closed', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectClaudeRulesRoot: '/repo',
      includeProjectClaudeRoot: false,
      types: { '@project/.claude/rules': 'symlink' },
      rules: { '@project/.claude/rules/always.md': rule('symlink guidance must not inject') },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && String(call.path).startsWith('@project/.claude/rules')), false)
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).startsWith('@project/.claude/rules')), false)
    } finally {
      await harness.dispose()
    }
  })
})

test('deduplicates explicit project-root Claude rules when the configured root equals cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo',
    projectRoot: '/repo',
    projectClaudeRulesRoot: '/repo',
    includeProjectClaudeRoot: true,
    rules: { '@project/.claude/rules/always.md': rule('one root, one injection') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.claude/rules/always.md',
    ])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.claude/rules').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('preserves root-relative globs when a CWD symlink alias resolves to the configured root', async () => {
  const harness = await makeHarness({
    cwd: '/repo/self',
    projectRoot: '/repo',
    projectClaudeRulesRoot: '/repo',
    includeProjectClaudeRoot: true,
    types: {
      '@project/self': 'symlink',
      '@project/self/.claude': 'directory',
      '@project/self/.claude/rules': 'directory',
    },
    symlinkTargets: { '@project/self': '@project' },
    rules: {
      '@project/.claude/rules/monorepo.md': rule('alias-root guidance', 'applyTo: "self/src/*.ts"'),
      '@project/.claude/rules/cwd-alias.md': rule('cwd-relative alias guidance', 'applyTo: "src/*.ts"'),
      '@project/src/x.ts': 'canonical source target',
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.claude/rules/cwd-alias.md',
      'project-root/.claude/rules/monorepo.md',
    ])
    assert.ok(texts[0].includes('[Match: glob: src/*.ts]'), 'CWD-relative alias patterns remain eligible')
    assert.ok(texts[1].includes('[Match: glob: self/src/*.ts]'), 'configured-root patterns use the explicit root-relative path')
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.claude/rules').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('matches explicit project-root Cursor rules for a nested session cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectCursorRulesRoot: '/repo',
    includeProjectClaudeRoot: false,
    rules: {
      '@project/.cursor/rules/always.md': rule('explicit-root Cursor always-apply guidance'),
      '@project/.cursor/rules/monorepo.mdc': rule(
        'explicit-root Cursor glob guidance',
        'description: Apply to TypeScript files\napplyTo: "apps/a/src/*.ts"',
      ),
      '@project/.cursor/rules/cwd-relative-only.md': rule(
        'this project-root rule must not use cwd-relative matching',
        'applyTo: "src/*.ts"',
      ),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.cursor/rules/always.md',
      'project-root/.cursor/rules/monorepo.mdc',
    ])
    assert.ok(texts[0].includes('[Match: alwaysApply]'))
    assert.ok(texts[1].includes('[Match: glob: apps/a/src/*.ts]'))
    assert.deepEqual(result.value, { body: 'body:src/x.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/x.ts' }])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat'
      && typeof call.path === 'string' && call.path.split('/').includes('..')), false)
  } finally {
    await harness.dispose()
  }
})

test('orders closer CWD rules before farther project roots, then preserves pinned source priority', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectClaudeRulesRoot: '/repo',
    projectCursorRulesRoot: '/repo',
    includeProjectClaudeRoot: true,
    includeProjectCursorRoot: true,
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    rules: {
      '@project/.claude/rules/project.md': rule('project Claude priority'),
      '@project/.cursor/rules/project.mdc': rule('project Cursor priority'),
      '@project/apps/a/.claude/rules/cwd.md': rule('CWD Claude priority'),
      '@project/apps/a/.cursor/rules/cwd.mdc': rule('CWD Cursor priority'),
      '@user/user.md': rule('explicit user rules follow project sources'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.claude/rules/cwd.md',
      '.cursor/rules/cwd.mdc',
      'project-root/.claude/rules/project.md',
      'project-root/.cursor/rules/project.mdc',
      'user/.claude/rules/user.md',
    ])
  } finally {
    await harness.dispose()
  }
})

test('deduplicates explicit project-root Cursor rules when the configured root equals cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo',
    projectRoot: '/repo',
    projectCursorRulesRoot: '/repo',
    includeProjectCursorRoot: true,
    rules: { '@project/.cursor/rules/always.mdc': rule('one Cursor root, one injection') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.cursor/rules/always.mdc',
    ])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.cursor/rules').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('preserves root-relative and CWD-relative Cursor globs for a root symlink alias', async () => {
  const harness = await makeHarness({
    cwd: '/repo/self',
    projectRoot: '/repo',
    projectCursorRulesRoot: '/repo',
    includeProjectCursorRoot: true,
    types: {
      '@project/self': 'symlink',
      '@project/self/.cursor': 'directory',
      '@project/self/.cursor/rules': 'directory',
    },
    symlinkTargets: { '@project/self': '@project' },
    rules: {
      '@project/.cursor/rules/cwd-alias.mdc': rule('CWD-relative alias guidance', 'applyTo: "src/*.ts"'),
      '@project/.cursor/rules/project-root.mdc': rule('project-root alias guidance', 'applyTo: "self/src/*.ts"'),
      '@project/src/x.ts': 'canonical source target',
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.cursor/rules/cwd-alias.mdc',
      'project-root/.cursor/rules/project-root.mdc',
    ])
    assert.ok(texts[0].includes('[Match: glob: src/*.ts]'))
    assert.ok(texts[1].includes('[Match: glob: self/src/*.ts]'))
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.cursor/rules').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root Cursor rules fail closed outside scope and on symlinked roots', async t => {
  await t.test('sibling cwd is outside the configured root', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/b',
      projectRoot: '/repo/apps/a',
      projectCursorRulesRoot: '/repo/apps/a',
      rules: { '@project/.cursor/rules/always.md': rule('sibling Cursor guidance') },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && String(call.path).startsWith('@project/.cursor/rules')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked .cursor and rules directories fail closed', async () => {
    for (const symlinkPath of ['@project/.cursor', '@project/.cursor/rules']) {
      const harness = await makeHarness({
        cwd: '/repo/apps/a',
        projectRoot: '/repo',
        projectCursorRulesRoot: '/repo',
        types: { [symlinkPath]: 'symlink' },
        rules: { '@project/.cursor/rules/always.md': rule('symlink Cursor guidance') },
      })
      try {
        const agent = await harness.createAgent()
        assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
          && String(call.path).startsWith('@project/.cursor/rules')), false)
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
          && String(call.target?.relative).startsWith('@project/.cursor/rules')), false)
      } finally {
        await harness.dispose()
      }
    }
  })
})

test('matches explicit project-root GitHub instructions for a nested session cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectClaudeRoot: false,
    rules: {
      '@project/.github/instructions/always.instructions.md': rule('explicit-root always-apply instruction', 'alwaysApply: true'),
      '@project/.github/instructions/monorepo.instructions.md': rule(
        'explicit-root GitHub glob guidance',
        'description: Apply to TypeScript files\napplyTo: "apps/a/src/*.ts"',
      ),
      '@project/.github/instructions/cwd-relative.instructions.md': rule(
        'project-root instructions must not use cwd-relative matching',
        'applyTo: "src/*.ts"',
      ),
      '@project/.github/instructions/plain.md': rule('plain Markdown is not a GitHub instruction', 'alwaysApply: true'),
      '@project/.github/instructions/wrong-extension.instructions.mdc': rule('MDC is not a GitHub instruction', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.github/instructions/always.instructions.md',
      'project-root/.github/instructions/monorepo.instructions.md',
    ])
    assert.ok(texts[0].includes('[Match: alwaysApply]'))
    assert.ok(texts[1].includes('[Match: glob: apps/a/src/*.ts]'))
    assert.deepEqual(result.value, { body: 'body:src/x.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/x.ts' }])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.github/instructions').length, 1)
    for (const suffix of ['/plain.md', '/wrong-extension.instructions.mdc']) {
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).endsWith(suffix)), false, `${suffix} must not be read`)
    }
  } finally {
    await harness.dispose()
  }
})

test('orders distance-zero project Copilot before CWD sources and nearer CWD before ancestor directories', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectOmoRoot: true,
    includeProjectGitHubInstructionsRoot: true,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: {
      '@project/apps/a/.omo/rules/cwd.md': rule('closer CWD OMO rule', 'alwaysApply: true'),
      '@project/.github/instructions/root.instructions.md': rule('project GitHub rules', 'alwaysApply: true'),
      '@project/apps/a/.github/instructions/cwd.instructions.md': rule('cwd GitHub rules', 'alwaysApply: true'),
      '@project/.github/copilot-instructions.md': 'project-root Copilot guidance.',
      '@project/apps/a/.github/copilot-instructions.md': 'cwd Copilot guidance.',
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.github/copilot-instructions.md',
      '.omo/rules/cwd.md',
      '.github/instructions/cwd.instructions.md',
      '.github/copilot-instructions.md',
      'project-root/.github/instructions/root.instructions.md',
    ])
    assert.ok(texts[0].includes('project-root Copilot guidance.'))
    assert.ok(texts[3].includes('cwd Copilot guidance.'))
  } finally {
    await harness.dispose()
  }
})

test('loads explicit-root Copilot guidance only when its Copilot opt-in is enabled', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: false,
    includeProjectGitHubCopilotInstructionsFile: false,
    rules: { '@project/.github/copilot-instructions.md': 'must not be read without Copilot opt-in.' },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.equal(contextTexts(result).length, 0)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
      && String(call.target?.relative).endsWith('.github/copilot-instructions.md')), false)
  } finally {
    await harness.dispose()
  }
})

test('loads explicit-root Copilot guidance when CWD GitHub instructions are disabled', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: { '@project/.github/copilot-instructions.md': 'root Copilot remains an explicit opt-in.' },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.github/copilot-instructions.md',
    ])
    assert.ok(contextTexts(result)[0].includes('root Copilot remains an explicit opt-in.'))
  } finally {
    await harness.dispose()
  }
})

test('does not read configured project files when the explicit-root opt-in is absent', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: { '@project/.github/copilot-instructions.md': 'root must remain unavailable without its root flag.' },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
      && String(call.target?.relative).startsWith('@project/.github/copilot-instructions.md')), false)
  } finally {
    await harness.dispose()
  }
})

test('deduplicates the explicit-root Copilot file when the configured root equals cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: true,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: { '@project/.github/copilot-instructions.md': 'one exact CWD Copilot source.' },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.equal(contextTexts(result).length, 1)
    assert.ok(contextTexts(result)[0].includes('[Rule: .github/copilot-instructions.md]'))
    assert.ok(contextTexts(result)[0].includes('one exact CWD Copilot source.'))
  } finally {
    await harness.dispose()
  }
})

test('deduplicates the root Copilot file when CWD aliases the configured root target', async () => {
  const harness = await makeHarness({
    cwd: '/repo/self',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: true,
    includeProjectGitHubCopilotInstructionsFile: true,
    types: { '@project/self': 'symlink', '@project/self/.github': 'directory' },
    symlinkTargets: { '@project/self': '@project' },
    rules: {
      '@project/.github/copilot-instructions.md': 'one canonical Copilot file.',
      '@project/src/x.ts': 'canonical source target',
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.equal(contextTexts(result).length, 1)
    assert.ok(contextTexts(result)[0].includes('[Rule: project-root/.github/copilot-instructions.md]'))
    assert.ok(contextTexts(result)[0].includes('one canonical Copilot file.'))
  } finally {
    await harness.dispose()
  }
})

test('explicit-root Copilot guidance fails closed outside the Agent boundary and on symlinks', async t => {
  await t.test('a sibling cwd cannot read the configured root file', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/b',
      projectRoot: '/repo/apps/a',
      projectGitHubInstructionsRoot: '/repo/apps/a',
      includeProjectClaudeRoot: false,
      includeProjectGitHubInstructionsRoot: true,
      includeProjectGitHubCopilotInstructionsFile: true,
      rules: { '@project/.github/copilot-instructions.md': 'sibling root must stay unread.' },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).startsWith('@project/.github/copilot-instructions.md')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('a symlinked .github parent is not traversed', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectGitHubInstructionsRoot: '/repo',
      includeProjectClaudeRoot: false,
      includeProjectGitHubInstructionsRoot: true,
      includeProjectGitHubCopilotInstructionsFile: true,
      types: { '@project/.github': 'symlink' },
      rules: { '@project/.github/copilot-instructions.md': 'symlink parent must stay unread.' },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).startsWith('@project/.github/copilot-instructions.md')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('a symlinked Copilot file is not read', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectGitHubInstructionsRoot: '/repo',
      includeProjectClaudeRoot: false,
      includeProjectGitHubInstructionsRoot: true,
      includeProjectGitHubCopilotInstructionsFile: true,
      types: { '@project/.github/copilot-instructions.md': 'symlink' },
      rules: { '@project/.github/copilot-instructions.md': 'symlink file must stay unread.' },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).startsWith('@project/.github/copilot-instructions.md')), false)
    } finally {
      await harness.dispose()
    }
  })
})

test('adds explicit-root GitHub instructions after successful read, write, and edit results', async () => {
  for (const name of ['read', 'write', 'edit']) {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectGitHubInstructionsRoot: '/repo',
      rules: { '@project/.github/instructions/always.instructions.md': rule('project-root operation guidance', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      const extraArgs = name === 'write' ? { content: 'new content' }
        : name === 'edit' ? { old_string: 'old', new_string: 'new' } : {}
      const result = await harness.executeFileOperation(agent, name, 'src/x.ts', extraArgs)
      assert.equal(contextTexts(result).length, 1, `${name} must receive the explicit-root context`)
      assert.deepEqual(result.value, { body: name === 'read' ? 'body:src/x.ts' : 'src/x.ts' })
      if (name === 'read') {
        assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/x.ts' }])
      } else {
        assert.deepEqual(result.content, [{ type: 'text', text: `${name}:src/x.ts` }])
      }
    } finally {
      await harness.dispose()
    }
  }
})

test('drops explicit-root GitHub instructions when the configured project root identity changes during scanning', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    rules: {
      '@project': {
        type: 'directory',
        version: 'v1',
        stat: { type: 'directory', version: 'v1' },
        replaced: true,
        afterPathInfo: { type: 'directory', version: 'v2' },
      },
      '@project/.github/instructions/always.instructions.md': rule('stale root must not publish', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.deepEqual(result.value, { body: 'body:src/x.ts' })
  } finally {
    await harness.dispose()
  }
})

test('orders explicit project-root GitHub instructions after all closer CWD sources', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectCursorRoot: true,
    includeProjectGitHubInstructionsRoot: true,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: {
      '@project/apps/a/.cursor/rules/cwd.mdc': rule('CWD Cursor priority', 'alwaysApply: true'),
      '@project/.github/instructions/project.instructions.md': rule('explicit project GitHub priority', 'alwaysApply: true'),
      '@project/apps/a/.github/instructions/cwd.instructions.md': rule('CWD GitHub priority', 'alwaysApply: true'),
      '@project/apps/a/.github/copilot-instructions.md': rule('CWD Copilot priority', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.cursor/rules/cwd.mdc',
      '.github/instructions/cwd.instructions.md',
      '.github/copilot-instructions.md',
      'project-root/.github/instructions/project.instructions.md',
    ])
  } finally {
    await harness.dispose()
  }
})

test('deduplicates explicit project-root GitHub instructions when the configured root equals cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectGitHubInstructionsRoot: true,
    rules: { '@project/.github/instructions/always.instructions.md': rule('one GitHub root, one injection', 'alwaysApply: true') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.github/instructions/always.instructions.md',
    ])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.github/instructions').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('preserves root-relative and CWD-relative GitHub globs for a root symlink alias', async () => {
  const harness = await makeHarness({
    cwd: '/repo/self',
    projectRoot: '/repo',
    projectGitHubInstructionsRoot: '/repo',
    includeProjectGitHubInstructionsRoot: true,
    types: {
      '@project/self': 'symlink',
      '@project/self/.github': 'directory',
      '@project/self/.github/instructions': 'directory',
    },
    symlinkTargets: { '@project/self': '@project' },
    rules: {
      '@project/.github/instructions/cwd-alias.instructions.md': rule('CWD-relative alias guidance', 'applyTo: "src/*.ts"'),
      '@project/.github/instructions/project-root.instructions.md': rule('project-root alias guidance', 'applyTo: "self/src/*.ts"'),
      '@project/src/x.ts': 'canonical source target',
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.github/instructions/cwd-alias.instructions.md',
      'project-root/.github/instructions/project-root.instructions.md',
    ])
    assert.ok(texts[0].includes('[Match: glob: src/*.ts]'))
    assert.ok(texts[1].includes('[Match: glob: self/src/*.ts]'))
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.github/instructions').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root GitHub instructions fail closed outside scope and on symlinked roots', async t => {
  await t.test('sibling cwd is outside the configured root', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/b',
      projectRoot: '/repo/apps/a',
      projectGitHubInstructionsRoot: '/repo/apps/a',
      rules: { '@project/.github/instructions/always.instructions.md': rule('sibling instructions', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && String(call.path).startsWith('@project/.github/instructions')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked project, .github, and instructions roots fail closed', async () => {
    for (const symlinkPath of ['@project', '@project/.github', '@project/.github/instructions']) {
      const harness = await makeHarness({
        cwd: '/repo/apps/a',
        projectRoot: '/repo',
        projectGitHubInstructionsRoot: '/repo',
        types: { [symlinkPath]: 'symlink' },
        rules: { '@project/.github/instructions/always.instructions.md': rule('symlink instructions', 'alwaysApply: true') },
      })
      try {
        const agent = await harness.createAgent()
        assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
          && String(call.path).startsWith('@project/.github/instructions')), false)
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
          && String(call.target?.relative).startsWith('@project/.github/instructions')), false)
      } finally {
        await harness.dispose()
      }
    }
  })
})

test('explicit project-root GitHub instructions preserve failure, cap, and cancellation gates', async t => {
  await t.test('failed and blocked operations receive no project context', async () => {
    for (const options of [{ toolError: true }, { blockRead: true }]) {
      const harness = await makeHarness({
        cwd: '/repo/apps/a',
        projectRoot: '/repo',
        projectGitHubInstructionsRoot: '/repo',
        rules: { '@project/.github/instructions/always.instructions.md': rule('only successful operations', 'alwaysApply: true') },
        ...options,
      })
      try {
        const agent = await harness.createAgent()
        assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      } finally {
        await harness.dispose()
      }
    }
  })

  await t.test('scanner cap prevents reading an overlarge explicit root', async () => {
    const rules = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
      `@project/.github/instructions/rule-${index}.instructions.md`, rule(`bounded-${index}`, 'alwaysApply: true'),
    ]))
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectGitHubInstructionsRoot: '/repo',
      rules,
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/x.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.deepEqual(result.value, { body: 'body:src/x.ts' })
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).startsWith('@project/.github/instructions')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('cancellation cannot append a partial project-root GitHub context', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectGitHubInstructionsRoot: '/repo',
      hangListDir: true,
      rules: { '@project/.github/instructions/always.instructions.md': rule('cancelled instructions', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      const controller = new AbortController()
      const pending = harness.executeRead(agent, 'src/x.ts', { signal: controller.signal })
      while (!harness.fileSystem.calls.some(call => call.method === 'listDir'
        && call.path === '@project/.github/instructions')) await new Promise(resolve => setImmediate(resolve))
      controller.abort()
      harness.fileSystem.fs.releaseListing?.()
      assert.deepEqual(contextTexts(await pending), [])
    } finally {
      harness.fileSystem.fs.releaseListing?.()
      await harness.dispose()
    }
  })
})

test('explicit project-root Cursor scanning preserves outcomes and shared caps', async t => {
  await t.test('failed and blocked file operations receive no project context', async () => {
    for (const options of [{ toolError: true }, { blockRead: true }]) {
      const harness = await makeHarness({
        cwd: '/repo/apps/a',
        projectRoot: '/repo',
        projectCursorRulesRoot: '/repo',
        rules: { '@project/.cursor/rules/always.mdc': rule('must only follow successful reads') },
        ...options,
      })
      try {
        const agent = await harness.createAgent()
        assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      } finally {
        await harness.dispose()
      }
    }
  })

  await t.test('scanner cap prevents reading an overlarge explicit root', async () => {
    const rules = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
      `@project/.cursor/rules/rule-${index}.mdc`, rule(`bounded-${index}`),
    ]))
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectCursorRulesRoot: '/repo',
      rules,
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/x.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.deepEqual(result.value, { body: 'body:src/x.ts' })
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).startsWith('@project/.cursor/rules')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('cancellation cannot append a partial project-root Cursor context', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectCursorRulesRoot: '/repo',
      hangListDir: true,
      rules: { '@project/.cursor/rules/always.mdc': rule('cancelled Cursor guidance') },
    })
    try {
      const agent = await harness.createAgent()
      const controller = new AbortController()
      const pending = harness.executeRead(agent, 'src/x.ts', { signal: controller.signal })
      while (!harness.fileSystem.calls.some(call => call.method === 'listDir'
        && call.path === '@project/.cursor/rules')) await new Promise(resolve => setImmediate(resolve))
      controller.abort()
      harness.fileSystem.fs.releaseListing?.()
      assert.deepEqual(contextTexts(await pending), [])
    } finally {
      harness.fileSystem.fs.releaseListing?.()
      await harness.dispose()
    }
  })
})

test('explicit project-root Claude scanning keeps existing success, cap, and cancellation gates', async t => {
  await t.test('failed and blocked file operations receive no project context', async () => {
    for (const options of [{ toolError: true }, { blockRead: true }]) {
      const harness = await makeHarness({
        cwd: '/repo/apps/a',
        projectRoot: '/repo',
        projectClaudeRulesRoot: '/repo',
        includeProjectClaudeRoot: false,
        rules: { '@project/.claude/rules/always.md': rule('must only follow successful reads') },
        ...options,
      })
      try {
        const agent = await harness.createAgent()
        assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      } finally {
        await harness.dispose()
      }
    }
  })

  await t.test('scanner cap stops a large explicit root before reading rules', async () => {
    const rules = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
      `@project/.claude/rules/rule-${index}.md`, rule(`bounded-${index}`),
    ]))
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectClaudeRulesRoot: '/repo',
      includeProjectClaudeRoot: false,
      rules,
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && String(call.target?.relative).startsWith('@project/.claude/rules')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('cancellation cannot append a partial project-root context', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectClaudeRulesRoot: '/repo',
      includeProjectClaudeRoot: false,
      hangListDir: true,
      rules: { '@project/.claude/rules/always.md': rule('cancelled guidance') },
    })
    try {
      const agent = await harness.createAgent()
      const controller = new AbortController()
      const pending = harness.executeRead(agent, 'src/x.ts', { signal: controller.signal })
      while (!harness.fileSystem.calls.some(call => call.method === 'listDir'
        && call.path === '@project/.claude/rules')) await new Promise(resolve => setImmediate(resolve))
      controller.abort()
      harness.fileSystem.fs.releaseListing?.()
      const result = await pending
      assert.deepEqual(contextTexts(result), [])
    } finally {
      harness.fileSystem.fs.releaseListing?.()
      await harness.dispose()
    }
  })
})

test('does not search an ancestor .cursor/rules tree', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectCursorRoot: true,
    rules: { '../.cursor/rules/ancestor.mdc': rule('ancestor Cursor guidance must not be read') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '../.cursor'), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path.startsWith('../.cursor')), false)
  } finally {
    await harness.dispose()
  }
})

test('does not search an ancestor .github/instructions tree', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: true,
    rules: { '../.github/instructions/ancestor.instructions.md': rule('ancestor GitHub instructions must not be read', 'alwaysApply: true') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '../.github'), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path.startsWith('../.github')), false)
  } finally {
    await harness.dispose()
  }
})

test('does not search an ancestor GitHub Copilot single-file source', async () => {
  const ancestorPath = '../.github/copilot-instructions.md'
  const harness = await makeHarness({
    cwd: '/workspace/nested',
    includeProjectClaudeRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    rules: { [ancestorPath]: 'ancestor Copilot instructions must not be read' },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '../.github'), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === ancestorPath), false)
  } finally {
    await harness.dispose()
  }
})

test('OMO-only mode scans the session-cwd .omo/rules root without inspecting Claude rules', async () => {
  const harness = await makeHarness({
    includeProjectOmoRoot: true,
    includeProjectClaudeRoot: false,
    rules: {
      '.omo/rules/project.md': rule('session-cwd OMO project guidance', 'alwaysApply: true'),
      '.claude/rules/ignored.md': rule('Claude source is disabled in OMO-only mode', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.omo/rules/project.md',
    ])
    assert.ok(contextTexts(result)[0].includes('session-cwd OMO project guidance'))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.claude'), false)
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root OMO rules follow nearer session-cwd rules while matching root-relative paths', async () => {
  const projectRoot = '/repo'
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot,
    projectOmoRulesRoot: projectRoot,
    includeProjectOmoRoot: true,
    includeProjectClaudeRoot: false,
    rules: {
      '@project/.omo/rules/monorepo.md': rule('project-root OMO guidance', 'applyTo: "apps/a/src/*.ts"'),
      '@project/.omo/rules/cwd-only.md': rule('this root rule must not use cwd-relative matching', 'applyTo: "src/*.ts"'),
      '@project/apps/a/.omo/rules/cwd.md': rule('session-cwd OMO guidance', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.omo/rules/cwd.md',
      'project-root/.omo/rules/monorepo.md',
    ])
    assert.ok(texts[1].includes('[Match: glob: apps/a/src/*.ts]'))
    assert.ok(texts[1].includes('project-root OMO guidance'))
    assert.ok(texts[0].includes('session-cwd OMO guidance'))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat'
      && typeof call.path === 'string' && call.path.split('/').includes('..')), false)
  } finally {
    await harness.dispose()
  }
})

test('closer CWD Sisyphus rules precede farther project OMO despite lower source priority', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectOmoRulesRoot: '/repo',
    includeProjectOmoRoot: true,
    includeProjectSisyphusRoot: true,
    includeProjectClaudeRoot: false,
    rules: {
      '@project/.omo/rules/ancestor.md': rule('farther OMO source', 'applyTo: "apps/a/src/*.ts"'),
      '@project/apps/a/.sisyphus/rules/cwd.md': rule('closer Sisyphus source', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.sisyphus/rules/cwd.md',
      'project-root/.omo/rules/ancestor.md',
    ])
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root OMO rules deduplicate when root equals session cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo',
    projectRoot: '/repo',
    projectOmoRulesRoot: '/repo',
    includeProjectOmoRoot: true,
    includeProjectClaudeRoot: false,
    rules: { '@project/.omo/rules/always.md': rule('one OMO root, one injection') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.omo/rules/always.md',
    ])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.omo/rules').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root OMO rules retain both matching paths when CWD and project roots share a target', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectOmoRulesRoot: '/repo',
    includeProjectOmoRoot: true,
    includeProjectClaudeRoot: false,
    types: { '@project/apps/a/.omo/rules': 'directory' },
    targetKeys: {
      '@project/.omo/rules': 'shared-omo-rules-target',
      '@project/apps/a/.omo/rules': 'shared-omo-rules-target',
    },
    rules: {
      '@project/.omo/rules/cwd-glob.md': rule('alias keeps CWD-relative matching', 'applyTo: "src/*.ts"'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'project-root/.omo/rules/cwd-glob.md',
    ])
    assert.ok(texts[0].includes('[Match: glob: src/*.ts]'))
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.omo/rules').length, 1)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
      && call.path === '@project/apps/a/.omo/rules'), false)
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root OMO rules fail closed outside scope and through symlinked root components', async t => {
  await t.test('sibling cwd is outside the configured root', async () => {
    const harness = await makeHarness({
      cwd: '/other',
      projectRoot: '/repo',
      projectOmoRulesRoot: '/repo',
      includeProjectClaudeRoot: false,
      rules: { '@project/.omo/rules/always.md': rule('outside guidance must not inject') },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && String(call.path).startsWith('@project/.omo/rules')), false)
    } finally {
      await harness.dispose()
    }
  })

  for (const symlinkPath of ['@project', '@project/.omo', '@project/.omo/rules']) {
    await t.test(`symlinked ${symlinkPath} is rejected`, async () => {
      const harness = await makeHarness({
        cwd: '/repo/apps/a',
        projectRoot: '/repo',
        projectOmoRulesRoot: '/repo',
        includeProjectClaudeRoot: false,
        types: { [symlinkPath]: 'symlink' },
        rules: { '@project/.omo/rules/escape.md': rule('symlinked OMO rules must not inject') },
      })
      try {
        const agent = await harness.createAgent()
        assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
          && String(call.path).startsWith('@project/.omo/rules')), false)
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
          && String(call.target?.relative).startsWith('@project/.omo/rules')), false)
      } finally {
        await harness.dispose()
      }
    })
  }
})

test('explicit project-root OMO rules preserve outcome, shared-cap, and cancellation gates', async t => {
  await t.test('failed and blocked operations receive no context', async () => {
    for (const options of [{ toolError: true }, { blockRead: true }]) {
      const harness = await makeHarness({
        cwd: '/repo/apps/a',
        projectRoot: '/repo',
        projectOmoRulesRoot: '/repo',
        includeProjectClaudeRoot: false,
        rules: { '@project/.omo/rules/always.md': rule('only successful operations receive context') },
        ...options,
      })
      try {
        const agent = await harness.createAgent()
        assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      } finally {
        await harness.dispose()
      }
    }
  })

  await t.test('project and CWD sources share the injected-rule cap', async () => {
    const rules = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `@project/.omo/rules/root-${index}.md`, rule(`root-${index}`),
    ]))
    rules['@project/apps/a/.omo/rules/cwd.md'] = rule('cwd rule crosses the shared cap')
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectOmoRulesRoot: '/repo',
      includeProjectOmoRoot: true,
      includeProjectClaudeRoot: false,
      rules,
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@project/.omo/rules'))
      assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@project/apps/a/.omo/rules'))
    } finally {
      await harness.dispose()
    }
  })

  await t.test('cancellation cannot append a partial project-root context', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/a',
      projectRoot: '/repo',
      projectOmoRulesRoot: '/repo',
      includeProjectClaudeRoot: false,
      hangListDir: true,
      rules: { '@project/.omo/rules/always.md': rule('cancelled OMO guidance') },
    })
    try {
      const agent = await harness.createAgent()
      const controller = new AbortController()
      const pending = harness.executeRead(agent, 'src/x.ts', { signal: controller.signal })
      while (!harness.fileSystem.calls.some(call => call.method === 'listDir'
        && call.path === '@project/.omo/rules')) await new Promise(resolve => setImmediate(resolve))
      controller.abort()
      harness.fileSystem.fs.releaseListing?.()
      assert.deepEqual(contextTexts(await pending), [])
    } finally {
      harness.fileSystem.fs.releaseListing?.()
      await harness.dispose()
    }
  })
})

test('scans session-cwd OMO, Claude, Cursor, GitHub Instructions, Copilot, and Sisyphus sources in pinned priority before user roots', async () => {
  const harness = await makeHarness({
    includeProjectOmoRoot: true,
    includeProjectCursorRoot: true,
    includeProjectGitHubInstructionsRoot: true,
    includeProjectGitHubCopilotInstructionsFile: true,
    includeProjectSisyphusRoot: true,
    userOpenCodeRulesRoots: [USER_OPENCODE_RULES_ROOT, USER_OMO_RULES_ROOT],
    rules: {
      '.omo/rules/project-omo.md': rule('shared project body', 'alwaysApply: true'),
      '.claude/rules/project-duplicate.md': rule('shared project body', 'alwaysApply: true'),
      '.claude/rules/project-claude.md': rule('cwd Claude source', 'alwaysApply: true'),
      '.cursor/rules/project-duplicate.mdc': rule('shared project body', 'alwaysApply: true'),
      '.cursor/rules/project-cursor.mdc': rule('cwd Cursor source', 'alwaysApply: true'),
      '.github/instructions/project-duplicate.instructions.md': rule('shared project body', 'alwaysApply: true'),
      '.github/instructions/project-github.instructions.md': rule('cwd GitHub instructions source', 'alwaysApply: true'),
      '.github/copilot-instructions.md': rule('cwd GitHub Copilot single-file source', 'applyTo: "no-match/**/*.md"'),
      '.sisyphus/rules/project-sisyphus.md': rule('cwd Sisyphus source', 'alwaysApply: true'),
      '@opencode1/user-omo.md': rule('user OMO source', 'alwaysApply: true'),
      '@opencode0/user-opencode.md': rule('user OpenCode source', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.omo/rules/project-omo.md',
      '.claude/rules/project-claude.md',
      '.cursor/rules/project-cursor.mdc',
      '.github/instructions/project-github.instructions.md',
      '.github/copilot-instructions.md',
      '.sisyphus/rules/project-sisyphus.md',
      'user/.omo/rules/user-omo.md',
      'user/.opencode/rules/user-opencode.md',
    ])
    assert.equal(texts.filter(text => text.includes('shared project body')).length, 1)
    assert.ok(texts[4].includes('[Match: copilot-instructions (always apply)]'))
    assert.ok(texts[5].includes('cwd Sisyphus source'))
  } finally {
    await harness.dispose()
  }
})

test('orders nearer CWD Sisyphus before ancestor project-root Sisyphus and all user roots', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectSisyphusRulesRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectGitHubCopilotInstructionsFile: true,
    includeProjectSisyphusRoot: true,
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    userOpenCodeRulesRoots: [USER_OPENCODE_RULES_ROOT, USER_OMO_RULES_ROOT],
    rules: {
      '@project/apps/a/.github/copilot-instructions.md': rule('CWD Copilot priority', 'alwaysApply: true'),
      '@project/.sisyphus/rules/project-root.mdc': rule(
        'explicit project-root Sisyphus guidance', 'applyTo: "apps/a/src/*.ts"',
      ),
      '@project/.sisyphus/rules/cwd-only.mdc': rule(
        'project-root rule must not use a CWD-relative pattern', 'applyTo: "src/*.ts"',
      ),
      '@project/apps/a/.sisyphus/rules/cwd.md': rule('exact-CWD Sisyphus source', 'alwaysApply: true'),
      '@opencode1/user-omo.md': rule('user OMO root follows all project sources', 'alwaysApply: true'),
      '@opencode0/user-opencode.md': rule('user OpenCode root follows user OMO', 'alwaysApply: true'),
      '@user/user.md': rule('user Claude root follows user OpenCode', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.github/copilot-instructions.md',
      '.sisyphus/rules/cwd.md',
      'project-root/.sisyphus/rules/project-root.mdc',
      'user/.omo/rules/user-omo.md',
      'user/.opencode/rules/user-opencode.md',
      'user/.claude/rules/user.md',
    ])
    assert.ok(texts[2].includes('[Match: glob: apps/a/src/*.ts]'))
    assert.ok(texts[2].includes('explicit project-root Sisyphus guidance'))
    assert.equal(texts.some(text => text.includes('CWD-relative pattern')), false)
  } finally {
    await harness.dispose()
  }
})

test('deduplicates explicit project-root Sisyphus rules when the configured root equals cwd', async () => {
  const harness = await makeHarness({
    cwd: '/repo',
    projectRoot: '/repo',
    projectSisyphusRulesRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectSisyphusRoot: true,
    rules: { '@project/.sisyphus/rules/always.md': rule('one Sisyphus root, one injection') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/x.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.sisyphus/rules/always.md',
    ])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir'
      && call.path === '@project/.sisyphus/rules').length, 1)
  } finally {
    await harness.dispose()
  }
})

test('rejects configured project-root Sisyphus rules for sibling CWDs and symlinked roots', async t => {
  await t.test('sibling CWD is outside the configured root', async () => {
    const harness = await makeHarness({
      cwd: '/repo/apps/b',
      projectRoot: '/repo/apps/a',
      projectSisyphusRulesRoot: '/repo/apps/a',
      includeProjectClaudeRoot: false,
      rules: { '@project/.sisyphus/rules/always.md': rule('sibling guidance must not inject') },
    })
    try {
      const agent = await harness.createAgent()
      assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && String(call.path).startsWith('@project/.sisyphus/rules')), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked configured root components and entries fail closed', async t => {
    const cases = [
      { symlinkPath: '@project/.sisyphus', rulePath: '@project/.sisyphus/rules/always.md' },
      { symlinkPath: '@project/.sisyphus/rules', rulePath: '@project/.sisyphus/rules/always.md' },
      { symlinkPath: '@project/.sisyphus/rules/escape', rulePath: '@project/.sisyphus/rules/escape/secret.md' },
      { symlinkPath: '@project/.sisyphus/rules/escape.md', rulePath: '@project/.sisyphus/rules/escape.md' },
    ]
    for (const { symlinkPath, rulePath } of cases) {
      await t.test(symlinkPath, async () => {
        const harness = await makeHarness({
          cwd: '/repo/apps/a',
          projectRoot: '/repo',
          projectSisyphusRulesRoot: '/repo',
          includeProjectClaudeRoot: false,
          types: { [symlinkPath]: 'symlink' },
          rules: { [rulePath]: rule('symlink guidance must not inject') },
        })
        try {
          const agent = await harness.createAgent()
          assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
          assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
            && call.path === symlinkPath), false)
          assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
            && String(call.target?.relative).includes(rulePath)), false)
        } finally {
          await harness.dispose()
        }
      })
    }
  })
})

test('rejects regular-looking configured Sisyphus roots whose canonical targets escape the project root', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    projectSisyphusRulesRoot: '/repo',
    includeProjectClaudeRoot: false,
    rules: { '@project/.sisyphus/rules/secret.md': rule('escaped root must stay unread') },
  })
  const resolve = harness.fileSystem.fs.resolve.bind(harness.fileSystem.fs)
  harness.fileSystem.fs.resolve = async (value, options = {}) => {
    if (value === '.sisyphus/rules' && options.cwd === '/repo') {
      return resolve('../outside/.sisyphus/rules', { cwd: '/repo' })
    }
    return resolve(value, options)
  }
  try {
    const agent = await harness.createAgent()
    assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/x.ts')), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
      && String(call.path).startsWith('@project/.sisyphus/rules')), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
      && String(call.target?.relative).includes('.sisyphus/rules/secret.md')), false)
  } finally {
    await harness.dispose()
  }
})

test('rejects symlinked session-cwd Cursor rule-root components', async t => {
  for (const symlinkPath of ['.cursor', '.cursor/rules']) {
    await t.test(symlinkPath, async () => {
      const harness = await makeHarness({
        includeProjectClaudeRoot: false,
        includeProjectCursorRoot: true,
        types: { [symlinkPath]: 'symlink' },
        rules: { '.cursor/rules/escape.mdc': rule('symlinked Cursor roots must not be read', 'alwaysApply: true') },
      })
      try {
        const agent = await harness.createAgent()
        const result = await harness.executeRead(agent, 'src/app.ts')
        assert.deepEqual(contextTexts(result), [])
        assert.ok(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === symlinkPath))
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.cursor/rules'), false)
      } finally {
        await harness.dispose()
      }
    })
  }
})

test('does not follow symlinked entries inside the session-cwd Cursor rules root', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectCursorRoot: true,
    types: { '.cursor/rules/escape': 'symlink' },
    symlinkTargets: { '.cursor/rules/escape': '../outside/.cursor/rules' },
    rules: { '.cursor/rules/escape/secret.mdc': rule('a symlinked Cursor entry must not be read') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.cursor/rules'))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.cursor/rules/escape/secret.mdc'), false)
  } finally {
    await harness.dispose()
  }
})

test('rejects symlinked session-cwd GitHub instruction-root components', async t => {
  for (const symlinkPath of ['.github', '.github/instructions']) {
    await t.test(symlinkPath, async () => {
      const harness = await makeHarness({
        includeProjectClaudeRoot: false,
        includeProjectGitHubInstructionsRoot: true,
        types: { [symlinkPath]: 'symlink' },
        rules: { '.github/instructions/escape.instructions.md': rule('symlinked GitHub instruction roots must not be read', 'alwaysApply: true') },
      })
      try {
        const agent = await harness.createAgent()
        const result = await harness.executeRead(agent, 'src/app.ts')
        assert.deepEqual(contextTexts(result), [])
        assert.ok(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === symlinkPath))
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.github/instructions'), false)
      } finally {
        await harness.dispose()
      }
    })
  }
})

test('rejects symlinked session-cwd Copilot source roots and files', async t => {
  for (const symlinkPath of ['.github', '.github/copilot-instructions.md']) {
    await t.test(symlinkPath, async () => {
      const harness = await makeHarness({
        includeProjectClaudeRoot: false,
        includeProjectGitHubCopilotInstructionsFile: true,
        types: { [symlinkPath]: 'symlink' },
        rules: { '.github/copilot-instructions.md': 'a symlinked Copilot source must not be read' },
      })
      try {
        const agent = await harness.createAgent()
        const result = await harness.executeRead(agent, 'src/app.ts')
        assert.deepEqual(contextTexts(result), [])
        assert.ok(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === symlinkPath))
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.github/copilot-instructions.md'), false)
      } finally {
        await harness.dispose()
      }
    })
  }
})

test('rejects symlinked session-cwd Sisyphus rule-root components', async t => {
  for (const symlinkPath of ['.sisyphus', '.sisyphus/rules']) {
    await t.test(symlinkPath, async () => {
      const harness = await makeHarness({
        includeProjectClaudeRoot: false,
        includeProjectSisyphusRoot: true,
        types: { [symlinkPath]: 'symlink' },
        rules: { '.sisyphus/rules/escape.md': rule('symlinked Sisyphus roots must not be read', 'alwaysApply: true') },
      })
      try {
        const agent = await harness.createAgent()
        const result = await harness.executeRead(agent, 'src/app.ts')
        assert.deepEqual(contextTexts(result), [])
        assert.ok(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === symlinkPath))
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.sisyphus/rules'), false)
      } finally {
        await harness.dispose()
      }
    })
  }
})

test('does not follow symlinked entries inside the session-cwd Sisyphus rules root', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectSisyphusRoot: true,
    types: { '.sisyphus/rules/escape': 'symlink' },
    symlinkTargets: { '.sisyphus/rules/escape': '../outside/.sisyphus/rules' },
    rules: { '.sisyphus/rules/escape/secret.md': rule('a symlinked Sisyphus entry must not be read') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.sisyphus/rules'))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
      && call.target?.relative === '.sisyphus/rules/escape/secret.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('rejects regular-looking Sisyphus roots or files whose canonical targets escape CWD', async t => {
  await t.test('rule root', async () => {
    const harness = await makeHarness({
      includeProjectClaudeRoot: false,
      includeProjectSisyphusRoot: true,
      rules: { '.sisyphus/rules/secret.md': rule('escaped Sisyphus root must stay unread', 'alwaysApply: true') },
    })
    const resolve = harness.fileSystem.fs.resolve.bind(harness.fileSystem.fs)
    harness.fileSystem.fs.resolve = async (value, options = {}) => {
      if (value === '.sisyphus/rules' && options.cwd === CWD) {
        return resolve('../outside/.sisyphus/rules', { cwd: CWD })
      }
      return resolve(value, options)
    }
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && call.path === '.sisyphus/rules'), false)
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && call.target?.relative === '.sisyphus/rules/secret.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('rule file', async () => {
    const harness = await makeHarness({
      includeProjectClaudeRoot: false,
      includeProjectSisyphusRoot: true,
      rules: {
        '.sisyphus/rules/escape.md': {
          ...makeRecord(rule('escaped Sisyphus file must stay unread', 'alwaysApply: true')),
          resolveOutside: true,
        },
      },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && call.path === '.sisyphus/rules'))
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
        && call.target?.relative === '.sisyphus/rules/escape.md'), false)
    } finally {
      await harness.dispose()
    }
  })
})

test('does not walk parent CWDs to find Sisyphus project rules', async () => {
  const harness = await makeHarness({
    cwd: '/repo/apps/a',
    projectRoot: '/repo',
    includeProjectClaudeRoot: false,
    includeProjectSisyphusRoot: true,
    rules: { '@project/.sisyphus/rules/parent.md': rule('ancestor Sisyphus guidance must remain out of scope', 'alwaysApply: true') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
      && call.path === '@project/.sisyphus/rules'), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'
      && call.target?.relative === '@project/.sisyphus/rules/parent.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('drops earlier project-rule contexts when a later GitHub instructions root fails', async () => {
  const harness = await makeHarness({
    includeProjectCursorRoot: true,
    includeProjectGitHubInstructionsRoot: true,
    failListDirPath: '.github/instructions',
    rules: {
      '.cursor/rules/first.mdc': rule('must not partially escape', 'alwaysApply: true'),
      '.github/instructions/fails.instructions.md': rule('later instructions root fails', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.cursor/rules'))
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.github/instructions'))
  } finally {
    await harness.dispose()
  }
})

test('does not follow symlinked child directories in the session-cwd GitHub instructions root', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectGitHubInstructionsRoot: true,
    types: { '.github/instructions/escape': 'symlink' },
    symlinkTargets: { '.github/instructions/escape': '../outside/.github/instructions' },
    rules: {
      '.github/instructions/legit.instructions.md': rule('valid instruction remains available', 'alwaysApply: true'),
      '.github/instructions/escape/secret.instructions.md': rule('an escaping child instruction must not be read', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.github/instructions/legit.instructions.md',
    ])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.github/instructions/escape/secret.instructions.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('rejects symlinked session-cwd .omo rule-root components', async t => {
  for (const symlinkPath of ['.omo', '.omo/rules']) {
    await t.test(symlinkPath, async () => {
      const harness = await makeHarness({
        includeProjectOmoRoot: true,
        includeProjectClaudeRoot: false,
        types: { [symlinkPath]: 'symlink' },
        rules: { '.omo/rules/escape.md': rule('symlinked OMO roots must not be read', 'alwaysApply: true') },
      })
      try {
        const agent = await harness.createAgent()
        const result = await harness.executeRead(agent, 'src/app.ts')
        assert.deepEqual(contextTexts(result), [])
        assert.ok(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === symlinkPath))
        assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.omo/rules'), false)
      } finally {
        await harness.dispose()
      }
    })
  }
})

test('drops earlier OMO contexts when a later project-rule root fails', async () => {
  const harness = await makeHarness({
    includeProjectOmoRoot: true,
    failListDirPath: '.claude/rules',
    rules: {
      '.omo/rules/first.md': rule('must not partially escape', 'alwaysApply: true'),
      '.claude/rules/fails.md': rule('later project root fails', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.omo/rules'))
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.claude/rules'))
  } finally {
    await harness.dispose()
  }
})

test('drops earlier Cursor contexts when a later explicit user root fails', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectCursorRoot: true,
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT],
    failListDirPath: '@opencode0',
    rules: {
      '.cursor/rules/first.mdc': rule('must not partially escape', 'alwaysApply: true'),
      '@opencode0/fails.md': rule('later user root fails', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.cursor/rules'))
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@opencode0'))
  } finally {
    await harness.dispose()
  }
})

test('scans one explicit user Claude root after project rules and matches the session file path', async () => {
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    rules: {
      '.claude/rules/project.md': rule('project rule first', 'alwaysApply: true'),
      '@user/user.mdc': rule('explicit user rule second', 'globs: "**/*.ts"'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/app.ts' })
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.claude/rules/project.md',
      'user/.claude/rules/user.mdc',
    ])
    assert.ok(contextTexts(result)[0].includes('project rule first'))
    assert.ok(contextTexts(result)[1].includes('explicit user rule second'))
    assert.ok(contextTexts(result)[1].includes('glob:'))
    assert.ok(result.additionalContexts.every(message => message.role === 'user' && message.source.kind === 'user'))
  } finally {
    await harness.dispose()
  }
})

test('orders explicit user Sisyphus rules after the pinned user Claude roots', async () => {
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    userOpenCodeRulesRoots: [USER_OPENCODE_RULES_ROOT, USER_OMO_RULES_ROOT],
    userSisyphusRulesRoot: USER_SISYPHUS_RULES_ROOT,
    rules: {
      '.claude/rules/project.md': rule('project rule first', 'alwaysApply: true'),
      '@opencode1/omo.mdc': rule('explicit OMO global source', 'globs: "**/*.ts"'),
      '@opencode0/opencode.md': rule('explicit OpenCode global source', 'alwaysApply: true'),
      '@sisyphus/sisyphus.md': rule('explicit Sisyphus user source', 'alwaysApply: true'),
      '@user/claude.md': rule('explicit Claude global source', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.claude/rules/project.md',
      'user/.omo/rules/omo.mdc',
      'user/.opencode/rules/opencode.md',
      'user/.claude/rules/claude.md',
      'user/.sisyphus/rules/sisyphus.md',
    ])
    for (const [index, expected] of [
      'project rule first',
      'explicit OMO global source',
      'explicit OpenCode global source',
      'explicit Claude global source',
      'explicit Sisyphus user source',
    ].entries()) assert.ok(texts[index].includes(expected))
  } finally {
    await harness.dispose()
  }
})

test('deduplicates identical rule bodies across prioritized OpenCode roots per live Agent', async () => {
  const body = 'one shared global instruction'
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT, USER_OPENCODE_RULES_ROOT],
    rules: {
      '@opencode0/omo.md': rule(body, 'alwaysApply: true'),
      '@opencode1/opencode.md': rule(body, 'globs: "**/*.ts"'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const first = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(first).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), ['user/.omo/rules/omo.md'])
    assert.deepEqual(contextTexts(await harness.executeRead(agent, 'src/app.ts')), [])

    const otherAgent = await harness.createAgent('other-agent')
    const isolated = await harness.executeRead(otherAgent, 'src/app.ts')
    assert.deepEqual(contextTexts(isolated).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), ['user/.omo/rules/omo.md'])
  } finally {
    await harness.dispose()
  }
})

test('OpenCode-only mode reads explicit user roots without scanning project Claude rules', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT],
    rules: {
      '.claude/rules/project.md': rule('must not be read in OpenCode-only mode', 'alwaysApply: true'),
      '@opencode0/global.md': rule('explicit OpenCode source', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      'user/.omo/rules/global.md',
    ])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.claude/rules'), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.claude/rules/project.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('does not infer user rule roots and skips a missing explicit root', async () => {
  const implicit = await makeHarness({ rules: {
    '@user/global.md': rule('must not be discovered implicitly', 'alwaysApply: true'),
    '@opencode0/global.md': rule('must not be discovered implicitly', 'alwaysApply: true'),
    '@sisyphus/global.md': rule('must not be discovered implicitly', 'alwaysApply: true'),
  } })
  try {
    const agent = await implicit.createAgent()
    const result = await implicit.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(implicit.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@user'), false)
    assert.equal(implicit.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@sisyphus'), false)
  } finally {
    await implicit.dispose()
  }

  const missing = await makeHarness({ userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT], missingUserRoot: true })
  try {
    const agent = await missing.createAgent()
    const result = await missing.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/app.ts' })
    assert.deepEqual(contextTexts(result), [])
    assert.equal(missing.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@user'), false)
  } finally {
    await missing.dispose()
  }

  const missingOpenCode = await makeHarness({
    includeProjectClaudeRoot: false,
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT],
    missingUserRoot: true,
  })
  try {
    const agent = await missingOpenCode.createAgent()
    const result = await missingOpenCode.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(missingOpenCode.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@opencode0'), false)
  } finally {
    await missingOpenCode.dispose()
  }

  const missingSisyphus = await makeHarness({
    includeProjectClaudeRoot: false,
    userSisyphusRulesRoot: USER_SISYPHUS_RULES_ROOT,
    missingUserRoot: true,
  })
  try {
    const agent = await missingSisyphus.createAgent()
    const result = await missingSisyphus.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(missingSisyphus.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@sisyphus'), false)
  } finally {
    await missingSisyphus.dispose()
  }
})

test('fails closed on a symlinked user root or an entry resolving outside its configured boundary', async t => {
  await t.test('symlinked root', async () => {
    const harness = await makeHarness({
      userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
      types: { '@user': 'symlink' },
      rules: { '@user/escape.md': rule('root symlink must not be followed', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@user'), false)
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@user/escape.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('outside entry alias', async () => {
    const harness = await makeHarness({
      userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
      rules: { '@user/escape.md': { text: rule('outside entry must not be read', 'alwaysApply: true'), resolveOutside: true } },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@user/escape.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked OpenCode root', async () => {
    const harness = await makeHarness({
      includeProjectClaudeRoot: false,
      userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT],
      types: { '@opencode0': 'symlink', '@outside/rules': 'directory' },
      symlinkTargets: { '@opencode0': '@outside/rules' },
      rules: { '@opencode0/escape.md': rule('OpenCode root symlink must not be followed', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'resolve' && call.path === USER_OMO_RULES_ROOT), false, 'lstat rejects the final symlink before resolve follows it')
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@opencode0'), false)
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@opencode0/escape.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked Sisyphus user root', async () => {
    const harness = await makeHarness({
      includeProjectClaudeRoot: false,
      userSisyphusRulesRoot: USER_SISYPHUS_RULES_ROOT,
      types: { '@sisyphus': 'symlink', '@outside/rules': 'directory' },
      symlinkTargets: { '@sisyphus': '@outside/rules' },
      rules: { '@sisyphus/escape.md': rule('Sisyphus user root symlink must not be followed', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'resolve' && call.path === USER_SISYPHUS_RULES_ROOT), false)
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@sisyphus'), false)
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@sisyphus/escape.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('outside Sisyphus user entry alias', async () => {
    const harness = await makeHarness({
      includeProjectClaudeRoot: false,
      userSisyphusRulesRoot: USER_SISYPHUS_RULES_ROOT,
      rules: { '@sisyphus/escape.md': { text: rule('outside Sisyphus user entry must not be read', 'alwaysApply: true'), resolveOutside: true } },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@sisyphus/escape.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked Sisyphus user descendant directory', async () => {
    const harness = await makeHarness({
      includeProjectClaudeRoot: false,
      userSisyphusRulesRoot: USER_SISYPHUS_RULES_ROOT,
      types: { '@sisyphus/branch': 'symlink' },
      rules: { '@sisyphus/branch/secret.md': rule('symlinked descendant rules must not be followed', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@sisyphus/branch'), false)
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@sisyphus/branch/secret.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('symlinked Sisyphus user rule file', async () => {
    const harness = await makeHarness({
      includeProjectClaudeRoot: false,
      userSisyphusRulesRoot: USER_SISYPHUS_RULES_ROOT,
      types: { '@sisyphus/escape.md': 'symlink' },
      rules: { '@sisyphus/escape.md': rule('symlinked rule file must not be read', 'alwaysApply: true') },
    })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, 'src/app.ts')
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@sisyphus/escape.md'), false)
    } finally {
      await harness.dispose()
    }
  })
})

test('keeps scanning the explicit user root when the project .claude directory is unavailable', async () => {
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    types: { '.claude': 'file' },
    rules: { '@user/global.md': rule('user root remains available', 'alwaysApply: true') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(contextTexts(result).length, 1)
    assert.ok(contextTexts(result)[0].includes('[Rule: user/.claude/rules/global.md]'))
    assert.ok(contextTexts(result)[0].includes('user root remains available'))
  } finally {
    await harness.dispose()
  }
})

test('skips duplicate root identities before charging the shared directory cap', async () => {
  const projectRulesRoot = `${CWD}/.claude/rules`
  const directories = []
  for (let branch = 0; branch < 4; branch += 1) {
    const branchPath = `.claude/rules/branch${branch}`
    directories.push(branchPath)
    for (let leaf = 0; leaf < 4; leaf += 1) directories.push(`${branchPath}/leaf${leaf}`)
  }
  for (let node = 0; node < 11; node += 1) directories.push('.claude/rules/branch0/leaf0/node' + node)
  assert.equal(directories.length, 31)

  const harness = await makeHarness({
    userClaudeRulesRoots: [projectRulesRoot],
    userClaudeRulesRoot: projectRulesRoot,
    userRootTargetKey: `directory:${CWD}:.claude/rules`,
    rules: {
      '.claude/rules/root.md': rule('one project match', 'alwaysApply: true'),
      ...Object.fromEntries(directories.map(directory => [`${directory}/ignore.txt`, 'ignored'])),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(contextTexts(result).length, 1)
    assert.ok(contextTexts(result)[0].includes('one project match'))
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir').length, 32)
  } finally {
    await harness.dispose()
  }
})

test('skips OpenCode root aliases sharing one canonical targetKey before listing both', async () => {
  const harness = await makeHarness({
    includeProjectClaudeRoot: false,
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT, USER_OPENCODE_RULES_ROOT],
    targetKeys: {
      '@opencode0': 'shared-open-code-rules-root',
      '@opencode1': 'shared-open-code-rules-root',
    },
    rules: {
      '@opencode0/omo.md': rule('canonical alias winner', 'alwaysApply: true'),
      '@opencode1/opencode.md': rule('duplicate alias must not be listed', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), ['user/.omo/rules/omo.md'])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir' && call.path.startsWith('@opencode')).length, 1)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@opencode1/opencode.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('uses shared per-invocation byte budgets across Copilot and explicit user rules', async () => {
  const body = 'x'.repeat(8_000)
  const harness = await makeHarness({
    includeProjectCursorRoot: true,
    includeProjectGitHubInstructionsRoot: true,
    includeProjectGitHubCopilotInstructionsFile: true,
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT],
    rules: {
      '.claude/rules/a.md': rule(body, 'alwaysApply: true'),
      '.cursor/rules/b.mdc': rule(body, 'alwaysApply: true'),
      '.github/instructions/c.instructions.md': rule(body, 'alwaysApply: true'),
      '.github/copilot-instructions.md': rule(body, 'alwaysApply: true'),
      '@opencode0/d.md': rule(body, 'alwaysApply: true'),
      '@user/e.md': rule(body, 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(contextTexts(result), [], 'the root scans fail open without partially injecting earlier matches')
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes').length, 4)
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.cursor/rules/b.mdc'))
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.github/instructions/c.instructions.md'))
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.github/copilot-instructions.md'),
      'the single-file source shares the aggregate allowance before user roots')
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@opencode0/d.md'), false,
      'the Copilot source consumes the aggregate allowance before OpenCode user roots')
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@user/e.md'), false,
      'all configured user roots share the same byte allowance')
  } finally {
    await harness.dispose()
  }
})

test('user-rule dedupe is Agent-local and resets only on clear/compact', async () => {
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    rules: { '@user/global.md': rule('agent-local user guidance', 'alwaysApply: true') },
  })
  try {
    const firstAgent = await harness.createAgent('user-root-agent-1')
    assert.equal(contextTexts(await harness.executeRead(firstAgent, 'src/app.ts')).length, 1)
    assert.deepEqual(contextTexts(await harness.executeRead(firstAgent, 'src/other.ts')), [])

    const secondAgent = await harness.createAgent('user-root-agent-2')
    assert.equal(contextTexts(await harness.executeRead(secondAgent, 'src/app.ts')).length, 1)

    await harness.reannounce(firstAgent, 'clear')
    assert.equal(contextTexts(await harness.executeRead(firstAgent, 'src/app.ts')).length, 1)
  } finally {
    await harness.dispose()
  }
})

test('preserves the accepted native result and drops all partial rule contexts when user-root listing fails', async () => {
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    failListDirPath: '@user',
    rules: {
      '.claude/rules/project.md': rule('partial project match must not escape', 'alwaysApply: true'),
      '@user/global.md': rule('user list fails', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/app.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/app.ts' }])
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@user'))
  } finally {
    await harness.dispose()
  }
})

test('preserves the native result and drops project matches when an OpenCode user root listing fails', async () => {
  const harness = await makeHarness({
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT],
    failListDirPath: '@opencode0',
    rules: {
      '.claude/rules/project.md': rule('partial project match must not escape', 'alwaysApply: true'),
      '@opencode0/global.md': rule('OpenCode list fails', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/app.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/app.ts' }])
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@opencode0'))
  } finally {
    await harness.dispose()
  }
})

test('preserves the native result and drops project matches when an explicit user rule read fails', async () => {
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    rules: {
      '.claude/rules/project.md': rule('partial project match must not escape', 'alwaysApply: true'),
      '@user/global.md': {
        text: rule('user read fails', 'alwaysApply: true'),
        readBytes() { throw new Error('simulated user-rule read failure') },
      },
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/app.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/app.ts' }])
    assert.deepEqual(contextTexts(result), [])
    assert.ok(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@user/global.md'))
  } finally {
    await harness.dispose()
  }
})

test('injects matching OMO project rules after successful write and edit file operations', async () => {
  const harness = await makeHarness({
    includeProjectOmoRoot: true,
    includeProjectClaudeRoot: false,
    rules: {
      '.omo/rules/source.md': rule('apply after file mutation', 'globs: "src/*.ts"'),
    },
  })
  try {
    const writeAgent = await harness.createAgent('write-agent')
    const writeResult = await harness.executeFileOperation(writeAgent, 'write', 'src/new.ts', { content: 'new source' })
    assert.equal(writeResult.isError, false)
    assert.deepEqual(writeResult.value, { body: 'src/new.ts' })
    assert.deepEqual(writeResult.content, [{ type: 'text', text: 'write:src/new.ts' }])
    assert.equal(contextTexts(writeResult).length, 1)
    assert.ok(contextTexts(writeResult)[0].includes('apply after file mutation'))

    const editAgent = await harness.createAgent('edit-agent')
    const editResult = await harness.executeFileOperation(editAgent, 'edit', 'src/existing.ts', {
      old_string: 'before',
      new_string: 'after',
    })
    assert.equal(editResult.isError, false)
    assert.deepEqual(editResult.value, { body: 'src/existing.ts' })
    assert.deepEqual(editResult.content, [{ type: 'text', text: 'edit:src/existing.ts' }])
    assert.equal(contextTexts(editResult).length, 1)
    assert.ok(contextTexts(editResult)[0].includes('apply after file mutation'))
  } finally {
    await harness.dispose()
  }
})

test('does not inject after failed, blocked, or unsafe write/edit operations', async () => {
  const failure = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectSisyphusRoot: true,
    toolErrorName: 'write',
    rules: { '.sisyphus/rules/all.md': rule('must not inject after failure', 'alwaysApply: true') },
  })
  try {
    const agent = await failure.createAgent('failed-write')
    const result = await failure.executeFileOperation(agent, 'write', 'src/app.ts', { content: 'source' })
    assert.equal(result.isError, true)
    assert.deepEqual(contextTexts(result), [])
    assert.equal(failure.fileSystem.calls.length, 0)
  } finally {
    await failure.dispose()
  }

  const blocked = await makeHarness({
    includeProjectClaudeRoot: false,
    includeProjectSisyphusRoot: true,
    blockTool: 'edit',
    rules: { '.sisyphus/rules/all.md': rule('must not inject after block', 'alwaysApply: true') },
  })
  try {
    const agent = await blocked.createAgent('blocked-edit')
    const result = await blocked.executeFileOperation(agent, 'edit', 'src/app.ts', {
      old_string: 'before',
      new_string: 'after',
    })
    assert.deepEqual(contextTexts(result), [])
    assert.equal(blocked.fileSystem.calls.length, 0)
  } finally {
    await blocked.dispose()
  }

  const unsafe = await makeHarness({ rules: { '.claude/rules/all.md': rule('must not inject outside cwd', 'alwaysApply: true') } })
  try {
    const agent = await unsafe.createAgent('unsafe-write')
    const result = await unsafe.executeFileOperation(agent, 'write', '../outside.ts', { content: 'outside' })
    assert.equal(result.isError, false)
    assert.deepEqual(contextTexts(result), [])
    assert.equal(unsafe.fileSystem.calls.length, 0)
  } finally {
    await unsafe.dispose()
  }
})

test('rejects a mismatched present file-path schema and accepts an omitted optional schema', async () => {
  const harness = await makeHarness({ rules: { '.claude/rules/all.md': rule('optional schema context', 'alwaysApply: true') } })
  const listener = createClaudeRulesOnReadContextListener(
    harness.agents,
    { get: id => harness.sessions.get(id) },
    harness.fileSystem.fs,
  )
  try {
    const agent = await harness.createAgent('schema-agent')
    const filePath = 'src/app.ts'
    harness.fileSystem.fs.setReadPath(filePath)
    const exec = {
      name: 'write',
      schema: {
        name: 'write',
        description: 'Mismatched test schema.',
        parameters: { type: 'object', properties: { file_path: { type: 'number' } } },
      },
      arguments: { file_path: filePath },
      agent: { id: agent.id },
      signal: new AbortController().signal,
    }
    const result = { isError: false, value: {}, content: [] }
    let nextCalls = 0
    const mismatched = await listener(exec, result, async () => {
      nextCalls += 1
      return { kind: 'accept', value: {} }
    })
    assert.equal(nextCalls, 1)
    assert.deepEqual(mismatched.additionalContexts ?? [], [])
    assert.equal(harness.fileSystem.calls.length, 0)

    const withoutSchema = { ...exec }
    delete withoutSchema.schema
    const accepted = await listener(withoutSchema, result, async () => ({ kind: 'accept', value: {} }))
    assert.equal(contextTexts(accepted).length, 1)
    assert.ok(contextTexts(accepted)[0].includes('optional schema context'))
  } finally {
    listener.dispose()
    await harness.dispose()
  }
})

test('alwaysApply is unconditional even when a negative glob matches', async () => {
  const harness = await makeHarness({ rules: {
    '.claude/rules/always-negative.md': rule('always applies despite negative glob', 'alwaysApply: true\nglobs: !**/*.ts'),
  } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(contextTexts(result).length, 1)
    assert.match(contextTexts(result)[0], /\[Match: alwaysApply\]/u)
    assert.ok(contextTexts(result)[0].includes('always applies despite negative glob'))
  } finally {
    await harness.dispose()
  }
})

test('appends rule contexts after contexts already returned by downstream listeners', async () => {
  const harness = await makeHarness({
    downstreamContext: true,
    rules: { '.claude/rules/all.md': rule('rule context', 'alwaysApply: true') },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.includes('downstream context') ? 'downstream' : 'rule'), ['downstream', 'rule'])
    assert.deepEqual(harness.finalizerCalls[0].additionalContexts, result.additionalContexts)
    assert.deepEqual(result.value, { body: 'body:src/app.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/app.ts' }])
  } finally {
    await harness.dispose()
  }
})

test('outer post-execute middleware can drop a rule after dedupe commits', async () => {
  const outerSawContexts = []
  const harness = await makeHarness({
    outerPostExecute: decision => {
      outerSawContexts.push(contextTexts(decision).length)
      return { ...decision, additionalContexts: [] }
    },
    rules: { '.claude/rules/all.md': rule('context dropped by outer listener', 'alwaysApply: true') },
  })
  try {
    const agent = await harness.createAgent()
    const first = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(first), [])
    const second = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(second), [])
    assert.deepEqual(outerSawContexts, [1, 0])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes'
      && call.target?.relative === '.claude/rules/all.md').length, 2)
  } finally {
    await harness.dispose()
  }
})

test('preserves apostrophes in plain scalar and inline-array globs', async () => {
  const harness = await makeHarness({ rules: {
    '.claude/rules/plain-apostrophe.md': rule(
      'plain scalar apostrophe guidance',
      "description: Don't edit generated files\napplyTo: src/don't-*.ts",
    ),
    '.claude/rules/array-apostrophe.md': rule(
      'inline array apostrophe guidance',
      "applyTo: [src/don't-*.ts, src/other.ts]",
    ),
  } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, "src/don't-change.ts")
    const texts = contextTexts(result)
    assert.equal(texts.length, 2)
    assert.ok(texts.some(text => text.includes('plain scalar apostrophe guidance')))
    assert.ok(texts.some(text => text.includes('inline array apostrophe guidance')))
    assert.ok(texts.every(text => text.includes("[Match: glob: src/don't-*.ts]")))
  } finally {
    await harness.dispose()
  }
})

test('parses BOM/CRLF frontmatter, inline/comma/multiline arrays, comments, dotfiles, basename patterns, and negative exclusions', async () => {
  const harness = await makeHarness({ rules: {
    '.claude/rules/dot.mdc': '\ufeff---\r\ndescription: "quoted # description" # outside comment\r\nmode: rule\r\nglobs:\r\n  - "**/.hidden/*.ts" # rule comment\r\npaths: [app.ts, "other, name.ts"]\r\napplyTo: **/*.tsx, **/*.jsx\r\nalwaysApply: false\r\n---\r\ndot and basename matched\r\n',
    '.claude/rules/negative.md': rule('generated excluded', 'globs: ["**/*.ts", "!**/generated/**"]'),
    '.claude/rules/brace.mdc': rule('brace expansion matched', 'globs: **/*.{ts,tsx}'),
  } })
  try {
    const dotAgent = await harness.createAgent('dot-agent')
    const dot = await harness.executeRead(dotAgent, 'src/.hidden/app.ts')
    assert.equal(contextTexts(dot).length, 3, JSON.stringify(contextTexts(dot)))
    assert.ok(contextTexts(dot).some(text => text.includes('dot and basename matched')))
    assert.ok(contextTexts(dot).some(text => text.includes('dot and basename matched\r\n')), 'preserves rule-body CRLF')
    assert.ok(contextTexts(dot).some(text => text.includes('brace expansion matched')))
    assert.ok(contextTexts(dot).some(text => text.includes('generated excluded')), 'positive glob applies outside the negative subtree')

    const basenameAgent = await harness.createAgent('basename-agent')
    const basename = await harness.executeRead(basenameAgent, 'src/docs/app.ts')
    assert.ok(contextTexts(basename).some(text => text.includes('dot and basename matched')), 'basename-only pattern matches')

    const applyToAgent = await harness.createAgent('apply-agent')
    const applyTo = await harness.executeRead(applyToAgent, 'src/app.tsx')
    assert.ok(contextTexts(applyTo).some(text => text.includes('dot and basename matched')), 'applyTo patterns are merged')

    const generatedAgent = await harness.createAgent('generated-agent')
    const generated = await harness.executeRead(generatedAgent, 'src/generated/app.ts')
    assert.ok(!contextTexts(generated).some(text => text.includes('generated excluded')))
    assert.equal(generated.isError, false)
  } finally {
    await harness.dispose()
  }
})

test('requires frontmatter at byte zero, merges glob aliases, and ignores unrelated metadata', async () => {
  const harness = await makeHarness({ rules: {
    '.claude/rules/prefix.md': `comment\n${rule('prefix should skip', 'alwaysApply: true')}`,
    '.claude/rules/no-close.md': '---\nalwaysApply: true\n--- \nno close',
    '.claude/rules/wrong-mode.md': rule('mode metadata ignored', 'mode: agent\npaths: ["src/*.ts"]'),
    '.claude/rules/bad-bool.md': rule('non-true boolean does not apply by itself', 'alwaysApply: yes'),
    '.claude/rules/duplicate.md': rule('duplicate glob keys merge', 'globs: "**/*.ts"\nglobs: "**/*.js"'),
    '.claude/rules/last-false.md': rule('last false wins', 'alwaysApply: true\nalwaysApply: false'),
    '.claude/rules/last-true.md': rule('last true wins', 'alwaysApply: false\nalwaysApply: true'),
    '.claude/rules/nested-metadata.md': rule('unknown nested metadata ignored', 'custom:\n  nested:\n    - ignored\nalwaysApply: true'),
    '.claude/rules/backslash.mdc': rule('backslash glob normalized', 'globs: src\\*.ts'),
    '.claude/rules/bad-quotes.md': rule('bad quote', 'paths: ["unfinished]'),
    '.claude/rules/invalid-utf8.md': { bytes: new Uint8Array([0xff]), type: 'file' },
    '.claude/rules/valid.mdc': rule('only valid rule', 'paths: ["src/*.ts"] # valid comment'),
  } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.claude/rules/backslash.mdc',
      '.claude/rules/duplicate.md',
      '.claude/rules/last-true.md',
      '.claude/rules/nested-metadata.md',
      '.claude/rules/valid.mdc',
      '.claude/rules/wrong-mode.md',
    ])
    assert.ok(contextTexts(result).some(text => text.includes('duplicate glob keys merge')))
    assert.ok(contextTexts(result).some(text => text.includes('last true wins')))
    assert.ok(!contextTexts(result).some(text => text.includes('last false wins')))
    assert.ok(contextTexts(result).some(text => text.includes('mode metadata ignored')))
    assert.ok(contextTexts(result).some(text => text.includes('unknown nested metadata ignored')))
    assert.ok(contextTexts(result).some(text => text.includes('backslash glob normalized')))
    assert.ok(contextTexts(result).some(text => text.includes('only valid rule')))

    const jsAgent = await harness.createAgent('js-agent')
    const jsResult = await harness.executeRead(jsAgent, 'src/app.js')
    assert.ok(contextTexts(jsResult).some(text => text.includes('duplicate glob keys merge')),
      'the second repeated glob alias matches a JavaScript-only path')
  } finally {
    await harness.dispose()
  }
})

test('encodes bracket and Unicode line separators in rule wrapper metadata', async () => {
  const rulePath = '.claude/rules/a][\u2028\u2029b.md'
  const harness = await makeHarness({ rules: {
    [rulePath]: rule('metadata is untrusted', 'globs: "**/app[.]ts"'),
  } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const [text] = contextTexts(result)
    assert.ok(text.startsWith(`[Rule: .claude/rules/a\uff3d\uff3b\\u2028\\u2029b.md]\n[Match: glob: **/app\uff3b.\uff3dts]\n`))
    assert.equal(text.includes('\u2028'), false)
    assert.equal(text.includes('\u2029'), false)
  } finally {
    await harness.dispose()
  }
})

test('skips upstream-excluded rule directories while retaining applicable root rules', async () => {
  const harness = await makeHarness({ rules: {
    '.claude/rules/root.md': rule('root rule retained', 'alwaysApply: true'),
    '.claude/rules/node_modules/deep/ignored.md': rule('node_modules must not inject', 'alwaysApply: true'),
    '.claude/rules/.git/ignored.md': rule('git subtree must not inject', 'alwaysApply: true'),
    '.claude/rules/dist/ignored.md': rule('dist subtree must not inject', 'alwaysApply: true'),
    '.claude/rules/build/ignored.md': rule('build subtree must not inject', 'alwaysApply: true'),
    '.claude/rules/.turbo/ignored.md': rule('turbo subtree must not inject', 'alwaysApply: true'),
    '.claude/rules/.next/ignored.md': rule('next subtree must not inject', 'alwaysApply: true'),
    '.claude/rules/coverage/ignored.md': rule('coverage subtree must not inject', 'alwaysApply: true'),
  } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(contextTexts(result).length, 1)
    assert.ok(contextTexts(result)[0].includes('root rule retained'))
    assert.ok(!contextTexts(result).some(text => /must not inject/u.test(text)))
    for (const excluded of ['node_modules', '.git', 'dist', 'build', '.turbo', '.next', 'coverage']) {
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'listDir'
        && call.path?.startsWith(`.claude/rules/${excluded}`)), false, `${excluded} subtree is not traversed`)
    }
  } finally {
    await harness.dispose()
  }
})

test('validates the read path before filesystem work and enforces cwd containment', async () => {
  const invalid = [
    '../outside.ts', 'src/../outside.ts', './src/app.ts', 'src\\app.ts', 'C:/outside.ts',
    'https://example.test/a.ts', 'file:///etc/passwd', '/etc/passwd', 'src/\u202eapp.ts', 'src/\u0000bad.ts',
    'src/line\nfeed.ts', '', ' ',
  ]
  for (const filePath of invalid) {
    const harness = await makeHarness({ rules: { '.claude/rules/all.md': rule('always', 'alwaysApply: true') } })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, filePath)
      assert.equal(result.isError, false, `read remains native for ${JSON.stringify(filePath)}`)
      assert.deepEqual(contextTexts(result), [], `no injection for ${JSON.stringify(filePath)}`)
      assert.equal(harness.fileSystem.calls.length, 0, 'invalid read paths cause no filesystem calls')
    } finally {
      await harness.dispose()
    }
  }

  const harness = await makeHarness({ rules: { '.claude/rules/all.md': rule('contained absolute path', 'alwaysApply: true') } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, `${CWD}/src/app.ts`)
    assert.equal(contextTexts(result).length, 1)
  } finally {
    await harness.dispose()
  }
})

test('rejects symlinked rule roots and entries without following them', async () => {
  const rootSymlink = await makeHarness({
    rules: { '.claude/rules/escape.md': rule('outside', 'alwaysApply: true') },
    types: { '.claude': 'symlink' },
  })
  try {
    const agent = await rootSymlink.createAgent()
    const result = await rootSymlink.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(rootSymlink.fileSystem.calls.some(call => call.method === 'listDir'), false)
  } finally {
    await rootSymlink.dispose()
  }

  const rulesSymlink = await makeHarness({
    rules: { '.claude/rules/escape.md': rule('outside', 'alwaysApply: true') },
    types: { '.claude/rules': 'symlink' },
  })
  try {
    const agent = await rulesSymlink.createAgent()
    const result = await rulesSymlink.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(rulesSymlink.fileSystem.calls.some(call => call.method === 'listDir'), false)
  } finally {
    await rulesSymlink.dispose()
  }

  const entrySymlink = await makeHarness({ rules: {
    '.claude/rules/safe.md': rule('safe rule', 'alwaysApply: true'),
    '.claude/rules/link.mdc': { type: 'symlink', resolveOutside: true, text: 'do not read' },
    '.claude/rules/nested/escape.md': rule('nested target', 'alwaysApply: true'),
  }, types: { '.claude/rules/nested': 'symlink' } })
  try {
    const agent = await entrySymlink.createAgent()
    const result = await entrySymlink.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result).map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), ['.claude/rules/safe.md'])
    assert.ok(!entrySymlink.fileSystem.calls.some(call => call.method === 'lstat' && call.path === '.claude/rules/link.mdc'), 'non-file listing entries are rejected before path resolution')
    assert.ok(!entrySymlink.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.claude/rules/link.mdc'))
    assert.ok(!entrySymlink.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '.claude/rules/nested'))
  } finally {
    await entrySymlink.dispose()
  }
})

test('rejects changed rule target, containment, lstat type, and stat version after readBytes', async () => {
  const rulePath = '.claude/rules/replace.md'
  const cases = [
    { label: 'target key', record: { afterTargetKey: 'replacement-target' } },
    { label: 'containment', record: { afterContains: false } },
    { label: 'lstat type', record: { afterPathInfo: { type: 'symlink' } } },
    { label: 'stat version', record: { afterStat: { type: 'file', size: encoder.encode(rule('safe', 'alwaysApply: true')).byteLength, version: 'v2' } } },
  ]
  for (const { label, record } of cases) {
    const harness = await makeHarness({ rules: { [rulePath]: { ...makeRecord(rule('safe', 'alwaysApply: true')), ...record } } })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.equal(result.isError, false, label)
      assert.deepEqual(contextTexts(result), [], label)
    } finally {
      await harness.dispose()
    }
  }
})

test('enforces per-file, aggregate, directory, entry, depth, and injected-rule limits fail-open', async t => {
  await t.test('oversized rule file', async () => {
    const harness = await makeHarness({ rules: {
      '.claude/rules/large.md': rule('x'.repeat(16_385), 'alwaysApply: true'),
    } })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.equal(result.isError, false)
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '.claude/rules/large.md'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('aggregate rule bytes', async () => {
    const body = 'x'.repeat(11_000)
    const rules = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [
      `.claude/rules/${index}.md`, rule(body, 'alwaysApply: true'),
    ]))
    const harness = await makeHarness({ rules })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.deepEqual(contextTexts(result), [])
    } finally {
      await harness.dispose()
    }
  })

  await t.test('invalid UTF-8 source bytes count toward the aggregate cap', async () => {
    const invalidBytes = new Uint8Array(1_024).fill(0xff)
    const rules = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      `.claude/rules/invalid-${String(index).padStart(2, '0')}.md`, { bytes: invalidBytes, type: 'file' },
    ]))
    const harness = await makeHarness({ rules })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.deepEqual(contextTexts(result), [])
      const reads = harness.fileSystem.calls.filter(call => call.method === 'readBytes')
      assert.equal(reads.length, 32)
      assert.equal(reads.reduce((total, call) => total + harness.fileSystem.records.get(call.target.relative).bytes.byteLength, 0), 32_768)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('post-read identity failures count toward the aggregate cap', async () => {
    const bytes = new Uint8Array(1_024).fill(0x61)
    const rules = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      `.claude/rules/stale-${String(index).padStart(2, '0')}.md`, {
        bytes,
        type: 'file',
        afterTargetKey: `stale-target-${index}`,
      },
    ]))
    const harness = await makeHarness({ rules })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes').length, 32)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('processed entries', async () => {
    const rules = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
      `.claude/rules/${String(index).padStart(3, '0')}.txt`, 'ignored',
    ]))
    const harness = await makeHarness({ rules })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.deepEqual(contextTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'), false)
    } finally {
      await harness.dispose()
    }
  })

  await t.test('directory count', async () => {
    const types = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
      `.claude/rules/dir-${String(index).padStart(2, '0')}`, 'directory',
    ]))
    const harness = await makeHarness({ types })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.deepEqual(contextTexts(result), [])
    } finally {
      await harness.dispose()
    }
  })

  await t.test('maximum injected rules', async () => {
    const rules = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
      `.claude/rules/${String(index).padStart(2, '0')}.md`, rule(`rule ${index}`, 'alwaysApply: true'),
    ]))
    const harness = await makeHarness({ rules })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.deepEqual(contextTexts(result), [])
    } finally {
      await harness.dispose()
    }
  })

  await t.test('maximum depth', async () => {
    const directory = Array.from({ length: 9 }, (_, index) => `d${index}`).join('/')
    const harness = await makeHarness({ rules: { [`.claude/rules/${directory}/deep.md`]: rule('too deep', 'alwaysApply: true') } })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.deepEqual(contextTexts(result), [])
    } finally {
      await harness.dispose()
    }
  })
})

test('deduplicates per live Agent by body hash, resets on clear/compact, and observes changed content', async () => {
  const rulePath = '.claude/rules/always.md'
  const harness = await makeHarness({ rules: { [rulePath]: rule('first body', 'alwaysApply: true') } })
  try {
    const firstAgent = await harness.createAgent('agent-1')
    const first = await harness.executeRead(firstAgent)
    assert.equal(contextTexts(first).length, 1)
    const duplicate = await harness.executeRead(firstAgent)
    assert.deepEqual(contextTexts(duplicate), [])

    const secondAgent = await harness.createAgent('agent-2')
    const isolated = await harness.executeRead(secondAgent)
    assert.equal(contextTexts(isolated).length, 1, 'dedupe state is per Agent')

    harness.fileSystem.fs.setFileText(rulePath, rule('changed body', 'alwaysApply: true'))
    const changed = await harness.executeRead(firstAgent)
    assert.equal(contextTexts(changed).length, 1)
    assert.ok(contextTexts(changed)[0].includes('changed body'))

    await harness.reannounce(firstAgent, 'resume')
    assert.deepEqual(contextTexts(await harness.executeRead(firstAgent)), [], 'resume does not reset rule dedupe')

    await harness.reannounce(firstAgent, 'clear')
    const afterClear = await harness.executeRead(firstAgent)
    assert.equal(contextTexts(afterClear).length, 1)
    await harness.reannounce(firstAgent, 'compact')
    const afterCompact = await harness.executeRead(firstAgent)
    assert.equal(contextTexts(afterCompact).length, 1)
  } finally {
    await harness.dispose()
  }
})

test('reserves a matched rule only once across concurrent reads on one Agent', async () => {
  const harness = await makeHarness({ rules: { '.claude/rules/all.md': rule('concurrent context', 'alwaysApply: true') } })
  try {
    const agent = await harness.createAgent()
    const results = await Promise.all([
      harness.executeRead(agent, 'src/first.ts'),
      harness.executeRead(agent, 'src/second.ts'),
    ])
    assert.ok(results.every(result => result.isError === false))
    assert.deepEqual(results.map(result => contextTexts(result).length).sort(), [0, 1])
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes').length, 2,
      'each concurrent read rereads the rule file before shared dedupe commits')
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'listDir' && call.path === '.claude/rules').length, 2,
      'each concurrent read walks the rule root independently')
  } finally {
    await harness.dispose()
  }
})

test('clear during an in-flight scan fences stale rule commits', async () => {
  const rulePath = '.claude/rules/all.md'
  const bytes = encoder.encode(rule('fresh after clear', 'alwaysApply: true'))
  let signalReadEntered
  const readEntered = new Promise(resolve => { signalReadEntered = resolve })
  let releaseRead
  const blockedRead = new Promise(resolve => { releaseRead = resolve })
  const harness = await makeHarness({ rules: {
    [rulePath]: {
      bytes,
      type: 'file',
      onRead: () => signalReadEntered(),
      readBytes: async () => {
        await blockedRead
        return bytes
      },
    },
  } })
  try {
    const agent = await harness.createAgent()
    const inFlight = harness.executeRead(agent, 'src/app.ts')
    await readEntered
    await harness.reannounce(agent, 'clear')
    releaseRead()
    const stale = await inFlight
    assert.deepEqual(contextTexts(stale), [])
    const fresh = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(contextTexts(fresh).length, 1)
    assert.ok(contextTexts(fresh)[0].includes('fresh after clear'))
  } finally {
    releaseRead()
    await harness.dispose()
  }
})

test('bounds the per-Agent dedupe cache to 256 entries', async () => {
  const rulePath = '.claude/rules/always.md'
  const harness = await makeHarness({ rules: { [rulePath]: rule('cache-0', 'alwaysApply: true') } })
  try {
    const agent = await harness.createAgent()
    assert.equal(contextTexts(await harness.executeRead(agent)).length, 1)
    for (let index = 1; index <= 256; index++) {
      harness.fileSystem.fs.setFileText(rulePath, rule(`cache-${index}`, 'alwaysApply: true'))
      assert.equal(contextTexts(await harness.executeRead(agent)).length, 1)
    }
    harness.fileSystem.fs.setFileText(rulePath, rule('cache-0', 'alwaysApply: true'))
    assert.equal(contextTexts(await harness.executeRead(agent)).length, 1, 'the least-recently inserted key was evicted')
  } finally {
    await harness.dispose()
  }
})

test('sanitizes Bidi/control text and escapes prompt-variable braces', async () => {
  const bidi = [...'\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069']
  const payload = `before\u0000${bidi.join('')} {{danger}} \n\t\r after`
  const harness = await makeHarness({ rules: { '.claude/rules/safe.md': rule(payload, 'alwaysApply: true') } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    const text = contextTexts(result)[0]
    assert.ok(text.includes('\uff5b\uff5bdanger\uff5d\uff5d'))
    assert.ok(text.includes('\n\t\r'))
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(text))
  } finally {
    await harness.dispose()
  }
})

test('fails open for FS errors, read errors, blocked decisions, cancellation and plugin unload', async t => {
  await t.test('listDir failure preserves accepted native result', async () => {
    const harness = await makeHarness({ failListDir: true, rules: { '.claude/rules/r.md': rule('rule', 'alwaysApply: true') } })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.equal(result.isError, false)
      assert.deepEqual(result.value, { body: 'body:src/app.ts' })
      assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/app.ts' }])
      assert.deepEqual(contextTexts(result), [])
    } finally {
      await harness.dispose()
    }
  })

  await t.test('tool error and blocked decision have no rule context', async () => {
    const errorHarness = await makeHarness({ toolError: true, rules: { '.claude/rules/r.md': rule('rule', 'alwaysApply: true') } })
    try {
      const agent = await errorHarness.createAgent()
      const result = await errorHarness.executeRead(agent)
      assert.equal(result.isError, true)
      assert.deepEqual(contextTexts(result), [])
    } finally {
      await errorHarness.dispose()
    }

    const blocked = await makeHarness({ blockRead: true, rules: { '.claude/rules/r.md': rule('rule', 'alwaysApply: true') } })
    try {
      const agent = await blocked.createAgent()
      const result = await blocked.executeRead(agent)
      assert.equal(result.isError, true)
      assert.deepEqual(contextTexts(result), [])
    } finally {
      await blocked.dispose()
    }
  })

  await t.test('plugin unload aborts a pending scan and preserves the native result', async () => {
    const harness = await makeHarness({ hangListDir: true, rules: { '.claude/rules/r.md': rule('rule', 'alwaysApply: true') } })
    try {
      const agent = await harness.createAgent()
      const pending = harness.executeRead(agent)
      while (!harness.fileSystem.calls.some(call => call.method === 'listDir')) await new Promise(resolve => setImmediate(resolve))
      await harness.disposeFeature()
      const result = await pending
      assert.equal(result.isError, false)
      assert.deepEqual(result.value, { body: 'body:src/app.ts' })
      assert.deepEqual(contextTexts(result), [])
      harness.fileSystem.fs.releaseListing?.()
    } finally {
      harness.fileSystem.fs.releaseListing?.()
      await harness.dispose()
    }
  })

  await t.test('execution cancellation does not append partial contexts', async () => {
    const harness = await makeHarness({ hangListDir: true, rules: { '.claude/rules/r.md': rule('rule', 'alwaysApply: true') } })
    try {
      const agent = await harness.createAgent()
      const controller = new AbortController()
      const pending = harness.executeRead(agent, 'src/app.ts', { signal: controller.signal })
      while (!harness.fileSystem.calls.some(call => call.method === 'listDir')) await new Promise(resolve => setImmediate(resolve))
      controller.abort()
      harness.fileSystem.fs.releaseListing?.()
      const result = await pending
      assert.deepEqual(contextTexts(result), [])
    } finally {
      harness.fileSystem.fs.releaseListing?.()
      await harness.dispose()
    }
  })
})

test('bounds one whole filesystem scan with a five-second deadline', async () => {
  const harness = await makeHarness({ hangListDir: true, rules: { '.claude/rules/r.md': rule('rule', 'alwaysApply: true') } })
  const started = Date.now()
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    assert.ok(Date.now() - started >= 4_900)
    assert.ok(Date.now() - started < 8_000)
    assert.equal(result.isError, false)
    assert.deepEqual(contextTexts(result), [])
  } finally {
    harness.fileSystem.fs.releaseListing?.()
    await harness.dispose()
  }
})
