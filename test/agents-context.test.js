import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { normalizeProjectAgentsRoot, normalizeProjectRootPath, registerProjectRootAgentsContext, registerRootAgentsContext } from '../src/agents-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))
const CONTEXT_NAME = 'dsh-omo:root-agents'
const PROJECT_CONTEXT_NAME = 'dsh-omo:project-root-agents'
const CWD_A = '/workspace/project-a'
const CWD_B = '/workspace/project-b'
const PROJECT_A = '# Project A\u202a\u202b\u202c\u202d\u202e\u0000\u061c\u200e\u200f\u2066\u2067\u2068\u2069\nLiteral braces: {{known}}, {{not_registered}}, {{bad-name}}, and {{unterminated.\nUse formatter A.\n'
const PROJECT_B = '# Project B\nUse formatter B.\n'

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${label}`)
}

function makeFileSystem(records) {
  const calls = []
  const watchers = []
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
      if (roots.has(path)) {
        const record = records.get(path)
        if (record?.rootReplacedAfterRead && typeof record.afterRootTargetKey === 'string') {
          const target = { targetKey: record.afterRootTargetKey }
          recordsByTarget.set(target, { cwd: path, record, type: 'directory' })
          return target
        }
        return roots.get(path)
      }
      if (path === 'AGENTS.md') {
        const record = records.get(options.cwd)
        if (record?.replacedAfterRead && typeof record.afterTargetKey === 'string') {
          const target = { targetKey: record.afterTargetKey }
          recordsByTarget.set(target, { cwd: options.cwd, record, type: 'file' })
          files.set(options.cwd, target)
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
      const bytes = entry.record.readBytes
        ? await entry.record.readBytes(target, signal, maxBytes)
        : new TextEncoder().encode(entry.record.text ?? '')
      if (entry.record.replaceRootAfterRead === true) entry.record.rootReplacedAfterRead = true
      return bytes
    },
    async watch(target, changed, signal) {
      calls.push(['watch', target, signal])
      if (signal.aborted) throw new Error('watch cancelled before setup')
      const entry = recordsByTarget.get(target)
      if (entry?.record.watchInit) await entry.record.watchInit
      const watcher = { target, changed, signal, closed: false }
      watchers.push(watcher)
      return async () => {
        if (watcher.closed) return
        if (entry?.record.closeFailuresRemaining > 0) {
          entry.record.closeFailuresRemaining -= 1
          calls.push(['watchCloseError', target])
          throw new Error('simulated watcher close failure')
        }
        watcher.closed = true
        calls.push(['watchClose', target])
      }
    },
  }
  function notify(cwd, slot = 'file', error) {
    const target = slot === 'directory' ? roots.get(cwd) : files.get(cwd)
    for (const watcher of watchers) {
      if (!watcher.closed && watcher.target?.targetKey === target?.targetKey) watcher.changed(error)
    }
  }
  return { fs, calls, watchers, notify }
}

async function makeHarness(records, {
  watch = false, projectRootWatch = false, onWatchError, projectRoot, skipIfSameAsCwd = false,
  cwdRootContext = false, allContextNames = false, fileSystem,
} = {}) {
  const ctx = new Context()
  const systemPromptFiber = await ctx.plugin(SystemPrompt)
  const agentRegistryFiber = await ctx.plugin(AgentRegistry)
  const agents = ctx.agents
  const sessions = new Map()
  const sessionService = { get: id => sessions.get(id) }
  const scopes = []
  const detachById = new Map()
  const { fs, calls, watchers, notify } = fileSystem ?? makeFileSystem(records)
  const contextNames = allContextNames ? [CONTEXT_NAME, PROJECT_CONTEXT_NAME]
    : [projectRoot === undefined ? CONTEXT_NAME : PROJECT_CONTEXT_NAME]
  let rootAgentsDispose
  let projectRootAgentsDispose
  const featureFiber = await ctx.plugin(pluginCtx => {
    const registrations = []
    if (projectRoot === undefined || cwdRootContext) {
      rootAgentsDispose = registerRootAgentsContext(pluginCtx, agents, sessionService, fs, { watch, onWatchError })
      registrations.push(rootAgentsDispose)
    }
    if (projectRoot !== undefined) {
      projectRootAgentsDispose = registerProjectRootAgentsContext(
        pluginCtx, agents, sessionService, fs, projectRoot, { skipIfSameAsCwd, watch: projectRootWatch, onWatchError },
      )
      registrations.push(projectRootAgentsDispose)
    }
    const dispose = async () => { await Promise.allSettled(registrations.map(registration => registration())) }
    Object.defineProperty(dispose, 'hasSnapshot', {
      value: agent => registrations.some(registration => registration.hasSnapshot?.(agent) === true),
    })
    if (!rootAgentsDispose) rootAgentsDispose = dispose
    return dispose
  })

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
    return ctx.systemPrompt.assemble({ scope: agent }).then(assembly => renderContextSections(assembly).filter(context => contextNames.includes(context.name)))
  }

  return {
    ctx,
    calls,
    watchers,
    notify,
    agents,
    createAgent,
    created,
    hasSnapshot: agent => rootAgentsDispose?.hasSnapshot?.(agent) === true,
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
    assert.equal(harness.hasSnapshot(a.agent), false, 'snapshot availability is false before awaited creation completes')
    await harness.created(a.agent)
    await harness.created(b.agent, { source: 'resume' })
    assert.equal(harness.watchers.length, 0, 'watching stays disabled unless explicitly configured')
    assert.strictEqual(harness.agents.get(a.agent.id).ctx, a.agent.ctx, 'the real DSH AgentRegistry exposes the live Agent scope used for prompt registration')
    assert.equal(harness.hasSnapshot(a.agent), true, 'snapshot availability follows successful context and scope registration')
    assert.equal(harness.hasSnapshot({ id: a.agent.id }), false, 'same-ID projections do not inherit exact-Agent snapshot status')
    assert.equal(harness.hasSnapshot(b.agent), true)

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
    assert.equal(harness.hasSnapshot(a.agent), false, 'Agent-scope teardown invalidates snapshot availability')
    harness.disposeAgent(a.agent)
    const replacement = await harness.createAgent('agent-a', CWD_A)
    await harness.created(replacement.agent, { source: 'compact' })
    assert.equal((await harness.promptContexts(replacement.agent)).length, 1, 'Agent-scope teardown also releases tracking for a later Agent with the same session id')
    assert.equal((await harness.promptContexts(b.agent)).length, 1, 'disposing one Agent leaves another Agent context intact')
    await harness.disposeFeature()
    assert.deepEqual(await harness.promptContexts(b.agent), [], 'plugin unload removes contexts from still-live Agents')
    assert.deepEqual(await harness.promptContexts(replacement.agent), [], 'plugin unload also clears replacement Agent contexts')
    assert.equal(harness.hasSnapshot(b.agent), false, 'plugin unload invalidates snapshot availability')
    assert.equal(harness.hasSnapshot(replacement.agent), false)
  } finally {
    disposeVariable()
    await harness.dispose()
  }
})

test('refreshes a watched root AGENTS snapshot for the same Agent and closes it on scope or plugin teardown', async () => {
  const record = { text: PROJECT_A }
  const harness = await makeHarness(new Map([
    [CWD_A, record],
    [CWD_B, { text: PROJECT_B }],
  ]), { watch: true })
  try {
    const first = await harness.createAgent('agent-watch-a', CWD_A)
    await harness.created(first.agent)
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 1, 'initial root AGENTS watcher')
    assert.equal(harness.hasSnapshot(first.agent), true)
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 1)
    assert.match((await harness.promptContexts(first.agent))[0].text, /Project A/u)

    record.text = '# Project A refreshed in place.\n'
    harness.notify(CWD_A, 'file')
    await waitUntil(async () => (await harness.promptContexts(first.agent)).some(context => context.text.includes('refreshed in place')),
      'in-place AGENTS refresh')

    const originalWatcher = harness.watchers.find(watcher => !watcher.closed)
    record.replacedAfterRead = true
    record.afterPathInfo = { type: 'file' }
    record.afterTargetKey = 'agents:/workspace/project-a/replaced'
    record.text = '# Project A replaced atomically.\n'
    harness.notify(CWD_A, 'file')
    await waitUntil(async () => (await harness.promptContexts(first.agent)).some(context => context.text.includes('replaced atomically')),
      'replacement AGENTS refresh')
    assert.equal(originalWatcher.closed, true, 'a changed stable target is re-resolved and the stale watcher is closed')
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 1)
    assert.equal(harness.watchers.find(watcher => !watcher.closed).target.targetKey, record.afterTargetKey)

    record.afterPathInfo = undefined
    harness.notify(CWD_A, 'file')
    await waitUntil(async () => !harness.hasSnapshot(first.agent), 'removed AGENTS snapshot clearing')
    assert.ok((await harness.promptContexts(first.agent)).every(context => !context.text.includes('replaced atomically')))

    record.afterPathInfo = { type: 'file' }
    record.text = '# Project A recreated.\n'
    harness.notify(CWD_A, 'file')
    await waitUntil(async () => (await harness.promptContexts(first.agent)).some(context => context.text.includes('recreated')),
      'recreated AGENTS refresh')
    assert.equal(harness.hasSnapshot(first.agent), true)

    await first.scope.dispose()
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 0, 'Agent scope teardown closes its watcher')
    assert.deepEqual(await harness.promptContexts(first.agent), [])

    const second = await harness.createAgent('agent-watch-b', CWD_B)
    await harness.created(second.agent)
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 1, 'second Agent root AGENTS watcher')
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 1)
    await harness.disposeFeature()
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 0, 'plugin unload closes watchers on live Agents')
    assert.deepEqual(await harness.promptContexts(second.agent), [])
  } finally {
    await harness.dispose()
  }
})

test('keeps failed watcher closes reserved and retries before rearming a replacement target', async () => {
  const record = { text: PROJECT_A, closeFailuresRemaining: 2 }
  const warnings = []
  const harness = await makeHarness(new Map([[CWD_A, record]]), {
    watch: true,
    onWatchError: error => warnings.push(error),
  })
  try {
    const first = await harness.createAgent('watch-close-retry', CWD_A)
    await harness.created(first.agent)
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 1,
      'initial watcher before close retry')
    const staleWatcher = harness.watchers.find(watcher => !watcher.closed)

    record.replacedAfterRead = true
    record.afterPathInfo = { type: 'file' }
    record.afterTargetKey = 'agents:/workspace/project-a/replaced-close-retry'
    record.text = '# Replaced after a failed close.\n'
    harness.notify(CWD_A, 'file')
    await waitUntil(() => harness.calls.some(call => call[0] === 'watchCloseError'), 'first watcher close failure')
    assert.equal(staleWatcher.closed, false, 'the failed disposer leaves the Host watcher unconfirmed')
    assert.equal(harness.calls.filter(call => call[0] === 'watch').length, 1,
      'a replacement watcher must not open while the stale close is pending')

    await waitUntil(() => staleWatcher.closed
      && harness.watchers.some(watcher => !watcher.closed
        && watcher.target.targetKey === record.afterTargetKey), 'close retry and replacement watcher', 3_000)
    assert.equal(harness.calls.filter(call => call[0] === 'watchCloseError').length, 2)
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 1)
    assert.match((await harness.promptContexts(first.agent))[0].text, /Replaced after a failed close/u)
    assert.ok(warnings.length >= 2)
  } finally {
    await harness.dispose()
  }
})

test('retries late watcher disposers after initialization cancellation', async () => {
  let releaseInitialization
  const record = {
    text: PROJECT_A,
    watchInit: new Promise(resolve => { releaseInitialization = resolve }),
    closeFailuresRemaining: 1,
  }
  const harness = await makeHarness(new Map([[CWD_A, record]]), { watch: true })
  try {
    const { agent } = await harness.createAgent('late-watch-close', CWD_A)
    const created = harness.created(agent)
    await waitUntil(() => harness.calls.some(call => call[0] === 'watch'), 'pending watcher initialization')
    await harness.disposeFeature()
    await created
    releaseInitialization()
    await waitUntil(() => harness.watchers.length === 1 && harness.watchers[0].closed,
      'late disposer retry after cancellation', 3_000)
    assert.equal(harness.calls.filter(call => call[0] === 'watchCloseError').length, 1)
    assert.equal(harness.calls.filter(call => call[0] === 'watchClose').length, 1)
  } finally {
    releaseInitialization?.()
    await harness.dispose()
  }
})

test('disables a watcher after recurring callback errors without rearming indefinitely', async () => {
  const warnings = []
  const harness = await makeHarness(new Map([[CWD_A, { text: PROJECT_A }]]), {
    watch: true,
    onWatchError: error => warnings.push(error),
  })
  try {
    const { agent } = await harness.createAgent('watch-error-circuit', CWD_A)
    await harness.created(agent)
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 1,
      'initial watcher before error circuit')

    for (let count = 1; count <= 3; count += 1) {
      const current = harness.watchers.find(watcher => !watcher.closed)
      assert.ok(current, `watcher ${count} should be active before its injected error`)
      harness.notify(CWD_A, 'file', new Error(`simulated persistent watch error ${count}`))
      if (count < 3) {
        await waitUntil(() => harness.watchers.some(watcher => !watcher.closed && watcher !== current),
          `bounded watcher rearm ${count}`)
      } else {
        await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 0,
          'watch error circuit breaker')
      }
    }

    const openedWatchers = harness.calls.filter(call => call[0] === 'watch').length
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(harness.calls.filter(call => call[0] === 'watch').length, openedWatchers,
      'repeated provider errors must stop the rearm loop')
    assert.equal(openedWatchers, 3)
    assert.equal(harness.hasSnapshot(agent), true, 'the last successful prompt snapshot is retained')
    assert.match((await harness.promptContexts(agent))[0].text, /Project A/u)
    assert.ok(warnings.length >= 3)
  } finally {
    await harness.dispose()
  }
})

test('shares the watcher cap across root/project sources and reactivation on one DSH filesystem', async () => {
  const projectRoot = '/workspace'
  const cwd = '/workspace/project'
  const projectFileKey = `agents:${projectRoot}`
  const cwdRootKey = `root:${cwd}`
  const projectRecord = { text: '# Explicit root instructions.\n', closeFailuresRemaining: 1 }
  projectRecord.contains = (_parent, child) => child?.targetKey === projectFileKey || child?.targetKey === cwdRootKey
  const cwdRecord = { text: '# CWD instructions.\n', closeFailuresRemaining: 1 }
  const records = new Map([[projectRoot, projectRecord], [cwd, cwdRecord]])
  const fileSystem = makeFileSystem(records)
  const first = await makeHarness(records, {
    watch: true, projectRoot, projectRootWatch: true, cwdRootContext: true, allContextNames: true, fileSystem,
  })
  let second
  try {
    const { agent } = await first.createAgent('before-reactivation', cwd)
    await first.created(agent)
    await waitUntil(() => fileSystem.watchers.filter(watcher => !watcher.closed).length === 2,
      'both initial context-source watchers')
    const oldWatchers = fileSystem.watchers.filter(watcher => !watcher.closed)

    await first.disposeFeature()
    await waitUntil(() => fileSystem.calls.filter(call => call[0] === 'watchCloseError').length === 2,
      'failed close reservations before reactivation')
    projectRecord.closeFailuresRemaining = 100
    cwdRecord.closeFailuresRemaining = 100

    second = await makeHarness(records, {
      watch: true, projectRoot, projectRootWatch: true, cwdRootContext: true, allContextNames: true, fileSystem,
    })
    for (let index = 0; index < 32; index += 1) {
      const { agent: nextAgent } = await second.createAgent(`after-reactivation-${index}`, cwd)
      await second.created(nextAgent)
    }
    assert.ok(fileSystem.watchers.filter(watcher => !watcher.closed).length <= 64,
      'two watcher sources and an old failed-close listener share one provider-level cap')

    projectRecord.closeFailuresRemaining = 0
    cwdRecord.closeFailuresRemaining = 0
    await waitUntil(() => oldWatchers.every(watcher => watcher.closed),
      'old listener close retries release provider-level reservations', 5_000)
    await second.disposeFeature()
    assert.equal(fileSystem.watchers.filter(watcher => !watcher.closed).length, 0)
  } finally {
    projectRecord.closeFailuresRemaining = 0
    cwdRecord.closeFailuresRemaining = 0
    await first.dispose()
    await second?.dispose()
  }
})

test('caps opted-in root AGENTS watchers and retains failed-close capacity until confirmed closed', async () => {
  const warnings = []
  const record = { text: PROJECT_A, closeFailuresRemaining: 1 }
  const harness = await makeHarness(new Map([[CWD_A, record]]), {
    watch: true,
    onWatchError: error => warnings.push(error),
  })
  let firstScope
  try {
    for (let index = 0; index < 65; index += 1) {
      const { agent, scope } = await harness.createAgent(`agent-watch-cap-${index}`, CWD_A)
      if (index === 0) firstScope = scope
      await harness.created(agent)
    }
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 64, 'root AGENTS watcher cap')
    await waitUntil(() => warnings.some(error => /watcher capacity reached/u.test(error.message)), 'watcher capacity warning')
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 64)

    const staleWatcher = harness.watchers[0]
    await firstScope.dispose()
    await waitUntil(() => harness.calls.some(call => call[0] === 'watchCloseError'), 'failed close at watcher cap')
    const { agent: blocked } = await harness.createAgent('agent-watch-cap-close-pending', CWD_A)
    await harness.created(blocked)
    assert.equal(harness.calls.filter(call => call[0] === 'watch').length, 64,
      'a failed close keeps its slot reserved against additional watchers')
    assert.equal(staleWatcher.closed, false)

    await waitUntil(() => staleWatcher.closed, 'failed close retries and releases its capacity slot', 3_000)
    const { agent: admitted } = await harness.createAgent('agent-watch-cap-after-close', CWD_A)
    await harness.created(admitted)
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 64,
      'a new watcher is admitted after confirmed close')
    assert.equal(harness.calls.filter(call => call[0] === 'watch').length, 65)
    assert.ok(warnings.some(error => /watcher capacity reached/u.test(error.message)))

    await harness.disposeFeature()
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 0)
  } finally {
    await harness.dispose()
  }
})

test('a watched absent root AGENTS path receives a file created later', async () => {
  const record = { pathInfo: undefined }
  const harness = await makeHarness(new Map([[CWD_A, record]]), { watch: true })
  try {
    const { agent } = await harness.createAgent('agent-watch-created', CWD_A)
    await harness.created(agent)
    assert.equal(harness.hasSnapshot(agent), false)
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 1, 'absent-path root AGENTS watcher')

    record.pathInfo = { type: 'file' }
    record.text = '# Created after Agent startup.\n'
    harness.notify(CWD_A, 'file')
    await waitUntil(async () => (await harness.promptContexts(agent)).some(context => context.text.includes('Created after Agent startup')),
      'new root AGENTS file')
    assert.equal(harness.hasSnapshot(agent), true)
  } finally {
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

test('failed Cordis lifecycle registration leaves an attached AGENTS listener inert', async () => {
  const { fs, calls } = makeFileSystem(new Map([['/workspace/rollback', { text: 'must not be read' }]]))
  const agent = { id: 'rollback', ctx: { systemPrompt: { context() { throw new Error('must not register context') } } } }
  let attachedListener
  const registrationError = new Error('effect registration failed')
  const ctx = {
    on(event, listener) {
      assert.equal(event, 'agent/created')
      attachedListener = listener
    },
    effect() { throw registrationError },
  }

  assert.throws(() => registerRootAgentsContext(
    ctx,
    { get: id => id === agent.id ? agent : undefined },
    { get: id => ({ header: { id, cwd: '/workspace/rollback' } }) },
    fs,
  ), error => error === registrationError)
  await attachedListener({ agent })
  assert.equal(calls.some(call => call[0] === 'resolve'), false)
})

test('projectAgentsRoot accepts only one normalized absolute non-filesystem-root path', () => {
  assert.equal(normalizeProjectAgentsRoot('/workspace/project'), '/workspace/project')
  assert.throws(() => normalizeProjectAgentsRoot('/'), /non-filesystem-root path/u)
  assert.throws(() => normalizeProjectAgentsRoot('workspace/project'), /normalized absolute/u)
  assert.throws(() => normalizeProjectAgentsRoot('/workspace/../project'), /normalized absolute/u)
  assert.throws(() => normalizeProjectAgentsRoot('/workspace/\u202eproject'), /normalized absolute/u)
  assert.equal(normalizeProjectRootPath('/workspace/project', 'projectReadmeRoot'), '/workspace/project')
  assert.throws(() => normalizeProjectRootPath('/', 'projectReadmeRoot'), /projectReadmeRoot.*non-filesystem-root/u)
})

test('reads only an explicitly configured project-root AGENTS file for contained nested Agent cwd', async () => {
  const projectRoot = '/workspace/project'
  const nestedCwd = '/workspace/project/packages/app'
  const projectFileKey = `agents:${projectRoot}`
  const nestedRootKey = `root:${nestedCwd}`
  const harness = await makeHarness(new Map([
    [projectRoot, {
      text: 'Project-root guidance.',
      contains: (_parent, child) => child?.targetKey === projectFileKey || child?.targetKey === nestedRootKey,
    }],
    [nestedCwd, { text: 'Nested cwd guidance must not be read.' }],
  ]), { projectRoot })
  try {
    const { agent } = await harness.createAgent('nested-project-agent', nestedCwd)
    await harness.created(agent)
    const contexts = await harness.promptContexts(agent)
    assert.equal(contexts.length, 1)
    assert.equal(contexts[0].name, PROJECT_CONTEXT_NAME)
    assert.match(contexts[0].text, /Project-root guidance/u)
    assert.match(contexts[0].text, /untrusted/u)
    assert.doesNotMatch(contexts[0].text, /Nested cwd guidance/u)
    assert.equal(harness.hasSnapshot(agent), true)
    assert.equal(harness.watchers.length, 0, 'explicit project roots are snapshots, not watched sources')
    assert.ok(harness.calls.some(call => call[0] === 'resolve' && call[1] === projectRoot))
    assert.ok(harness.calls.some(call => call[0] === 'resolve' && call[1] === nestedCwd))
    assert.ok(harness.calls.some(call => call[0] === 'readBytes' && call[1]?.targetKey === projectFileKey && call[3] === 16_384))
    assert.equal(harness.calls.some(call => call[0] === 'readBytes' && call[1]?.targetKey === `agents:${nestedCwd}`), false)
  } finally {
    await harness.dispose()
  }
})

test('refreshes only the watched explicit project-root AGENTS snapshot and closes its watcher', async () => {
  const projectRoot = '/workspace/project'
  const nestedCwd = '/workspace/project/packages/app'
  const projectFileKey = `agents:${projectRoot}`
  const nestedRootKey = `root:${nestedCwd}`
  const projectRecord = { text: '# Project guidance v1.\n' }
  projectRecord.contains = (_parent, child) => child?.targetKey === projectFileKey
    || child?.targetKey === projectRecord.afterTargetKey
    || child?.targetKey === nestedRootKey
  const records = new Map([
    [projectRoot, projectRecord],
    [nestedCwd, { text: 'Nested cwd guidance must remain separate.' }],
  ])
  const harness = await makeHarness(records, { projectRoot, projectRootWatch: true })
  try {
    const first = await harness.createAgent('project-watch-agent', nestedCwd)
    await harness.created(first.agent)
    await waitUntil(() => harness.watchers.filter(watcher => !watcher.closed).length === 1,
      'explicit project-root AGENTS watcher')
    assert.equal(harness.watchers.find(watcher => !watcher.closed).target.targetKey, projectFileKey)
    assert.equal(harness.calls.some(call => call[0] === 'watch' && call[1]?.targetKey === nestedRootKey), false,
      'the watcher must not broaden to the Agent cwd')
    assert.match((await harness.promptContexts(first.agent))[0].text, /Project guidance v1/u)

    projectRecord.text = '# Project guidance edited in place.\n'
    harness.notify(projectRoot, 'file')
    await waitUntil(async () => (await harness.promptContexts(first.agent))
      .some(context => context.text.includes('edited in place')), 'project-root AGENTS in-place refresh')

    const staleWatcher = harness.watchers.find(watcher => !watcher.closed)
    projectRecord.replacedAfterRead = true
    projectRecord.afterTargetKey = 'agents:/workspace/project/replaced'
    projectRecord.afterPathInfo = { type: 'file' }
    projectRecord.text = '# Project guidance atomically replaced.\n'
    harness.notify(projectRoot, 'file')
    await waitUntil(async () => (await harness.promptContexts(first.agent))
      .some(context => context.text.includes('atomically replaced')), 'project-root AGENTS replacement refresh')
    assert.equal(staleWatcher.closed, true)
    assert.equal(harness.watchers.filter(watcher => !watcher.closed)[0].target.targetKey, projectRecord.afterTargetKey)

    projectRecord.afterPathInfo = undefined
    harness.notify(projectRoot, 'file')
    await waitUntil(async () => !harness.hasSnapshot(first.agent), 'project-root AGENTS deletion clears snapshot')
    assert.deepEqual(await harness.promptContexts(first.agent), [])

    projectRecord.afterPathInfo = { type: 'file' }
    projectRecord.text = '# Project guidance recreated.\n'
    harness.notify(projectRoot, 'file')
    await waitUntil(async () => (await harness.promptContexts(first.agent))
      .some(context => context.text.includes('recreated')), 'project-root AGENTS recreation refresh')

    await harness.disposeFeature()
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 0,
      'plugin disposal closes project-root watchers on live Agents')
    assert.deepEqual(await harness.promptContexts(first.agent), [])
  } finally {
    await harness.dispose()
  }
})

test('project-root AGENTS watcher refuses to watch an out-of-root Agent cwd', async () => {
  const projectRoot = '/workspace/project'
  const nestedCwd = '/workspace/project/packages/app'
  const projectFileKey = `agents:${projectRoot}`
  const nestedRootKey = `root:${nestedCwd}`
  const harness = await makeHarness(new Map([
    [projectRoot, {
      text: 'Must remain out of scope.',
      contains: (_parent, child) => child?.targetKey === projectFileKey,
    }],
    [nestedCwd, { text: 'Agent cwd is not contained.' }],
  ]), { projectRoot, projectRootWatch: true })
  try {
    const { agent } = await harness.createAgent('out-of-root-project-watch', nestedCwd)
    await harness.created(agent)
    assert.equal(harness.watchers.filter(watcher => !watcher.closed).length, 0)
    assert.equal(harness.calls.some(call => call[0] === 'watch' && call[1]?.targetKey === projectFileKey), false)
    assert.equal(harness.calls.some(call => call[0] === 'watch' && call[1]?.targetKey === nestedRootKey), false)
    assert.deepEqual(await harness.promptContexts(agent), [])
  } finally {
    await harness.dispose()
  }
})

test('explicit project-root context precedes nested cwd instructions and avoids same-root duplication', async () => {
  const projectRoot = '/workspace/project'
  const nestedCwd = '/workspace/project/packages/app'
  const projectFileKey = `agents:${projectRoot}`
  const nestedRootKey = `root:${nestedCwd}`
  const records = new Map([
    [projectRoot, {
      text: 'Project-root guidance.',
      contains: (_parent, child) => child?.targetKey === projectFileKey || child?.targetKey === nestedRootKey,
    }],
    [nestedCwd, { text: 'Nested cwd guidance.' }],
  ])
  const combined = await makeHarness(records, {
    projectRoot, cwdRootContext: true, allContextNames: true,
  })
  try {
    const { agent } = await combined.createAgent('combined-agent', nestedCwd)
    await combined.created(agent)
    const contexts = await combined.promptContexts(agent)
    assert.deepEqual(contexts.map(context => context.name), [PROJECT_CONTEXT_NAME, CONTEXT_NAME])
    assert.match(contexts[0].text, /Project-root guidance/u)
    assert.match(contexts[1].text, /Nested cwd guidance/u)
  } finally {
    await combined.dispose()
  }

  const sameRoot = await makeHarness(new Map([[projectRoot, { text: 'One copy only.' }]]), {
    projectRoot, projectRootWatch: true, skipIfSameAsCwd: true, cwdRootContext: true, allContextNames: true,
  })
  try {
    const { agent } = await sameRoot.createAgent('same-root-agent', projectRoot)
    await sameRoot.created(agent)
    const contexts = await sameRoot.promptContexts(agent)
    assert.deepEqual(contexts.map(context => context.name), [CONTEXT_NAME])
    assert.equal(sameRoot.watchers.filter(watcher => !watcher.closed).length, 0,
      'a duplicate project root does not consume a second watcher')
    assert.equal(contexts.length, 1)
  } finally {
    await sameRoot.dispose()
  }
})

test('explicit project-root context skips outside cwd, escaped AGENTS files, and root identity changes', async () => {
  const projectRoot = '/workspace/project'
  const outsideCwd = '/workspace/project-sibling'
  const projectFileKey = `agents:${projectRoot}`
  const outside = await makeHarness(new Map([
    [projectRoot, { text: 'must not load', contains: (_parent, child) => child?.targetKey === projectFileKey }],
    [outsideCwd, { text: 'outside' }],
  ]), { projectRoot })
  try {
    const { agent } = await outside.createAgent('outside-agent', outsideCwd)
    await outside.created(agent)
    assert.deepEqual(await outside.promptContexts(agent), [])
    assert.equal(outside.calls.some(call => call[0] === 'readBytes'), false)
    assert.ok(outside.calls.some(call => call[0] === 'resolve' && call[1] === outsideCwd))
  } finally {
    await outside.dispose()
  }

  const nestedCwd = '/workspace/project/app'
  const nestedRootKey = `root:${nestedCwd}`
  const escapedFile = await makeHarness(new Map([
    [projectRoot, { text: 'outside symlink target', contains: (_parent, child) => child?.targetKey === nestedRootKey }],
    [nestedCwd, { text: 'nested' }],
  ]), { projectRoot })
  try {
    const { agent } = await escapedFile.createAgent('escaped-file-agent', nestedCwd)
    await escapedFile.created(agent)
    assert.deepEqual(await escapedFile.promptContexts(agent), [], 'the root file itself must remain contained')
    assert.equal(escapedFile.calls.some(call => call[0] === 'readBytes'), false)
  } finally {
    await escapedFile.dispose()
  }

  const movingRoot = await makeHarness(new Map([
    [projectRoot, {
      text: 'must not publish after root replacement',
      contains: (_parent, child) => child?.targetKey === projectFileKey || child?.targetKey === nestedRootKey,
      replaceRootAfterRead: true,
      afterRootTargetKey: 'root:replacement',
    }],
    [nestedCwd, { text: 'nested' }],
  ]), { projectRoot })
  try {
    const { agent } = await movingRoot.createAgent('moving-root-agent', nestedCwd)
    await movingRoot.created(agent)
    assert.deepEqual(await movingRoot.promptContexts(agent), [], 'root replacement during read fails closed')
  } finally {
    await movingRoot.dispose()
  }
})

test('explicit project-root snapshot stops on Agent-creation cancellation without publishing', async () => {
  const projectRoot = '/workspace/project'
  const nestedCwd = '/workspace/project/app'
  const projectFileKey = `agents:${projectRoot}`
  const nestedRootKey = `root:${nestedCwd}`
  const controllerBytes = new TextEncoder().encode('late repository text')
  const harness = await makeHarness(new Map([
    [projectRoot, {
      text: 'repository text',
      contains: (_parent, child) => child?.targetKey === projectFileKey || child?.targetKey === nestedRootKey,
      readBytes: (_target, signal) => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(controllerBytes), { once: true })
      }),
    }],
    [nestedCwd, { text: 'nested' }],
  ]), { projectRoot })
  try {
    const { agent } = await harness.createAgent('cancel-project-root-agent', nestedCwd)
    const controller = new AbortController()
    const pending = harness.created(agent, { source: 'startup', signal: controller.signal })
    await waitUntil(() => harness.calls.some(call => call[0] === 'readBytes'), 'explicit project-root read start')
    controller.abort()
    await pending
    assert.deepEqual(await harness.promptContexts(agent), [])
  } finally {
    await harness.dispose()
  }
})
