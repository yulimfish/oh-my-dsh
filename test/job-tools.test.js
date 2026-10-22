import assert from 'node:assert/strict'
import test from 'node:test'
import { createJobFollowTool, createJobListTool, registerJobTools } from '../src/job-tools.js'

const SESSION_ID = 'session-current'
const OTHER_SESSION_ID = 'session-other'
const OUTPUT_LIMIT_BYTES = 16 * 1024
const MAX_FOLLOW_FRAMES = 32
const PRIVATE_DETAIL = 'private-job-detail-must-not-escape'
const PRIVATE_SPILL = '/private/job-output/spill.log'

function jobView(overrides = {}) {
  const base = {
    id: 'job-1',
    kind: 'shell',
    label: 'build package',
    owner: SESSION_ID,
    outputLimitBytes: 32 * 1024,
    status: 'running',
    progress: 'running tests',
    detail: PRIVATE_DETAIL,
    startedAt: 1_710_000_000_000,
    output: { total: 12, earliest: 0, spillPaths: [PRIVATE_SPILL] },
  }
  return {
    ...base,
    ...overrides,
    output: { ...base.output, ...(overrides.output ?? {}) },
  }
}

function makeIterable(frames, options = {}) {
  const state = { nextCalls: 0, returnCalls: 0 }
  let index = 0
  let closed = false
  const iterator = {
    async next() {
      state.nextCalls += 1
      if (options.onNext) return options.onNext(state.nextCalls, index, frames)
      if (closed || index >= frames.length) return { done: true, value: undefined }
      return { done: false, value: frames[index++] }
    },
    async return(value) {
      state.returnCalls += 1
      closed = true
      options.onReturn?.()
      return { done: true, value }
    },
    [Symbol.asyncIterator]() { return this },
  }
  return { iterable: { [Symbol.asyncIterator]: () => iterator }, iterator, state }
}

function makeController(overrides = {}) {
  const calls = { list: [], follow: [], kill: 0 }
  const controller = {
    list(request, signal) {
      calls.list.push({ request, signal })
      return makeIterable([{ type: 'rows', jobs: [jobView()] }]).iterable
    },
    follow(request, signal) {
      calls.follow.push({ request, signal })
      return makeIterable([
        { type: 'opened', job: jobView(), from: request.from ?? 0 },
        { type: 'status', job: jobView({ status: 'completed', finishedAt: 1_710_000_000_100 }) },
      ]).iterable
    },
    kill() { calls.kill += 1; return { outcome: 'requested' } },
    ...overrides,
  }
  return { controller, calls }
}

function makeContext() {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(registered.has(definition.name), false, `duplicate registration: ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }
  return { ctx, registered }
}

function assertNoPrivateJobFields(value) {
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes(PRIVATE_DETAIL), false, 'JobView.detail is not projected')
  assert.equal(serialized.includes(PRIVATE_SPILL), false, 'JobView.output.spillPaths are not projected')
  assert.equal(serialized.includes('spillPaths'), false, 'spillPaths is omitted, not merely redacted')
}

function assertProjectedJob(job) {
  assert.equal('owner' in job, false, 'JobView.owner is omitted')
  assert.equal('detail' in job, false, 'JobView.detail is omitted')
  assert.equal('spillPaths' in job.output, false, 'spill paths are omitted')
}

const execFor = (agentId = SESSION_ID, signal = new AbortController().signal) => ({
  agent: agentId === undefined ? undefined : { id: agentId },
  signal,
})

test('validates controller methods and registers exactly two disposable read-only tools', () => {
  assert.throws(() => createJobListTool({}), /list/u)
  assert.throws(() => createJobFollowTool({}), /follow/u)

  const fixture = makeController()
  const tools = makeContext()
  const dispose = registerJobTools(tools.ctx, fixture.controller)
  assert.deepEqual([...tools.registered.keys()], ['dsh_omo_job_list', 'dsh_omo_job_follow'])
  assert.equal(tools.registered.has('job_list'), false, 'avoid colliding with DSH job_list')
  assert.equal(tools.registered.has('job_output'), false, 'avoid colliding with DSH job_output')
  assert.equal(tools.registered.has('job_kill'), false, 'do not register a model-facing Host job-kill Tool')
  assert.equal(typeof dispose, 'function')
  assert.equal(tools.registered.get('dsh_omo_job_list').output.schema.type, 'object')
  assert.equal(tools.registered.get('dsh_omo_job_list').output.schema.additionalProperties, false)
  assert.equal(tools.registered.get('dsh_omo_job_follow').output.schema.type, 'object')
  assert.equal(tools.registered.get('dsh_omo_job_follow').output.schema.additionalProperties, false)
  assert.match(tools.registered.get('dsh_omo_job_list').description, /not OMO.*result/i)
  assert.match(tools.registered.get('dsh_omo_job_follow').description, /not OMO.*result/i)
  assert.deepEqual(Object.keys(tools.registered.get('dsh_omo_job_list').parameters.properties), ['limit'])
  assert.equal(tools.registered.get('dsh_omo_job_list').parameters.properties.limit.type, 'integer')
  assert.match(tools.registered.get('dsh_omo_job_list').parameters.properties.limit.description, /1.*50/u)
  assert.equal(tools.registered.get('dsh_omo_job_follow').parameters.properties.jobId.type, 'string')
  assert.equal('sessionId' in tools.registered.get('dsh_omo_job_follow').parameters.properties, false)
  assert.equal(tools.registered.get('dsh_omo_job_follow').parameters.properties.from.type, 'integer')
  assert.match(tools.registered.get('dsh_omo_job_follow').parameters.properties.from.description, /absolute UTF-8 byte offset/u)
  assert.ok(tools.registered.get('dsh_omo_job_follow').timeoutMs <= 13_000, 'tool deadline covers the eight-second stream budget and bounded cleanup')

  dispose()
  dispose()
  assert.equal(tools.registered.size, 0)
  assert.equal(fixture.calls.kill, 0)
  assert.throws(
    () => registerJobTools({ tools: { register: () => undefined } }, fixture.controller),
    /did not return a disposer/u,
  )
})

test('dsh_omo_job_list requires the current Agent and rejects invalid limits before Host calls', async () => {
  const fixture = makeController()
  const tool = createJobListTool(fixture.controller)

  await assert.rejects(tool.execute({ limit: 1 }))
  await assert.rejects(tool.execute({}, execFor('')))
  for (const limit of [0, 51, 1.5, '2', Number.NaN]) {
    await assert.rejects(tool.execute({ limit }, execFor()))
  }
  assert.deepEqual(fixture.calls.list, [])
})

test('dsh_omo_job_list derives its fence from the Agent, reads only the first rows frame, and closes the stream', async () => {
  const stream = makeIterable([
    { type: 'rows', jobs: [jobView(), jobView({ id: 'job-unowned', owner: undefined })] },
    { type: 'rows', jobs: [jobView({ id: 'must-not-read' })] },
  ])
  const fixture = makeController({
    list(request, signal) {
      fixture.calls.list.push({ request, signal })
      return stream.iterable
    },
  })
  const tool = createJobListTool(fixture.controller)
  const signal = new AbortController().signal
  const result = await tool.execute({}, execFor(SESSION_ID, signal))

  assert.deepEqual(fixture.calls.list.map(call => call.request), [{ sessionId: SESSION_ID }])
  assert.equal(typeof fixture.calls.list[0].signal?.addEventListener, 'function')
  assert.equal(stream.state.nextCalls, 1, 'later whole-set snapshots are not consumed')
  assert.equal(stream.state.returnCalls, 1, 'the persistent stream is closed after its initial snapshot')
  assert.equal(result.truncated, false)
  assert.deepEqual(new Set(result.jobs.map(item => item.id)), new Set(['job-1', 'job-unowned']))
  result.jobs.forEach(assertProjectedJob)
  assertNoPrivateJobFields(result)
  assert.doesNotMatch(tool.output.render({}, result)[0].text, /private-job-detail|spill\.log|session-current/u)
})

test('dsh_omo_job_list closes a stalled first-frame stream on its deadline', async () => {
  const stream = makeIterable([], { onNext: () => new Promise(() => {}) })
  const tool = createJobListTool(makeController({ list: () => stream.iterable }).controller)
  const nativeSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 1_000 ? 0 : delay, ...args)
  try {
    await assert.rejects(tool.execute({}, execFor()), /Timed out/u)
  } finally {
    globalThis.setTimeout = nativeSetTimeout
  }
  assert.equal(stream.state.returnCalls, 1)
})

test('dsh_omo_job_list discards a late first frame after caller cancellation and closes the stream', async () => {
  let releaseFirst
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const stream = makeIterable([], {
    onNext() {
      markStarted()
      return new Promise(resolve => { releaseFirst = resolve })
    },
  })
  const tool = createJobListTool(makeController({ list: () => stream.iterable }).controller)
  const abort = new AbortController()
  const pending = tool.execute({}, execFor(SESSION_ID, abort.signal))
  await started
  abort.abort()
  releaseFirst({ done: false, value: { type: 'rows', jobs: [jobView()] } })
  await assert.rejects(pending, /cancel|abort/u)
  assert.equal(stream.state.returnCalls, 1)
})

test('dsh_omo_job_list applies the 50-row cap and default 25-row limit with truncation', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => jobView({ id: `job-${index}` }))
  const makeListTool = () => {
    const stream = makeIterable([{ type: 'rows', jobs: rows }])
    return { tool: createJobListTool(makeController({ list: () => stream.iterable }).controller), stream }
  }

  const capped = makeListTool()
  const maxResult = await capped.tool.execute({ limit: 50 }, execFor())
  assert.equal(maxResult.jobs.length, 50)
  assert.equal(new Set(maxResult.jobs.map(item => item.id)).size, 50)
  assert.ok(maxResult.jobs.every(item => rows.some(row => row.id === item.id)))
  assert.equal(maxResult.truncated, true)
  assert.equal(capped.stream.state.nextCalls, 1)
  assert.equal(capped.stream.state.returnCalls, 1)

  const defaulted = makeListTool()
  const defaultResult = await defaulted.tool.execute({}, execFor())
  assert.equal(defaultResult.jobs.length, 25)
  assert.equal(new Set(defaultResult.jobs.map(item => item.id)).size, 25)
  assert.equal(defaultResult.truncated, true)
})

test('dsh_omo_job_list caps aggregate escaped output and rejects oversized snapshots', async () => {
  const backslash = String.fromCharCode(92)
  const rows = Array.from({ length: 50 }, (_, index) => jobView({
    id: `${index}-${backslash.repeat(250)}`,
    kind: backslash.repeat(128),
    label: backslash.repeat(240),
    progress: backslash.repeat(240),
  }))
  const boundedStream = makeIterable([{ type: 'rows', jobs: rows }])
  const boundedTool = createJobListTool(makeController({ list: () => boundedStream.iterable }).controller)
  const bounded = await boundedTool.execute({ limit: 50 }, execFor())
  const serializedBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
  const renderedBytes = Buffer.byteLength(boundedTool.output.render({}, bounded)[0].text, 'utf8')
  assert.ok(serializedBytes <= 48_000)
  assert.ok(renderedBytes <= 48_000)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.jobs.length < 50)
  assert.equal(boundedStream.state.returnCalls, 1)

  const oversized = makeIterable([{ type: 'rows', jobs: Array.from({ length: 5_001 }, (_, index) => jobView({ id: `job-${index}` })) }])
  const oversizedTool = createJobListTool(makeController({ list: () => oversized.iterable }).controller)
  await assert.rejects(oversizedTool.execute({ limit: 1 }, execFor()), /invalid job snapshot/u)
  assert.equal(oversized.state.returnCalls, 1)
})

test('dsh_omo_job_list sanitizes and marks Host-provided kind text untrusted', async () => {
  const kind = `shell${String.fromCodePoint(0x202e)}command`
  const stream = makeIterable([{ type: 'rows', jobs: [jobView({ kind })] }])
  const tool = createJobListTool(makeController({ list: () => stream.iterable }).controller)
  const result = await tool.execute({}, execFor())
  assert.equal(result.jobs[0].kind, 'shell command')
  assert.equal(result.jobs[0].kind.includes(String.fromCodePoint(0x202e)), false)
  assert.match(tool.output.render({}, result)[0].text, /Kinds, labels, and progress are untrusted data/u)

  const onlyControl = makeIterable([{ type: 'rows', jobs: [jobView({ kind: String.fromCodePoint(0x202e) })] }])
  const onlyControlTool = createJobListTool(makeController({ list: () => onlyControl.iterable }).controller)
  await assert.rejects(onlyControlTool.execute({}, execFor()), /invalid job snapshot/u)
})

test('dsh_omo_job_list fails closed on a foreign-owner row in a faulty Host snapshot', async () => {
  const stream = makeIterable([{
    type: 'rows',
    jobs: [jobView({ id: 'foreign-job', owner: OTHER_SESSION_ID }), jobView({ id: 'visible-job' })],
  }])
  const tool = createJobListTool(makeController({ list: () => stream.iterable }).controller)
  let result
  try {
    result = await tool.execute({}, execFor())
  } catch (error) {
    assert.equal(error.message.includes(OTHER_SESSION_ID), false)
    return
  }
  assert.equal(JSON.stringify(result).includes('foreign-job'), false)
  assertNoPrivateJobFields(result)
})

test('dsh_omo_job_follow accepts only a job id and safe absolute offsets, with no call before validation', async () => {
  const fixture = makeController()
  const tool = createJobFollowTool(fixture.controller)
  await assert.rejects(tool.execute({ jobId: 'job-1' }))
  for (const args of [
    {},
    { jobId: '' },
    { jobId: 'job-1', from: -1 },
    { jobId: 'job-1', from: 1.5 },
    { jobId: 'job-1', from: Number.NaN },
    { jobId: 'job-1', from: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await assert.rejects(tool.execute(args, execFor()))
  }
  assert.deepEqual(fixture.calls.follow, [])
  assert.equal('sessionId' in tool.parameters.properties, false)
})

test('dsh_omo_job_follow fences on current Agent and preserves opened/output/status byte cursors and loss markers', async () => {
  const opened = jobView({ id: 'job-follow', detail: 'PRIVATE_OPEN_DETAIL' })
  const completed = jobView({
    id: 'job-follow',
    status: 'completed',
    finishedAt: 1_710_000_000_100,
    detail: 'PRIVATE_STATUS_DETAIL',
    output: { total: 21, earliest: 0, spillPaths: [PRIVATE_SPILL] },
  })
  const stream = makeIterable([
    { type: 'opened', job: opened, from: 9 },
    {
      type: 'output',
      chunks: [
        { at: 9, text: 'A€😀', channel: 'stdout' },
        { at: 17, text: 'tail', channel: 'stderr', gapBefore: true },
      ],
      next: 21,
      lossy: true,
    },
    { type: 'status', job: completed },
    { type: 'status', job: jobView({ id: 'must-not-read' }) },
  ])
  const fixture = makeController({
    follow(request, signal) {
      fixture.calls.follow.push({ request, signal })
      return stream.iterable
    },
  })
  const tool = createJobFollowTool(fixture.controller)
  const signal = new AbortController().signal
  const args = { jobId: 'job-follow', from: 9 }
  const result = await tool.execute(args, execFor(SESSION_ID, signal))

  assert.deepEqual(fixture.calls.follow.map(call => call.request), [{
    sessionId: SESSION_ID, jobId: 'job-follow', from: 9,
  }])
  assert.equal(typeof fixture.calls.follow[0].signal?.addEventListener, 'function')
  assert.equal(stream.state.nextCalls, 3, 'the terminal status closes follow without consuming later frames')
  assert.equal(stream.state.returnCalls, 1)
  assert.equal(result.job.id, 'job-follow')
  assert.equal(result.requestedFrom, 9)
  assert.equal(result.openedFrom, 9)
  assert.deepEqual(result.chunks.map(({ at, text, channel, gapBefore }) => ({ at, text, channel, gapBefore })), [
    { at: 9, text: 'A€😀', channel: 'stdout', gapBefore: undefined },
    { at: 17, text: 'tail', channel: 'stderr', gapBefore: true },
  ])
  assert.equal(result.nextOffset, 21, 'offsets count UTF-8 bytes, not JavaScript code units')
  assert.equal(result.lossy, true)
  assert.equal(result.job.status, 'completed')
  assert.equal(result.terminal, true)
  assert.equal(result.truncated, false)
  assert.equal(result.serviceError, false)
  assertProjectedJob(result.job)
  assertNoPrivateJobFields(result)
  const rendered = tool.output.render(args, result)[0].text
  assert.match(rendered, /A€😀/u)
  assert.doesNotMatch(rendered, /PRIVATE_|spill\.log|session-current/u)
})

test('dsh_omo_job_follow fails closed for a foreign owner and malformed or regressing byte offsets', async () => {
  const foreignStream = makeIterable([
    { type: 'opened', job: jobView({ owner: OTHER_SESSION_ID }), from: 0 },
    { type: 'output', chunks: [{ at: 0, text: 'secret' }], next: 6 },
  ])
  const foreignTool = createJobFollowTool(makeController({ follow: () => foreignStream.iterable }).controller)
  await assert.rejects(foreignTool.execute({ jobId: 'job-1' }, execFor()), error => {
    assert.equal(error.message.includes(OTHER_SESSION_ID), false)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
  assert.equal(foreignStream.state.returnCalls, 1)

  const badOffsetStream = makeIterable([
    { type: 'opened', job: jobView(), from: 0 },
    { type: 'output', chunks: [{ at: 0, text: 'abcd' }], next: 4 },
    { type: 'output', chunks: [{ at: 3, text: 'regressed' }], next: 3 },
  ])
  const badOffsetTool = createJobFollowTool(makeController({ follow: () => badOffsetStream.iterable }).controller)
  await assert.rejects(badOffsetTool.execute({ jobId: 'job-1' }, execFor()), error => {
    assert.equal(error.message.includes('regressed'), false)
    return true
  })
  assert.equal(badOffsetStream.state.returnCalls, 1)

  const hugeText = '😀'.repeat(8_000)
  const hugeChunkBytes = Buffer.byteLength(hugeText, 'utf8')
  const hugeChunks = Array.from({ length: 9 }, (_, index) => ({ at: index * hugeChunkBytes, text: hugeText }))
  const oversizedStream = makeIterable([
    { type: 'opened', job: jobView(), from: 0 },
    { type: 'output', chunks: hugeChunks, next: hugeChunkBytes * hugeChunks.length },
  ])
  const oversizedTool = createJobFollowTool(makeController({ follow: () => oversizedStream.iterable }).controller)
  await assert.rejects(oversizedTool.execute({ jobId: 'job-1' }, execFor()), /invalid job-follow/u)
  assert.equal(oversizedStream.state.returnCalls, 1)
})

test('dsh_omo_job_follow enforces the 32-frame cap and returns bounded partial output', async () => {
  const frames = [{ type: 'opened', job: jobView(), from: 0 }]
  for (let index = 0; index < 40; index += 1) {
    frames.push({ type: 'output', chunks: [{ at: index, text: 'x' }], next: index + 1 })
  }
  frames.push({ type: 'status', job: jobView({ status: 'completed' }) })
  const stream = makeIterable(frames)
  const tool = createJobFollowTool(makeController({ follow: () => stream.iterable }).controller)
  const result = await tool.execute({ jobId: 'job-1' }, execFor())

  assert.ok(stream.state.nextCalls <= MAX_FOLLOW_FRAMES)
  assert.equal(stream.state.returnCalls, 1)
  assert.equal(result.truncated, true)
  assert.equal(result.terminal, false)
  assert.ok(Buffer.byteLength(result.chunks.map(chunk => chunk.text).join(''), 'utf8') <= OUTPUT_LIMIT_BYTES)
})

test('dsh_omo_job_follow bounds a stalled stream by its wall-clock deadline', async () => {
  const stream = makeIterable([], {
    onNext(nextCall) {
      if (nextCall === 1) {
        return Promise.resolve({ done: false, value: { type: 'opened', job: jobView(), from: 0 } })
      }
      return new Promise(() => {})
    },
  })
  const tool = createJobFollowTool(makeController({ follow: () => stream.iterable }).controller)
  const nativeSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 1_000 ? 0 : delay, ...args)
  let result
  try {
    result = await tool.execute({ jobId: 'job-1' }, execFor())
  } finally {
    globalThis.setTimeout = nativeSetTimeout
  }

  assert.equal(result.truncated, true)
  assert.equal(result.terminal, false)
  assert.equal(result.serviceError, false)
  assert.equal(stream.state.nextCalls, 2)
  assert.equal(stream.state.returnCalls, 1)
})

test('dsh_omo_job_follow truncates output at the UTF-8 byte budget without splitting a code point', async () => {
  const longText = `${'x'.repeat(OUTPUT_LIMIT_BYTES - 6)}😀tail`
  const serviceNext = Buffer.byteLength(longText, 'utf8')
  const stream = makeIterable([
    { type: 'opened', job: jobView(), from: 0 },
    { type: 'output', chunks: [{ at: 0, text: longText, channel: 'stdout' }], next: serviceNext },
    { type: 'status', job: jobView({ status: 'completed' }) },
  ])
  const tool = createJobFollowTool(makeController({ follow: () => stream.iterable }).controller)
  const result = await tool.execute({ jobId: 'job-1' }, execFor())
  const text = result.chunks.map(chunk => chunk.text).join('')

  assert.ok(Buffer.byteLength(text, 'utf8') <= OUTPUT_LIMIT_BYTES)
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text, 'clipped UTF-8 text remains valid')
  assert.equal(result.truncated, true)
  assert.ok(Number.isSafeInteger(result.nextOffset))
  assert.ok(result.nextOffset <= serviceNext, 'resume cursor must not skip bytes that were not returned')
  assert.equal(stream.state.returnCalls, 1)
})

test('dsh_omo_job_follow caps aggregate escaped output and resumes at the first omitted chunk', async () => {
  const chunkText = '"'.repeat(32)
  const makeChunks = start => Array.from({ length: 256 }, (_, index) => ({
    at: start + index * Buffer.byteLength(chunkText, 'utf8'),
    text: chunkText,
    channel: 'stdout',
  }))
  const streams = []
  const fixture = makeController({
    follow(request) {
      fixture.calls.follow.push({ request })
      const from = request.from ?? 0
      let frames
      if (from === 0) {
        frames = [
          { type: 'opened', job: jobView({ output: { total: 16_384, earliest: 0 } }), from: 0 },
          { type: 'output', chunks: makeChunks(0), next: 8_192 },
          { type: 'output', chunks: makeChunks(8_192), next: 16_384 },
          { type: 'status', job: jobView({ status: 'completed', output: { total: 16_384, earliest: 0 } }) },
        ]
      } else {
        frames = [
          { type: 'opened', job: jobView({ output: { total: 16_384, earliest: 0 } }), from },
          { type: 'output', chunks: [{ at: from - 16, text: chunkText, channel: 'stdout' }], next: from + 16 },
          { type: 'status', job: jobView({ status: 'completed', output: { total: 16_384, earliest: 0 } }) },
        ]
      }
      const stream = makeIterable(frames)
      streams.push(stream)
      return stream.iterable
    },
  })
  const tool = createJobFollowTool(fixture.controller)
  const result = await tool.execute({ jobId: 'job-1' }, execFor())
  const serializedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
  const renderedBytes = Buffer.byteLength(tool.output.render({}, result)[0].text, 'utf8')
  const deliveredBytes = Buffer.byteLength(result.chunks.map(chunk => chunk.text).join(''), 'utf8')

  assert.ok(serializedBytes <= 48_000)
  assert.ok(renderedBytes <= 48_000)
  assert.equal(result.truncated, true)
  assert.ok(result.chunks.length < 512)
  assert.equal(result.nextOffset, deliveredBytes, 'cursor remains at the first omitted byte')
  assert.ok(result.nextOffset > 16)
  assert.equal(streams[0].state.returnCalls, 1)

  const resumed = await tool.execute({ jobId: 'job-1', from: result.nextOffset }, execFor())
  assert.equal(fixture.calls.follow[1].request.from, result.nextOffset)
  assert.equal(resumed.chunks[0].at, result.nextOffset)
  assert.equal(resumed.chunks[0].text, chunkText.slice(16))
  assert.equal(resumed.nextOffset, result.nextOffset + 16)
  assert.equal(resumed.lossy, false)
  assert.equal(streams[1].state.returnCalls, 1)
})

test('dsh_omo_job_follow sanitizes bidi controls without corrupting absolute byte offsets', async () => {
  const first = `a${String.fromCodePoint(0x202e)}b`
  const second = 'c'
  const firstEnd = Buffer.byteLength(first, 'utf8')
  const next = firstEnd + Buffer.byteLength(second, 'utf8')
  const stream = makeIterable([
    { type: 'opened', job: jobView(), from: 0 },
    {
      type: 'output',
      chunks: [
        { at: 0, text: first, channel: 'stdout' },
        { at: firstEnd, text: second, channel: 'stdout' },
      ],
      next,
    },
    { type: 'status', job: jobView({ status: 'completed' }) },
  ])
  const tool = createJobFollowTool(makeController({ follow: () => stream.iterable }).controller)
  const result = await tool.execute({ jobId: 'job-1' }, execFor())

  assert.equal(result.chunks[0].text, 'a b')
  assert.equal(result.chunks[1].text, 'c')
  assert.equal(result.chunks[1].gapBefore, undefined)
  assert.equal(result.lossy, false)
  assert.equal(result.nextOffset, next)
})

test('dsh_omo_job_follow propagates cancellation when an awaited next resolves after abort', async () => {
  let releaseFirst
  let signalSeen
  const firstNextStarted = new Promise(resolve => { signalSeen = resolve })
  const stream = makeIterable([], {
    onNext(nextCall) {
      if (nextCall === 1) {
        signalSeen()
        return new Promise(resolve => { releaseFirst = resolve })
      }
      return Promise.resolve({
        done: false,
        value: { type: 'status', job: jobView({ status: 'completed' }) },
      })
    },
  })
  const fixture = makeController({
    follow(request, signal) {
      fixture.calls.follow.push({ request, signal })
      return stream.iterable
    },
  })
  const tool = createJobFollowTool(fixture.controller)
  const abort = new AbortController()
  const pending = tool.execute({ jobId: 'job-1' }, execFor(SESSION_ID, abort.signal))
  await firstNextStarted
  abort.abort()
  releaseFirst({ done: false, value: { type: 'opened', job: jobView(), from: 0 } })

  await assert.rejects(pending, /cancel|abort/u)
  assert.equal(stream.state.returnCalls, 1)
  assert.equal(fixture.calls.follow.length, 1)
})

test('dsh_omo_job_follow sanitizes service errors and never calls kill', async () => {
  const secret = 'private-host-follow-error'
  const state = { nextCalls: 0, returnCalls: 0 }
  const broken = {
    [Symbol.asyncIterator]() {
      return {
        async next() { state.nextCalls += 1; throw new Error(secret) },
        async return() { state.returnCalls += 1; return { done: true } },
      }
    },
  }
  const fixture = makeController({ follow: () => broken })
  const tool = createJobFollowTool(fixture.controller)
  await assert.rejects(tool.execute({ jobId: 'job-1' }, execFor()), error => {
    assert.equal(error.message.includes(secret), false)
    return true
  })
  assert.equal(state.returnCalls, 1)

  const partialState = { nextCalls: 0, returnCalls: 0 }
  const partial = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          partialState.nextCalls += 1
          if (partialState.nextCalls === 1) {
            return { done: false, value: { type: 'opened', job: jobView(), from: 0 } }
          }
          throw new Error(secret)
        },
        async return() { partialState.returnCalls += 1; return { done: true } },
      }
    },
  }
  const partialTool = createJobFollowTool(makeController({ follow: () => partial }).controller)
  const partialResult = await partialTool.execute({ jobId: 'job-1' }, execFor())
  assert.equal(partialResult.serviceError, true)
  assert.equal(partialResult.truncated, true)
  assert.equal(partialResult.terminal, false)
  assert.equal(JSON.stringify(partialResult).includes(secret), false)
  assert.equal(partialState.returnCalls, 1)
  assert.equal(fixture.calls.kill, 0)
})
