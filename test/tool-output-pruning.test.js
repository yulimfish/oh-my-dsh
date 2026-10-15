import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolResultPruningFinalizer } from '../src/tool-output-pruning.js'

const exec = Object.freeze({ agent: { id: 'agent-1' } })

test('returns no finalizer without the optional Host pruner', () => {
  assert.equal(createToolResultPruningFinalizer(undefined), undefined)
  assert.equal(createToolResultPruningFinalizer({}), undefined)
})

test('prunes only successful canonical content and preserves the structured value', () => {
  const calls = []
  const nonTextBlock = { type: 'image', data: 'opaque' }
  const trailingNonTextBlock = { type: 'audio', data: 'opaque' }
  const pruner = {
    pruneContent(blocks) {
      calls.push(blocks)
      return [blocks[0], blocks[1], { type: 'text', text: '[middle pruned]' }, blocks[3]]
    },
  }
  const finalizeContent = createToolResultPruningFinalizer(pruner)
  const original = [
    { type: 'text', text: 'head' },
    nonTextBlock,
    { type: 'text', text: 'large middle' },
    trailingNonTextBlock,
  ]
  const value = Object.freeze({ chunks: ['head', 'large middle'], nextOffset: 42 })
  const result = Object.freeze({ isError: false, value, content: original })

  const finalized = finalizeContent(exec, result)

  assert.equal(calls.length, 1)
  assert.equal(calls[0], original)
  assert.deepEqual(finalized, [
    { type: 'text', text: 'head' },
    nonTextBlock,
    { type: 'text', text: '[middle pruned]' },
    trailingNonTextBlock,
  ])
  assert.equal(result.content, original, 'the frozen Tool result is not mutated')
  assert.equal(result.value, value, 'the structured value remains unchanged')
})

test('preserves error content and skips the pruner', () => {
  let calls = 0
  const pruner = { pruneContent() { calls += 1; return [] } }
  const finalizeContent = createToolResultPruningFinalizer(pruner)
  const content = [{ type: 'text', text: 'error details' }]
  const result = Object.freeze({ isError: true, error: { message: 'failed' }, content })

  assert.equal(finalizeContent(exec, result), content)
  assert.equal(calls, 0)
})

test('preserves exact content within budget when the Host returns null', () => {
  const content = [{ type: 'text', text: 'short' }, { type: 'image', data: 'opaque' }]
  const finalizeContent = createToolResultPruningFinalizer({ pruneContent: () => null })
  const result = Object.freeze({ isError: false, value: 'short', content })

  assert.equal(finalizeContent(exec, result), content)
})

test('fails open to exact content when the optional Host pruner fails', () => {
  const content = [{ type: 'text', text: 'unpruned' }]
  const finalizeContent = createToolResultPruningFinalizer({ pruneContent: () => { throw new Error('private host failure') } })
  const result = Object.freeze({ isError: false, value: 'unpruned', content })

  assert.equal(finalizeContent(exec, result), content)
})
