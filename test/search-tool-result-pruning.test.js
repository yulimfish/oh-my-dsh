import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeneralToolResultPruningListener, createSearchToolResultPruningListener, normalizeAdditionalToolResultPruningNames } from '../src/search-tool-result-pruning.js'

const caller = Object.freeze({ id: 'agent-1' })

function makeExec(overrides = {}) {
  return {
    name: 'grep',
    parent: undefined,
    agent: caller,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function makeResult(overrides = {}) {
  return { isError: false, content: [{ type: 'text', text: 'must not be used' }], ...overrides }
}

function makeDecision(overrides = {}) {
  return {
    kind: 'accept',
    content: [{ type: 'text', text: 'downstream content' }],
    additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'keep me' }] }],
    marker: 'extra decision field',
    ...overrides,
  }
}

function makeTools(get = () => ({ name: 'grep' })) {
  return { get }
}

function makePruner(pruneContent = blocks => blocks) {
  return { pruneContent }
}

test('normalizes a bounded exact additional Tool-name allowlist', () => {
  assert.deepEqual(normalizeAdditionalToolResultPruningNames(undefined), [])
  assert.deepEqual(normalizeAdditionalToolResultPruningNames(['custom:read', 'my_tool']), ['custom:read', 'my_tool'])
  assert.throws(() => normalizeAdditionalToolResultPruningNames('custom_tool'), /must be an array/u)
  assert.throws(() => normalizeAdditionalToolResultPruningNames(Array.from({ length: 33 }, (_, index) => `tool_${index}`)), /at most 32/u)
  for (const invalid of ['', ' custom_tool', 'custom_tool ', 'x'.repeat(129), 'é'.repeat(65), 'run_code', 'safe\u202ename']) {
    assert.throws(() => normalizeAdditionalToolResultPruningNames([invalid]), /exact safe Tool name/u)
  }
  assert.throws(() => normalizeAdditionalToolResultPruningNames(['custom_tool', 'custom_tool']), /must not contain duplicates/u)
})

async function assertSkipped({ listenerFactory = createSearchToolResultPruningListener, exec = makeExec(), result = makeResult(), decision = makeDecision(), tools = makeTools(), pruner = makePruner(), expectedPruneCalls = 0 } = {}) {
  let nextCalls = 0
  let pruneCalls = 0
  const pruning = listenerFactory(tools, {
    pruneContent(...args) {
      pruneCalls += 1
      return pruner.pruneContent(...args)
    },
  })
  const returned = await pruning.listener(exec, result, async () => {
    nextCalls += 1
    return decision
  })
  assert.strictEqual(returned, decision, 'fail-open paths preserve exact downstream decision identity')
  assert.equal(nextCalls, 1, 'the waterfall is continued exactly once')
  assert.equal(pruneCalls, expectedPruneCalls, 'pruner call count matches eligibility and fail-open outcome')
  return pruning
}

test('general pruning accepts an unlisted exact visible Tool when enabled', async () => {
  const originalContent = Object.freeze([
    Object.freeze({ type: 'text', text: 'long custom Tool result' }),
    Object.freeze({ type: 'image', data: 'keep rich block' }),
  ])
  const replacementContent = Object.freeze([{ type: 'text', text: '[pruned]' }])
  const decision = Object.freeze({ kind: 'accept', content: originalContent, marker: 'preserve decision metadata' })
  const lookups = []
  let prunedInput
  const pruning = createGeneralToolResultPruningListener({
    get(name, agent) {
      lookups.push([name, agent])
      return { name }
    },
  }, {
    pruneContent(content) {
      prunedInput = content
      return replacementContent
    },
  })

  const returned = await pruning.listener(
    makeExec({ name: 'custom_report_tool' }),
    makeResult(),
    async () => decision,
  )
  assert.notStrictEqual(returned, decision)
  assert.strictEqual(returned.content, replacementContent)
  assert.equal(returned.marker, 'preserve decision metadata')
  assert.strictEqual(prunedInput, originalContent)
  assert.deepEqual(lookups, [['custom_report_tool', caller]])
  pruning.dispose()
})

test('general pruning leaves non-eligible and Tool-finalized outcomes unchanged', async () => {
  const customDefinition = makeTools(() => ({ name: 'custom_tool' }))
  const aborted = new AbortController()
  aborted.abort()
  const cases = [
    { exec: makeExec({ name: 'run_code' }) },
    { exec: makeExec({ name: 'custom_tool', parent: caller }), tools: customDefinition },
    { exec: makeExec({ name: 'custom_tool', signal: aborted.signal }), tools: customDefinition },
    { exec: makeExec({ name: 'custom_tool' }), result: makeResult({ isError: true }), tools: customDefinition },
    { exec: makeExec({ name: 'custom_tool' }), decision: { kind: 'accept', value: { structured: true } }, tools: customDefinition },
    { exec: makeExec({ name: 'custom_tool' }), decision: { kind: 'block', feedback: [] }, tools: customDefinition },
    { exec: makeExec({ name: 'custom_tool' }), tools: makeTools(() => undefined) },
    { exec: makeExec({ name: 'custom_tool' }), tools: makeTools(() => ({ name: 'different_tool' })) },
    { exec: makeExec({ name: 'custom_tool' }), tools: makeTools(() => ({ name: 'custom_tool', projectContent() {} })) },
    { exec: makeExec({ name: 'custom_tool' }), tools: makeTools(() => ({ name: 'custom_tool', finalizeContent() {} })) },
    { exec: makeExec({ name: 'custom_tool' }), tools: customDefinition, pruner: makePruner(() => { throw new Error('private pruner failure') }), expectedPruneCalls: 1 },
  ]

  for (const options of cases) {
    await assertSkipped({ listenerFactory: createGeneralToolResultPruningListener, ...options })
  }
})

test('prunes downstream mixed content for exact caller-scoped grep, glob, and web_fetch Tools without mutation', async () => {
  for (const name of ['grep', 'glob', 'web_fetch']) {
    const blocks = Object.freeze([
      Object.freeze({ type: 'text', text: `${name} heading` }),
      Object.freeze({ type: 'image', data: 'opaque-image' }),
      Object.freeze({ type: 'text', text: 'large middle excerpt' }),
      Object.freeze({ type: 'audio', data: 'opaque-audio' }),
      Object.freeze({ type: 'resource', uri: 'file:///result' }),
      Object.freeze({ type: 'text', text: 'tail' }),
    ])
    const resultContent = Object.freeze([{ type: 'text', text: 'dispatch result content' }])
    const priorContext = Object.freeze({ role: 'user', content: Object.freeze([{ type: 'text', text: 'preserve context' }]) })
    const additionalContexts = Object.freeze([priorContext])
    const decision = Object.freeze({ kind: 'accept', content: blocks, additionalContexts, marker: 'preserve other fields' })
    const result = Object.freeze({ isError: false, content: resultContent })
    const output = Object.freeze([blocks[0], blocks[1], Object.freeze({ type: 'text', text: '[pruned]' }), blocks[3], blocks[4], blocks[5]])
    const toolLookups = []
    let pruneCalls = 0
    const tools = {
      get(toolName, scope) {
        toolLookups.push([toolName, scope])
        return { name: toolName, projectContent: undefined, finalizeContent: undefined }
      },
    }
    const pruner = {
      pruneContent(content) {
        assert.strictEqual(this, pruner, 'the Host pruner receiver is retained')
        pruneCalls += 1
        assert.strictEqual(content, blocks, 'decision.content, not result.content, is passed by identity')
        assert.deepEqual(content.map(block => block.type), ['text', 'image', 'text', 'audio', 'resource', 'text'])
        return output
      },
    }
    const pruning = createSearchToolResultPruningListener(tools, pruner)
    let nextCalls = 0
    const returned = await pruning.listener(makeExec({ name }), result, async () => {
      nextCalls += 1
      return decision
    })

    assert.equal(nextCalls, 1)
    assert.equal(pruneCalls, 1)
    assert.deepEqual(toolLookups, [[name, caller]])
    assert.notStrictEqual(returned, decision)
    assert.equal(returned.kind, decision.kind)
    assert.strictEqual(returned.content, output)
    assert.deepEqual(returned.content.map(block => block.type), ['text', 'image', 'text', 'audio', 'resource', 'text'])
    assert.equal(returned.content[2].text, '[pruned]')
    assert.strictEqual(returned.content[0], blocks[0])
    assert.strictEqual(returned.content[1], blocks[1])
    assert.strictEqual(returned.content[3], blocks[3])
    assert.strictEqual(returned.content[4], blocks[4])
    assert.strictEqual(returned.content[5], blocks[5])
    assert.strictEqual(returned.additionalContexts, additionalContexts)
    assert.strictEqual(returned.additionalContexts[0], priorContext)
    assert.equal(returned.marker, decision.marker)
    assert.strictEqual(decision.content, blocks)
    assert.strictEqual(result.content, resultContent)
    assert.deepEqual(blocks.map(block => block.type), ['text', 'image', 'text', 'audio', 'resource', 'text'])
    pruning.dispose()
  }
})

test('uses only the exact case-sensitive grep/glob/web_fetch allowlist and direct dispatches', async () => {
  for (const name of ['Grep', 'Glob', 'grep_extra', 'glob ', 'websearch', 'webfetch', 'WebFetch', 'web_fetch_extra']) {
    let lookups = 0
    const pruning = await assertSkipped({
      exec: makeExec({ name }),
      tools: makeTools(() => { lookups += 1; return { name } }),
    })
    assert.equal(lookups, 0)
    pruning.dispose()
  }

  for (const parent of [{ id: 'parent' }, null]) {
    let lookups = 0
    const pruning = await assertSkipped({
      exec: makeExec({ parent }),
      tools: makeTools(() => { lookups += 1; return { name: 'grep' } }),
    })
    assert.equal(lookups, 0)
    pruning.dispose()
  }
})

test('skips missing Agent/signal, abort, Tool errors, and non-accept decisions', async () => {
  const controller = new AbortController()
  controller.abort()
  const cases = [
    { exec: makeExec({ agent: undefined }) },
    { exec: makeExec({ agent: null }) },
    { exec: makeExec({ agent: 1 }) },
    { exec: makeExec({ signal: undefined }) },
    { exec: makeExec({ signal: {} }) },
    { exec: makeExec({ signal: controller.signal }) },
    { result: makeResult({ isError: true }) },
    { decision: { kind: 'block', feedback: [] } },
    { decision: { kind: 'accept', value: { ok: true } } },
    { decision: { kind: 'accept', value: null } },
    { decision: { kind: 'accept', content: [{ type: 'text', text: 'also has value' }], value: undefined } },
    { decision: { kind: 'accept', content: [{ type: 'text', text: 'also has value' }], value: null } },
    { decision: Object.assign(Object.create({ value: undefined }), { kind: 'accept', content: [] }) },
    { decision: { kind: 'accept' } },
    { decision: { kind: 'accept', content: 'not-an-array' } },
  ]

  for (const options of cases) {
    let lookups = 0
    const pruning = await assertSkipped({
      ...options,
      tools: makeTools(() => { lookups += 1; return { name: 'grep' } }),
    })
    assert.equal(lookups, 0)
    pruning.dispose()
  }
})

test('does not fall back to result.content when downstream content is missing or malformed', async () => {
  for (const content of [undefined, null, 'not-an-array']) {
    const decision = content === undefined ? { kind: 'accept' } : { kind: 'accept', content }
    let lookups = 0
    const pruning = await assertSkipped({
      decision,
      result: makeResult({ content: [{ type: 'text', text: 'result content must not be used' }] }),
      tools: makeTools(() => { lookups += 1; return { name: 'grep' } }),
    })
    assert.equal(lookups, 0)
    pruning.dispose()
  }
})

test('fails open for missing/mismatched definitions and definition-owned content callbacks', async () => {
  const definitions = [
    undefined,
    null,
    { name: 'glob' },
    { name: 'grep', projectContent() {} },
    { name: 'grep', finalizeContent() {} },
    { name: 'grep', projectContent: null },
    { name: 'grep', finalizeContent: null },
  ]

  for (const definition of definitions) {
    let pruneCalls = 0
    let getCalls = 0
    const tools = {
      get(name, scope) {
        getCalls += 1
        assert.equal(name, 'grep')
        assert.strictEqual(scope, caller)
        return definition
      },
    }
    const pruning = await assertSkipped({
      tools,
      pruner: { pruneContent() { pruneCalls += 1; return [] } },
    })
    assert.equal(getCalls, 1)
    assert.equal(pruneCalls, 0)
    pruning.dispose()
  }
})

test('null, non-array, and throwing Host pruner results preserve the exact decision', async () => {
  for (const pruneContent of [() => null, () => undefined, () => 'not-an-array', () => { throw new Error('private pruner failure') }]) {
    const pruning = await assertSkipped({
      pruner: { pruneContent },
      tools: makeTools(() => ({ name: 'grep' })),
      expectedPruneCalls: 1,
    })
    pruning.dispose()
  }
  const missingMethod = await assertSkipped({
    pruner: {},
    tools: makeTools(() => ({ name: 'grep' })),
    expectedPruneCalls: 1,
  })
  missingMethod.dispose()
})

test('cancellation and disposal during pruning fence returned arrays', async () => {
  for (const fence of ['abort', 'dispose']) {
    const controller = new AbortController()
    const signal = controller.signal
    let pruning
    const decision = makeDecision()
    const pruner = {
      pruneContent() {
        if (fence === 'abort') controller.abort()
        else pruning.dispose()
        return [{ type: 'text', text: 'must not escape' }]
      },
    }
    pruning = createSearchToolResultPruningListener(makeTools(() => ({ name: 'grep' })), pruner)
    let nextCalls = 0
    const returned = await pruning.listener(makeExec({ signal }), makeResult(), async () => {
      nextCalls += 1
      return decision
    })
    assert.equal(nextCalls, 1)
    assert.strictEqual(returned, decision)
  }
})

test('disposal before execution still calls next exactly once and skips lookup/pruning', async () => {
  let lookups = 0
  let pruneCalls = 0
  const pruning = createSearchToolResultPruningListener(
    makeTools(() => { lookups += 1; return { name: 'grep' } }),
    { pruneContent() { pruneCalls += 1; return [] } },
  )
  pruning.dispose()
  const decision = makeDecision()
  let nextCalls = 0
  const returned = await pruning.listener(makeExec(), makeResult(), async () => {
    nextCalls += 1
    return decision
  })
  assert.equal(nextCalls, 1)
  assert.equal(lookups, 0)
  assert.equal(pruneCalls, 0)
  assert.strictEqual(returned, decision)
})

test('malformed getters and service failures fail open to the exact downstream decision', async () => {
  const decision = makeDecision()
  const badExec = Object.defineProperty(makeExec(), 'name', { get() { throw new Error('private exec getter') } })
  const badDecision = Object.defineProperty({ kind: 'accept' }, 'content', { get() { throw new Error('private decision getter') } })
  const badResult = Object.defineProperty({}, 'isError', { get() { throw new Error('private result getter') } })
  const badSignal = Object.defineProperty({}, 'aborted', { get() { throw new Error('private signal getter') } })
  const cases = [
    { exec: badExec },
    { decision: badDecision },
    { result: badResult },
    { exec: makeExec({ signal: badSignal }) },
    { tools: {} },
    { tools: { get() { throw new Error('private tools service failure') } } },
    { tools: makeTools(() => Object.defineProperty({ name: 'grep' }, 'finalizeContent', { get() { throw new Error('private definition getter') } })) },
    { pruner: Object.defineProperty({}, 'pruneContent', { get() { throw new Error('private pruner getter') } }) },
  ]

  for (const options of cases) {
    let nextCalls = 0
    const pruning = createSearchToolResultPruningListener(
      options.tools ?? makeTools(() => ({ name: 'grep' })),
      options.pruner ?? makePruner(),
    )
    const returned = await pruning.listener(options.exec ?? makeExec(), options.result ?? makeResult(), async () => {
      nextCalls += 1
      return options.decision ?? decision
    })
    assert.equal(nextCalls, 1)
    assert.strictEqual(returned, options.decision ?? decision)
    pruning.dispose()
  }
})

test('does not catch or rewrite errors thrown by next', async () => {
  const error = new Error('downstream failure')
  const pruning = createSearchToolResultPruningListener(makeTools(), makePruner())
  let nextCalls = 0
  await assert.rejects(
    pruning.listener(makeExec(), makeResult(), async () => {
      nextCalls += 1
      throw error
    }),
    caught => caught === error,
  )
  assert.equal(nextCalls, 1)
  pruning.dispose()
})
