import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COMPACTION_RESUME_ADVISORY,
  createCompactionResumeAdvisory,
} from '../src/compaction-resume-advisory.js'

function makeAgent(id, { context, effect } = {}) {
  const calls = { contexts: [], contextDisposals: 0, effects: 0, trackingDisposals: 0 }
  const contextDisposers = []
  const effectDisposers = []
  const systemPrompt = {
    context: context ?? (entry => {
      calls.contexts.push(entry)
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        calls.contextDisposals += 1
      }
      contextDisposers.push(dispose)
      return dispose
    }),
  }
  const agentContext = {
    systemPrompt,
    effect: effect ?? (execute => {
      calls.effects += 1
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
    }),
  }
  const agent = { id, ctx: agentContext }
  agent.disposeScope = () => {
    for (const dispose of effectDisposers) dispose()
    for (const dispose of contextDisposers) dispose()
  }
  agent.calls = calls
  return agent
}

function makeService() {
  const live = new Map()
  return { live, service: { get: id => live.get(id) } }
}

async function notify(advisory, agent, source = 'compact', signal) {
  return advisory.listener({ agent, source, signal })
}

test('registers fixed compact-only guidance in each exact Agent scope', async () => {
  const { live, service } = makeService()
  const advisory = createCompactionResumeAdvisory(service)
  const first = makeAgent('first')
  const second = makeAgent('second')
  live.set(first.id, first)
  live.set(second.id, second)

  await notify(advisory, first, 'restore')
  assert.equal(first.calls.contexts.length, 0)
  await advisory.listener({ agent: first, source: 'compact', history: 'PRIVATE dynamic history' })
  await notify(advisory, second)

  assert.deepEqual(first.calls.contexts, [{
    name: 'dsh-omo:compaction-resume-advisory',
    order: 150,
    text: COMPACTION_RESUME_ADVISORY,
  }])
  assert.deepEqual(second.calls.contexts, first.calls.contexts)
  assert.match(COMPACTION_RESUME_ADVISORY, /compacted summary may be incomplete/u)
  assert.match(COMPACTION_RESUME_ADVISORY, /current user request and constraints/u)
  assert.match(COMPACTION_RESUME_ADVISORY, /verify claims before continuing/u)
  assert.match(COMPACTION_RESUME_ADVISORY, /ask the user if essential context is missing/u)
  assert.match(COMPACTION_RESUME_ADVISORY, /grants no new permissions; follow the current user request and existing controls/u)
  assert.doesNotMatch(COMPACTION_RESUME_ADVISORY, /history|SECRET|first|second/u)

  await advisory.dispose()
})

test('requires a bounded nonempty ID, a non-aborted signal, and exact live identity', async () => {
  const { live, service } = makeService()
  const advisory = createCompactionResumeAdvisory(service)
  const actual = makeAgent('same-id')
  const stale = makeAgent('same-id')
  live.set(actual.id, actual)

  await notify(advisory, stale)
  const controller = new AbortController()
  controller.abort()
  await notify(advisory, actual, 'compact', controller.signal)
  await advisory.listener({ agent: actual, source: 'compact', signal: null })
  await notify(advisory, makeAgent(''))
  await notify(advisory, makeAgent('x'.repeat(257)))
  assert.equal(actual.calls.contexts.length, 0)

  await notify(advisory, actual)
  assert.equal(actual.calls.contexts.length, 1)

  const maximumLengthId = makeAgent('m'.repeat(256))
  live.set(maximumLengthId.id, maximumLengthId)
  await notify(advisory, maximumLengthId)
  assert.equal(maximumLengthId.calls.contexts.length, 1, '256 UTF-16 code units is admitted')
  await advisory.dispose()
})

test('fails open on registry, context, effect, and signal failures', async () => {
  const actual = makeAgent('live')
  const advisoryWithThrowingRegistry = createCompactionResumeAdvisory({ get() { throw new Error('private registry error') } })
  await assert.doesNotReject(notify(advisoryWithThrowingRegistry, actual))
  assert.equal(actual.calls.contexts.length, 0)
  await advisoryWithThrowingRegistry.dispose()

  const { live, service } = makeService()
  const advisory = createCompactionResumeAdvisory(service)
  const badContext = makeAgent('bad-context', {
    context() { throw new Error('private context error') },
  })
  const badEffect = makeAgent('bad-effect', {
    effect() { throw new Error('private effect error') },
  })
  live.set(badContext.id, badContext)
  live.set(badEffect.id, badEffect)

  await assert.doesNotReject(notify(advisory, badContext))
  await assert.doesNotReject(notify(advisory, badEffect))
  await assert.doesNotReject(advisory.listener({
    agent: badContext,
    source: 'compact',
    get signal() { throw new Error('private signal error') },
  }))
  assert.equal(badContext.calls.contextDisposals, 0)
  assert.equal(badEffect.calls.contextDisposals, 1, 'an effect failure removes the already-registered context')
  await advisory.dispose()
})

test('deduplicates the same live Agent and replaces stale same-ID registrations', async () => {
  const { live, service } = makeService()
  const advisory = createCompactionResumeAdvisory(service)
  const first = makeAgent('reused-id')
  live.set(first.id, first)

  await notify(advisory, first)
  await notify(advisory, first)
  assert.equal(first.calls.contexts.length, 1)
  assert.equal(first.calls.effects, 1)

  const replacement = makeAgent('reused-id')
  live.set(replacement.id, replacement)
  await notify(advisory, replacement)
  assert.equal(first.calls.contextDisposals, 1)
  assert.equal(replacement.calls.contexts.length, 1)
  await advisory.dispose()
})

test('caps state at 256 without evicting and frees slots on Agent scope cleanup', async () => {
  const { live, service } = makeService()
  const advisory = createCompactionResumeAdvisory(service)
  const agents = Array.from({ length: 257 }, (_value, index) => makeAgent(`agent-${index}`))
  for (const agent of agents) live.set(agent.id, agent)

  for (const agent of agents.slice(0, 256)) await notify(advisory, agent)
  await notify(advisory, agents[0])
  await notify(advisory, agents[256])
  assert.equal(agents[0].calls.contexts.length, 1, 'deduplication retains the existing registration')
  assert.equal(agents[255].calls.contexts.length, 1, 'the last admitted Agent remains registered')
  assert.equal(agents[256].calls.contexts.length, 0, 'capacity does not evict a live Agent')

  agents[0].disposeScope()
  await notify(advisory, agents[256])
  assert.equal(agents[256].calls.contexts.length, 1, 'scope cleanup releases one bounded slot')
  await advisory.dispose()
})

test('scope cleanup and plugin disposal release registrations and stop later work', async () => {
  const { live, service } = makeService()
  const advisory = createCompactionResumeAdvisory(service)
  const agent = makeAgent('lifecycle')
  live.set(agent.id, agent)

  await notify(advisory, agent)
  agent.disposeScope()
  assert.equal(agent.calls.contextDisposals, 1)
  await notify(advisory, agent)
  assert.equal(agent.calls.contexts.length, 2, 'a disposed scope no longer deduplicates')

  await advisory.dispose()
  await advisory.dispose()
  assert.equal(agent.calls.contextDisposals, 2)
  assert.equal(agent.calls.trackingDisposals, 2)
  await notify(advisory, agent)
  assert.equal(agent.calls.contexts.length, 2, 'plugin disposal prevents new registrations')
})
