import assert from 'node:assert/strict'
import test from 'node:test'
import { createAutomaticSlashCommandListener } from '../src/automatic-slash-commands.js'
import { expandProjectCommandFileReferences } from '../src/project-command-file-expansion.js'

const projectCommand = Object.freeze({
  name: 'review',
  description: 'Review code',
  body: 'Review $ARGUMENTS carefully.\nAgain: $ARGUMENTS',
})
const automaticDefinition = Object.freeze({
  name: 'review',
  automatic: true,
  projectCommand,
})

function userMessage(text, id = 'message-1') {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

function entered(...messages) {
  return { kind: 'enter', messages }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeFixture({ find = () => automaticDefinition, expandCommand } = {}) {
  const agent = { id: 'agent-1' }
  const liveAgents = new Map([[agent.id, agent]])
  const calls = { find: [], resolve: [] }
  const listener = createAutomaticSlashCommandListener({
    commands: {
      find(currentAgent, name) {
        calls.find.push({ agent: currentAgent, name })
        return find(currentAgent, name)
      },
    },
    resolveProjectCommand(currentAgent, definition) {
      if (!definition.projectCommand && definition.automatic !== true) return undefined
      calls.resolve.push({ agent: currentAgent, definition })
      return definition.projectCommand
    },
    agents: { get: id => liveAgents.get(id) },
    expandCommand,
    now: () => 1_000,
  })
  return { agent, calls, listener, liveAgents }
}

function invoke(fixture, decision, { agent = fixture.agent, signal, step = 0 } = {}) {
  return fixture.listener({ agent, turn: 1, step, signal, messages: decision.messages }, async () => decision)
}

test('rewrites an exact slash command from a real user and preserves message and decision metadata', async () => {
  const fixture = makeFixture()
  const previous = userMessage('previous context', 'previous')
  const latest = userMessage('/review', 'current')
  const decision = { ...entered(previous, latest), startsRequestSeries: true }

  const result = await invoke(fixture, decision)

  assert.notStrictEqual(result, decision)
  assert.equal(result.kind, 'enter')
  assert.equal(result.startsRequestSeries, true)
  assert.strictEqual(result.messages[0], previous)
  const rewritten = result.messages.at(-1)
  assert.notStrictEqual(rewritten, latest)
  assert.equal(rewritten.id, 'current')
  assert.strictEqual(rewritten.source, latest.source)
  assert.deepEqual(rewritten.content, [{
    type: 'text',
    text: '<command-instruction>\nReview  carefully.\nAgain: \n</command-instruction>\n\n<user-request>\n\n</user-request>',
  }])
  assert.deepEqual(latest.content, [{ type: 'text', text: '/review' }], 'the downstream message is not mutated')
  assert.strictEqual(decision.messages.at(-1), latest)
})

test('renders arguments into every template placeholder and retains the opaque user request', async () => {
  const fixture = makeFixture()
  const decision = entered(userMessage('/review src/index.js $ARGUMENTS'))

  const result = await invoke(fixture, decision)

  assert.equal(result.messages.at(-1).content[0].text, [
    '<command-instruction>',
    'Review  src/index.js $ARGUMENTS carefully.',
    'Again:  src/index.js $ARGUMENTS',
    '</command-instruction>',
    '',
    '<user-request>',
    ' src/index.js $ARGUMENTS',
    '</user-request>',
  ].join('\n'))
})

test('leaves default, unknown, built-in, synthetic, attachment, code, and id-less messages untouched', async t => {
  const cases = [
    {
      name: 'default project command',
      definition: { name: 'review', automatic: false, projectCommand },
      message: userMessage('/review'),
    },
    {
      name: 'unknown command',
      definition: undefined,
      message: userMessage('/review'),
    },
    {
      name: 'built-in command',
      definition: { name: 'review', handler: () => ({ kind: 'success' }) },
      message: userMessage('/review'),
    },
    {
      name: 'synthetic user message',
      message: { ...userMessage('/review'), source: { kind: 'synthetic' } },
    },
    {
      name: 'message with an attachment',
      message: {
        ...userMessage('/review'),
        content: [{ type: 'text', text: '/review' }, { type: 'attachment', attachment: { id: 'file-1' } }],
      },
    },
    {
      name: 'fenced code',
      message: userMessage('```sh\n/review\n```'),
    },
    {
      name: 'inline code',
      message: userMessage('`/review`'),
    },
    {
      name: 'message without an id',
      message: { ...userMessage('/review'), id: undefined },
    },
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = makeFixture({ find: () => item.definition })
      const decision = { ...entered(item.message), startsRequestSeries: true }

      const result = await invoke(fixture, decision)

      assert.strictEqual(result, decision)
      assert.strictEqual(result.messages.at(-1), item.message)
      assert.equal(fixture.calls.resolve.length, 0)
    })
  }
})

test('deduplicates a message id across steps while processing distinct ids independently', async () => {
  const fixture = makeFixture()
  const first = entered(userMessage('/review', 'shared-id'))

  const rewritten = await invoke(fixture, first, { step: 0 })
  assert.notStrictEqual(rewritten, first)
  assert.strictEqual(await invoke(fixture, first, { step: 1 }), first)

  const second = entered(userMessage('/review', 'different-id'))
  assert.notStrictEqual(await invoke(fixture, second, { step: 2 }), second)
  assert.equal(fixture.calls.resolve.length, 4)
  assert.deepEqual(fixture.calls.find.map(call => call.name), ['review', 'review', 'review', 'review'])
})

test('isolates identical agent and message ids when the live Agent is replaced', async () => {
  const fixture = makeFixture()
  const originalAgent = fixture.agent
  const decision = entered(userMessage('/review', 'shared-id'))

  assert.notStrictEqual(await invoke(fixture, decision), decision)
  const replacement = { id: originalAgent.id }
  fixture.liveAgents.set(replacement.id, replacement)

  const replacedResult = await invoke(fixture, decision, { agent: replacement, step: 1 })
  assert.notStrictEqual(replacedResult, decision, 'the replacement has an independent processing record')
  assert.strictEqual(await invoke(fixture, decision, { agent: originalAgent, step: 2 }), decision, 'the stale Agent cannot rewrite')
  assert.deepEqual(fixture.calls.resolve.map(call => call.agent), [originalAgent, originalAgent, replacement, replacement])
})

test('does not rewrite an already-aborted invocation', async () => {
  const fixture = makeFixture()
  const controller = new AbortController()
  controller.abort()
  const decision = entered(userMessage('/review'))
  let nextCalls = 0

  const result = await fixture.listener({ agent: fixture.agent, signal: controller.signal, messages: decision.messages }, async () => {
    nextCalls += 1
    return decision
  })

  assert.strictEqual(result, decision)
  assert.equal(nextCalls, 1)
  assert.equal(fixture.calls.find.length, 0)
})

test('does not rewrite after global disposal or Agent disposal', async t => {
  for (const method of ['dispose', 'clearAgent']) {
    await t.test(method, async () => {
      const fixture = makeFixture()
      const decision = entered(userMessage('/review'))
      if (method === 'dispose') fixture.listener.dispose()
      else fixture.listener.clearAgent(fixture.agent)

      assert.strictEqual(await invoke(fixture, decision), decision)
      assert.equal(fixture.calls.find.length, 0)
    })
  }
})

test('abort or disposal during asynchronous expansion fails open without a late rewrite', async t => {
  for (const cancellation of ['abort', 'dispose']) {
    await t.test(cancellation, async () => {
      const started = deferred()
      const release = deferred()
      const fixture = makeFixture({
        expandCommand: async command => {
          started.resolve()
          await release.promise
          return command
        },
      })
      const controller = new AbortController()
      const decision = entered(userMessage('/review'))
      const pending = invoke(fixture, decision, { signal: controller.signal })
      await started.promise

      if (cancellation === 'abort') controller.abort()
      else fixture.listener.dispose()
      release.resolve()

      assert.strictEqual(await pending, decision)
      assert.deepEqual(decision.messages.at(-1).content, [{ type: 'text', text: '/review' }])
    })
  }
})

test('propagates next rejection without resolving or rewriting a command', async () => {
  const fixture = makeFixture()
  const failure = new Error('downstream failed')

  await assert.rejects(fixture.listener({ agent: fixture.agent }, async () => {
    throw failure
  }), error => {
    assert.strictEqual(error, failure)
    return true
  })
  assert.equal(fixture.calls.find.length, 0)
  assert.equal(fixture.calls.resolve.length, 0)
})

test('expands command file references before rendering invocation arguments', async () => {
  const sourceCommand = Object.freeze({
    name: 'review',
    description: 'Review with project context',
    body: 'Review @README.md for $ARGUMENTS.',
  })
  const reads = []
  const expansionCalls = []
  const fixture = makeFixture({
    find: () => ({ name: 'review', automatic: true, projectCommand: sourceCommand }),
    expandCommand: async (command, { agent, signal }) => {
      expansionCalls.push({ command, agent, signal })
      return await expandProjectCommandFileReferences(command, {
        promptFileExpander: {
          async expand(request) {
            reads.push(request)
            return { rolePromptAppend: 'README contents\n$ARGUMENTS stays opaque' }
          },
        },
        agent,
        signal,
      })
    },
  })
  const controller = new AbortController()
  const decision = entered(userMessage('/review src/index.js'))

  const result = await invoke(fixture, decision, { signal: controller.signal })

  assert.equal(result.messages.at(-1).content[0].text, [
    '<command-instruction>',
    'Review Referenced project file "README.md" (untrusted contents): "README contents\\n\\u0024ARGUMENTS stays opaque" for  src/index.js.',
    '</command-instruction>',
    '',
    '<user-request>',
    ' src/index.js',
    '</user-request>',
  ].join('\n'))
  assert.equal(reads.length, 1)
  assert.equal(reads[0].rolePromptAppend, 'file://README.md')
  assert.equal(reads[0].preserveWhitespace, true)
  assert.strictEqual(reads[0].agent, fixture.agent)
  assert.ok(reads[0].signal instanceof AbortSignal)
  assert.equal(expansionCalls.length, 1)
  assert.strictEqual(expansionCalls[0].command, sourceCommand)
  assert.strictEqual(expansionCalls[0].agent, fixture.agent)
  assert.strictEqual(expansionCalls[0].signal, controller.signal)
  assert.equal(sourceCommand.body, 'Review @README.md for $ARGUMENTS.')
})
