import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { posix as path } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRootAgentsContextListener } from '../src/agents-context.js'
import { createRootReadmeContextListener } from '../src/readme-context.js'
import {
  createAgentsOnReadContextListener,
  createReadmeOnReadContextListener,
  registerAgentsOnReadContext,
  registerReadmeOnReadContext,
} from '../src/readme-on-read.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))

const CWD = '/workspace/project'
const encoder = new TextEncoder()

function userContext(text) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function normalizeRecord(value) {
  if (typeof value === 'string') return { text: value, bytes: encoder.encode(value) }
  return { ...value, bytes: value.bytes instanceof Uint8Array ? value.bytes : encoder.encode(value.text ?? '') }
}

function makeFileSystem({ cwd = CWD, projectRoot, readmes = {}, projectReadmes = {}, outsideRead = false, onContains } = {}) {
  const calls = []
  const projectBaseRelative = projectRoot === undefined ? undefined : '@project'
  const relativeCwd = projectRoot === undefined ? '' : path.relative(projectRoot, cwd)
  const cwdBaseRelative = projectRoot === undefined
    ? ''
    : relativeCwd === '' ? projectBaseRelative
      : relativeCwd === '..' || relativeCwd.startsWith('../') ? '@outside/cwd'
        : path.join(projectBaseRelative, relativeCwd)
  const records = new Map(Object.entries(readmes).map(([relative, record]) => [
    path.join(cwdBaseRelative, relative), normalizeRecord(record),
  ]))
  if (projectRoot !== undefined) {
    for (const [relative, record] of Object.entries(projectReadmes)) {
      records.set(path.join(projectBaseRelative, relative), normalizeRecord(record))
    }
  }
  const targets = new WeakMap()
  const directoryTargets = new Map()
  const fileTargets = new Map()
  let activeReadPath = 'src/nested/file.ts'
  let directoryPaths = new Set()

  function addDirectoryParents(relativePath) {
    const segments = relativePath.split('/')
    for (let index = 1; index < segments.length; index++) directoryPaths.add(segments.slice(0, index).join('/'))
  }

  function rebuildDirectories() {
    directoryPaths = new Set([cwdBaseRelative])
    if (projectBaseRelative !== undefined) directoryPaths.add(projectBaseRelative)
    for (const relativePath of records.keys()) addDirectoryParents(relativePath)
    const readPath = path.join(cwdBaseRelative, activeReadPath)
    addDirectoryParents(readPath)
  }

  function makeTarget(relative, kind, record, { targetKey, outside = false, after = false } = {}) {
    const target = {
      targetKey: targetKey ?? `${kind}:${cwd}:${relative}`,
      cwd,
      relative,
      kind,
      outside,
      after,
      record,
    }
    targets.set(target, { cwd, relative, kind, record, outside, after })
    return target
  }

  const rootTarget = makeTarget(cwdBaseRelative, 'directory', undefined, { targetKey: `root:${cwd}` })
  directoryTargets.set(cwdBaseRelative, rootTarget)
  const projectRootTarget = projectRoot === undefined ? undefined
    : projectRoot === cwd ? rootTarget
      : makeTarget(projectBaseRelative, 'directory', undefined, { targetKey: `project-root:${projectRoot}` })
  if (projectRootTarget) directoryTargets.set(projectBaseRelative, projectRootTarget)

  function getDirectoryTarget(relative) {
    let target = directoryTargets.get(relative)
    if (!target) {
      target = makeTarget(relative, 'directory')
      directoryTargets.set(relative, target)
    }
    return target
  }

  function getFileTarget(relative, record, kind = 'file') {
    if (!record) {
      let target = fileTargets.get(relative)
      if (!target) {
        target = makeTarget(relative, kind)
        fileTargets.set(relative, target)
      }
      return target
    }
    if (record.replaced && (record.afterTargetKey !== undefined || record.afterContains !== undefined
      || record.afterStat !== undefined || record.afterPathInfo !== undefined)) {
      if (!record.afterTarget) {
        record.afterTarget = makeTarget(relative, 'file', record, {
          targetKey: record.afterTargetKey ?? record.target?.targetKey,
          after: true,
        })
      }
      return record.afterTarget
    }
    if (!record.target) record.target = makeTarget(relative, 'file', record)
    fileTargets.set(relative, record.target)
    return record.target
  }

  function absoluteKey(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return undefined
    if (projectRoot !== undefined) {
      const projectRelative = path.relative(projectRoot, value)
      if (projectRelative === '') return projectBaseRelative
      if (!path.isAbsolute(projectRelative) && projectRelative !== '..' && !projectRelative.startsWith('../')) {
        return path.join(projectBaseRelative, projectRelative)
      }
    }
    const cwdRelative = path.relative(cwd, value)
    if (cwdRelative === '') return cwdBaseRelative
    if (!path.isAbsolute(cwdRelative) && cwdRelative !== '..' && !cwdRelative.startsWith('../')) {
      return path.join(cwdBaseRelative, cwdRelative)
    }
    return undefined
  }

  function relativeKey(value, basePath) {
    if (typeof value !== 'string') return undefined
    if (path.isAbsolute(value)) return absoluteKey(value)
    let baseRelative
    if (projectRoot !== undefined && basePath === projectRoot) baseRelative = projectBaseRelative
    else if (basePath === undefined || basePath === cwd) baseRelative = cwdBaseRelative
    else return undefined
    return value === '' || value === '.' ? baseRelative : path.join(baseRelative, value)
  }

  function isRelativeContained(parent, child) {
    return parent === '' || child === parent || child.startsWith(`${parent}/`)
  }

  rebuildDirectories()
  const fs = {
    async resolve(pathValue, options = {}) {
      calls.push({ method: 'resolve', path: pathValue, options })
      if (pathValue === cwd) return rootTarget
      if (projectRoot !== undefined && pathValue === projectRoot) return projectRootTarget
      const relativePath = relativeKey(pathValue, options.cwd)
      if (relativePath === undefined) {
        return makeTarget(String(pathValue), 'file', undefined, { targetKey: `outside:${String(pathValue)}`, outside: true })
      }
      const activeReadKey = path.join(cwdBaseRelative, activeReadPath)
      if (relativePath === activeReadKey) {
        if (outsideRead) return makeTarget(relativePath, 'file', undefined, { targetKey: `outside:${cwd}:${relativePath}`, outside: true })
        return getFileTarget(relativePath, records.get(relativePath), 'read-file')
      }
      const record = records.get(relativePath)
      if (record) return getFileTarget(relativePath, record)
      if (directoryPaths.has(relativePath)) return getDirectoryTarget(relativePath)
      throw new Error(`unexpected resolve: ${String(pathValue)}`)
    },
    contains(parent, child) {
      calls.push({ method: 'contains', parent, child })
      const parentInfo = targets.get(parent)
      const childInfo = targets.get(child)
      onContains?.({ parentInfo, childInfo })
      if (!parentInfo || !childInfo || parentInfo.kind !== 'directory'
        || childInfo.cwd !== cwd || childInfo.outside
        || !isRelativeContained(parentInfo.relative, childInfo.relative)) return false
      if (childInfo.after && childInfo.record?.afterContains !== undefined) return childInfo.record.afterContains === true
      if (childInfo.record?.replaced && childInfo.record.afterContains !== undefined && childInfo.after) {
        return childInfo.record.afterContains === true
      }
      return true
    },
    async lstat(relative, options = {}, signal) {
      calls.push({ method: 'lstat', path: relative, options, signal })
      const relativePath = relativeKey(relative, options.cwd)
      const record = relativePath === undefined ? undefined : records.get(relativePath)
      if (!record) return relativePath !== undefined && directoryPaths.has(relativePath) ? { type: 'directory' } : undefined
      record.lstatCalls = (record.lstatCalls ?? 0) + 1
      if (record.replaced && record.afterPathInfo !== undefined && record.lstatCalls > 1) return record.afterPathInfo
      return record.pathInfo ?? { type: 'file' }
    },
    async stat(target, signal) {
      calls.push({ method: 'stat', target, signal })
      const info = targets.get(target)
      if (!info) return undefined
      if (info.kind === 'directory') {
        if (info.relative === '') return { type: 'directory' }
        return info.record?.directoryInfo ?? { type: 'directory' }
      }
      const record = info.record
      if (!record) return { type: 'file', size: 0, version: 'read-v1' }
      record.statCalls = (record.statCalls ?? 0) + 1
      if (record.replaced && record.afterStat !== undefined && record.statCalls > 1) return record.afterStat
      if (record.fileInfo !== undefined) return record.fileInfo
      return { type: 'file', size: record.bytes.byteLength, version: 'v1' }
    },
    async readBytes(target, signal, maxBytes) {
      calls.push({ method: 'readBytes', target, signal, maxBytes })
      const info = targets.get(target)
      const record = info?.record
      if (!record) throw new Error('no README data for target')
      record.readCalls = (record.readCalls ?? 0) + 1
      record.replaced = true
      record.onRead?.({ target, signal, maxBytes, record })
      if (typeof record.readBytes === 'function') return record.readBytes(target, signal, maxBytes)
      if (record.bytes.byteLength > maxBytes) throw new RangeError('readBytes maximum exceeded')
      return record.bytes
    },
    setReadPath(relative) {
      activeReadPath = path.isAbsolute(relative) ? path.relative(cwd, relative) : relative
      rebuildDirectories()
    },
  }
  return { fs, calls, records }
}

async function makeHarness(options = {}) {
  const ctx = new Context()
  const systemPromptFiber = await ctx.plugin(SystemPrompt)
  const agentRegistryFiber = await ctx.plugin(AgentRegistry)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const agents = ctx.agents
  const sessions = new Map()
  const sessionService = { get: id => sessions.get(id) }
  const fileSystem = makeFileSystem({
    cwd: options.cwd ?? CWD,
    projectRoot: options.projectRoot,
    readmes: options.readmes,
    projectReadmes: options.projectReadmes,
    outsideRead: options.outsideRead,
    onContains: options.onContains,
  })
  const registerContext = options.contextType === 'agents' ? registerAgentsOnReadContext : registerReadmeOnReadContext
  const listenerOptions = {
    ...(options.skipRoot === undefined ? {} : { skipRoot: options.skipRoot }),
    ...(options.rootSnapshotAvailable === undefined ? {} : { rootSnapshotAvailable: options.rootSnapshotAvailable }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.projectRootSnapshotAvailable === undefined
      ? {} : { projectRootSnapshotAvailable: options.projectRootSnapshotAvailable }),
    ...(options.includeCwd === undefined ? {} : { includeCwd: options.includeCwd }),
  }
  const featureFiber = await ctx.plugin(pluginCtx => registerContext(
    pluginCtx,
    agents,
    sessionService,
    fileSystem.fs,
    listenerOptions,
  ))
  const downstreamContext = options.downstreamContext ? userContext('downstream policy context') : undefined
  let policyFiber
  if (options.blockRead || downstreamContext) {
    policyFiber = await ctx.plugin(pluginCtx => pluginCtx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'read') return decision
      if (options.blockRead) {
        return {
          kind: 'block',
          feedback: [{ type: 'text', text: 'The read result was blocked.' }],
          ...(downstreamContext ? { additionalContexts: [downstreamContext] } : {}),
        }
      }
      return downstreamContext
        ? { ...decision, additionalContexts: [...decision.additionalContexts ?? [], downstreamContext] }
        : decision
    }))
  }

  const finalizerCalls = []
  const toolContext = options.toolContext ? userContext('tool-owned deferred context') : undefined
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
    async execute(args, exec) {
      if (options.toolError) throw new Error('simulated read failure')
      if (toolContext) exec.deferContext(toolContext)
      return { body: `body:${String(args?.file_path ?? 'missing')}` }
    },
    finalizeContent(_exec, result) {
      finalizerCalls.push({
        isError: result.isError,
        value: result.value,
        content: result.content,
        additionalContexts: result.additionalContexts,
      })
      const previous = result.content.map(block => block.type === 'text' ? block.text : '[non-text]').join('\n')
      return [{ type: 'text', text: `finalized:${previous}` }]
    },
  })
  const unregisterRead = ctx.tools.register(readTool)
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
    const detach = agents.enter(agent, undefined)
    detachAgents.set(agent.id, detach)
    await agents.announce(agent, source)
  }

  async function replaceAgent(agent, source) {
    const id = agent.id
    const cwd = sessions.get(id)?.header?.cwd ?? options.cwd ?? CWD
    detachAgents.get(id)?.()
    const replacement = { id, session: { id } }
    const scope = createScope(ctx, replacement)
    scopes.push(scope)
    await scope.ctx.inject(['systemPrompt'], injected => { replacement.ctx = injected })
    const detach = agents.enter(replacement, undefined)
    detachAgents.set(id, detach)
    await agents.announce(replacement, source)
    return replacement
  }

  async function executeRead(agent, args = { file_path: 'src/nested/file.ts' }, { signal = new AbortController().signal } = {}) {
    if (typeof args?.file_path === 'string') fileSystem.fs.setReadPath(args.file_path)
    callCount++
    return ctx.tools.execute({
      callId: `read-call-${callCount}`,
      name: 'read',
      arguments: args,
      agent,
      signal,
    })
  }

  async function disposeFeature() {
    await featureFiber.dispose()
  }

  async function dispose() {
    await featureFiber.dispose()
    await policyFiber?.dispose()
    unregisterRead()
    for (const detach of detachAgents.values()) detach()
    detachAgents.clear()
    for (const scope of scopes) await scope.dispose()
    await toolsFiber.dispose()
    await agentRegistryFiber.dispose()
    await systemPromptFiber.dispose()
  }

  return {
    ctx,
    agents,
    sessions,
    sessionService,
    fileSystem,
    finalizerCalls,
    createAgent,
    reannounce,
    replaceAgent,
    executeRead,
    disposeFeature,
    dispose,
    toolContext,
    downstreamContext,
  }
}

function readmeTexts(result) {
  return (result.additionalContexts ?? []).map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
}

async function runConcurrentDirectoryContextReads(contextType, firstReadFails) {
  const firstReadStarted = deferred()
  const firstReadGate = deferred()
  const secondReadTargetContained = deferred()
  const contextFileName = contextType === 'agents' ? 'AGENTS.md' : 'README.md'
  let readCount = 0
  let readTargetCount = 0
  const harness = await makeHarness({
    contextType,
    readmes: {
      [contextFileName]: {
        text: `# shared ${contextType}`,
        readBytes() {
          readCount += 1
          if (readCount === 1) {
            firstReadStarted.resolve()
            return firstReadGate.promise
          }
          return encoder.encode(`# shared ${contextType}`)
        },
      },
    },
    onContains: ({ childInfo }) => {
      if (childInfo?.kind !== 'read-file') return
      readTargetCount += 1
      if (readTargetCount === 2) secondReadTargetContained.resolve()
    },
  })
  try {
    const agent = await harness.createAgent()
    const first = harness.executeRead(agent)
    await firstReadStarted.promise
    const second = harness.executeRead(agent)
    await secondReadTargetContained.promise
    if (firstReadFails) firstReadGate.reject(new Error('transient first context read failure'))
    else firstReadGate.resolve(encoder.encode(`# shared ${contextType}`))
    const results = await Promise.all([first, second])
    const after = await harness.executeRead(agent)
    return { results, after, readCount }
  } finally {
    await harness.dispose()
  }
}

async function beginConcurrentPendingDirectoryReads({ contextType = 'readme', secondSignal } = {}) {
  const firstReadStarted = deferred()
  const firstReadGate = deferred()
  const secondReadTargetContained = deferred()
  const contextFileName = contextType === 'agents' ? 'AGENTS.md' : 'README.md'
  let readCount = 0
  const readSignals = []
  let readTargetCount = 0
  const harness = await makeHarness({
    contextType,
    readmes: {
      [contextFileName]: {
        text: `# shared ${contextType}`,
        readBytes(_target, signal) {
          readSignals.push(signal)
          readCount += 1
          if (readCount === 1) {
            firstReadStarted.resolve()
            return firstReadGate.promise
          }
          return encoder.encode(`# shared ${contextType}`)
        },
      },
    },
    onContains: ({ childInfo }) => {
      if (childInfo?.kind !== 'read-file') return
      readTargetCount += 1
      if (readTargetCount === 2) secondReadTargetContained.resolve()
    },
  })
  const agent = await harness.createAgent()
  const first = harness.executeRead(agent)
  await firstReadStarted.promise
  const second = harness.executeRead(agent, undefined, { signal: secondSignal })
  await secondReadTargetContained.promise
  return {
    harness,
    agent,
    first,
    second,
    firstReadGate,
    readSignals,
    readCount: () => readCount,
  }
}

test('appends root-to-nested README contexts after existing contexts and preserves canonical output through finalizeContent', async () => {
  const harness = await makeHarness({
    readmes: {
      'README.md': '# root guidance',
      'src/README.md': '# src guidance',
      'src/nested/README.md': '# nested guidance',
    },
    toolContext: true,
    downstreamContext: true,
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/nested/file.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/nested/file.ts' }])
    assert.equal(harness.finalizerCalls.length, 1)
    assert.deepEqual(harness.finalizerCalls[0].value, result.value)
    assert.equal(harness.finalizerCalls[0].content[0].text, 'canonical:body:src/nested/file.ts')
    const contexts = result.additionalContexts ?? []
    assert.equal(contexts.length, 5)
    assert.equal(contexts[0].content[0].text, 'tool-owned deferred context')
    assert.deepEqual(contexts[1], harness.downstreamContext)
    assert.deepEqual(readmeTexts({ additionalContexts: contexts.slice(2) }).map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), [
      'README.md', 'src/README.md', 'src/nested/README.md',
    ])
    assert.deepEqual(harness.finalizerCalls[0].additionalContexts, contexts)
    assert.ok(contexts.slice(2).every(message => message.role === 'user' && message.source.kind === 'user'))
    assert.match(contexts[2].content[0].text, /untrusted repository text/u)

    const readsBefore = harness.fileSystem.calls.filter(call => call.method === 'readBytes').length
    const duplicate = await harness.executeRead(agent)
    assert.equal(duplicate.isError, false)
    assert.deepEqual(duplicate.value, result.value)
    assert.deepEqual(duplicate.content, result.content)
    assert.equal((duplicate.additionalContexts ?? []).length, 2, 'tool/delegated contexts remain, while deduped README contexts do not repeat')
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes').length, readsBefore)

    await harness.reannounce(agent, 'clear')
    const afterClear = await harness.executeRead(agent)
    assert.equal((afterClear.additionalContexts ?? []).length, 5, 'clear resets per-Agent/directory dedupe')
    await harness.reannounce(agent, 'compact')
    const afterCompact = await harness.executeRead(agent)
    assert.equal((afterCompact.additionalContexts ?? []).length, 5, 'compact resets per-Agent/directory dedupe')
  } finally {
    await harness.dispose()
  }
})

test('injects root-to-nested AGENTS.md contexts after successful reads as untrusted separate messages', async () => {
  const harness = await makeHarness({
    contextType: 'agents',
    readmes: {
      'AGENTS.md': '# root instructions',
      'src/AGENTS.md': '# src instructions',
      'src/nested/AGENTS.md': '# nested instructions',
    },
    toolContext: true,
    downstreamContext: true,
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/nested/file.ts' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'finalized:canonical:body:src/nested/file.ts' }])
    const contexts = result.additionalContexts ?? []
    assert.equal(contexts.length, 5)
    assert.equal(contexts[0].content[0].text, 'tool-owned deferred context')
    assert.deepEqual(contexts[1], harness.downstreamContext)
    const injected = contexts.slice(2)
    assert.deepEqual(readmeTexts({ additionalContexts: injected }).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), [
      'AGENTS.md', 'src/AGENTS.md', 'src/nested/AGENTS.md',
    ])
    assert.match(injected[0].content[0].text, /untrusted repository text, not instructions from the user/u)
    assert.ok(injected.every(message => message.role === 'user' && message.source.kind === 'user'))

    const readsBefore = harness.fileSystem.calls.filter(call => call.method === 'readBytes').length
    const duplicate = await harness.executeRead(agent)
    assert.equal(duplicate.isError, false)
    assert.deepEqual(duplicate.value, result.value)
    assert.deepEqual(duplicate.content, result.content)
    assert.equal((duplicate.additionalContexts ?? []).length, 2, 'existing Tool contexts remain while deduped AGENTS contexts do not repeat')
    assert.equal(harness.fileSystem.calls.filter(call => call.method === 'readBytes').length, readsBefore)

    await harness.reannounce(agent, 'clear')
    assert.equal((await harness.executeRead(agent)).additionalContexts.length, 5, 'clear resets per-Agent/directory dedupe')
    await harness.reannounce(agent, 'compact')
    assert.equal((await harness.executeRead(agent)).additionalContexts.length, 5, 'compact resets per-Agent/directory dedupe')
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root README context walks configured ancestors before a nested CWD', async () => {
  const harness = await makeHarness({
    contextType: 'readme',
    cwd: '/workspace/apps/demo',
    projectRoot: '/workspace',
    includeCwd: false,
    projectReadmes: {
      'README.md': '# project README',
      'apps/README.md': '# apps README',
      'apps/demo/README.md': '# cwd README',
      'apps/demo/src/README.md': '# src README',
    },
  })
  try {
    const agent = await harness.createAgent('project-readme-on-read', '/workspace/apps/demo')
    const result = await harness.executeRead(agent, { file_path: 'src/nested/file.ts' })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/nested/file.ts' })
    assert.match(result.content[0].text, /finalized:canonical:body:src\/nested\/file\.ts/u)
    const contexts = readmeTexts(result)
    assert.deepEqual(contexts.map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), [
      'README.md', 'apps/README.md', 'apps/demo/README.md', 'apps/demo/src/README.md',
    ])
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root README context is limited to top-level accepted reads', async () => {
  const projectRoot = '/workspace'
  const cwd = '/workspace/apps/demo'
  const harness = await makeHarness({
    contextType: 'readme', cwd, projectRoot, includeCwd: false,
    projectReadmes: { 'README.md': '# project README' },
  })
  const listener = createReadmeOnReadContextListener(
    harness.agents, harness.sessionService, harness.fileSystem.fs, { projectRoot, includeCwd: false },
  )
  try {
    const agent = await harness.createAgent('nested-project-readme', cwd)
    let nextCalls = 0
    const result = await listener({
      name: 'read',
      arguments: { file_path: 'src/nested/file.ts' },
      agent,
      signal: new AbortController().signal,
      parent: Symbol('nested-tool-call'),
    }, { isError: false }, async () => {
      nextCalls++
      return { kind: 'accept', value: { body: 'native' }, content: [{ type: 'text', text: 'native' }] }
    })
    assert.equal(nextCalls, 1)
    assert.deepEqual(readmeTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    listener.dispose()
    await harness.dispose()
  }
})

test('explicit project-root AGENTS context walks configured ancestors before a nested CWD', async () => {
  const harness = await makeHarness({
    contextType: 'agents',
    cwd: '/workspace/apps/demo',
    projectRoot: '/workspace',
    includeCwd: false,
    projectReadmes: {
      'AGENTS.md': '# project instructions',
      'apps/AGENTS.md': '# apps instructions',
      'apps/demo/AGENTS.md': '# cwd instructions',
      'apps/demo/src/AGENTS.md': '# src instructions',
      'apps/demo/src/nested/AGENTS.md': '# nested instructions',
    },
    toolContext: true,
    downstreamContext: true,
  })
  try {
    const agent = await harness.createAgent('project-agents-on-read', '/workspace/apps/demo')
    const result = await harness.executeRead(agent, { file_path: 'src/nested/file.ts' })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/nested/file.ts' })
    assert.match(result.content[0].text, /finalized:canonical:body:src\/nested\/file\.ts/u)
    const contexts = result.additionalContexts ?? []
    assert.equal(contexts[0].content[0].text, 'tool-owned deferred context')
    assert.deepEqual(contexts[1], harness.downstreamContext)
    const injected = contexts.slice(2)
    assert.deepEqual(readmeTexts({ additionalContexts: injected }).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), [
      'AGENTS.md',
      'apps/AGENTS.md',
      'apps/demo/AGENTS.md',
      'apps/demo/src/AGENTS.md',
      'apps/demo/src/nested/AGENTS.md',
    ])
    assert.ok(injected.every(message => message.role === 'user' && message.source.kind === 'user'))
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root AGENTS scope fails open outside the root and on lexical identity mismatch', async () => {
  const outside = await makeHarness({
    contextType: 'agents',
    cwd: '/workspace/other',
    projectRoot: '/workspace/project',
    includeCwd: false,
    projectReadmes: { 'AGENTS.md': '# out-of-scope project instructions' },
  })
  try {
    const agent = await outside.createAgent('outside-project-agents', '/workspace/other')
    const result = await outside.executeRead(agent)
    assert.deepEqual(readmeTexts(result), [])
    assert.equal(outside.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    await outside.dispose()
  }

  const mismatch = await makeHarness({
    contextType: 'agents',
    cwd: '/workspace/apps/demo',
    projectRoot: '/workspace',
    includeCwd: false,
    projectReadmes: { 'AGENTS.md': '# mismatched identity must not be read' },
  })
  const originalResolve = mismatch.fileSystem.fs.resolve.bind(mismatch.fileSystem.fs)
  mismatch.fileSystem.fs.resolve = async (pathValue, options = {}) => {
    const target = await originalResolve(pathValue, options)
    if (pathValue === 'apps/demo' && options.cwd === '/workspace') return { ...target, targetKey: 'different-cwd-identity' }
    return target
  }
  try {
    const agent = await mismatch.createAgent('mismatched-project-agents', '/workspace/apps/demo')
    const result = await mismatch.executeRead(agent)
    assert.deepEqual(readmeTexts(result), [])
    assert.equal(mismatch.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    await mismatch.dispose()
  }
})

test('explicit project-root AGENTS refuses a symlink root before reading context', async () => {
  const projectRoot = '/workspace'
  const harness = await makeHarness({
    contextType: 'agents',
    cwd: '/workspace/apps/demo',
    projectRoot,
    includeCwd: false,
    projectReadmes: { 'AGENTS.md': '# must not be read through a symlink root' },
  })
  const originalLstat = harness.fileSystem.fs.lstat.bind(harness.fileSystem.fs)
  harness.fileSystem.fs.lstat = async (pathValue, options, signal) => {
    if (pathValue === projectRoot) return { type: 'symlink' }
    return originalLstat(pathValue, options, signal)
  }
  try {
    const agent = await harness.createAgent('symlink-project-agents-root', '/workspace/apps/demo')
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root AGENTS context is limited to top-level accepted reads', async () => {
  const projectRoot = '/workspace'
  const cwd = '/workspace/apps/demo'
  const harness = await makeHarness({
    contextType: 'agents', cwd, projectRoot, includeCwd: false,
    projectReadmes: { 'AGENTS.md': '# project instructions' },
  })
  const listener = createAgentsOnReadContextListener(
    harness.agents,
    harness.sessionService,
    harness.fileSystem.fs,
    { projectRoot, includeCwd: false },
  )
  try {
    const agent = await harness.createAgent('nested-project-agents', cwd)
    let nextCalls = 0
    const result = await listener({
      name: 'read',
      arguments: { file_path: 'src/nested/file.ts' },
      agent,
      signal: new AbortController().signal,
      parent: Symbol('nested-tool-call'),
    }, { isError: false }, async () => {
      nextCalls++
      return { kind: 'accept', value: { body: 'native' }, content: [{ type: 'text', text: 'native' }] }
    })
    assert.equal(nextCalls, 1)
    assert.deepEqual(readmeTexts(result), [])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    listener.dispose()
    await harness.dispose()
  }
})

test('explicit project-root AGENTS traversal retains the eight-directory cap', async () => {
  const projectRoot = '/workspace'
  const cwd = '/workspace/a/b/c/d/e/f/g/h/i'
  const directoryNames = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
  const projectReadmes = { 'AGENTS.md': '# root' }
  for (let depth = 1; depth <= directoryNames.length; depth++) {
    projectReadmes[`${directoryNames.slice(0, depth).join('/')}/AGENTS.md`] = `# level ${depth}`
  }
  const harness = await makeHarness({
    contextType: 'agents', cwd, projectRoot, includeCwd: false, projectReadmes,
  })
  try {
    const agent = await harness.createAgent('project-agents-depth-cap', cwd)
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), [
      'AGENTS.md',
      ...directoryNames.slice(0, 7).map((_, index) => `${directoryNames.slice(0, index + 1).join('/')}/AGENTS.md`),
    ])
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root and CWD walks share the aggregate AGENTS byte cap', async () => {
  const projectRoot = '/workspace'
  const cwd = '/workspace/a/b/c/d/e/f/g/h/i'
  const limitSizedText = 'x'.repeat(16_384)
  const harness = await makeHarness({
    contextType: 'agents',
    cwd,
    projectRoot,
    includeCwd: true,
    projectReadmes: {
      'AGENTS.md': limitSizedText,
      'a/AGENTS.md': limitSizedText,
      'a/b/AGENTS.md': '# should exceed shared budget',
      'a/b/c/d/e/f/g/h/i/AGENTS.md': '# cwd source should exceed shared budget',
    },
  })
  try {
    const agent = await harness.createAgent('project-agents-byte-cap', cwd)
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), [
      'AGENTS.md', 'a/AGENTS.md',
    ])
    const readBytesCalls = harness.fileSystem.calls.filter(call => call.method === 'readBytes')
    assert.equal(readBytesCalls.length, 2, 'the third project file and the CWD source are beyond the shared budget')
    assert.ok(readBytesCalls.every(call => call.maxBytes <= 16_384))
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat'
      && call.path === 'a/b/AGENTS.md' && call.options.cwd === projectRoot), false)
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat'
      && call.path === 'AGENTS.md' && call.options.cwd === cwd), false)
  } finally {
    await harness.dispose()
  }
})

test('CWD README snapshot suppresses only the nested CWD directory in explicit-root traversal', async () => {
  const projectRoot = '/workspace'
  const cwd = '/workspace/apps/demo'
  const harness = await makeHarness({
    contextType: 'readme', cwd, projectRoot, skipRoot: true, includeCwd: true,
    rootSnapshotAvailable: () => true,
    projectReadmes: {
      'README.md': '# project README',
      'apps/README.md': '# apps README',
      'apps/demo/README.md': '# cwd snapshot',
      'apps/demo/src/README.md': '# src README',
    },
  })
  try {
    const agent = await harness.createAgent('nested-project-readme-snapshot', cwd)
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), [
      'README.md', 'apps/README.md', 'apps/demo/src/README.md',
    ])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat'
      && call.path === 'apps/demo/README.md' && call.options.cwd === projectRoot), false)
  } finally {
    await harness.dispose()
  }
})

test('project-root README aliases the CWD root without duplicating a successful snapshot', async () => {
  const cwd = '/workspace/project'
  const harness = await makeHarness({
    contextType: 'readme',
    cwd,
    projectRoot: cwd,
    skipRoot: true,
    includeCwd: true,
    rootSnapshotAvailable: () => true,
    projectReadmes: {
      'README.md': '# shared root snapshot',
      'src/README.md': '# src README',
      'src/nested/README.md': '# nested README',
    },
  })
  try {
    const agent = await harness.createAgent('project-readme-cwd-alias', cwd)
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), [
      'src/README.md', 'src/nested/README.md',
    ])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === 'README.md'), false)
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root and CWD Agent snapshots suppress only their exact directories', async () => {
  const projectRoot = '/workspace'
  const cwd = '/workspace/apps/demo'
  const harness = await makeHarness({
    contextType: 'agents',
    cwd,
    projectRoot,
    skipRoot: true,
    includeCwd: true,
    rootSnapshotAvailable: () => true,
    projectRootSnapshotAvailable: () => true,
    projectReadmes: {
      'AGENTS.md': '# project snapshot',
      'apps/AGENTS.md': '# apps instructions',
      'apps/demo/AGENTS.md': '# cwd snapshot',
      'apps/demo/src/AGENTS.md': '# src instructions',
      'apps/demo/src/nested/AGENTS.md': '# nested instructions',
    },
  })
  try {
    const agent = await harness.createAgent('project-agents-snapshots', cwd)
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), [
      'apps/AGENTS.md', 'apps/demo/src/AGENTS.md', 'apps/demo/src/nested/AGENTS.md',
    ])
    const lstatPaths = harness.fileSystem.calls.filter(call => call.method === 'lstat').map(call => [call.path, call.options.cwd])
    assert.equal(lstatPaths.some(([pathName, base]) => pathName === 'AGENTS.md' && base === projectRoot), false)
    assert.equal(lstatPaths.some(([pathName, base]) => pathName === 'AGENTS.md' && base === cwd), false)
  } finally {
    await harness.dispose()
  }
})

test('project-root AGENTS aliases the CWD root without duplicating a successful snapshot', async () => {
  const cwd = '/workspace/project'
  const harness = await makeHarness({
    contextType: 'agents',
    cwd,
    projectRoot: cwd,
    includeCwd: true,
    projectRootSnapshotAvailable: () => true,
    projectReadmes: {
      'AGENTS.md': '# shared root snapshot',
      'src/AGENTS.md': '# src instructions',
      'src/nested/AGENTS.md': '# nested instructions',
    },
  })
  try {
    const agent = await harness.createAgent('project-root-cwd-alias', cwd)
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), [
      'src/AGENTS.md', 'src/nested/AGENTS.md',
    ])
    const rootReads = harness.fileSystem.calls.filter(call => call.method === 'lstat' && call.path === 'AGENTS.md')
    assert.equal(rootReads.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('a failed pending README/AGENTS read lets one concurrent waiter retry', async () => {
  for (const contextType of ['readme', 'agents']) {
    const { results, after, readCount } = await runConcurrentDirectoryContextReads(contextType, true)
    assert.deepEqual(results.map(result => readmeTexts(result).length), [0, 1], `${contextType}: only the retrying read receives context`)
    assert.equal(results.every(result => result.isError === false), true)
    assert.match(readmeTexts(results[1])[0], contextType === 'agents' ? /Project AGENTS\.md/u : /Project README/u)
    assert.deepEqual(readmeTexts(after), [], `${contextType}: successful retry commits the dedupe entry`)
    assert.equal(readCount, 2, `${contextType}: failed owner plus one bounded retry`)
  }
})

test('a successful pending README/AGENTS read dedupes concurrent results', async () => {
  for (const contextType of ['readme', 'agents']) {
    const { results, after, readCount } = await runConcurrentDirectoryContextReads(contextType, false)
    assert.deepEqual(results.map(result => readmeTexts(result).length), [1, 0], `${contextType}: the owner injects exactly once`)
    assert.deepEqual(readmeTexts(after), [], `${contextType}: a committed directory remains deduped`)
    assert.equal(readCount, 1, `${contextType}: followers share the pending outcome instead of rereading`)
  }
})

test('a pending directory waiter honors its own cancellation without canceling the owner', async () => {
  const controller = new AbortController()
  const pair = await beginConcurrentPendingDirectoryReads({ secondSignal: controller.signal })
  try {
    controller.abort()
    assert.equal(pair.readSignals[0].aborted, false, 'a cancelled follower does not abort the owner generation signal')
    const secondOutcome = await Promise.race([
      pair.second.then(value => ({ kind: 'result', value }), error => ({ kind: 'error', error })),
      new Promise(resolve => setImmediate(() => resolve({ kind: 'pending' }))),
    ])
    assert.notEqual(secondOutcome.kind, 'pending', 'the waiter settles on its own abort before the owner finishes')
    if (secondOutcome.kind === 'result') assert.deepEqual(readmeTexts(secondOutcome.value), [])

    pair.firstReadGate.resolve(encoder.encode('# shared readme'))
    const firstResult = await pair.first
    assert.equal(readmeTexts(firstResult).length, 1, 'one waiter cancellation does not cancel the shared owner')
    assert.equal(pair.readCount(), 1, 'canceling a waiter does not start another context read')
  } finally {
    pair.firstReadGate.resolve(encoder.encode('# shared readme'))
    await pair.harness.dispose()
  }
})

test('clear and compact abort pending README/AGENTS reads, wake waiters, and fence stale results', async () => {
  for (const contextType of ['readme', 'agents']) {
    for (const source of ['clear', 'compact']) {
      const pair = await beginConcurrentPendingDirectoryReads({ contextType })
      try {
        await pair.harness.reannounce(pair.agent, source)
        assert.equal(pair.readSignals[0].aborted, true, `${contextType} ${source} aborts the old filesystem read signal`)
        const secondOutcome = await Promise.race([
          pair.second.then(value => ({ kind: 'result', value }), error => ({ kind: 'error', error })),
          new Promise(resolve => setImmediate(() => resolve({ kind: 'pending' }))),
        ])
        assert.notEqual(secondOutcome.kind, 'pending', `${contextType} ${source} settles old-generation waiters before the owner finishes`)
        if (secondOutcome.kind === 'result') assert.deepEqual(readmeTexts(secondOutcome.value), [])
        const firstOutcome = await Promise.race([
          pair.first.then(value => ({ kind: 'result', value }), error => ({ kind: 'error', error })),
          new Promise(resolve => setImmediate(() => resolve({ kind: 'pending' }))),
        ])
        assert.equal(firstOutcome.kind, 'result', `${contextType} ${source} settles the old owner before its backend read resolves`)
        assert.deepEqual(readmeTexts(firstOutcome.value), [])

        pair.firstReadGate.resolve(encoder.encode(`# shared ${contextType}`))
        const firstResult = await pair.first
        assert.deepEqual(readmeTexts(firstResult), [], `${contextType} ${source} prevents an old pending read from injecting`)
        const after = await pair.harness.executeRead(pair.agent)
        assert.equal(readmeTexts(after).length, 1, `${contextType} ${source} permits a fresh-generation context`)
        assert.equal(pair.readCount(), 2, `${contextType} ${source} discards the stale attempt and reads the fresh generation once`)
      } finally {
        pair.firstReadGate.resolve(encoder.encode(`# shared ${contextType}`))
        await pair.harness.dispose()
      }
    }
  }
})

test('clear and compact abort only the exact Agent generation', async () => {
  for (const source of ['clear', 'compact']) {
    const gates = [deferred(), deferred()]
    const started = [deferred(), deferred()]
    const readSignals = []
    let readCount = 0
    const harness = await makeHarness({
      readmes: {
        'README.md': {
          text: '# shared context',
          readBytes(_target, signal) {
            const index = readCount++
            readSignals[index] = signal
            started[index].resolve()
            return gates[index].promise
          },
        },
      },
    })
    try {
      const agentA = await harness.createAgent('agent-a')
      const agentB = await harness.createAgent('agent-b')
      const readA = harness.executeRead(agentA)
      await started[0].promise
      const readB = harness.executeRead(agentB)
      await started[1].promise

      await harness.reannounce(agentA, source)
      assert.equal(readSignals[0].aborted, true, `${source} aborts Agent A's generation signal`)
      assert.equal(readSignals[1].aborted, false, `${source} leaves Agent B's generation signal intact`)

      const resultA = await readA
      assert.deepEqual(readmeTexts(resultA), [], `${source} fences Agent A's stale read`)
      gates[1].resolve(encoder.encode('# shared context'))
      const resultB = await readB
      assert.equal(readmeTexts(resultB).length, 1, `${source} permits Agent B's read to commit`)
      assert.equal(readCount, 2)
    } finally {
      gates[0].resolve(encoder.encode('# Agent A context'))
      gates[1].resolve(encoder.encode('# shared context'))
      await harness.dispose()
    }
  }
})

test('clear and compact replace the Agent object and abort its prior same-ID read', async () => {
  for (const source of ['clear', 'compact']) {
    const gates = [deferred(), deferred()]
    const started = [deferred(), deferred()]
    const readSignals = []
    let readCount = 0
    const harness = await makeHarness({
      readmes: {
        'README.md': {
          text: '# shared context',
          readBytes(_target, signal) {
            const index = readCount++
            readSignals[index] = signal
            started[index].resolve()
            return gates[index].promise
          },
        },
      },
    })
    try {
      const original = await harness.createAgent('same-session-agent')
      const oldRead = harness.executeRead(original)
      await started[0].promise

      const replacement = await harness.replaceAgent(original, source)
      assert.notStrictEqual(replacement, original)
      assert.equal(replacement.id, original.id)
      assert.equal(readSignals[0].aborted, true, `${source} aborts the prior same-ID Agent's generation signal`)
      const oldOutcome = await Promise.race([
        oldRead.then(value => ({ kind: 'result', value }), error => ({ kind: 'error', error })),
        new Promise(resolve => setImmediate(() => resolve({ kind: 'pending' }))),
      ])
      assert.equal(oldOutcome.kind, 'result', `${source} settles prior work before its backend read resolves`)
      assert.deepEqual(readmeTexts(oldOutcome.value), [])

      const newRead = harness.executeRead(replacement)
      await started[1].promise
      assert.equal(readSignals[1].aborted, false, `${source} leaves the replacement Agent's generation active`)
      gates[1].resolve(encoder.encode('# shared context'))
      const newResult = await newRead
      assert.equal(readmeTexts(newResult).length, 1, `${source} allows the replacement Agent to commit fresh context`)
      assert.equal(readCount, 2)
    } finally {
      gates[0].resolve(encoder.encode('# shared context'))
      gates[1].resolve(encoder.encode('# shared context'))
      await harness.dispose()
    }
  }
})

test('plugin disposal aborts waiters on a pending directory reservation', async () => {
  const pair = await beginConcurrentPendingDirectoryReads()
  try {
    await pair.harness.disposeFeature()
    assert.equal(pair.readSignals[0].aborted, true, 'plugin disposal aborts the filesystem read signal')
    const outcomes = await Promise.race([
      Promise.all([pair.first, pair.second]).then(results => ({ kind: 'results', results }), error => ({ kind: 'error', error })),
      new Promise(resolve => setImmediate(() => resolve({ kind: 'pending' }))),
    ])
    assert.notEqual(outcomes.kind, 'pending', 'plugin unload settles owner and waiters without waiting for the backend')
    if (outcomes.kind === 'results') {
      assert.deepEqual(outcomes.results.map(result => readmeTexts(result).length), [0, 0])
    }
    assert.equal(pair.readCount(), 1, 'plugin unload cancels the pending owner without spawning a retry')
  } finally {
    pair.firstReadGate.resolve(encoder.encode('# shared readme'))
    await pair.harness.dispose()
  }
})

test('directory AGENTS context can skip root and never injects the exact file being read', async () => {
  const harness = await makeHarness({
    contextType: 'agents',
    skipRoot: true,
    readmes: { 'AGENTS.md': '# root instructions', 'src/AGENTS.md': '# src instructions' },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), ['src/AGENTS.md'])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === 'AGENTS.md'), false)

    await harness.reannounce(agent, 'clear')
    const self = await harness.executeRead(agent, { file_path: 'src/AGENTS.md' })
    assert.deepEqual(readmeTexts(self), [])
  } finally {
    await harness.dispose()
  }
})

test('skipRoot avoids the root README, and the exact file being read is never injected as its own context', async () => {
  const harness = await makeHarness({
    skipRoot: true,
    readmes: {
      'README.md': '# root',
      'src/README.md': '# nested',
    },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), ['src/README.md'])
    assert.equal(harness.fileSystem.calls.some(call => call.method === 'lstat' && call.path === 'README.md'), false)

    const self = await harness.executeRead(agent, { file_path: 'src/README.md' })
    assert.deepEqual(readmeTexts(self), [])
  } finally {
    await harness.dispose()
  }
})

test('skips root README only for a successfully registered snapshot on the exact Agent, else falls back', async () => {
  let successfulSnapshot
  const successful = await makeHarness({
    skipRoot: true,
    rootSnapshotAvailable: agent => successfulSnapshot?.hasSnapshot(agent) === true,
    readmes: { 'README.md': '# root snapshot', 'src/README.md': '# nested' },
  })
  successfulSnapshot = createRootReadmeContextListener(successful.agents, successful.sessionService, successful.fileSystem.fs)
  try {
    const agent = await successful.createAgent()
    await successfulSnapshot({ agent, signal: new AbortController().signal })
    assert.equal(successfulSnapshot.hasSnapshot(agent), true)
    const readStart = successful.fileSystem.calls.length
    const result = await successful.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), ['src/README.md'])
    const readPaths = successful.fileSystem.calls.slice(readStart)
      .filter(call => call.method === 'lstat').map(call => call.path)
    assert.equal(readPaths.includes('README.md'), false, 'a successful exact-Agent snapshot avoids root duplication')
  } finally {
    await successfulSnapshot.dispose()
    await successful.dispose()
  }

  let failedSnapshot
  const failed = await makeHarness({
    skipRoot: true,
    rootSnapshotAvailable: agent => failedSnapshot?.hasSnapshot(agent) === true,
    readmes: {
      'README.md': {
        text: '# root fallback',
        onRead: ({ record }) => { if (record.readCalls === 1) throw new Error('transient snapshot read failure') },
      },
      'src/README.md': '# nested',
    },
  })
  failedSnapshot = createRootReadmeContextListener(failed.agents, failed.sessionService, failed.fileSystem.fs)
  try {
    const agent = await failed.createAgent()
    await failedSnapshot({ agent, signal: new AbortController().signal })
    assert.equal(failedSnapshot.hasSnapshot(agent), false)
    const result = await failed.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), [
      'README.md', 'src/README.md',
    ], 'a failed snapshot leaves the bounded root-to-nested post-read fallback available')
  } finally {
    await failedSnapshot.dispose()
    await failed.dispose()
  }
})

test('skips root AGENTS only for a successfully registered snapshot on the exact Agent, else falls back', async () => {
  let successfulSnapshot
  const successful = await makeHarness({
    contextType: 'agents',
    skipRoot: true,
    rootSnapshotAvailable: agent => successfulSnapshot?.hasSnapshot(agent) === true,
    readmes: { 'AGENTS.md': '# root snapshot', 'src/AGENTS.md': '# nested' },
  })
  successfulSnapshot = createRootAgentsContextListener(successful.agents, successful.sessionService, successful.fileSystem.fs)
  try {
    const agent = await successful.createAgent()
    await successfulSnapshot({ agent, signal: new AbortController().signal })
    assert.equal(successfulSnapshot.hasSnapshot(agent), true)
    const readStart = successful.fileSystem.calls.length
    const result = await successful.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), ['src/AGENTS.md'])
    const readPaths = successful.fileSystem.calls.slice(readStart)
      .filter(call => call.method === 'lstat').map(call => call.path)
    assert.equal(readPaths.includes('AGENTS.md'), false, 'a successful exact-Agent snapshot avoids root duplication')
  } finally {
    await successfulSnapshot.dispose()
    await successful.dispose()
  }

  let failedSnapshot
  const failed = await makeHarness({
    contextType: 'agents',
    skipRoot: true,
    rootSnapshotAvailable: agent => failedSnapshot?.hasSnapshot(agent) === true,
    readmes: {
      'AGENTS.md': {
        text: '# root fallback',
        onRead: ({ record }) => { if (record.readCalls === 1) throw new Error('transient snapshot read failure') },
      },
      'src/AGENTS.md': '# nested',
    },
  })
  failedSnapshot = createRootAgentsContextListener(failed.agents, failed.sessionService, failed.fileSystem.fs)
  try {
    const agent = await failed.createAgent()
    await failedSnapshot({ agent, signal: new AbortController().signal })
    assert.equal(failedSnapshot.hasSnapshot(agent), false)
    const result = await failed.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project AGENTS\.md: ([^;]+)/u)?.[1]), [
      'AGENTS.md', 'src/AGENTS.md',
    ], 'a failed snapshot leaves the bounded root-to-nested post-read fallback available')
  } finally {
    await failedSnapshot.dispose()
    await failed.dispose()
  }
})

test('snapshot status checker failure is fail-open to bounded root README context', async () => {
  const harness = await makeHarness({
    skipRoot: true,
    rootSnapshotAvailable() { throw new Error('status unavailable') },
    readmes: { 'README.md': '# root', 'src/README.md': '# nested' },
  })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    assert.deepEqual(readmeTexts(result).map(text => text.match(/\[Project README: ([^;]+)/u)?.[1]), [
      'README.md', 'src/README.md',
    ])
  } finally {
    await harness.dispose()
  }
})

test('rejects malformed, parent, backslash, control, and outside paths; accepts an in-cwd absolute read path', async () => {
  const invalidPaths = ['../secret.txt', 'src/../secret.txt', `${CWD}/src/../nested/file.ts`, `${CWD}/./src/nested/file.ts`, '/etc/passwd', 'C:/secret.txt', 'src\\secret.txt', 'src/\u202ehidden.txt', 'src/\u0000bad.txt', '', `${'x'.repeat(4_097)}.txt`]
  for (const filePath of invalidPaths) {
    const harness = await makeHarness({ readmes: { 'README.md': '# root' } })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent, { file_path: filePath })
      assert.equal(result.isError, false, `read itself stays successful for ${JSON.stringify(filePath)}`)
      assert.deepEqual(result.value, { body: `body:${filePath}` })
      assert.deepEqual(readmeTexts(result), [])
      assert.equal(harness.fileSystem.calls.some(call => call.method === 'readBytes'), false)
    } finally {
      await harness.dispose()
    }
  }

  const absolute = await makeHarness({ readmes: { 'README.md': '# root' } })
  try {
    const agent = await absolute.createAgent()
    const filePath = `${CWD}/src/nested/file.ts`
    const result = await absolute.executeRead(agent, { file_path: filePath })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: `body:${filePath}` })
    assert.match(readmeTexts(result)[0], /README: README\.md/u)
  } finally {
    await absolute.dispose()
  }

  const malformed = await makeHarness({ readmes: { 'README.md': '# root' } })
  try {
    const agent = await malformed.createAgent()
    for (const args of [null, [], {}, { file_path: 5 }, { file_path: 'src/file.ts', extra: undefined }]) {
      const result = await malformed.executeRead(agent, args)
      assert.equal(result.isError, true, 'tool schema rejects malformed read arguments')
      assert.deepEqual(readmeTexts(result), [])
    }
    assert.equal(malformed.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    await malformed.dispose()
  }

  const outside = await makeHarness({ readmes: { 'README.md': '# root' }, outsideRead: true })
  try {
    const agent = await outside.createAgent()
    const result = await outside.executeRead(agent)
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/nested/file.ts' })
    assert.deepEqual(readmeTexts(result), [])
    assert.equal(outside.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    await outside.dispose()
  }
})

test('skips unsafe, malformed, oversized, or changed README files while preserving successful read results', async () => {
  const cases = [
    ['symlink', { pathInfo: { type: 'symlink' }, text: '# unsafe' }],
    ['oversized', { text: 'x'.repeat(16_385) }],
    ['invalid UTF-8', { bytes: new Uint8Array([0xff, 0xfe]) }],
    ['size mismatch', { text: 'short', fileInfo: { type: 'file', size: 99, version: 'v1' } }],
    ['post-read symlink', { text: 'before', afterPathInfo: { type: 'symlink' } }],
    ['post-read target replacement', { text: 'before', afterTargetKey: 'replacement:README.md' }],
    ['post-read containment loss', { text: 'before', afterContains: false }],
    ['post-read version change', { text: 'before', afterStat: { type: 'file', size: 6, version: 'v2' } }],
    ['post-read size change', { text: 'before', afterStat: { type: 'file', size: 99, version: 'v1' } }],
  ]
  for (const [label, record] of cases) {
    const harness = await makeHarness({ readmes: { 'README.md': record } })
    try {
      const agent = await harness.createAgent()
      const result = await harness.executeRead(agent)
      assert.equal(result.isError, false, `${label}: read result stays successful`)
      assert.deepEqual(result.value, { body: 'body:src/nested/file.ts' }, label)
      assert.deepEqual(readmeTexts(result), [], label)
    } finally {
      await harness.dispose()
    }
  }
})

test('replaces C0/C1 and Bidi characters, preserves Markdown whitespace, and escapes prompt-variable braces', async () => {
  const harness = await makeHarness({ readmes: { 'README.md': 'unsafe\u0001 {{assistant}} \u202E text\u009F\nline2\tindent\r\nline3' } })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent)
    const [text] = readmeTexts(result)
    assert.match(text, /unsafe\? /u)
    assert.ok(text.includes('\uFF5B\uFF5Bassistant\uFF5D\uFF5D'))
    assert.equal(text.includes('\u0001'), false)
    assert.equal(text.includes('\u202E'), false)
    assert.equal(text.includes('\u009F'), false)
    assert.match(text, /\? text/u)
    assert.ok(text.includes('text?\nline2'), 'C1 controls are replaced without flattening LF')
    assert.ok(text.includes('line2\tindent\r\nline3'), 'Markdown tabs and line breaks remain readable')
  } finally {
    await harness.dispose()
  }
})

test('caps aggregate source bytes and traversed directory depth', async () => {
  const sixteenKiB = 'a'.repeat(16_384)
  const readmes = {
    'README.md': sixteenKiB,
    'src/README.md': sixteenKiB,
    'src/nested/README.md': 'not reached by the aggregate cap',
    'src/nested/deeper/README.md': 'deeper',
  }
  const harness = await makeHarness({ readmes })
  try {
    const agent = await harness.createAgent()
    const result = await harness.executeRead(agent, { file_path: 'src/nested/deeper/branch/leaf.ts' })
    const texts = readmeTexts(result)
    assert.equal(texts.length, 2)
    assert.match(texts[0], /README: README\.md/u)
    assert.match(texts[1], /README: src\/README\.md/u)
    const loadedBytes = harness.fileSystem.calls.filter(call => call.method === 'readBytes').reduce((total, call) => total + call.maxBytes, 0)
    assert.ok(loadedBytes <= 32_768)
    const resolvedReadmes = harness.fileSystem.calls.filter(call => call.method === 'resolve' && String(call.path).endsWith('/README.md'))
    assert.ok(resolvedReadmes.length <= 7, 'only candidates within the eight-directory root-first traversal are considered')
  } finally {
    await harness.dispose()
  }
})

test('bounds the per-Agent directory dedupe cache', async () => {
  const directoryCount = 257
  const readmes = Object.fromEntries(Array.from({ length: directoryCount }, (_, index) => [`dir-${index}/README.md`, `# dir ${index}`]))
  const harness = await makeHarness({ skipRoot: true, readmes })
  try {
    const agent = await harness.createAgent()
    for (let index = 0; index < directoryCount; index++) {
      const result = await harness.executeRead(agent, { file_path: `dir-${index}/file.ts` })
      assert.equal(readmeTexts(result).length, 1)
    }
    assert.equal(harness.fileSystem.records.get('dir-0/README.md').readCalls, 1)
    const firstDirectoryAgain = await harness.executeRead(agent, { file_path: 'dir-0/file.ts' })
    assert.equal(readmeTexts(firstDirectoryAgain).length, 1, 'an evicted entry can be injected again')
    assert.equal(harness.fileSystem.records.get('dir-0/README.md').readCalls, 2)
  } finally {
    await harness.dispose()
  }
})

test('does not enrich error results or downstream block decisions, and always calls next exactly once', async () => {
  const errorHarness = await makeHarness({ toolError: true, readmes: { 'README.md': '# root' } })
  try {
    const agent = await errorHarness.createAgent()
    const result = await errorHarness.executeRead(agent)
    assert.equal(result.isError, true)
    assert.deepEqual(readmeTexts(result), [])
    assert.equal(errorHarness.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    await errorHarness.dispose()
  }

  const blockHarness = await makeHarness({ blockRead: true, downstreamContext: true, readmes: { 'README.md': '# root' } })
  try {
    const agent = await blockHarness.createAgent()
    const result = await blockHarness.executeRead(agent)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /blocked/u)
    assert.deepEqual(readmeTexts(result), ['downstream policy context'])
    assert.equal(blockHarness.fileSystem.calls.some(call => call.method === 'readBytes'), false)
  } finally {
    await blockHarness.dispose()
  }

  const fs = makeFileSystem({ readmes: { 'README.md': '# root' } })
  let nextCalls = 0
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
  const listener = createReadmeOnReadContextListener({ get() { throw new Error('must not be called') } }, { get() { throw new Error('must not be called') } }, fs.fs)
  try {
    const result = await listener({ name: 'read' }, { isError: false }, async () => { nextCalls++; return blocked })
    assert.equal(nextCalls, 1)
    assert.equal(result, blocked)
    assert.deepEqual(fs.calls, [])
  } finally {
    listener.dispose()
  }
})

test('observes caller cancellation, applies one total five-second deadline, and aborts promptly on plugin unload', async () => {
  let cancellationStarted
  const cancellationGate = new Promise(resolve => { cancellationStarted = resolve })
  const cancelController = new AbortController()
  const cancelHarness = await makeHarness({
    readmes: {
      'README.md': {
        text: '# pending',
        readBytes(_target, signal) {
          cancellationStarted()
          return new Promise(resolve => signal.addEventListener('abort', () => resolve(new Uint8Array()), { once: true }))
        },
      },
    },
  })
  try {
    const agent = await cancelHarness.createAgent()
    const execution = cancelHarness.executeRead(agent, undefined, { signal: cancelController.signal })
    await cancellationGate
    cancelController.abort()
    const result = await execution
    assert.equal(result.isError, true)
    assert.deepEqual(readmeTexts(result), [])
  } finally {
    await cancelHarness.dispose()
  }

  const deadlineHarness = await makeHarness({
    readmes: { 'README.md': { text: '# hangs', readBytes: () => new Promise(() => {}) } },
  })
  const deadlineStart = Date.now()
  try {
    const agent = await deadlineHarness.createAgent()
    const result = await deadlineHarness.executeRead(agent)
    assert.ok(Date.now() - deadlineStart >= 4_500)
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { body: 'body:src/nested/file.ts' })
    assert.deepEqual(readmeTexts(result), [])
  } finally {
    await deadlineHarness.dispose()
  }

  let unloadStarted
  const unloadGate = new Promise(resolve => { unloadStarted = resolve })
  const unloadHarness = await makeHarness({
    readmes: {
      'README.md': {
        text: '# pending unload',
        readBytes(_target, signal) {
          unloadStarted()
          return new Promise(resolve => signal.addEventListener('abort', () => resolve(new Uint8Array()), { once: true }))
        },
      },
    },
  })
  try {
    const agent = await unloadHarness.createAgent()
    const execution = unloadHarness.executeRead(agent)
    await unloadStarted
    await unloadHarness.disposeFeature()
    const result = await execution
    assert.equal(result.isError, false)
    assert.deepEqual(readmeTexts(result), [])
    const calls = unloadHarness.fileSystem.calls.length
    const afterUnload = await unloadHarness.executeRead(agent)
    assert.equal(afterUnload.isError, false)
    assert.deepEqual(readmeTexts(afterUnload), [])
    assert.equal(unloadHarness.fileSystem.calls.length, calls)
  } finally {
    await unloadHarness.dispose()
  }
})

test('validates DSH dependencies and options, and feature disposal unregisters all listeners', async () => {
  assert.throws(() => createReadmeOnReadContextListener({}, {}, {}), /agents\.get/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, {}, {}), /sessions\.get/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, { get() {} }, {}), /fs\.resolve/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, { get() {} }, makeFileSystem().fs, { skipRoot: 'yes' }), /skipRoot.*boolean/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, { get() {} }, makeFileSystem().fs, { rootSnapshotAvailable: true }), /rootSnapshotAvailable.*function/u)
  assert.throws(() => createAgentsOnReadContextListener({ get() {} }, { get() {} }, makeFileSystem().fs, {
    projectRoot: '/', includeCwd: false,
  }), /projectRoot/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, { get() {} }, makeFileSystem().fs, {
    projectRoot: '/workspace/a\\b', includeCwd: false,
  }), /POSIX separators.*backslashes/u)
  assert.throws(() => createAgentsOnReadContextListener({ get() {} }, { get() {} }, makeFileSystem().fs, {
    includeCwd: false,
  }), /without cwd requires projectRoot/u)

  const harness = await makeHarness({ readmes: { 'README.md': '# root' } })
  try {
    const agent = await harness.createAgent()
    const first = await harness.executeRead(agent)
    assert.equal(readmeTexts(first).length, 1)
    await harness.disposeFeature()
    const count = harness.fileSystem.calls.length
    const after = await harness.executeRead(agent)
    assert.equal(after.isError, false)
    assert.deepEqual(readmeTexts(after), [])
    assert.equal(harness.fileSystem.calls.length, count)
  } finally {
    await harness.dispose()
  }
})
