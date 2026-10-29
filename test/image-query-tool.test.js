import assert from 'node:assert/strict'
import test from 'node:test'
import { createImageQueryTool, registerImageQueryTool } from '../src/image-query-tool.js'

const route = { provider: 'vision-provider', model: 'vision-model' }
const signal = new AbortController().signal
const testAgents = new Map()

function agentFor(id = 'agent-1') {
  if (!testAgents.has(id)) testAgents.set(id, { id })
  return testAgents.get(id)
}

function imageBlock(id = 'image-1', overrides = {}) {
  return {
    type: 'image',
    attachment: {
      attachmentId: id,
      mediaType: 'image/png',
      bytes: 1024,
      width: 320,
      height: 240,
      ...overrides,
    },
  }
}

function userMessage(content, source = { kind: 'user' }) {
  return { role: 'user', source, content }
}

function makeLlm(options = {}) {
  const preparations = []
  const requests = []
  const llm = {
    prepareCall: async (config, callSignal) => {
      preparations.push({ config, signal: callSignal })
      if (options.prepareError) throw new Error('private provider detail')
      return {
        config: { ...config },
        ...(options.omitModalities ? {} : { inputModalities: options.modalities ?? ['text', 'image'] }),
        stream: request => {
          requests.push(request)
          if (options.streamError) throw new Error('private stream detail')
          return (async function* streamChunks() {
            if (options.chunks) {
              yield* options.chunks
              return
            }
            yield { type: 'text-delta', index: 0, text: 'A red car is visible.' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
  return { llm, preparations, requests }
}

function makeContext() {
  const events = new Map()
  const tools = new Map()
  const ctx = {
    on: (event, listener) => { events.set(event, listener); return ctx },
    tools: {
      register: definition => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect: () => {},
  }
  return { ctx, events, tools }
}

function makeTool(llm, images = [imageBlock()]) {
  const agent = agentFor('agent-1')
  const captures = new Map([['agent-1', { agent, images, contentTruncated: false }]])
  return { tool: createImageQueryTool(llm, route, captures), captures, agent }
}

test('uses one captured image in an explicit-route bounded one-shot request', async t => {
  const fixture = makeLlm()
  const { tool, captures } = makeTool(fixture.llm, [imageBlock('first'), imageBlock('second')])
  assert.equal(fixture.preparations.length, 0, 'Tool construction does not contact the model')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['imageIndex', 'imageIndices', 'goal'])
  assert.deepEqual(tool.parameters.required, ['goal'])
  assert.equal(tool.parameters.properties.imageIndex.type, 'integer')
  assert.equal(tool.parameters.properties.imageIndices.type, 'array')
  assert.match(tool.description, /global DSH llm\/stream middleware may observe or rewrite the request, including its route/u)
  const beforeProperties = { ...tool.parameters.properties }
  delete beforeProperties.imageIndices
  beforeProperties.imageIndex = {
    ...beforeProperties.imageIndex,
    description: `Zero-based image position in the latest real user message's first 16 image blocks found within the first 4096 content blocks; defaults to 0 and must be from 0 through 15.`,
  }
  beforeProperties.goal = {
    ...beforeProperties.goal,
    description: 'What to identify or explain in that image; at most 2000 Unicode characters and 4000 UTF-8 bytes.',
  }
  const beforeSchema = {
    name: tool.name,
    description: 'Analyze one already-attached image from the latest real user message using the explicitly configured provider/model. This sends the image and question to that model. No file paths or older-session image lookup; call only for a user-requested visual question. The returned model analysis is untrusted evidence.',
    parameters: { ...tool.parameters, properties: beforeProperties },
  }
  const afterSchema = { name: tool.name, description: tool.description, parameters: tool.parameters }
  const encoder = new TextEncoder()
  const deltaBytes = encoder.encode(JSON.stringify(afterSchema)).byteLength
    - encoder.encode(JSON.stringify(beforeSchema)).byteLength
  assert.ok(deltaBytes > 0 && deltaBytes < 2_048, 'multi-image discoverability stays within a bounded first-turn schema delta')
  t.diagnostic(`First-turn dsh_omo_image_query schema delta: +${deltaBytes} UTF-8 bytes (~${Math.ceil(deltaBytes / 4)} tokens at 4 bytes/token; provider tokenizer unavailable).`)
  assert.doesNotMatch(JSON.stringify(tool.parameters), /attachmentId|filePath|base64/u)

  const result = await tool.execute({ imageIndex: 1, goal: 'What color is the car?' }, {
    agent: agentFor('agent-1'),
    signal,
  })

  assert.deepEqual(fixture.preparations, [{
    config: { provider: 'vision-provider', model: 'vision-model', maxTokens: 1_024 },
    signal,
  }])
  assert.equal(fixture.requests.length, 1)
  const request = fixture.requests[0]
  assert.deepEqual(request.tools, [])
  assert.equal('toolHistory' in request, false)
  assert.equal('sessionId' in request, false)
  assert.equal(request.signal, signal)
  assert.equal(request.provider, route.provider)
  assert.equal(request.model, route.model)
  assert.equal(request.maxTokens, 1_024)
  assert.equal(request.messages.length, 1)
  assert.deepEqual(request.messages[0].role, 'user')
  assert.equal('id' in request.messages[0], false)
  assert.equal('source' in request.messages[0], false)
  assert.equal(request.messages[0].content.length, 2)
  assert.equal(request.messages[0].content[1].type, 'image')
  assert.equal(request.messages[0].content[1].attachment.attachmentId, 'second')
  assert.equal(result.provider, route.provider)
  assert.equal(result.model, route.model)
  assert.equal(result.imageIndex, 1)
  assert.equal('imageIndices' in result, false, 'legacy single-image output stays unchanged')
  assert.equal(result.analysis, 'A red car is visible.')
  assert.equal(result.truncated, false)
  assert.equal(captures.has('agent-1'), false, 'a capture is consumed once')
  assert.match(tool.output.render({}, result)[0].text, /untrusted evidence/u)
})

test('sends a bounded multi-image selection together in the requested order', async () => {
  const fixture = makeLlm()
  const { tool, captures } = makeTool(fixture.llm, [
    imageBlock('first'), imageBlock('second'), imageBlock('third'), imageBlock('fourth'),
  ])

  const result = await tool.execute({ imageIndices: [2, 0, 3], goal: 'Compare their visible colors.' }, {
    agent: agentFor('agent-1'),
    signal,
  })

  assert.equal(fixture.preparations.length, 1, 'multi-image analysis remains one explicit-route call')
  assert.equal(fixture.requests.length, 1)
  const request = fixture.requests[0]
  assert.deepEqual(request.tools, [])
  assert.equal('toolHistory' in request, false)
  assert.equal('sessionId' in request, false)
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].content.length, 4)
  assert.match(request.messages[0].content[0].text, /zero-based positions 2, 0, 3 in that order/u)
  assert.deepEqual(request.messages[0].content.slice(1).map(image => image.attachment.attachmentId), [
    'third', 'first', 'fourth',
  ])
  assert.equal(result.imageIndex, 2, 'the legacy result field identifies the first selected image')
  assert.deepEqual(result.imageIndices, [2, 0, 3])
  assert.equal(captures.has('agent-1'), false, 'one multi-image request consumes one capture')
})

test('normalizes shorthand media types to the inspected DSH image union', async () => {
  for (const [alias, canonical] of [
    ['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
  ]) {
    const fixture = makeLlm()
    const { tool } = makeTool(fixture.llm, [imageBlock('alias', { mediaType: alias })])
    await tool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal })
    assert.equal(fixture.requests[0].messages[0].content[1].attachment.mediaType, canonical)
  }
})

test('invalid image selections do not consume a capture before any provider call', async () => {
  const fixture = makeLlm()
  const onlyOneImage = makeTool(fixture.llm, [imageBlock('only')])
  await assert.rejects(onlyOneImage.tool.execute({ imageIndex: 1, goal: 'Describe it.' }, {
    agent: agentFor('agent-1'), signal,
  }), /imageIndex 1 is not present/u)
  assert.equal(onlyOneImage.captures.has('agent-1'), true)
  assert.equal(fixture.preparations.length, 0)

  const malformedThenValid = makeTool(fixture.llm, [
    imageBlock('malformed', { width: 0 }),
    imageBlock('valid'),
  ])
  await assert.rejects(malformedThenValid.tool.execute({ imageIndex: 0, goal: 'Describe it.' }, {
    agent: agentFor('agent-1'), signal,
  }), /unsupported, offloaded, malformed/u)
  assert.equal(malformedThenValid.captures.has('agent-1'), true)
  await malformedThenValid.tool.execute({ imageIndex: 1, goal: 'Describe it.' }, {
    agent: agentFor('agent-1'), signal,
  })
  assert.equal(fixture.requests[0].messages[0].content[1].attachment.attachmentId, 'valid')
})

test('bounds multi-image indices and aggregate bytes/pixels before consuming a capture', async () => {
  const malformedSelections = [
    { args: { imageIndices: [], goal: 'Compare.' }, pattern: /1 through 4 unique/u },
    { args: { imageIndices: [0, 0], goal: 'Compare.' }, pattern: /duplicate indices/u },
    { args: { imageIndices: [0, 1, 2, 3, 4], goal: 'Compare.' }, pattern: /1 through 4 unique/u },
    { args: { imageIndices: [0], imageIndex: 0, goal: 'Compare.' }, pattern: /either imageIndex or imageIndices/u },
    { args: { imageIndices: ['0'], goal: 'Compare.' }, pattern: /must be an integer/u },
    { args: { imageIndices: [16], goal: 'Compare.' }, pattern: /integer from 0 through 15/u },
  ]
  for (const { args, pattern } of malformedSelections) {
    const fixture = makeLlm()
    const { tool, captures } = makeTool(fixture.llm, [imageBlock('first'), imageBlock('second')])
    await assert.rejects(tool.execute(args, { agent: agentFor('agent-1'), signal }), pattern)
    assert.equal(captures.has('agent-1'), true, 'invalid selections preserve the current capture')
    assert.equal(fixture.preparations.length, 0)
    assert.equal(fixture.requests.length, 0)
  }

  const missing = makeTool(makeLlm().llm, [imageBlock('only')])
  await assert.rejects(missing.tool.execute({ imageIndices: [0, 1], goal: 'Compare.' }, {
    agent: agentFor('agent-1'), signal,
  }), /imageIndex 1 is not present/u)
  assert.equal(missing.captures.has('agent-1'), true)

  const byteFixture = makeLlm()
  const overBytes = makeTool(byteFixture.llm, [
    imageBlock('a', { bytes: 6 * 1024 * 1024 }),
    imageBlock('b', { bytes: 6 * 1024 * 1024 }),
    imageBlock('c', { bytes: 6 * 1024 * 1024 }),
  ])
  await assert.rejects(overBytes.tool.execute({ imageIndices: [0, 1, 2], goal: 'Compare.' }, {
    agent: agentFor('agent-1'), signal,
  }), /combined 16 MiB or 64 megapixel limit/u)
  assert.equal(overBytes.captures.has('agent-1'), true)
  assert.equal(byteFixture.preparations.length, 0)

  const pixelFixture = makeLlm()
  const overPixels = makeTool(pixelFixture.llm, [
    imageBlock('a', { width: 5_000, height: 4_500 }),
    imageBlock('b', { width: 5_000, height: 4_500 }),
    imageBlock('c', { width: 5_000, height: 4_500 }),
  ])
  await assert.rejects(overPixels.tool.execute({ imageIndices: [0, 1, 2], goal: 'Compare.' }, {
    agent: agentFor('agent-1'), signal,
  }), /combined 16 MiB or 64 megapixel limit/u)
  assert.equal(overPixels.captures.has('agent-1'), true)
  assert.equal(pixelFixture.preparations.length, 0)
})

test('accepts the inclusive combined image-byte and pixel limits', async () => {
  const fixture = makeLlm()
  const { tool } = makeTool(fixture.llm, [
    imageBlock('a', { bytes: 8 * 1024 * 1024, width: 8_000, height: 4_000 }),
    imageBlock('b', { bytes: 8 * 1024 * 1024, width: 8_000, height: 4_000 }),
  ])
  const result = await tool.execute({ imageIndices: [0, 1], goal: 'Compare.' }, {
    agent: agentFor('agent-1'), signal,
  })
  assert.deepEqual(result.imageIndices, [0, 1])
  assert.equal(fixture.requests.length, 1)
})

test('does not retry or fall back when the selected provider rejects multiple images', async () => {
  const fixture = makeLlm({ streamError: true })
  const { tool } = makeTool(fixture.llm, [imageBlock('first'), imageBlock('second')])
  await assert.rejects(tool.execute({ imageIndices: [0, 1], goal: 'Compare them.' }, {
    agent: agentFor('agent-1'), signal,
  }), /configured image-query request failed/u)
  assert.equal(fixture.preparations.length, 1)
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].provider, route.provider)
  assert.equal(fixture.requests[0].model, route.model)
})

test('captures only the last real user message after downstream pre-step listeners', async () => {
  const fixture = makeLlm()
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route)
  const listener = events.get('agent/pre-step')
  const decision = {
    kind: 'enter',
    startsRequestSeries: true,
    messages: [
      userMessage([imageBlock('older')]),
      userMessage([imageBlock('current-0'), imageBlock('current-1')]),
    ],
  }
  const returned = await listener({ agent: agentFor('agent-1'), turn: 2, step: 0 }, async () => decision)
  assert.equal(returned, decision, 'the listener preserves the downstream decision object')
  assert.equal(returned.startsRequestSeries, true)

  const result = await tools.get('dsh_omo_image_query').execute({ imageIndices: [1, 0], goal: 'Compare the two signs.' }, {
    agent: agentFor('agent-1'),
    signal,
  })
  assert.equal(result.analysis, 'A red car is visible.')
  assert.deepEqual(result.imageIndices, [1, 0])
  assert.deepEqual(fixture.requests[0].messages[0].content.slice(1).map(image => image.attachment.attachmentId), [
    'current-1', 'current-0',
  ])
  dispose()
  assert.equal(tools.has('dsh_omo_image_query'), false)
})

test('newer pre-step capture wins when downstream waterfall completions arrive out of order', async () => {
  const fixture = makeLlm()
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route)
  const listener = events.get('agent/pre-step')
  const tool = tools.get('dsh_omo_image_query')
  const agent = { id: 'agent-race' }
  let resolveOlder
  let resolveNewer

  const older = listener({ agent, turn: 1, step: 0 }, () => new Promise(resolve => { resolveOlder = resolve }))
  const newer = listener({ agent, turn: 2, step: 0 }, () => new Promise(resolve => { resolveNewer = resolve }))
  resolveNewer({ kind: 'enter', messages: [userMessage([imageBlock('newer')])] })
  await newer
  resolveOlder({ kind: 'enter', messages: [userMessage([imageBlock('older')])] })
  await older

  await tool.execute({ goal: 'Describe it.' }, { agent, signal })
  assert.equal(fixture.requests[0].messages[0].content[1].attachment.attachmentId, 'newer')
  dispose()
})

test('bounds image capture work and temporary references for large message bodies', async () => {
  const fixture = makeLlm()
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route)
  const listener = events.get('agent/pre-step')
  const tool = tools.get('dsh_omo_image_query')
  const agent = { id: 'agent-large' }
  const manyImages = new Array(100_000).fill(imageBlock('bulk'))
  let imageBlockReads = 0
  const instrumentedImages = new Proxy(manyImages, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/u.test(property)) imageBlockReads += 1
      return Reflect.get(target, property, receiver)
    },
  })

  await listener({ agent }, async () => ({ kind: 'enter', messages: [userMessage(instrumentedImages)] }))
  assert.equal(imageBlockReads, 17, 'the scanner stops after the 17th image block')
  await assert.rejects(tool.execute({ imageIndex: 16, goal: 'Describe it.' }, { agent, signal }), /imageIndex must be an integer from 0 through 15/u)
  await tool.execute({ imageIndex: 15, goal: 'Describe it.' }, { agent, signal })
  assert.equal(fixture.requests[0].messages[0].content[1].attachment.attachmentId, 'bulk')

  const textBlocks = new Array(4_097).fill({ type: 'text', text: 'bounded' })
  textBlocks[4_096] = imageBlock('outside-scan')
  const guardedBlocks = new Proxy(textBlocks, {
    get(target, property, receiver) {
      if (property === '4096') throw new Error('read beyond block scan bound')
      return Reflect.get(target, property, receiver)
    },
  })
  await listener({ agent }, async () => ({ kind: 'enter', messages: [userMessage(guardedBlocks)] }))
  await assert.rejects(tool.execute({ goal: 'Describe it.' }, { agent, signal }), /No image was found within the first 4096 content blocks/u)
  assert.equal(fixture.requests.length, 1, 'oversized content never reaches the provider')
  dispose()
})

test('fails closed for non-user provenance, absent images, and non-entered steps', async () => {
  const fixture = makeLlm()
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route)
  const listener = events.get('agent/pre-step')
  const tool = tools.get('dsh_omo_image_query')
  const exec = { agent: agentFor('agent-1'), signal }

  await listener({ agent: exec.agent }, async () => ({
    kind: 'enter',
    messages: [userMessage([imageBlock()], { kind: 'agent-relay' })],
  }))
  await assert.rejects(tool.execute({ goal: 'Analyze it.' }, exec), /No image from the latest real user message/u)

  await listener({ agent: exec.agent }, async () => ({
    kind: 'enter',
    messages: [userMessage([{ type: 'text', text: 'No image here.' }])],
  }))
  await assert.rejects(tool.execute({ goal: 'Analyze it.' }, exec), /No image from the latest real user message/u)

  await listener({ agent: exec.agent }, async () => ({
    kind: 'enter',
    messages: [userMessage([imageBlock()], {})],
  }))
  await assert.rejects(tool.execute({ goal: 'Analyze it.' }, exec), /No image from the latest real user message/u)

  await listener({ agent: exec.agent }, async () => ({ kind: 'reject' }))
  await assert.rejects(tool.execute({ goal: 'Analyze it.' }, exec), /No image from the latest real user message/u)
  assert.equal(fixture.preparations.length, 0)
  dispose()
})

test('isolates current image captures by Agent and consumes them exactly once', async () => {
  const fixture = makeLlm()
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route)
  const listener = events.get('agent/pre-step')
  const tool = tools.get('dsh_omo_image_query')
  const agentA = { id: 'agent-a' }
  const agentB = { id: 'agent-b' }
  await listener({ agent: agentA }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('a')])] }))
  await listener({ agent: agentB }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('b')])] }))

  await tool.execute({ goal: 'Describe it.' }, { agent: agentB, signal })
  await assert.rejects(tool.execute({ goal: 'Describe it.' }, { agent: agentB, signal }), /No image from the latest real user message/u)
  await tool.execute({ goal: 'Describe it.' }, { agent: agentA, signal })
  assert.deepEqual(fixture.requests.map(request => request.messages[0].content[1].attachment.attachmentId), ['b', 'a'])
  dispose()
})

test('same-ID replacement owns its image capture and survives stale execution and disposal', async () => {
  const fixture = makeLlm()
  const liveAgents = new Map()
  const agents = { get: id => liveAgents.get(id) }
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route, { agents })
  const listener = events.get('agent/pre-step')
  const disposedListener = events.get('agent/disposed')
  const tool = tools.get('dsh_omo_image_query')
  const id = 'reused-image-agent'
  const oldAgent = { id }
  const replacement = { id }
  liveAgents.set(id, oldAgent)
  await listener({ agent: oldAgent }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('old-image')])] }))

  liveAgents.set(id, replacement)
  await listener({ agent: replacement }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('replacement-image')])] }))
  await assert.rejects(tool.execute({ goal: 'Describe it.' }, { agent: oldAgent, signal }), /current DSH Agent/u)
  assert.equal(fixture.preparations.length, 0, 'stale same-ID execution is rejected before model preparation')

  disposedListener({ agent: oldAgent })
  await tool.execute({ goal: 'Describe it.' }, { agent: replacement, signal })
  assert.equal(fixture.requests[0].messages[0].content[1].attachment.attachmentId, 'replacement-image')
  dispose()
})

test('late pre-step completion from a displaced same-ID Agent cannot overwrite its replacement', async () => {
  const fixture = makeLlm()
  const liveAgents = new Map()
  const agents = { get: id => liveAgents.get(id) }
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route, { agents })
  const listener = events.get('agent/pre-step')
  const tool = tools.get('dsh_omo_image_query')
  const id = 'delayed-image-agent'
  const oldAgent = { id }
  const replacement = { id }
  liveAgents.set(id, oldAgent)
  let resolveOld
  const oldStep = listener({ agent: oldAgent }, () => new Promise(resolve => { resolveOld = resolve }))

  liveAgents.set(id, replacement)
  await listener({ agent: replacement }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('replacement-image')])] }))
  resolveOld({ kind: 'enter', messages: [userMessage([imageBlock('late-old-image')])] })
  await oldStep

  await tool.execute({ goal: 'Describe it.' }, { agent: replacement, signal })
  assert.equal(fixture.requests[0].messages[0].content[1].attachment.attachmentId, 'replacement-image')
  dispose()
})

test('without agents.get, a conflicting same-ID capture waits for exact disposal', async () => {
  const fixture = makeLlm()
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route)
  const listener = events.get('agent/pre-step')
  const disposedListener = events.get('agent/disposed')
  const tool = tools.get('dsh_omo_image_query')
  const id = 'unverified-image-agent'
  const oldAgent = { id }
  const replacement = { id }
  await listener({ agent: oldAgent }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('old-image')])] }))
  await listener({ agent: replacement }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('replacement-image')])] }))
  await assert.rejects(tool.execute({ goal: 'Describe it.' }, { agent: replacement, signal }), /No image from the latest real user message/u)
  await tool.execute({ goal: 'Describe it.' }, { agent: oldAgent, signal })
  assert.equal(fixture.requests[0].messages[0].content[1].attachment.attachmentId, 'old-image')

  disposedListener({ agent: oldAgent })
  await listener({ agent: replacement }, async () => ({ kind: 'enter', messages: [userMessage([imageBlock('replacement-image')])] }))
  await tool.execute({ goal: 'Describe it.' }, { agent: replacement, signal })
  assert.equal(fixture.requests[1].messages[0].content[1].attachment.attachmentId, 'replacement-image')
  dispose()
})

test('requires explicit image modality and does not dispatch when it is unknown or absent', async () => {
  for (const options of [{ omitModalities: true }, { modalities: ['text'] }]) {
    const fixture = makeLlm(options)
    const { tool } = makeTool(fixture.llm)
    await assert.rejects(tool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /does not explicitly advertise image input/u)
    assert.equal(fixture.requests.length, 0)
  }
})

test('uses bounded output and marks model or character-limit truncation', async () => {
  const fixture = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: 'x'.repeat(6_100) },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ] })
  const { tool } = makeTool(fixture.llm)
  const result = await tool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal })
  assert.equal(Array.from(result.analysis).length, 6_000)
  assert.equal(result.truncated, true)
})

test('handles block-end-only text and rejects unsupported tool calls or failed streams', async () => {
  const blockOnly = makeLlm({ chunks: [
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Fallback text.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const { tool: blockTool } = makeTool(blockOnly.llm)
  assert.equal((await blockTool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal })).analysis, 'Fallback text.')

  const toolCalls = makeLlm({ chunks: [{ type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '{}' }] })
  const { tool: toolCallTool } = makeTool(toolCalls.llm)
  await assert.rejects(toolCallTool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /unsupported tool call/u)

  const failed = makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { kind: 'provider', message: 'secret' } } }] })
  const { tool: failedTool } = makeTool(failed.llm)
  await assert.rejects(failedTool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /request failed/u)
})

test('bounds inputs, rejects offloaded or malformed attachments, and requires a live Agent signal', async () => {
  const fixture = makeLlm()
  const offloaded = makeTool(fixture.llm, [imageBlock('offloaded')])
  offloaded.captures.set('agent-1', { agent: agentFor('agent-1'), images: [{ ...imageBlock('offloaded'), offloaded: true }], contentTruncated: false })
  await assert.rejects(offloaded.tool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /unsupported, offloaded, malformed/u)
  assert.equal(offloaded.captures.has('agent-1'), true, 'a rejected image is not consumed before a provider call')

  const oversized = makeTool(fixture.llm, [imageBlock('large', { bytes: 8 * 1024 * 1024 + 1 })])
  await assert.rejects(oversized.tool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /unsupported, offloaded, malformed/u)
  const unsupportedMedia = makeTool(fixture.llm, [imageBlock('unknown', { mediaType: 'image/tiff' })])
  await assert.rejects(unsupportedMedia.tool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /unsupported, offloaded, malformed/u)
  assert.equal(unsupportedMedia.captures.has('agent-1'), true)

  const ordinary = makeTool(fixture.llm)
  await assert.rejects(ordinary.tool.execute({ goal: 'x'.repeat(2_001) }, { agent: agentFor('agent-1'), signal }), /goal must be/u)
  await assert.rejects(ordinary.tool.execute({ goal: 'Describe it.' }, { signal }), /current DSH Agent/u)
  await assert.rejects(ordinary.tool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1') }), /AbortSignal/u)
  assert.equal(fixture.preparations.length, 0)
})

test('redacts preparation and stream errors, and propagates cancellation', async () => {
  const prepareError = makeLlm({ prepareError: true })
  const { tool: preparationTool } = makeTool(prepareError.llm)
  await assert.rejects(preparationTool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /Could not prepare/u)
  assert.doesNotMatch((await preparationTool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }).catch(error => error.message)), /private provider detail/u)

  const streamError = makeLlm({ streamError: true })
  const { tool: streamTool } = makeTool(streamError.llm)
  await assert.rejects(streamTool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal }), /request failed/u)

  const abortedController = new AbortController()
  abortedController.abort()
  const aborted = makeLlm()
  const { tool: abortedTool } = makeTool(aborted.llm)
  await assert.rejects(abortedTool.execute({ goal: 'Describe it.' }, { agent: agentFor('agent-1'), signal: abortedController.signal }), /cancelled/u)
  assert.equal(aborted.preparations.length, 0)
})

test('registration validates optional services and disposal stops capture and unregisters the Tool', async () => {
  assert.throws(() => registerImageQueryTool({}, makeLlm().llm, route), /ctx.on/u)
  assert.throws(() => registerImageQueryTool({ on() {}, tools: { register() {} } }, makeLlm().llm, route), /ctx.effect/u)
  assert.throws(() => registerImageQueryTool({ on() {}, effect() {}, tools: { register() {} } }, {}, route), /llm.prepareCall/u)
  const noDisposer = makeContext()
  noDisposer.ctx.tools.register = () => undefined
  assert.throws(() => registerImageQueryTool(noDisposer.ctx, makeLlm().llm, route), /did not return a disposer/u)
  assert.throws(() => createImageQueryTool(makeLlm().llm, {}, new Map()), /imageQueryRoute/u)

  const fixture = makeLlm()
  const { ctx, events, tools } = makeContext()
  const dispose = registerImageQueryTool(ctx, fixture.llm, route)
  const listener = events.get('agent/pre-step')
  const disposedListener = events.get('agent/disposed')
  assert.equal(typeof disposedListener, 'function')
  await listener({ agent: agentFor('agent-1') }, async () => ({
    kind: 'enter',
    messages: [userMessage([imageBlock()])],
  }))
  disposedListener({ agent: agentFor('agent-1') })
  await assert.rejects(tools.get('dsh_omo_image_query').execute({ goal: 'Analyze it.' }, {
    agent: agentFor('agent-1'),
    signal,
  }), /current DSH Agent/u)

  dispose()
  await listener({ agent: agentFor('agent-1') }, async () => ({
    kind: 'enter',
    messages: [userMessage([imageBlock()])],
  }))
  assert.equal(tools.has('dsh_omo_image_query'), false)
  assert.equal(fixture.preparations.length, 0)
})
