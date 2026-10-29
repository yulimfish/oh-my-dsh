import assert from 'node:assert/strict'
import test from 'node:test'
import { expandProjectCommandFileReferences } from '../src/project-command-file-expansion.js'

function command(body) {
  return Object.freeze({ name: 'review', description: 'Review', body })
}

test('expands bounded prose references while keeping referenced text opaque', async () => {
  const agent = { id: 'agent-1' }
  const source = command([
    'Read @README.md, then inspect @src/index.js.',
    'Contact owner@example.com; that is not a file reference.',
  ].join('\n'))
  const reads = []
  const expander = {
    async expand(request) {
      reads.push(request)
      const contents = request.rolePromptAppend === 'file://README.md'
        ? 'Project overview\n$ARGUMENTS stays data; @nested.md is not recursively expanded.'
        : 'export const value = 1'
      return { rolePromptAppend: contents, expanded: true }
    },
  }

  const result = await expandProjectCommandFileReferences(source, { promptFileExpander: expander, agent })

  assert.deepEqual(reads.map(read => read.rolePromptAppend), ['file://README.md', 'file://src/index.js'])
  assert.equal(reads.every(read => read.agent === agent && read.signal instanceof AbortSignal), true)
  assert.equal(source.body.includes('Referenced project file'), false, 'the immutable source command is unchanged')
  assert.ok(result.body.includes('"Project overview\\n\\u0024ARGUMENTS stays data; @nested.md is not recursively expanded."'))
  assert.match(result.body, /"README\.md"[^\n]*, then inspect/u, 'trailing punctuation stays outside the replaced reference')
  assert.match(result.body, /owner@example\.com/u)
})

test('expands prose references while leaving references inside inline and fenced code untouched', async () => {
  const source = command([
    'Read @before.md before code.',
    'Use ` @inline.md ` but expand @outside.md.',
    '```typescript',
    '@fenced.md',
    '```',
    '~~~text',
    '@tilde-fenced.md',
    '~~~',
    '> ````sh',
    '> @blockquote-fenced.md',
    '> ````',
    'Read @after.md.',
  ].join('\n'))
  const reads = []
  const result = await expandProjectCommandFileReferences(source, {
    promptFileExpander: {
      async expand(request) {
        reads.push(request)
        return { rolePromptAppend: `contents for ${request.rolePromptAppend}` }
      },
    },
    agent: { id: 'agent-1' },
  })

  assert.deepEqual(reads.map(read => read.rolePromptAppend), [
    'file://before.md', 'file://outside.md', 'file://after.md',
  ])
  assert.equal(result.body.includes('Referenced project file "inline.md"'), false)
  assert.equal(result.body.includes('@inline.md'), true)
  assert.equal(result.body.includes('@fenced.md'), true)
  assert.equal(result.body.includes('@tilde-fenced.md'), true)
  assert.equal(result.body.includes('@blockquote-fenced.md'), true)
  assert.equal(result.body.includes('Referenced project file "before.md"'), true)
  assert.equal(result.body.includes('Referenced project file "outside.md"'), true)
  assert.equal(result.body.includes('Referenced project file "after.md"'), true)
})

test('fails closed before any read when Markdown code context is ambiguous', async () => {
  const ambiguousBodies = [
    'Read @outside.md then `unterminated inline code.',
    'Read @outside.md first.\n```typescript\n@inside.md',
    'Read @outside.md first.\n~~~yaml\n@inside.md',
    'Read @outside.md first.\n````typescript\n@inside.md\n```',
    'Read @outside.md first.\n```bad`info\n@inside.md',
    'Read @outside.md and show ~~~ in prose.',
    '> ```sh\n> @inside.md\n@outside.md\n> ```',
    `Read @outside.md first.\n${'`x` '.repeat(130)}`,
  ]

  for (const body of ambiguousBodies) {
    const source = command(body)
    const reads = []
    const result = await expandProjectCommandFileReferences(source, {
      promptFileExpander: { async expand(request) { reads.push(request); return { rolePromptAppend: 'should not be read' } } },
      agent: { id: 'agent-1' },
    })
    assert.equal(result, source, 'ambiguous markup leaves the complete command unchanged')
    assert.equal(reads.length, 0, `ambiguous body was pre-scanned before reading: ${JSON.stringify(body.slice(0, 64))}`)
  }
})

test('bounds reference count and aggregate expanded bytes', async t => {
  await t.test('reference count', async () => {
    let calls = 0
    const body = Array.from({ length: 5 }, (_, index) => `@file-${index}.md`).join(' ')
    await assert.rejects(expandProjectCommandFileReferences(command(body), {
      promptFileExpander: { async expand() { calls += 1; return { rolePromptAppend: 'x' } } },
      agent: { id: 'agent-1' },
    }), /at most 4 file references/u)
    assert.equal(calls, 0, 'reject an over-limit command before any referenced file is read')
  })

  await t.test('reference count across separate lines', async () => {
    let calls = 0
    const body = ['Read @one.md.', '` @not-counted.md `', 'Then @two.md and @three.md.', 'Finally @four.md and @five.md.'].join('\n')
    await assert.rejects(expandProjectCommandFileReferences(command(body), {
      promptFileExpander: { async expand() { calls += 1; throw new Error('must never read') } },
      agent: { id: 'agent-1' },
    }), /at most 4 file references/u)
    assert.equal(calls, 0)
  })

  await t.test('combined output bytes', async () => {
    let calls = 0
    const body = Array.from({ length: 4 }, (_, index) => `@file-${index}.md`).join(' ')
    await assert.rejects(expandProjectCommandFileReferences(command(body), {
      promptFileExpander: { async expand() { calls += 1; return { rolePromptAppend: 'x'.repeat(9_000) } } },
      agent: { id: 'agent-1' },
    }), /combined limit/u)
    assert.equal(calls, 2)
  })
})

test('fails closed when a referenced file cannot be read', async () => {
  await assert.rejects(expandProjectCommandFileReferences(command('Review @missing.md'), {
    promptFileExpander: { async expand() { throw new Error('provider path details must not escape') } },
    agent: { id: 'agent-1' },
  }), /could not be read safely/u)
})
