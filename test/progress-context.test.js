import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createProgressContext, createProgressProjection, progressContextText } from '../src/progress-context.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const agentRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { AgentRegistry } = await import(agentRequire.resolve('@deepseek-ai/dsh-agent'))
const sessionRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent'))
const { SessionStore } = await import(sessionRequire.resolve('@deepseek-ai/dsh-session'))

const CONTEXT_NAME = 'dsh-omo:progress-context'

function todoEvent(seq, callId, todos, name = 'todo_write') {
  return {
    seq,
    type: 'tool/call',
    data: { callId, name, arguments: JSON.stringify({ todos }) },
  }
}

function resultEvent(seq, callId, { error = false, hostError = false } = {}) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: { toolCallId: callId, isError: error },
      ...(hostError ? { error: { name: 'Error', code: 'FAILED' } } : {}),
    },
  }
}

function sessionWith(events) {
  return {
    get seq() { return events.length + 1 },
    snapshotEvents(from = 0, to = events.length + 1) {
      return events.filter(event => event.seq >= from && event.seq < to)
    },
  }
}

function makeAgent(id) {
  const calls = { contexts: [], contextDisposals: 0, trackingDisposals: 0 }
  const contextDisposers = []
  const effectDisposers = []
  const agent = {
    id,
    ctx: {
      systemPrompt: {
        context(entry) {
          calls.contexts.push(entry)
          let active = true
          const dispose = () => {
            if (!active) return
            active = false
            calls.contextDisposals += 1
          }
          contextDisposers.push(dispose)
          return dispose
        },
      },
      effect(execute) {
        const cleanup = execute()
        let active = true
        const dispose = () => {
          if (!active) return
          active = false
          calls.trackingDisposals += 1
          cleanup?.()
        }
        effectDisposers.push(dispose)
        return dispose
      },
    },
  }
  agent.disposeScope = () => {
    for (const dispose of effectDisposers) dispose()
    for (const dispose of contextDisposers) dispose()
  }
  agent.calls = calls
  return agent
}

test('folds only successful todo_write results and incrementally replaces the complete list', () => {
  const events = [
    todoEvent(1, 'call-pending', [{ content: 'must not appear before success', status: 'pending' }]),
    todoEvent(2, 'call-first', [{ content: 'first task', status: 'in_progress' }, { content: 'second task', status: 'pending' }]),
    resultEvent(3, 'call-first'),
    todoEvent(4, 'call-failed', [{ content: 'failed replacement', status: 'pending' }]),
    resultEvent(5, 'call-failed', { error: true }),
    todoEvent(6, 'call-host-failed', [{ content: 'Host failure replacement', status: 'pending' }]),
    resultEvent(7, 'call-host-failed', { hostError: true }),
  ]
  const projection = createProgressProjection(sessionWith(events))
  const first = projection.render()
  assert.match(first, /Latest successful todo_write snapshot/u)
  assert.match(first, /- \[in_progress\] "first task"/u)
  assert.match(first, /- \[pending\] "second task"/u)
  assert.doesNotMatch(first, /must not appear|failed replacement|Host failure replacement/u)
  assert.match(first, /Do not redo completed items/u)
  assert.match(first, /verify outcomes against the current user request/u)

  events.push(
    { seq: 8, type: 'assistant/message', data: { private: 'ignored' } },
    todoEvent(9, 'call-second', [{ content: 'first task', status: 'completed' }, { content: 'second task', status: 'in_progress' }]),
    resultEvent(10, 'call-second'),
  )
  const second = projection.render()
  assert.match(second, /- \[completed\] "first task"/u)
  assert.match(second, /- \[in_progress\] "second task"/u)
  assert.doesNotMatch(second, /failed replacement|Host failure replacement/u)

  events.push(todoEvent(11, 'call-clear', []), resultEvent(12, 'call-clear'))
  assert.equal(projection.render(), '', 'an accepted empty list clears older progress')
})

test('sanitizes bounded todo content and rejects malformed or over-budget snapshots without stale fallback', () => {
  const good = progressContextText([{ content: 'safe task', status: 'pending' }])
  assert.match(good, /safe task/u)
  assert.equal(progressContextText([]), '')
  assert.equal(progressContextText(undefined), '')

  const invalidSnapshots = [
    [{ content: 'x'.repeat(513), status: 'pending' }],
    [{ content: '   ', status: 'pending' }],
    [{ content: 'bad status', status: 'done' }],
    [{ content: 42, status: 'pending' }],
    Array.from({ length: 65 }, () => ({ content: 'task', status: 'pending' })),
    Array.from({ length: 17 }, () => ({ content: 'x'.repeat(500), status: 'pending' })),
  ]
  for (const todos of invalidSnapshots) {
    const projection = createProgressProjection(sessionWith([
      todoEvent(1, 'good', [{ content: 'old list must not survive', status: 'pending' }]),
      resultEvent(2, 'good'),
      todoEvent(3, 'invalid', todos),
      resultEvent(4, 'invalid'),
    ]))
    assert.equal(projection.render(), '')
  }

  const projection = createProgressProjection(sessionWith([
    todoEvent(1, 'controls', [{ content: 'line one\nline\ttwo\u202e', status: 'pending' }]),
    resultEvent(2, 'controls'),
  ]))
  const text = projection.render()
  assert.match(text, /line one line two/u)
  assert.equal(text.includes('\u202e'), false)
})

test('skipping an event window never presents an older list as current', () => {
  const events = [todoEvent(1, 'old', [{ content: 'old list', status: 'pending' }]), resultEvent(2, 'old')]
  for (let seq = 3; seq <= 600; seq += 1) events.push({ seq, type: 'step/end', data: {} })
  const projection = createProgressProjection(sessionWith(events))
  assert.equal(projection.render(), '', 'the old list is outside the bounded initial window')

  events.push(todoEvent(601, 'new', [{ content: 'new list', status: 'in_progress' }]), resultEvent(602, 'new'))
  assert.match(projection.render(), /new list/u)
})

test('recovers a recent successful todo inside the initial bounded window', () => {
  const events = []
  for (let seq = 1; seq <= 600; seq += 1) events.push({ seq, type: 'step/end', data: {} })
  events.push(todoEvent(601, 'recent', [{ content: 'recent restored task', status: 'in_progress' }]), resultEvent(602, 'recent'))
  const projection = createProgressProjection(sessionWith(events))
  assert.match(projection.render(), /recent restored task/u)
})

test('recovers immediately when a restored session resets seq to a smaller in-window value', () => {
  const events = [todoEvent(1, 'restored', [{ content: 'restored current task', status: 'in_progress' }]), resultEvent(2, 'restored')]
  for (let seq = 3; seq <= 20; seq += 1) events.push({ seq, type: 'step/end', data: {} })
  const base = sessionWith(events)
  const session = { seq: base.seq, snapshotEvents: (...args) => base.snapshotEvents(...args) }
  const projection = createProgressProjection(session)
  assert.match(projection.render(), /restored current task/u)

  // Simulate restore/compaction exposing a shorter log at the same Session object.
  session.seq = 3
  assert.match(projection.render(), /restored current task/u)
  events.push(todoEvent(3, 'next', [{ content: 'next task after restore', status: 'pending' }]), resultEvent(4, 'next'))
  session.seq = 5
  const next = projection.render()
  assert.match(next, /next task after restore/u)
  assert.doesNotMatch(next, /restored current task/u)
})

test('does not let an older todo result overwrite a newer plan when results arrive out of order', () => {
  const projection = createProgressProjection(sessionWith([
    todoEvent(1, 'old-call', [{ content: 'old plan', status: 'in_progress' }]),
    todoEvent(2, 'new-call', [{ content: 'new plan', status: 'in_progress' }]),
    resultEvent(3, 'new-call'),
    resultEvent(4, 'old-call'),
  ]))
  const text = projection.render()
  assert.match(text, /new plan/u)
  assert.doesNotMatch(text, /old plan/u)
  const withFailure = createProgressProjection(sessionWith([
    todoEvent(1, 'old-call', [{ content: 'old plan', status: 'in_progress' }]),
    todoEvent(2, 'new-call', [{ content: 'new plan', status: 'in_progress' }]),
    resultEvent(3, 'new-call'),
    resultEvent(4, 'old-call', { error: true }),
  ]))
  assert.match(withFailure.render(), /new plan/u)
})

test('does not attribute a reused todo call ID result to the newer pending plan', () => {
  const projection = createProgressProjection(sessionWith([
    todoEvent(1, 'reused-todo', [{ content: 'first plan', status: 'in_progress' }]),
    todoEvent(2, 'reused-todo', [{ content: 'second plan', status: 'in_progress' }]),
    resultEvent(3, 'reused-todo'),
  ]))
  assert.equal(projection.render(), '', 'reused call IDs have ambiguous result correlation')
  const independent = createProgressProjection(sessionWith([
    todoEvent(1, 'reused-todo', [{ content: 'first plan', status: 'in_progress' }]),
    todoEvent(2, 'reused-todo', [{ content: 'second plan', status: 'in_progress' }]),
    resultEvent(3, 'reused-todo'),
    todoEvent(4, 'independent-todo', [{ content: 'independent plan', status: 'pending' }]),
    resultEvent(5, 'independent-todo'),
  ]))
  assert.match(independent.render(), /independent plan/u)
})

test('quarantines a todo call ID reused after its first result completed', () => {
  const projection = createProgressProjection(sessionWith([
    todoEvent(1, 'completed-reuse', [{ content: 'first completed plan', status: 'in_progress' }]),
    resultEvent(2, 'completed-reuse'),
    todoEvent(3, 'completed-reuse', [{ content: 'second ambiguous plan', status: 'in_progress' }]),
    resultEvent(4, 'completed-reuse'),
  ]))
  assert.equal(projection.render(), '')
  const unrelated = createProgressProjection(sessionWith([
    todoEvent(1, 'first', [{ content: 'first plan', status: 'pending' }]),
    resultEvent(2, 'first'),
    todoEvent(3, 'second', [{ content: 'second current plan', status: 'in_progress' }]),
    resultEvent(4, 'second'),
    todoEvent(5, 'first', [{ content: 'ambiguous old plan', status: 'pending' }]),
  ]))
  assert.match(unrelated.render(), /second current plan/u)
})

test('quarantines duplicate results for one todo call ID', () => {
  const projection = createProgressProjection(sessionWith([
    todoEvent(1, 'duplicate-result', [{ content: 'ambiguous completed plan', status: 'in_progress' }]),
    resultEvent(2, 'duplicate-result'),
    resultEvent(3, 'duplicate-result'),
  ]))
  assert.equal(projection.render(), '')
})

test('does not re-admit an ambiguous todo call ID after quarantine eviction', () => {
  const events = [todoEvent(1, 'old-ambiguous', [{ content: 'old ambiguous plan', status: 'in_progress' }]), todoEvent(2, 'old-ambiguous', [{ content: 'old ambiguous second', status: 'pending' }])]
  for (let index = 0; index < 40; index += 1) {
    const id = `ambiguous-${index}`
    events.push(todoEvent(index * 2 + 3, id, [{ content: `plan ${index}`, status: 'pending' }]))
    events.push(todoEvent(index * 2 + 4, id, [{ content: `plan ${index} duplicate`, status: 'pending' }]))
  }
  events.push(todoEvent(83, 'old-ambiguous', [{ content: 'revived old plan', status: 'in_progress' }]), resultEvent(84, 'old-ambiguous'))
  const projection = createProgressProjection(sessionWith(events))
  assert.equal(projection.render(), '')
})

test('does not re-admit a completed call ID or accept a duplicate result after eviction', () => {
  const completedEvents = [todoEvent(1, 'old-completed', [{ content: 'revived old plan', status: 'in_progress' }]), resultEvent(2, 'old-completed')]
  for (let index = 0; index < 40; index += 1) {
    completedEvents.push(todoEvent(index * 2 + 3, `completed-${index}`, [{ content: 'other plan', status: 'pending' }]))
    completedEvents.push(resultEvent(index * 2 + 4, `completed-${index}`))
  }
  completedEvents.push(todoEvent(83, 'old-completed', [{ content: 'revived old plan', status: 'in_progress' }]), resultEvent(84, 'old-completed'))
  const completedText = createProgressProjection(sessionWith(completedEvents)).render()
  assert.doesNotMatch(completedText, /revived old plan/u)

  const duplicateEvents = [todoEvent(1, 'current', [{ content: 'stale current plan', status: 'in_progress' }]), resultEvent(2, 'current')]
  for (let index = 0; index < 32; index += 1) {
    duplicateEvents.push(todoEvent(index * 2 + 3, `failed-${index}`, [{ content: 'failed plan', status: 'pending' }]))
    duplicateEvents.push(resultEvent(index * 2 + 4, `failed-${index}`, { error: true }))
  }
  duplicateEvents.push(resultEvent(67, 'current'))
  assert.equal(createProgressProjection(sessionWith(duplicateEvents)).render(), '')
})

test('retains the current plan when only its completed tombstone is evicted', () => {
  const events = [todoEvent(1, 'current-plan', [{ content: 'still current plan', status: 'in_progress' }]), resultEvent(2, 'current-plan')]
  for (let index = 0; index < 40; index += 1) {
    events.push(todoEvent(index * 2 + 3, `completed-${index}`, [{ content: `other plan ${index}`, status: 'pending' }]))
    events.push(resultEvent(index * 2 + 4, `completed-${index}`))
  }
  const text = createProgressProjection(sessionWith(events)).render()
  assert.match(text, /other plan 39/u)
  assert.doesNotMatch(text, /still current plan/u)
})

test('keeps the newest successful plan when a later call fails before an older result succeeds', () => {
  const projection = createProgressProjection(sessionWith([
    todoEvent(1, 'old-call', [{ content: 'old successful plan', status: 'in_progress' }]),
    todoEvent(2, 'new-call', [{ content: 'new failed plan', status: 'in_progress' }]),
    resultEvent(3, 'new-call', { error: true }),
    resultEvent(4, 'old-call'),
  ]))
  assert.match(projection.render(), /old successful plan/u)
})

test('malformed session data and snapshot failures fail open', () => {
  const malformed = createProgressProjection({
    seq: 3,
    snapshotEvents() {
      return [{ seq: 2, type: 'tool/call', data: { name: 'todo_write', callId: 'x', arguments: '{}' } }]
    },
  })
  assert.equal(malformed.render(), '')
  const throwing = createProgressProjection({ seq: 1, snapshotEvents() { throw new Error('private') } })
  assert.equal(throwing.render(), '')
  assert.equal(createProgressProjection({ seq: 2, snapshotEvents: () => 'not-an-array' }).render(), '')
})

test('registers exact live Agents, refreshes on compact, and disposes callbacks', async () => {
  const live = new Map()
  const sessions = new Map()
  const feature = createProgressContext({ get: id => sessions.get(id) }, { get: id => live.get(id) })
  const agent = makeAgent('progress-agent')
  live.set(agent.id, agent)
  const session = {
    header: { id: agent.id },
    ...sessionWith([
      todoEvent(1, 'first', [{ content: 'persisted plan', status: 'in_progress' }]),
      resultEvent(2, 'first'),
    ]),
  }
  sessions.set(agent.id, session)

  for (const source of ['startup', 'resume', 'clear', 'compact']) await feature.listener({ agent, source })
  assert.equal(agent.calls.contexts.length, 1)
  assert.equal(agent.calls.contexts[0].name, CONTEXT_NAME)
  assert.equal(agent.calls.contexts[0].order, 146)
  assert.match(agent.calls.contexts[0].text(), /persisted plan/u)

  const replacement = makeAgent(agent.id)
  live.set(replacement.id, replacement)
  sessions.set(replacement.id, {
    header: { id: replacement.id },
    ...sessionWith([
      todoEvent(1, 'compacted', [{ content: 'restored after compact', status: 'pending' }]),
      resultEvent(2, 'compacted'),
    ]),
  })
  await feature.listener({ agent: replacement, source: 'compact' })
  assert.equal(agent.calls.contextDisposals, 1)
  assert.equal(agent.calls.contexts[0].text(), '')
  assert.match(replacement.calls.contexts[0].text(), /restored after compact/u)

  replacement.disposeScope()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(replacement.calls.contexts[0].text(), '')
  assert.equal(replacement.calls.contextDisposals, 1)
  await feature.dispose()
  await feature.dispose()
})

test('stale, aborted, malformed, and over-cap Agents receive no progress registration', async () => {
  const live = new Map()
  const feature = createProgressContext({ get: () => undefined }, { get: id => live.get(id) })
  const actual = makeAgent('same-id')
  const stale = makeAgent('same-id')
  live.set(actual.id, actual)
  await feature.listener({ agent: stale })
  const controller = new AbortController()
  controller.abort()
  await feature.listener({ agent: actual, signal: controller.signal })
  await feature.listener({ agent: actual, signal: null })
  assert.equal(actual.calls.contexts.length, 0)

  const agents = Array.from({ length: 257 }, (_value, index) => makeAgent(`agent-${index}`))
  for (const agent of agents) live.set(agent.id, agent)
  for (const agent of agents.slice(0, 256)) await feature.listener({ agent })
  await feature.listener({ agent: agents[256] })
  assert.equal(agents[0].calls.contexts.length, 1)
  assert.equal(agents[256].calls.contexts.length, 0)
  agents[0].disposeScope()
  await feature.listener({ agent: agents[256] })
  assert.equal(agents[256].calls.contexts.length, 1)
  await feature.dispose()
})

test('plugin disposal joins replacement cleanup without self-await or duplicate context disposal', async () => {
  const live = new Map()
  const feature = createProgressContext({ get: () => undefined }, { get: id => live.get(id) })
  const original = makeAgent('progress-replacement')
  let contextCalls = 0
  original.ctx.systemPrompt.context = () => {
    contextCalls += 1
    return () => { contextCalls += 1; original.calls.contextDisposals += 1 }
  }
  let releaseTracking
  const trackingReady = new Promise(resolve => { releaseTracking = resolve })
  let trackingStartedResolve
  const trackingStarted = new Promise(resolve => { trackingStartedResolve = resolve })
  let trackingDispose
  original.ctx.effect = execute => {
    execute()
    trackingDispose = async () => {
      trackingStartedResolve()
      await trackingReady
    }
    return trackingDispose
  }
  live.set(original.id, original)
  await feature.listener({ agent: original })
  const replacement = makeAgent(original.id)
  live.set(replacement.id, replacement)
  const replacing = feature.listener({ agent: replacement, source: 'compact' })
  await trackingStarted
  const cleanup = feature.dispose()
  let settled = false
  void cleanup.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false)
  assert.equal(original.calls.contextDisposals, 0)
  releaseTracking()
  await Promise.all([replacing, cleanup])
  assert.equal(original.calls.contextDisposals, 1)
  assert.equal(contextCalls, 2)
  assert.equal(replacement.calls.contexts.length, 0)
})

test('real SessionStore and systemPrompt recover accepted progress in the matching Agent scope', async t => {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const agentFiber = await ctx.plugin(AgentRegistry)
  const sessionFiber = await ctx.plugin(SessionStore)
  const owned = []
  const sessions = new Map()
  const feature = createProgressContext({ get: id => sessions.get(id) }, ctx.agents)
  const featureFiber = await ctx.plugin(pluginCtx => {
    pluginCtx.on('agent/created', feature.listener)
    pluginCtx.effect(() => feature.dispose, 'test progress context')
  })
  t.after(async () => {
    await featureFiber.dispose()
    for (const { scope, detach } of owned.reverse()) {
      await scope.dispose()
      detach()
    }
    await sessionFiber.dispose()
    await agentFiber.dispose()
    await promptFiber.dispose()
  })

  async function createAgent(id, source = 'startup') {
    const session = ctx.sessions.create(id)
    sessions.set(id, session)
    const agent = { id, session }
    const scope = createScope(ctx, agent)
    await scope.ctx.inject(['systemPrompt'], injected => { agent.ctx = injected })
    const detach = ctx.agents.enter(agent, undefined)
    owned.push({ scope, detach })
    await ctx.agents.announce(agent, source)
    return agent
  }

  const agent = await createAgent('real-progress')
  const outside = await createAgent('outside-progress', 'compact')
  const assemblyFor = agent => ctx.systemPrompt.assemble({ scope: agent })
  const call = agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: 'todo-1',
    name: 'todo_write',
    arguments: JSON.stringify({ todos: [{ content: 'real current task', status: 'in_progress' }] }),
  })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: call.data.callId },
      toolCallId: call.data.callId,
      content: [{ type: 'text', text: 'Updated todo list' }],
      isError: false,
    },
  }, { surfaceOp: 'append' })

  const entries = (await assemblyFor(agent)).contexts.filter(entry => entry.name === CONTEXT_NAME)
  assert.equal(entries.length, 1)
  assert.match(entries[0].text, /real current task/u)
  const outsideEntries = (await assemblyFor(outside)).contexts.filter(entry => entry.name === CONTEXT_NAME)
  assert.equal(outsideEntries.length, 1)
  assert.equal(outsideEntries[0].text, '')
  assert.deepEqual((await ctx.systemPrompt.assemble()).contexts.filter(entry => entry.name === CONTEXT_NAME), [])

  await featureFiber.dispose()
  assert.deepEqual((await assemblyFor(agent)).contexts.filter(entry => entry.name === CONTEXT_NAME), [])
})
