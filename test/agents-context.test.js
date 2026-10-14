import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { registerRootAgentsContext } from '../src/agents-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))
const CONTEXT_NAME = 'dsh-omo:root-agents'
const CWD_A = '/workspace/project-a'
const CWD_B = '/workspace/project-b'
const PROJECT_A = '# Project A\u202a\u202b\u202c\u202d\u202e\u0000\u061c\u200e\u200f\u2066\u2067\u2068\u2069\nLiteral braces: {{known}}, {{not_registered}}, {{bad-name}}, and {{unterminated.\nUse formatter A.\n'
const PROJECT_B = '# Project B\nUse formatter B.\n'

function makeFileSystem(records) {
  const calls = []
  const roots = new Map()
  const files = new Map()
  const recordsByTarget = new Map()
  for (const [cwd, record] of records) {
    const root = { targetKey: `root:${cwd}` }
    const file = { targetKey: `agents:${cwd}` }
    roots.set(cwd, root)
    files.set(cwd, file)
    recordsByTarget.set(root, { cwd, record, type: 'directory' })
    recordsByTarget.set(file, { cwd, record, type: 'file' })
  }

  const fs = {
    async resolve(path, options = {}) {
      calls.push(['resolve', path, options])
      if (roots.has(path)) return roots.get(path)
      if (path === 'AGENTS.md') {
        const record = records.get(options.cwd)
        if (record?.replacedAfterRead && typeof record.afterTargetKey === 'string') {
          const target = { targetKey: record.afterTargetKey }
          recordsByTarget.set(target, { cwd: options.cwd, record, type: 'file' })
          return target
        }
        return files.get(options.cwd)
      }
      throw new Error(`unexpected path: ${path}`)
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
      return entry.type === 'directory'
        ? entry.record.rootInfo ?? { type: 'directory' }
        : entry.record.fileInfo ?? { type: 'file' }
    },
    async readBytes(target, signal, maxBytes) {
      calls.push(['readBytes', target, signal, maxBytes])
      const entry = recordsByTarget.get(target)
      if (!entry || entry.type !== 'file') throw new Error('unexpected target')
      if (entry.record.readBytes) return entry.record.readBytes(target, signal, maxBytes)
      return new TextEncoder().encode(entry.record.text ?? '')
    },
  }
  return { fs, calls }
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
  const featureFiber = await ctx.plugin(pluginCtx => registerRootAgentsContext(pluginCtx, agents, sessionService, fs))

  async function createAgent(id, cwd) {
    const agent = { id, session: { id } }
    // RC2 runtime Agent types augment the compact `{ id }` projection with this scope-owned `ctx`.
    const scope = createScope(ctx, agent)
    scopes.push(scope)
    let agentContext
    await scope.ctx.inject(['systemPrompt'], injected => { agentContext = injected })
    agent.ctx = agentContext
    sessions.set(id, { header: { id, cwd } })
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

test('snapshots root AGENTS into isolated Agent systemPrompt scopes before the first assembly', async () => {
  const harness = await makeHarness(new Map([
    [CWD_A, { text: PROJECT_A }],
    [CWD_B, { text: PROJECT_B }],
  ]))
  const a = await harness.createAgent('agent-a', CWD_A)
  const b = await harness.createAgent('agent-b', CWD_B)
  const disposeVariable = harness.ctx.systemPrompt.variable('known', () => 'SHOULD_NOT_INTERPOLATE')
  try {
    assert.deepEqual(await harness.promptContexts(a.agent), [])
    await harness.created(a.agent)
    await harness.created(b.agent, { source: 'resume' })
    assert.strictEqual(harness.agents.get(a.agent.id).ctx, a.agent.ctx, 'the real DSH AgentRegistry exposes the live Agent scope used for prompt registration')

    const contextsA = await harness.promptContexts(a.agent)
    const contextsB = await harness.promptContexts(b.agent)
    const globalContexts = (await harness.ctx.systemPrompt.assemble()).contexts.filter(context => context.name === CONTEXT_NAME)
    assert.equal(contextsA.length, 1)
    assert.equal(contextsB.length, 1)
    assert.match(contextsA[0].text, /Project A/u)
    assert.ok(contextsA[0].text.includes('｛｛known｝｝'), 'known prompt variables remain literal')
    assert.ok(contextsA[0].text.includes('｛｛not_registered｝｝'), 'unknown prompt variables cannot break assembly')
    assert.ok(contextsA[0].text.includes('｛｛bad-name｝｝'), 'malformed prompt variables cannot break assembly')
    assert.ok(contextsA[0].text.includes('｛｛unterminated.'), 'unmatched prompt-variable braces remain literal')
    assert.doesNotMatch(contextsA[0].text, /SHOULD_NOT_INTERPOLATE/u)
    assert.match(contextsA[0].text, /untrusted/u)
    assert.doesNotMatch(contextsA[0].text, /[\u0000\p{Bidi_Control}]/u)
    assert.match(contextsB[0].text, /Project B/u)
    assert.doesNotMatch(contextsB[0].text, /Project A/u)
    assert.deepEqual(globalContexts, [], 'project context does not leak into the global prompt')
    assert.ok(harness.calls.some(call => call[0] === 'readBytes' && call[3] === 16_384))

    await a.scope.dispose()
    assert.deepEqual(await harness.promptContexts(a.agent), [], 'Agent-scope teardown removes its context')
    harness.disposeAgent(a.agent)
    const replacement = await harness.createAgent('agent-a', CWD_A)
    await harness.created(replacement.agent, { source: 'compact' })
    assert.equal((await harness.promptContexts(replacement.agent)).length, 1, 'Agent-scope teardown also releases tracking for a later Agent with the same session id')
    assert.equal((await harness.promptContexts(b.agent)).length, 1, 'disposing one Agent leaves another Agent context intact')
    await harness.disposeFeature()
    assert.deepEqual(await harness.promptContexts(b.agent), [], 'plugin unload removes contexts from still-live Agents')
    assert.deepEqual(await harness.promptContexts(replacement.agent), [], 'plugin unload also clears replacement Agent contexts')
  } finally {
    disposeVariable()
    await harness.dispose()
  }
})

test('skips absent, unsafe, oversized, malformed, blank, and changed-during-read AGENTS files', async () => {
  const records = new Map([
    ['/workspace/missing', { pathInfo: undefined }],
    ['/workspace/symlink', { pathInfo: { type: 'symlink' } }],
    ['/workspace/directory', { pathInfo: { type: 'directory' } }],
    ['/workspace/escaped', { contains: false }],
    ['/workspace/not-file', { fileInfo: { type: 'directory' } }],
    ['/workspace/oversized-stat', { fileInfo: { type: 'file', size: 16_385 }, text: 'not read' }],
    ['/workspace/partial-read', { fileInfo: { type: 'file', size: 9 }, text: 'short' }],
    ['/workspace/too-large-error', { readBytes: async () => { throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' }) } }],
    ['/workspace/invalid-utf8', { readBytes: async () => new Uint8Array([0xc3, 0x28]) }],
    ['/workspace/over-limit', { readBytes: async () => new Uint8Array(16_385) }],
    ['/workspace/blank', { text: ' \n\t' }],
    ['/workspace/replaced-during-read', {
      pathInfo: { type: 'file' },
      afterPathInfo: { type: 'symlink' },
      async readBytes() {
        records.get('/workspace/replaced-during-read').replacedAfterRead = true
        return new TextEncoder().encode('external replacement must not reach the prompt')
      },
    }],
    ['/workspace/escaped-after-read', {
      pathInfo: { type: 'file' },
      afterPathInfo: { type: 'file' },
      afterContains: false,
      async readBytes() {
        records.get('/workspace/escaped-after-read').replacedAfterRead = true
        return new TextEncoder().encode('outside-root contents must not reach the prompt')
      },
    }],
    ['/workspace/replaced-in-root', {
      pathInfo: { type: 'file' },
      afterPathInfo: { type: 'file' },
      afterTargetKey: 'agents:replacement-in-root',
      afterContains: true,
      async readBytes() {
        records.get('/workspace/replaced-in-root').replacedAfterRead = true
        return new TextEncoder().encode('valid')
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
    assert.equal(harness.calls.some(call => call[0] === 'readBytes' && call[1]?.targetKey === 'agents:/workspace/oversized-stat'), false)
    assert.equal(harness.calls.filter(call => call[0] === 'readBytes').length, 8)
  } finally {
    await harness.dispose()
  }
})

test('cancellation and transient reads do not block Agent creation or leak a partial context', async () => {
  let attempts = 0
  const retryRecord = {
    readBytes: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary filesystem failure')
      return new TextEncoder().encode('Recovered project instructions.')
    },
  }
  const neverRecord = { readBytes: (_target, signal) => new Promise(() => { signal.addEventListener('abort', () => {}, { once: true }) }) }
  const harness = await makeHarness(new Map([
    ['/workspace/retry', retryRecord],
    ['/workspace/cancel', neverRecord],
    ['/workspace/unload', { readBytes: (_target, signal) => new Promise(() => { signal.addEventListener('abort', () => {}, { once: true }) }) }],
  ]))
  try {
    const failed = await harness.createAgent('failed-once', '/workspace/retry')
    await harness.created(failed.agent)
    assert.deepEqual(await harness.promptContexts(failed.agent), [])
    const retry = await harness.createAgent('retry-next-agent', '/workspace/retry')
    await harness.created(retry.agent)
    assert.match((await harness.promptContexts(retry.agent))[0].text, /Recovered project instructions/u)
    assert.equal(attempts, 2)

    const cancelled = await harness.createAgent('cancelled', '/workspace/cancel')
    const controller = new AbortController()
    const cancelledEvent = harness.created(cancelled.agent, { source: 'clear', signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await cancelledEvent
    assert.deepEqual(await harness.promptContexts(cancelled.agent), [])

    const pending = await harness.createAgent('unloading', '/workspace/unload')
    const pendingEvent = harness.created(pending.agent, { source: 'compact' })
    await new Promise(resolve => setImmediate(resolve))
    await harness.disposeFeature()
    await pendingEvent
    assert.deepEqual(await harness.promptContexts(pending.agent), [])
  } finally {
    await harness.dispose()
  }
})
