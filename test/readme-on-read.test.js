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

function normalizeRecord(value) {
  if (typeof value === 'string') return { text: value, bytes: encoder.encode(value) }
  return { ...value, bytes: value.bytes instanceof Uint8Array ? value.bytes : encoder.encode(value.text ?? '') }
}

function makeFileSystem({ cwd = CWD, readmes = {}, outsideRead = false } = {}) {
  const calls = []
  const records = new Map(Object.entries(readmes).map(([relative, record]) => [relative, normalizeRecord(record)]))
  const targets = new WeakMap()
  const directoryTargets = new Map()
  const fileTargets = new Map()
  let activeReadPath = 'src/nested/file.ts'
  let directoryPaths = new Set()

  function rebuildDirectories() {
    const segments = typeof activeReadPath === 'string' ? activeReadPath.split('/') : []
    directoryPaths = new Set([''])
    for (let index = 1; index < segments.length; index++) directoryPaths.add(segments.slice(0, index).join('/'))
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

  const rootTarget = makeTarget('', 'directory', undefined, { targetKey: `root:${cwd}` })
  directoryTargets.set('', rootTarget)

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

  rebuildDirectories()
  const fs = {
    async resolve(pathValue, options = {}) {
      calls.push({ method: 'resolve', path: pathValue, options })
      if (pathValue === cwd) return rootTarget
      if (options.cwd !== undefined && options.cwd !== cwd) {
        return makeTarget(String(pathValue), 'file', undefined, { targetKey: `outside:${String(pathValue)}`, outside: true })
      }
      const relativePath = typeof pathValue === 'string' && path.isAbsolute(pathValue) ? path.relative(cwd, pathValue) : pathValue
      if (relativePath === '') return rootTarget
      if (typeof pathValue === 'string' && path.isAbsolute(pathValue)
        && (relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath))) {
        return makeTarget(String(pathValue), 'file', undefined, { targetKey: `outside:${String(pathValue)}`, outside: true })
      }
      if (relativePath === activeReadPath) {
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
      if (!parentInfo || !childInfo || parentInfo.kind !== 'directory' || parentInfo.relative !== ''
        || childInfo.cwd !== cwd || childInfo.outside) return false
      if (childInfo.after && childInfo.record?.afterContains !== undefined) return childInfo.record.afterContains === true
      if (childInfo.record?.replaced && childInfo.record.afterContains !== undefined && childInfo.after) {
        return childInfo.record.afterContains === true
      }
      return true
    },
    async lstat(relative, options = {}, signal) {
      calls.push({ method: 'lstat', path: relative, options, signal })
      const record = records.get(relative)
      if (!record) return undefined
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
  const fileSystem = makeFileSystem({ cwd: options.cwd ?? CWD, readmes: options.readmes, outsideRead: options.outsideRead })
  const registerContext = options.contextType === 'agents' ? registerAgentsOnReadContext : registerReadmeOnReadContext
  const listenerOptions = {
    ...(options.skipRoot === undefined ? {} : { skipRoot: options.skipRoot }),
    ...(options.rootSnapshotAvailable === undefined ? {} : { rootSnapshotAvailable: options.rootSnapshotAvailable }),
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

test('validates DSH dependencies and options, and feature disposal removes both listeners', async () => {
  assert.throws(() => createReadmeOnReadContextListener({}, {}, {}), /agents\.get/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, {}, {}), /sessions\.get/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, { get() {} }, {}), /fs\.resolve/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, { get() {} }, makeFileSystem().fs, { skipRoot: 'yes' }), /skipRoot.*boolean/u)
  assert.throws(() => createReadmeOnReadContextListener({ get() {} }, { get() {} }, makeFileSystem().fs, { rootSnapshotAvailable: true }), /rootSnapshotAvailable.*function/u)

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
