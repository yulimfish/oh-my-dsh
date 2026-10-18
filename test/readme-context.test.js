import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { registerRootAgentsContext } from '../src/agents-context.js'
import { createRootReadmeContextListener, registerRootReadmeContext } from '../src/readme-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))
const CONTEXT_NAME = 'dsh-omo:root-readme'
const AGENTS_CONTEXT_NAME = 'dsh-omo:root-agents'
const CWD_A = '/workspace/project-a'
const CWD_B = '/workspace/project-b'
const PROJECT_A = '# Project A\u202a\u202b\u202c\u202d\u202e\u0000\u061c\u200e\u200f\u2066\u2067\u2068\u2069\nLiteral braces: {{known}}, {{not_registered}}, {{bad-name}}, and {{unterminated.\nFollow formatter A.\n'
const PROJECT_B = '# Project B\nFollow formatter B.\n'
const encoder = new TextEncoder()

function bytesFor(record) {
  if (record.bytes instanceof Uint8Array) return record.bytes
  return encoder.encode(record.text ?? '')
}

function makeFileSystem(records) {
  const calls = []
  const roots = new Map()
  const files = new Map()
  const recordsByTarget = new Map()
  for (const [cwd, record] of records) {
    const root = { targetKey: `root:${cwd}` }
    const file = { targetKey: `readme:${cwd}` }
    roots.set(cwd, root)
    files.set(cwd, file)
    recordsByTarget.set(root, { cwd, record, type: 'directory' })
    recordsByTarget.set(file, { cwd, record, type: 'file' })
  }

  const fs = {
    async resolve(path, options = {}) {
      calls.push(['resolve', path, options])
      if (roots.has(path)) return roots.get(path)
      if (path === 'README.md') {
        const record = records.get(options.cwd)
        if (record?.replacedAfterRead && typeof record.afterTargetKey === 'string') {
          const target = { targetKey: record.afterTargetKey }
          recordsByTarget.set(target, { cwd: options.cwd, record, type: 'file' })
          return target
        }
        return files.get(options.cwd)
      }
      throw new Error(`unexpected root-file path: ${path}`)
    },
    contains(parent, child) {
      calls.push(['contains', parent, child])
      const parentEntry = recordsByTarget.get(parent)
      const record = parentEntry?.record
      const containment = record?.replacedAfterRead && record.afterContains !== undefined
        ? record.afterContains
        : record?.contains
      if (typeof containment === 'function') return containment(parent, child)
      if (containment !== undefined) return containment === true
      return child === files.get(parentEntry?.cwd)
    },
    async lstat(path, options, signal) {
      calls.push(['lstat', path, options, signal])
      const record = records.get(options.cwd)
      if (!record) return undefined
      const key = record.replacedAfterRead ? 'afterPathInfo' : 'pathInfo'
      return Object.hasOwn(record, key) ? record[key] : { type: 'file' }
    },
    async stat(target, signal) {
      calls.push(['stat', target, signal])
      const entry = recordsByTarget.get(target)
      if (!entry) return undefined
      if (entry.type === 'directory') return entry.record.rootInfo ?? { type: 'directory' }
      if (entry.record.replacedAfterRead && entry.record.afterFileInfo) return entry.record.afterFileInfo
      if (entry.record.fileInfo) return entry.record.fileInfo
      return { type: 'file', size: bytesFor(entry.record).byteLength, version: entry.record.version ?? 'v1' }
    },
    async readBytes(target, signal, maxBytes) {
      calls.push(['readBytes', target, signal, maxBytes])
      const entry = recordsByTarget.get(target)
      if (!entry || entry.type !== 'file') throw new Error('unexpected target')
      if (entry.record.readBytes) return entry.record.readBytes(target, signal, maxBytes)
      return bytesFor(entry.record)
    },
  }
  return { fs, calls, roots, files }
}

async function makeHarness(records) {
  const ctx = new Context()
  const systemPromptFiber = await ctx.plugin(SystemPrompt)
  const agentRegistryFiber = await ctx.plugin(AgentRegistry)
  const agents = ctx.agents
  const sessions = new Map()
  const sessionService = { get: id => sessions.get(id) }
  const scopes = []
  const detachById = new Map()
  const { fs, calls } = makeFileSystem(records)
  let rootReadmeDispose
  const featureFiber = await ctx.plugin(pluginCtx => {
    rootReadmeDispose = registerRootReadmeContext(pluginCtx, agents, sessionService, fs)
    return rootReadmeDispose
  })

  async function createAgent(id, cwd, { headerId = id, headerCwd = cwd } = {}) {
    const agent = { id, session: { id } }
    const scope = createScope(ctx, agent)
    scopes.push(scope)
    let agentContext
    await scope.ctx.inject(['systemPrompt'], injected => { agentContext = injected })
    agent.ctx = agentContext
    sessions.set(id, { header: { id: headerId, cwd: headerCwd } })
    return { agent, scope }
  }

  async function created(agent, { source = 'startup', signal } = {}) {
    const detach = agents.enter(agent, undefined)
    detachById.set(agent.id, detach)
    await agents.announce(agent, source, signal)
  }

  function disposeAgent(agent) {
    const detach = detachById.get(agent.id)
    if (detach) {
      detachById.delete(agent.id)
      detach()
    }
  }

  function promptContexts(agent) {
    return ctx.systemPrompt.assemble({ scope: agent }).then(assembly => renderContextSections(assembly).filter(context => context.name === CONTEXT_NAME))
  }

  return {
    ctx,
    calls,
    agents,
    createAgent,
    created,
    hasSnapshot: agent => rootReadmeDispose?.hasSnapshot?.(agent) === true,
    disposeAgent,
    promptContexts,
    async disposeFeature() { await featureFiber.dispose() },
    async dispose() {
      await featureFiber.dispose()
      for (const scope of scopes) await scope.dispose()
      for (const detach of detachById.values()) detach()
      detachById.clear()
      await agentRegistryFiber.dispose()
      await systemPromptFiber.dispose()
    },
  }
}

function makeCombinedAgentsAndReadmeFs(cwd) {
  const rootTarget = { targetKey: `root:${cwd}` }
  const agentsTarget = { targetKey: `agents:${cwd}` }
  const readmeTarget = { targetKey: `readme:${cwd}` }
  const calls = []
  const fs = {
    async resolve(path, options = {}) {
      calls.push(['resolve', path, options])
      if (path === cwd) return rootTarget
      if (path === 'AGENTS.md' && options.cwd === cwd) return agentsTarget
      if (path === 'README.md' && options.cwd === cwd) return readmeTarget
      throw new Error(`unexpected path: ${path}`)
    },
    contains(parent, child) {
      calls.push(['contains', parent, child])
      return parent === rootTarget && (child === agentsTarget || child === readmeTarget)
    },
    async lstat(path, options, signal) {
      calls.push(['lstat', path, options, signal])
      if (options.cwd !== cwd) return undefined
      return path === 'AGENTS.md' || path === 'README.md' ? { type: 'file' } : undefined
    },
    async stat(target, signal) {
      calls.push(['stat', target, signal])
      if (target === rootTarget) return { type: 'directory' }
      if (target === agentsTarget) return { type: 'file', size: encoder.encode('AGENTS survive a failed README read.').byteLength, version: 'agents-v1' }
      if (target === readmeTarget) return { type: 'file', size: encoder.encode('README is unavailable').byteLength, version: 'readme-v1' }
      return undefined
    },
    async readBytes(target, signal, maxBytes) {
      calls.push(['readBytes', target, signal, maxBytes])
      if (target === agentsTarget) return encoder.encode('AGENTS survive a failed README read.')
      throw new Error('README is unavailable')
    },
  }
  return { fs, calls }
}

function makeCombinedHarness(fs, cwd, calls) {
  return (async () => {
    const ctx = new Context()
    const systemPromptFiber = await ctx.plugin(SystemPrompt)
    const agentRegistryFiber = await ctx.plugin(AgentRegistry)
    const agents = ctx.agents
    const sessions = new Map()
    const sessionService = { get: id => sessions.get(id) }
    const scopes = []
    const detachers = new Map()
    const agentsFiber = await ctx.plugin(pluginCtx => registerRootAgentsContext(pluginCtx, agents, sessionService, fs))
    const readmeFiber = await ctx.plugin(pluginCtx => registerRootReadmeContext(pluginCtx, agents, sessionService, fs))
    const agent = { id: 'combined-agent', session: { id: 'combined-agent' } }
    const scope = createScope(ctx, agent)
    scopes.push(scope)
    let agentContext
    await scope.ctx.inject(['systemPrompt'], injected => { agentContext = injected })
    agent.ctx = agentContext
    sessions.set(agent.id, { header: { id: agent.id, cwd } })
    const detach = agents.enter(agent, undefined)
    detachers.set(agent.id, detach)
    await agents.announce(agent, 'startup')
    return {
      ctx,
      agent,
      calls,
      async dispose() {
        await readmeFiber.dispose()
        await agentsFiber.dispose()
        for (const item of scopes) await item.dispose()
        for (const detachAgent of detachers.values()) detachAgent()
        await agentRegistryFiber.dispose()
        await systemPromptFiber.dispose()
      },
    }
  })()
}

test('snapshots root README into isolated Agent systemPrompt scopes before first assembly', async () => {
  const harness = await makeHarness(new Map([
    [CWD_A, { text: PROJECT_A }],
    [CWD_B, { text: PROJECT_B }],
  ]))
  const a = await harness.createAgent('agent-a', CWD_A)
  const b = await harness.createAgent('agent-b', CWD_B)
  const disposeVariable = harness.ctx.systemPrompt.variable('known', () => 'SHOULD_NOT_INTERPOLATE')
  const disposeAgentsContext = a.agent.ctx.systemPrompt.context({ name: AGENTS_CONTEXT_NAME, order: 130, text: 'AGENTS context precedes the README snapshot.' })
  try {
    assert.deepEqual(await harness.promptContexts(a.agent), [], 'before awaited agent/created there is no README context')
    assert.equal(harness.hasSnapshot(a.agent), false, 'snapshot availability is false before successful Agent initialization')
    assert.equal(harness.calls.length, 0, 'there is no backfill or prompt-assembly filesystem read')

    await harness.created(a.agent)
    await harness.created(b.agent, { source: 'resume' })
    assert.strictEqual(harness.agents.get(a.agent.id).ctx, a.agent.ctx, 'real AgentRegistry exposes the scoped Agent context')
    assert.equal(harness.hasSnapshot(a.agent), true, 'availability follows both prompt and Agent-scope registration')
    assert.equal(harness.hasSnapshot({ id: a.agent.id }), false, 'same-ID projections do not inherit exact-Agent snapshot status')
    assert.equal(harness.hasSnapshot(b.agent), true)

    const contextsA = await harness.promptContexts(a.agent)
    const contextsB = await harness.promptContexts(b.agent)
    const globalContexts = (await harness.ctx.systemPrompt.assemble()).contexts.filter(context => context.name === CONTEXT_NAME)
    assert.equal(contextsA.length, 1)
    assert.equal(contextsB.length, 1)
    assert.match(contextsA[0].text, /Project A/u)
    assert.match(contextsA[0].text, /untrusted/u)
    assert.ok(contextsA[0].text.includes('｛｛known｝｝'), 'known prompt variables remain literal')
    assert.ok(contextsA[0].text.includes('｛｛not_registered｝｝'), 'unknown variables remain literal')
    assert.ok(contextsA[0].text.includes('｛｛bad-name｝｝'), 'malformed variables remain literal')
    assert.ok(contextsA[0].text.includes('｛｛unterminated.'), 'unmatched braces remain literal')
    assert.doesNotMatch(contextsA[0].text, /SHOULD_NOT_INTERPOLATE/u)
    assert.doesNotMatch(contextsA[0].text, /[\u0000\p{Bidi_Control}]/u)
    assert.match(contextsB[0].text, /Project B/u)
    assert.doesNotMatch(contextsB[0].text, /Project A/u)
    assert.deepEqual(globalContexts, [], 'Agent README context never leaks into the global prompt')

    const assemblyA = await harness.ctx.systemPrompt.assemble({ scope: a.agent })
    assert.deepEqual(assemblyA.contexts.filter(item => [AGENTS_CONTEXT_NAME, CONTEXT_NAME].includes(item.name)).map(item => item.name), [AGENTS_CONTEXT_NAME, CONTEXT_NAME], 'README order 140 follows AGENTS order 130')
    const rootFileCalls = harness.calls.filter(call => ['resolve', 'lstat'].includes(call[0])).map(call => call[1])
    assert.ok(rootFileCalls.includes('README.md'))
    assert.equal(rootFileCalls.some(path => path === 'AGENTS.md' || path.includes('../') || path.includes('/README.md')), false, 'README listener only checks the exact root literal')
    assert.ok(harness.calls.some(call => call[0] === 'readBytes' && call[3] === 32_768))
    assert.ok(harness.calls.filter(call => call[0] === 'readBytes').every(call => call[2] instanceof AbortSignal), 'every bounded read receives the linked cancellation signal')

    await a.scope.dispose()
    assert.deepEqual(await harness.promptContexts(a.agent), [], 'Agent-scope teardown removes its README context')
    assert.equal(harness.hasSnapshot(a.agent), false, 'Agent-scope teardown invalidates snapshot availability')
    harness.disposeAgent(a.agent)
    const replacement = await harness.createAgent('agent-a', CWD_A)
    await harness.created(replacement.agent, { source: 'compact' })
    assert.equal((await harness.promptContexts(replacement.agent)).length, 1, 'scope cleanup permits the same session id to snapshot a new Agent')
    assert.equal((await harness.promptContexts(b.agent)).length, 1, 'disposing one Agent leaves another context intact')
    await harness.disposeFeature()
    assert.deepEqual(await harness.promptContexts(b.agent), [], 'plugin unload clears contexts from still-live Agents')
    assert.deepEqual(await harness.promptContexts(replacement.agent), [], 'plugin unload also clears replacement Agent contexts')
    assert.equal(harness.hasSnapshot(b.agent), false, 'plugin unload invalidates snapshot availability')
    assert.equal(harness.hasSnapshot(replacement.agent), false)
  } finally {
    disposeAgentsContext()
    disposeVariable()
    await harness.dispose()
  }
})

test('snapshot availability requires successful context and Agent-scope registrations', async () => {
  const { fs } = makeFileSystem(new Map([[CWD_A, { text: '# README' }]]))
  const agents = new Map()
  const sessions = { get: id => ({ header: { id, cwd: CWD_A } }) }
  const listener = createRootReadmeContextListener({ get: id => agents.get(id) }, sessions, fs)

  const contextFailure = {
    id: 'context-failure',
    ctx: { effect: execute => execute(), systemPrompt: { context: () => undefined } },
  }
  agents.set(contextFailure.id, contextFailure)
  await listener({ agent: contextFailure })
  assert.equal(listener.hasSnapshot(contextFailure), false)

  let contextDisposals = 0
  const scopeFailure = {
    id: 'scope-failure',
    ctx: { effect: () => undefined, systemPrompt: { context: () => () => { contextDisposals += 1 } } },
  }
  agents.set(scopeFailure.id, scopeFailure)
  await listener({ agent: scopeFailure })
  assert.equal(listener.hasSnapshot(scopeFailure), false)
  assert.equal(contextDisposals, 1, 'failed Agent-scope tracking disposes the prompt context')

  const success = {
    id: 'successful-snapshot',
    ctx: { effect: execute => execute(), systemPrompt: { context: () => () => { contextDisposals += 1 } } },
  }
  agents.set(success.id, success)
  await listener({ agent: success })
  assert.equal(listener.hasSnapshot(success), true)
  agents.set(success.id, { id: success.id })
  assert.equal(listener.hasSnapshot(success), false, 'a replaced same-ID Agent cannot inherit snapshot state')
  await listener.dispose()
  assert.equal(listener.hasSnapshot(success), false, 'plugin cleanup clears snapshot availability')
})

test('README snapshot stays stale until a newly created Agent refreshes it', async () => {
  const records = new Map([[CWD_A, { text: '# Initial README\n' }]])
  const harness = await makeHarness(records)
  try {
    const first = await harness.createAgent('stale-agent', CWD_A)
    await harness.created(first.agent)
    const initial = (await harness.promptContexts(first.agent))[0].text
    assert.match(initial, /Initial README/u)

    records.get(CWD_A).text = '# Updated README\n'
    assert.match((await harness.promptContexts(first.agent))[0].text, /Initial README/u, 'no watcher changes an existing snapshot')
    assert.doesNotMatch((await harness.promptContexts(first.agent))[0].text, /Updated README/u)

    await first.scope.dispose()
    harness.disposeAgent(first.agent)
    const refreshed = await harness.createAgent('stale-agent', CWD_A)
    await harness.created(refreshed.agent, { source: 'resume' })
    assert.match((await harness.promptContexts(refreshed.agent))[0].text, /Updated README/u, 'a new Agent creation snapshots the latest file')
  } finally {
    await harness.dispose()
  }
})

test('skips absent, unsafe, oversized, malformed, blank, and changed-during-read README files', async () => {
  const records = new Map([
    ['/workspace/missing', { pathInfo: undefined }],
    ['/workspace/symlink', { pathInfo: { type: 'symlink' } }],
    ['/workspace/directory', { pathInfo: { type: 'directory' } }],
    ['/workspace/escaped', { contains: false }],
    ['/workspace/not-file', { fileInfo: { type: 'directory' } }],
    ['/workspace/oversized-stat', { fileInfo: { type: 'file', size: 32_769 }, text: 'not read' }],
    ['/workspace/partial-read', { fileInfo: { type: 'file', size: 9 }, text: 'short' }],
    ['/workspace/too-large-error', { readBytes: async () => { throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' }) } }],
    ['/workspace/invalid-utf8', { bytes: new Uint8Array([0xc3, 0x28]) }],
    ['/workspace/over-limit', { readBytes: async () => new Uint8Array(32_769) }],
    ['/workspace/blank', { text: ' \n\t' }],
    ['/workspace/replaced-during-read', {
      pathInfo: { type: 'file' },
      afterPathInfo: { type: 'symlink' },
      async readBytes() {
        records.get('/workspace/replaced-during-read').replacedAfterRead = true
        return encoder.encode('replacement must not reach the prompt')
      },
    }],
    ['/workspace/escaped-after-read', {
      pathInfo: { type: 'file' },
      afterPathInfo: { type: 'file' },
      afterContains: false,
      async readBytes() {
        records.get('/workspace/escaped-after-read').replacedAfterRead = true
        return encoder.encode('outside-root contents must not reach the prompt')
      },
    }],
    ['/workspace/replaced-in-root', {
      pathInfo: { type: 'file' },
      afterPathInfo: { type: 'file' },
      afterTargetKey: 'readme:replacement-in-root',
      afterContains: true,
      async readBytes() {
        records.get('/workspace/replaced-in-root').replacedAfterRead = true
        return encoder.encode('replacement target must not reach the prompt')
      },
    }],
    ['/workspace/version-changed', {
      fileInfo: { type: 'file', size: encoder.encode('version stable').byteLength, version: 'before' },
      afterFileInfo: { type: 'file', size: encoder.encode('version stable').byteLength, version: 'after' },
      async readBytes() {
        records.get('/workspace/version-changed').replacedAfterRead = true
        return encoder.encode('version stable')
      },
    }],
    ['/workspace/size-changed', {
      fileInfo: { type: 'file', size: encoder.encode('same size').byteLength, version: 'before' },
      afterFileInfo: { type: 'file', size: encoder.encode('same size').byteLength + 1, version: 'before' },
      async readBytes() {
        records.get('/workspace/size-changed').replacedAfterRead = true
        return encoder.encode('same size')
      },
    }],
  ])
  const harness = await makeHarness(records)
  try {
    let index = 0
    for (const cwd of records.keys()) {
      const { agent } = await harness.createAgent(`skip-${index++}`, cwd)
      await harness.created(agent)
      assert.deepEqual(await harness.promptContexts(agent), [], `no prompt context for ${cwd}`)
    }
    assert.equal(records.get('/workspace/escaped-after-read').replacedAfterRead, true)
    assert.equal(records.get('/workspace/replaced-in-root').replacedAfterRead, true)
    assert.equal(records.get('/workspace/version-changed').replacedAfterRead, true)
    assert.equal(records.get('/workspace/size-changed').replacedAfterRead, true)
    assert.equal(harness.calls.some(call => call[0] === 'readBytes' && call[1]?.targetKey === 'readme:/workspace/oversized-stat'), false)
    assert.equal(harness.calls.filter(call => call[0] === 'readBytes').length, 10)
  } finally {
    await harness.dispose()
  }
})

test('README failure does not interfere with the independent AGENTS context', async () => {
  const cwd = '/workspace/combined'
  const { fs, calls } = makeCombinedAgentsAndReadmeFs(cwd)
  const harness = await makeCombinedHarness(fs, cwd, calls)
  try {
    const contexts = await harness.ctx.systemPrompt.assemble({ scope: harness.agent }).then(renderContextSections)
    assert.equal(contexts.some(context => context.name === AGENTS_CONTEXT_NAME && /AGENTS survive/u.test(context.text)), true)
    assert.equal(contexts.some(context => context.name === CONTEXT_NAME), false, 'a failed README read simply omits its own context')
    assert.ok(harness.calls.some(call => call[0] === 'readBytes' && call[1]?.targetKey === `readme:${cwd}`), 'the README read was attempted and failed')
  } finally {
    await harness.dispose()
  }
})

test('event cancellation, plugin unload, and the read deadline do not leak a partial README context', { timeout: 12_000 }, async () => {
  const neverRecord = { readBytes: (_target, signal) => new Promise(() => { signal.addEventListener('abort', () => {}, { once: true }) }) }
  const harness = await makeHarness(new Map([
    ['/workspace/event-cancel', neverRecord],
    ['/workspace/plugin-unload', { ...neverRecord }],
    ['/workspace/deadline', { ...neverRecord }],
  ]))
  try {
    const cancelled = await harness.createAgent('event-cancelled', '/workspace/event-cancel')
    const controller = new AbortController()
    const cancelledEvent = harness.created(cancelled.agent, { source: 'clear', signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await cancelledEvent
    assert.deepEqual(await harness.promptContexts(cancelled.agent), [])

    const deadline = await harness.createAgent('deadline', '/workspace/deadline')
    const started = Date.now()
    await harness.created(deadline.agent)
    assert.ok(Date.now() - started >= 4_500, 'the bounded read deadline cancels a stalled FS read')
    assert.deepEqual(await harness.promptContexts(deadline.agent), [])

    const pending = await harness.createAgent('plugin-unload', '/workspace/plugin-unload')
    const pendingEvent = harness.created(pending.agent, { source: 'compact' })
    await new Promise(resolve => setImmediate(resolve))
    await harness.disposeFeature()
    await pendingEvent
    assert.deepEqual(await harness.promptContexts(pending.agent), [])
  } finally {
    await harness.dispose()
  }
})

test('exports listener and validates its DSH dependencies', () => {
  assert.throws(() => createRootReadmeContextListener({}, {}, {}), /agents.get/u)
  assert.throws(() => createRootReadmeContextListener({ get() {} }, {}, {}), /sessions.get/u)
  assert.throws(() => createRootReadmeContextListener({ get() {} }, { get() {} }, {}), /fs.resolve/u)
})
