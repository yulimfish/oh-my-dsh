import assert from 'node:assert/strict'
import test from 'node:test'
import { createManualContextPruningHandler } from '../src/manual-context-pruning-command.js'

function fixture(overrides = {}) {
  const agent = Object.freeze({ id: 'session-1' })
  const session = Object.freeze({ id: agent.id })
  const calls = []
  const state = { currentAgent: agent, currentSession: session }
  const handler = createManualContextPruningHandler({
    agents: { get(id) { calls.push(['agent.get', id]); return state.currentAgent } },
    sessions: { get(id) { calls.push(['sessions.get', id]); return state.currentSession } },
    pruner: {
      pruneSession(value) {
        calls.push(['pruneSession', value])
        return { pruned: [{ replacementSeq: 4 }], charsRemoved: 120, ...overrides.result }
      },
    },
  })
  return { agent, session, state, calls, handler }
}

function invocation(agent, overrides = {}) {
  return { agent, rawInput: '', signal: new AbortController().signal, ...overrides }
}

test('prunes only the exact invoking Agent live Session and reports aggregate results', () => {
  const f = fixture()
  const result = f.handler(invocation(f.agent))
  assert.deepEqual(result, {
    kind: 'success',
    text: 'Host context pruning completed for the invoking Agent’s current session. Review the current conversation to see whether content changed.',
  })
  assert.deepEqual(f.calls, [
    ['agent.get', f.agent.id],
    ['sessions.get', f.agent.id],
    ['pruneSession', f.session],
    ['agent.get', f.agent.id],
    ['sessions.get', f.agent.id],
  ])
})

test('does not infer counts or savings from the Host result summary', () => {
  const f = fixture({ result: { pruned: [], charsRemoved: 0 } })
  assert.deepEqual(f.handler(invocation(f.agent)), {
    kind: 'success',
    text: 'Host context pruning completed for the invoking Agent’s current session. Review the current conversation to see whether content changed.',
  })
})

test('rejects arguments, malformed invocations, and cancellation before Host pruning', () => {
  const f = fixture()
  assert.equal(f.handler(invocation(f.agent, { rawInput: 'session-2' })).kind, 'error')
  assert.equal(f.handler(invocation(undefined)).kind, 'error')
  assert.equal(f.handler(invocation(f.agent, { signal: undefined })).kind, 'error')
  const controller = new AbortController()
  controller.abort()
  assert.match(f.handler(invocation(f.agent, { signal: controller.signal })).text, /canceled before it started/u)
  assert.equal(f.calls.some(([name]) => name === 'pruneSession'), false)
})

test('reports an uncertain outcome if cancellation arrives during Host pruning', () => {
  const agent = Object.freeze({ id: 'session-1' })
  const session = Object.freeze({ id: agent.id })
  const controller = new AbortController()
  const handler = createManualContextPruningHandler({
    agents: { get: () => agent },
    sessions: { get: () => session },
    pruner: {
      pruneSession() {
        controller.abort()
        return { pruned: [], charsRemoved: 0 }
      },
    },
  })
  const result = handler(invocation(agent, { signal: controller.signal }))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /may have changed the session/u)
})

test('does not resolve or prune a session for a stale or mismatched Agent', () => {
  const f = fixture()
  f.state.currentAgent = Object.freeze({ id: f.agent.id })
  assert.match(f.handler(invocation(f.agent)).text, /no longer the exact live Agent/u)
  assert.equal(f.calls.some(([name]) => name === 'sessions.get' || name === 'pruneSession'), false)

  const g = fixture()
  g.state.currentSession = Object.freeze({ id: 'another-session' })
  assert.match(g.handler(invocation(g.agent)).text, /Session is unavailable/u)
  assert.equal(g.calls.some(([name]) => name === 'pruneSession'), false)
})

test('reports possible partial changes when the Host pruner throws', () => {
  const agent = Object.freeze({ id: 'session-1' })
  const session = Object.freeze({ id: agent.id })
  const handler = createManualContextPruningHandler({
    agents: { get: () => agent },
    sessions: { get: () => session },
    pruner: { pruneSession() { throw new Error('private Host detail') } },
  })
  const result = handler(invocation(agent))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Earlier replacements may already have landed/u)
  assert.doesNotMatch(result.text, /private Host detail/u)
})

test('fails closed if the invoking Agent is replaced while pruning', () => {
  const agent = Object.freeze({ id: 'session-1' })
  const session = Object.freeze({ id: agent.id })
  let currentAgent = agent
  const replaced = createManualContextPruningHandler({
    agents: { get: () => currentAgent },
    sessions: { get: () => session },
    pruner: {
      pruneSession() {
        currentAgent = Object.freeze({ id: agent.id })
        return { pruned: [], charsRemoved: 0 }
      },
    },
  })
  assert.match(replaced(invocation(agent)).text, /may have changed the session/u)
})
