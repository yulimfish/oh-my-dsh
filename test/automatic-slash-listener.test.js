import assert from 'node:assert/strict'
import test from 'node:test'
import { createAutomaticSlashCommandListener } from '../src/automatic-slash-commands.js'

function message(text, id = 'message-1', source = { kind: 'user' }) {
  return { id, role: 'user', source, content: [{ type: 'text', text }] }
}
const projectCommand = {
  name: 'review', description: 'Review', body: 'Review $ARGUMENTS.',
  path: '/workspace/.opencode/commands/review.md', bytes: 20,
}
const definition = { automatic: true, projectCommand }

function fixture(options = {}) {
  const calls = []
  const listener = createAutomaticSlashCommandListener({
    commands: { find: (_agent, name) => options.unknown ? undefined : definition },
    resolveProjectCommand: () => projectCommand,
    ...options,
  })
  return { listener, calls }
}

test('rewrites a real user project slash command without invoking a handler or changing identity', async () => {
  const { listener } = fixture()
  const original = message('/review  this file  ')
  const previous = message('previous context', 'previous')
  const decision = await listener(
    { agent: { id: 'agent' }, messages: [previous, original], turn: 1, step: 0, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [previous, original], startsRequestSeries: true }),
  )
  assert.equal(decision.startsRequestSeries, true)
  assert.equal(decision.messages[0], previous)
  assert.equal(decision.messages[1].id, original.id)
  assert.equal(decision.messages[1].source, original.source)
  assert.match(decision.messages[1].content[0].text, /Review {3}this file/u)
  assert.match(decision.messages[1].content[0].text, /<user-request>/u)
})

for (const [label, input] of [
  ['unknown command', '/other'],
  ['synthetic source', '/review'],
  ['embedded text', 'please run /review'],
  ['fenced command', '```\n/review\n```'],
]) {
  test(`leaves ${label} unchanged`, async () => {
    const original = message(input, label, label === 'synthetic source' ? { kind: 'model' } : { kind: 'user' })
    const { listener } = fixture({ unknown: label === 'unknown command' })
    const decision = await listener(
      { agent: { id: 'agent' }, messages: [original], signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [original] }),
    )
    assert.equal(decision.messages[0], original)
  })
}

test('deduplicates by exact Agent and message ID across steps', async () => {
  let resolves = 0
  const { listener } = fixture({ resolveProjectCommand: () => { resolves += 1; return projectCommand } })
  const original = message('/review once')
  for (const step of [0, 1]) {
    const decision = await listener(
      { agent: { id: 'agent' }, messages: [original], turn: 1, step, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [original] }),
    )
    if (step === 0) assert.match(decision.messages[0].content[0].text, /Review {2}once/u)
    else assert.match(decision.messages[0].content[0].text, /Review {2}once/u)
  }
  assert.equal(resolves, 4, 'one expansion plus a final validity recheck per successful rewrite')
})
