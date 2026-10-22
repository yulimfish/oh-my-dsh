import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { posix as path } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createClaudeRulesOnReadContextListener, normalizeUserClaudeRulesRoots, normalizeUserOpenCodeRulesRoots, registerClaudeRulesOnReadContext } from '../src/claude-rules-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))

const CWD = '/workspace/project'
const USER_CLAUDE_RULES_ROOT = '/Users/alice/.claude/rules'
const USER_OMO_RULES_ROOT = '/Users/alice/.omo/rules'
const USER_OPENCODE_RULES_ROOT = '/Users/alice/.opencode/rules'
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
  userClaudeRulesRoot = USER_CLAUDE_RULES_ROOT,
  userOpenCodeRulesRoots = [],
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
    ...userOpenCodeRulesRoots.map((root, index) => ({ path: root, relative: `@opencode${index}` })),
  ].sort((left, right) => right.path.length - left.path.length)
  const directories = new Set(['', '.claude', '.claude/rules'])
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
    if (value === cwd) return ''
    for (const root of userRootMappings) {
      if (value === root.path) return root.relative
      if (path.isAbsolute(value) && value.startsWith(`${root.path}/`)) {
        return `${root.relative}/${path.relative(root.path, value)}`
      }
    }
    if (path.isAbsolute(value)) {
      const relative = path.relative(cwd, value)
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined
      return relative
    }
    const userRoot = userRootMappings.find(root => root.path === baseCwd)
    if (userRoot) {
      const relative = path.normalize(value)
      if (relative === '.') return userRoot.relative
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined
      return `${userRoot.relative}/${relative}`
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
      if (options.cwd !== undefined && options.cwd !== cwd && !userRootMappings.some(root => root.path === options.cwd)) {
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
      userOpenCodeRulesRoots: options.userOpenCodeRulesRoots ?? [],
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

test('scans session-cwd .omo rules before Claude and configured user roots', async () => {
  const harness = await makeHarness({
    includeProjectOmoRoot: true,
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    userOpenCodeRulesRoots: [USER_OPENCODE_RULES_ROOT, USER_OMO_RULES_ROOT],
    rules: {
      '.omo/rules/project-omo.md': rule('shared project body', 'alwaysApply: true'),
      '.claude/rules/project-duplicate.md': rule('shared project body', 'alwaysApply: true'),
      '.claude/rules/project-claude.md': rule('cwd Claude source', 'alwaysApply: true'),
      '@opencode1/user-omo.md': rule('user OMO source', 'alwaysApply: true'),
      '@opencode0/user-opencode.md': rule('user OpenCode source', 'alwaysApply: true'),
      '@user/user-claude.md': rule('user Claude source', 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    const texts = contextTexts(result)
    assert.deepEqual(texts.map(text => text.match(/^\[Rule: ([^\]]+)/u)?.[1]), [
      '.omo/rules/project-omo.md',
      '.claude/rules/project-claude.md',
      'user/.omo/rules/user-omo.md',
      'user/.opencode/rules/user-opencode.md',
      'user/.claude/rules/user-claude.md',
    ])
    assert.equal(texts.filter(text => text.includes('shared project body')).length, 1)
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

test('scans explicit OpenCode user roots after project rules in pinned priority order', async () => {
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    userOpenCodeRulesRoots: [USER_OPENCODE_RULES_ROOT, USER_OMO_RULES_ROOT],
    rules: {
      '.claude/rules/project.md': rule('project rule first', 'alwaysApply: true'),
      '@opencode1/omo.mdc': rule('explicit OMO global source', 'globs: "**/*.ts"'),
      '@opencode0/opencode.md': rule('explicit OpenCode global source', 'alwaysApply: true'),
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
    ])
    for (const [index, expected] of [
      'project rule first',
      'explicit OMO global source',
      'explicit OpenCode global source',
      'explicit Claude global source',
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
  } })
  try {
    const agent = await implicit.createAgent()
    const result = await implicit.executeRead(agent, 'src/app.ts')
    assert.deepEqual(contextTexts(result), [])
    assert.equal(implicit.fileSystem.calls.some(call => call.method === 'listDir' && call.path === '@user'), false)
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

test('uses shared per-invocation byte budgets across project and explicit user rule roots', async () => {
  const body = 'x'.repeat(11_000)
  const harness = await makeHarness({
    userClaudeRulesRoots: [USER_CLAUDE_RULES_ROOT],
    userOpenCodeRulesRoots: [USER_OMO_RULES_ROOT],
    rules: {
      '.claude/rules/a.md': rule(body, 'alwaysApply: true'),
      '.claude/rules/b.md': rule(body, 'alwaysApply: true'),
      '@opencode0/c.md': rule(body, 'alwaysApply: true'),
      '@user/d.md': rule(body, 'alwaysApply: true'),
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, 'src/app.ts')
    assert.equal(result.isError, false)
    assert.deepEqual(contextTexts(result), [], 'the root scans fail open without partially injecting earlier matches')
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes').length, 2)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@opencode0/c.md'), false,
      'project bytes reduce the earlier OpenCode user-root byte allowance')
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes' && call.target?.relative === '@user/d.md'), false,
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
    toolErrorName: 'write',
    rules: { '.claude/rules/all.md': rule('must not inject after failure', 'alwaysApply: true') },
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
    blockTool: 'edit',
    rules: { '.claude/rules/all.md': rule('must not inject after block', 'alwaysApply: true') },
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
