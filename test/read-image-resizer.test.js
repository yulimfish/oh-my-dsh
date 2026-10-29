import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createReadImageResizingListener,
} from '../src/read-image-resizer.js'

const IMAGE_BYTES = 6 * 1024 * 1024
const DERIVED_BYTES = 1024 * 1024
const sourceRef = Object.freeze({
  attachmentId: 'source-image',
  mediaType: 'image/png',
  bytes: IMAGE_BYTES,
  width: 3_000,
  height: 2_000,
  name: 'diagram.png',
})
const derivedRef = Object.freeze({
  attachmentId: 'derived-image',
  mediaType: 'image/jpeg',
  bytes: DERIVED_BYTES,
  width: 1_568,
  height: 1_045,
  name: 'diagram.png',
  originalDimensions: { width: 3_000, height: 2_000 },
})

function makeResult(content = [{ type: 'image', attachment: sourceRef }, { type: 'text', text: 'diagram' }]) {
  return {
    card: 'read',
    path: '/workspace/diagram.png',
    content,
  }
}

function makeAttachments(options = {}) {
  const calls = { reads: [], saves: [] }
  const attachments = {
    async readImageRequest(ref, target, signal) {
      calls.reads.push({ ref, target, signal })
      if (options.abortDuringRead) options.abortDuringRead()
      if (options.readError) throw new Error('private decode detail')
      return options.variant ?? {
        variantId: 'request-variant',
        attachment: ref,
        data: new Uint8Array(DERIVED_BYTES),
        mediaType: 'image/jpeg',
        bytes: DERIVED_BYTES,
        width: 1_568,
        height: 1_045,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
    async saveImages(inputs) {
      calls.saves.push(inputs)
      options.abortDuringSave?.()
      if (options.saveError) throw new Error('private storage detail')
      return options.saved ?? inputs.map(() => derivedRef)
    },
  }
  return { attachments, calls }
}

async function dispatch(listener, options = {}) {
  const controller = options.controller ?? new AbortController()
  const value = options.value ?? makeResult()
  const decision = options.decision ?? { kind: 'accept', value, additionalContexts: [{ role: 'user', content: [] }] }
  let nextCalls = 0
  const returned = await listener(
    { name: options.name ?? 'read', parent: options.parent, signal: controller.signal },
    { isError: options.isError ?? false, value },
    async () => {
      nextCalls += 1
      return decision
    },
  )
  return { returned, decision, value, controller, nextCalls }
}

test('resizes bounded successful top-level read results through one durable image batch', async () => {
  const { attachments, calls } = makeAttachments()
  const { listener } = createReadImageResizingListener(attachments)
  const input = makeResult()
  const textBlock = input.content[1]
  const downstreamContext = { role: 'user', content: [] }
  const downstreamDecision = { kind: 'accept', value: input, additionalContexts: [downstreamContext], trace: 'preserve-me' }
  const { returned, decision, value, nextCalls, controller } = await dispatch(listener, { value: input, decision: downstreamDecision })

  assert.equal(nextCalls, 1)
  assert.notEqual(returned, decision)
  assert.equal(returned.kind, 'accept')
  assert.equal(returned.trace, 'preserve-me')
  assert.deepEqual(returned.additionalContexts[0], downstreamContext)
  assert.equal(returned.additionalContexts.length, 2)
  assert.equal(returned.additionalContexts[1].content[0].text, 'Image dimensions (pixels): 1: 3000 × 2000 → 1568 × 1045.')
  assert.notEqual(returned.value, value)
  assert.notEqual(returned.value.content, value.content)
  assert.deepEqual(value.content[0].attachment, sourceRef, 'the original result remains immutable')
  assert.equal(returned.value.content[0].attachment.attachmentId, 'derived-image')
  assert.equal(returned.value.content[0].attachment.mediaType, 'image/jpeg')
  assert.equal(returned.value.content[0].attachment.bytes, DERIVED_BYTES)
  assert.equal(returned.value.content[0].attachment.originalDimensions.width, 3_000)
  assert.equal(returned.value.content[1], textBlock)
  assert.equal(calls.reads.length, 1)
  assert.deepEqual(calls.reads[0].target, { width: 1_568, height: 1_568, maxBytes: 5 * 1024 * 1024 })
  assert.equal(calls.reads[0].signal, controller.signal)
  assert.equal(calls.saves.length, 1)
  assert.equal(calls.saves[0].length, 1)
  assert.equal(calls.saves[0][0].data.byteLength, DERIVED_BYTES)
  assert.equal(calls.saves[0][0].mediaType, 'image/jpeg')
})

test('adds one bounded pixel-dimensions note for small valid images without storage calls', async () => {
  const smallRef = Object.freeze({ ...sourceRef, attachmentId: 'small-image', bytes: 1_024, width: 800, height: 600 })
  const { attachments, calls } = makeAttachments()
  const { listener } = createReadImageResizingListener(attachments)
  const input = makeResult([
    { type: 'image', attachment: smallRef },
    { type: 'image', attachment: smallRef },
  ])
  const { returned, decision, value, nextCalls } = await dispatch(listener, { value: input })

  assert.equal(nextCalls, 1)
  assert.notEqual(returned, decision)
  assert.equal(returned.value, value, 'the read result remains unchanged when no resize is needed')
  assert.equal(returned.additionalContexts.length, 2, 'repeated attachment IDs produce one note entry')
  assert.equal(returned.additionalContexts[1].content[0].text, 'Image dimensions (pixels): 1: 800 × 600.')
  assert.equal(calls.reads.length, 0)
  assert.equal(calls.saves.length, 0)
  assert.deepEqual(input.content[0].attachment, smallRef, 'the input attachment is not mutated')
})

test('leaves non-read, nested, failed, and content-only outcomes unchanged', async t => {
  for (const scenario of [
    { name: 'write', label: 'non-read Tool' },
    { name: 'read', parent: { name: 'run_code' }, label: 'nested read' },
    { name: 'read', isError: true, label: 'failed read' },
    { name: 'read', decision: { kind: 'accept', content: [{ type: 'text', text: 'already finalized' }] }, label: 'content-only decision' },
    { name: 'read', decision: { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }, label: 'blocked decision' },
  ]) {
    await t.test(scenario.label, async () => {
      const { attachments, calls } = makeAttachments()
      const { listener } = createReadImageResizingListener(attachments)
      const { returned, decision, nextCalls } = await dispatch(listener, scenario)
      assert.equal(returned, decision)
      assert.equal(nextCalls, 1)
      assert.equal(calls.reads.length, 0)
      assert.equal(calls.saves.length, 0)
    })
  }
})

test('fails open when image reading or durable batch save fails', async t => {
  for (const option of [{ readError: true, label: 'request variant failure' }, { saveError: true, label: 'batch commit failure' }]) {
    await t.test(option.label, async () => {
      const { attachments, calls } = makeAttachments(option)
      const { listener } = createReadImageResizingListener(attachments)
      const { returned, decision } = await dispatch(listener)
      assert.equal(returned, decision)
      assert.equal(calls.reads.length, 1)
      assert.equal(calls.saves.length, option.readError ? 0 : 1)
    })
  }
})

test('rejects oversized or malformed request variants before persisting anything', async t => {
  const cases = [
    {
      label: 'best-effort byte target is not met',
      variant: {
        variantId: 'too-large', attachment: sourceRef, data: new Uint8Array(5 * 1024 * 1024 + 1),
        mediaType: 'image/jpeg', bytes: 5 * 1024 * 1024 + 1, width: 1_568, height: 1_045,
      },
    },
    {
      label: 'metadata does not match the encoded bytes',
      variant: {
        variantId: 'bad-size', attachment: sourceRef, data: new Uint8Array(DERIVED_BYTES),
        mediaType: 'image/jpeg', bytes: DERIVED_BYTES - 1, width: 1_568, height: 1_045,
      },
    },
    {
      label: 'aspect ratio changes materially',
      variant: {
        variantId: 'cropped', attachment: sourceRef, data: new Uint8Array(DERIVED_BYTES),
        mediaType: 'image/jpeg', bytes: DERIVED_BYTES, width: 1_568, height: 1_000,
      },
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.label, async () => {
      const { attachments, calls } = makeAttachments(scenario)
      const { listener } = createReadImageResizingListener(attachments)
      const { returned, decision } = await dispatch(listener)
      assert.equal(returned, decision)
      assert.equal(calls.reads.length, 1)
      assert.equal(calls.saves.length, 0)
    })
  }
})

test('does not reference derivatives that Host normalization moves outside the target or aspect ratio', async t => {
  for (const savedRef of [
    { ...derivedRef, bytes: 6 * 1024 * 1024 },
    { ...derivedRef, width: 1_568, height: 900 },
  ]) {
    const { attachments, calls } = makeAttachments({ saved: [savedRef] })
    const { listener } = createReadImageResizingListener(attachments)
    const { returned, decision } = await dispatch(listener)
    assert.equal(returned, decision)
    assert.equal(calls.saves.length, 1, 'saveImages commits before its normalized reference can be checked')
  }
})

test('observes cancellation and plugin disposal before durable storage', async t => {
  await t.test('caller cancels during variant generation', async () => {
    const controller = new AbortController()
    const { attachments, calls } = makeAttachments({ abortDuringRead: () => controller.abort() })
    const { listener } = createReadImageResizingListener(attachments)
    const { returned, decision } = await dispatch(listener, { controller })
    assert.equal(returned, decision)
    assert.equal(calls.reads.length, 1)
    assert.equal(calls.saves.length, 0)
  })

  await t.test('plugin unloads during variant generation', async () => {
    const lifetime = new AbortController()
    const { attachments, calls } = makeAttachments({ abortDuringRead: () => lifetime.abort() })
    const adapter = createReadImageResizingListener(attachments, lifetime.signal)
    const { returned, decision } = await dispatch(adapter.listener)
    assert.equal(returned, decision)
    assert.equal(calls.reads.length, 1)
    assert.equal(calls.saves.length, 0)
    adapter.dispose()
  })

  await t.test('unload during non-cancelable durable save preserves the original result', async () => {
    const lifetime = new AbortController()
    const { attachments, calls } = makeAttachments({ abortDuringSave: () => lifetime.abort() })
    const adapter = createReadImageResizingListener(attachments, lifetime.signal)
    const { returned, decision } = await dispatch(adapter.listener)
    assert.equal(returned, decision)
    assert.equal(calls.saves.length, 1, 'the Host save API has no cancellation parameter')
    adapter.dispose()
  })

  await t.test('caller abort during pending durable save preserves the original result', async () => {
    const controller = new AbortController()
    const { attachments, calls } = makeAttachments()
    let resolveStarted
    let resolveSave
    const started = new Promise(resolve => { resolveStarted = resolve })
    const pendingSave = new Promise(resolve => { resolveSave = resolve })
    attachments.saveImages = async inputs => {
      calls.saves.push(inputs)
      resolveStarted()
      return pendingSave
    }
    const { listener } = createReadImageResizingListener(attachments)
    const pending = dispatch(listener, { controller })
    await started
    controller.abort()
    resolveSave([derivedRef])
    const { returned, decision } = await pending
    assert.equal(returned, decision)
    assert.equal(calls.saves.length, 1, 'the Host save API has no cancellation parameter')
  })
})

test('bounds scanned result size and image count; deduplicates repeated references', async t => {
  await t.test('too many content blocks', async () => {
    const { attachments, calls } = makeAttachments()
    const { listener } = createReadImageResizingListener(attachments)
    const content = Array.from({ length: 257 }, () => ({ type: 'text', text: 'x' }))
    const { returned, decision } = await dispatch(listener, { value: makeResult(content) })
    assert.equal(returned, decision)
    assert.equal(returned.additionalContexts.length, decision.additionalContexts.length)
    assert.equal(calls.reads.length, 0)
    assert.equal(calls.saves.length, 0)
  })

  await t.test('too many image blocks', async () => {
    const { attachments, calls } = makeAttachments()
    const { listener } = createReadImageResizingListener(attachments)
    const content = Array.from({ length: 5 }, (_, index) => ({
      type: 'image',
      attachment: { ...sourceRef, attachmentId: `source-${index}` },
    }))
    const { returned, decision } = await dispatch(listener, { value: makeResult(content) })
    assert.equal(returned, decision)
    assert.equal(returned.additionalContexts.length, decision.additionalContexts.length)
    assert.equal(calls.reads.length, 0)
    assert.equal(calls.saves.length, 0)
  })

  await t.test('malformed and offloaded blocks do not consume the valid-reference limit', async () => {
    const saved = Array.from({ length: 4 }, (_, index) => ({ ...derivedRef, attachmentId: `derived-${index}` }))
    const { attachments, calls } = makeAttachments({ saved })
    const { listener } = createReadImageResizingListener(attachments)
    const content = [
      { type: 'image', offloaded: true, attachment: sourceRef },
      { type: 'image', attachment: { ...sourceRef, attachmentId: 'not-an-image', mediaType: 'text/plain' } },
      ...Array.from({ length: 4 }, (_, index) => ({
        type: 'image',
        attachment: { ...sourceRef, attachmentId: `valid-source-${index}` },
      })),
    ]
    const { returned, decision } = await dispatch(listener, { value: makeResult(content) })
    assert.equal(calls.reads.length, 4)
    assert.equal(calls.saves.length, 1)
    assert.equal(calls.saves[0].length, 4)
    assert.equal(returned.additionalContexts.length, decision.additionalContexts.length, 'malformed/offloaded references do not produce a dimension note')
    assert.deepEqual(returned.value.content.slice(2).map(block => block.attachment.attachmentId), saved.map(ref => ref.attachmentId))
  })

  await t.test('malformed or offloaded references alone preserve the downstream decision without a note', async () => {
    const { attachments, calls } = makeAttachments()
    const { listener } = createReadImageResizingListener(attachments)
    const content = [
      { type: 'image', offloaded: true, attachment: sourceRef },
      { type: 'image', attachment: { ...sourceRef, mediaType: 'text/plain' } },
    ]
    const { returned, decision } = await dispatch(listener, { value: makeResult(content) })
    assert.equal(returned, decision)
    assert.equal(calls.reads.length, 0)
    assert.equal(calls.saves.length, 0)
  })

  await t.test('repeated reference is read and saved once', async () => {
    const { attachments, calls } = makeAttachments()
    const { listener } = createReadImageResizingListener(attachments)
    const content = [
      { type: 'image', attachment: sourceRef },
      { type: 'image', attachment: sourceRef },
    ]
    const { returned } = await dispatch(listener, { value: makeResult(content) })
    assert.equal(calls.reads.length, 1)
    assert.equal(calls.saves.length, 1)
    assert.equal(calls.saves[0].length, 1)
    assert.equal(returned.value.content[0].attachment.attachmentId, 'derived-image')
    assert.equal(returned.additionalContexts.length, 2)
    assert.equal(returned.additionalContexts[1].content[0].text, 'Image dimensions (pixels): 1: 3000 × 2000 → 1568 × 1045.')
    assert.equal(returned.value.content[1].attachment.attachmentId, 'derived-image')
  })
})

test('requires attachment request and durable-save capabilities', () => {
  assert.throws(() => createReadImageResizingListener(undefined), /requires attachments/u)
  assert.throws(() => createReadImageResizingListener({ saveImages() {} }), /requires attachments/u)
})
