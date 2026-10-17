import assert from 'node:assert/strict'
import test from 'node:test'
import { posix as path } from 'node:path'
import { createPlanChecklistTool, parsePlanChecklist, registerPlanChecklistTool } from '../src/plan-checklist.js'
import { createPlanFormatAdvisoryListener } from '../src/plan-format-advisory.js'

const CWD = '/workspace/project'
const AGENT = Object.freeze({ id: 'session-current' })
const PLAN_PATH = `${CWD}/.omo/plans/active.md`

function makeWorkspace({
  markdown = '- [ ] First task\n- [x] Finished task\n',
  headerId,
  headerCwd,
  nodeOverrides = {},
  resolveMap = {},
  onRead,
  onObserve,
} = {}) {
  const nodes = new Map()
  const calls = { observe: [], disposed: 0, resolve: [], lstat: [], stat: [], readBytes: [] }
  const putDirectory = (absolutePath, version = `v:${absolutePath}`) => nodes.set(absolutePath, { type: 'directory', version })
  const encoded = new TextEncoder().encode(markdown)
  const putFile = (absolutePath, bytes = encoded, version = `v:${absolutePath}`) => nodes.set(absolutePath, {
    type: 'file', bytes: new Uint8Array(bytes), size: bytes.byteLength, version,
  })
  putDirectory(CWD)
  putDirectory(`${CWD}/.omo`)
  putDirectory(`${CWD}/.omo/plans`)
  putFile(PLAN_PATH)
  for (const [absolutePath, node] of Object.entries(nodeOverrides)) nodes.set(absolutePath, { ...node })

  const absolute = (value, cwd = CWD) => path.resolve(cwd, value)
  const target = absolutePath => ({ targetKey: absolutePath, displayPath: absolutePath })
  const fs = {
    async resolve(value, options = {}) {
      calls.resolve.push({ value, options })
      const mapped = resolveMap[value]
      return target(mapped ?? absolute(value, options.cwd ?? CWD))
    },
    contains(parent, child) {
      const root = parent.targetKey
      const candidate = child.targetKey
      return candidate === root || candidate.startsWith(`${root.replace(/\/$/u, '')}/`)
    },
    async lstat(value, options = {}, signal) {
      calls.lstat.push({ value, options, signal })
      if (signal?.aborted) throw new Error('aborted')
      const node = nodes.get(absolute(value, options.cwd ?? CWD))
      if (!node) return undefined
      return { type: node.type, version: node.version, ...(node.size === undefined ? {} : { size: node.size }) }
    },
    async stat(fileTarget, signal) {
      calls.stat.push({ target: fileTarget, signal })
      if (signal?.aborted) throw new Error('aborted')
      const node = nodes.get(fileTarget.targetKey)
      if (!node) return undefined
      return { type: node.type, version: node.version, ...(node.size === undefined ? {} : { size: node.size }) }
    },
    async readBytes(fileTarget, signal, maxBytes) {
      calls.readBytes.push({ target: fileTarget, signal, maxBytes })
      if (signal?.aborted) throw new Error('aborted')
      const node = nodes.get(fileTarget.targetKey)
      if (!node || node.type !== 'file') throw new Error('not a file')
      if (node.bytes.byteLength > maxBytes) {
        const error = new Error('too large')
        error.code = 'FS_TOO_LARGE'
        throw error
      }
      const result = new Uint8Array(node.bytes)
      onRead?.({ node, nodes, result })
      return result
    },
  }
  const sessionQuery = {
    async observeSession(id, options) {
      calls.observe.push({ id, options })
      onObserve?.()
      return {
        header: {
          id: headerId ?? id,
          cwd: headerCwd === undefined ? CWD : headerCwd,
        },
        [Symbol.dispose]() { calls.disposed += 1 },
      }
    },
  }
  return { fs, sessionQuery, calls, nodes, putFile, putDirectory }
}

function toolFor(fixture, lifecycleSignal) {
  return createPlanChecklistTool(fixture.sessionQuery, fixture.fs, lifecycleSignal)
}

function planWriteExec({ name = 'write', filePath = PLAN_PATH, signal = new AbortController().signal, schema } = {}) {
  return {
    name,
    schema: schema ?? {
      name,
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
    arguments: { file_path: filePath },
    agent: AGENT,
    signal,
  }
}

test('parses simple checkboxes, ignores nested/fenced examples, and separates in-progress work', () => {
  const result = parsePlanChecklist([
    '- [ ] First open item',
    '- [x] Completed item',
    '* [~] In progress item',
    '  - [ ] Nested item is not top-level',
    '```md',
    '- [ ] Example in a fence',
    '```',
  ].join('\n'))
  assert.deepEqual(result, { completed: 1, remaining: 1, total: 3, nextTaskLabel: 'First open item' })
})

test('parses only structured TODO and final verification task rows', () => {
  const result = parsePlanChecklist([
    '## TODOs',
    '- [ ] T1. Build the adapter',
    '- [x] T2. Review the API',
    '- [ ] Untracked row is not a structured task',
    '## Final Verification Wave',
    '- [ ] F1. Run tests',
    '## Notes',
    '- [ ] Not part of the structured checklist',
    '```md',
    '## TODOs',
    '- [ ] T3. Fenced example',
    '```',
  ].join('\n'))
  assert.deepEqual(result, { completed: 1, remaining: 2, total: 3, nextTaskLabel: 'T1. Build the adapter' })
})

test('falls back to a simple checklist when structured sections have no recognized tasks', () => {
  const result = parsePlanChecklist([
    '## TODOs',
    '- [ ] Unnumbered task',
    '## Notes',
    '- [ ] Another task',
  ].join('\n'))
  assert.deepEqual(result, { completed: 0, remaining: 2, total: 2, nextTaskLabel: 'Unnumbered task' })
})

test('bounds parser lines and actionable checklist entries', () => {
  assert.throws(() => parsePlanChecklist(Array.from({ length: 4_097 }, () => 'text').join('\n')), /exceeds 4096 lines/u)
  assert.throws(() => parsePlanChecklist(Array.from({ length: 501 }, (_item, index) => `- [ ] task ${index}`).join('\n')), /more than 500 checklist items/u)
})

test('reads only a bounded current-workspace plan and returns a sanitized summary', async () => {
  const fixture = makeWorkspace({ markdown: '- [ ] First\u202e task\n- [x] Done\n- [~] Active\nSECRET BODY SHOULD NOT BE RETURNED\n' })
  const tool = toolFor(fixture)
  const result = await tool.execute({ plan: 'active.md' }, { agent: AGENT })
  assert.deepEqual(result, {
    plan: 'active.md',
    exists: true,
    completed: 1,
    remaining: 1,
    total: 3,
    hasNextTask: true,
    nextTaskLabel: 'First task',
    nextTaskLabelTruncated: false,
    formatWarnings: [],
  })
  assert.equal(fixture.calls.observe.length, 1)
  assert.equal(fixture.calls.observe[0].id, AGENT.id)
  assert.equal(fixture.calls.observe[0].options.projectionMode, 'none')
  assert.ok(fixture.calls.observe[0].options.signal instanceof AbortSignal)
  assert.equal(fixture.calls.disposed, 1)
  assert.equal(fixture.calls.readBytes.length, 1)
  assert.equal(fixture.calls.readBytes[0].target.targetKey, PLAN_PATH)
  assert.equal(fixture.calls.readBytes[0].maxBytes, 128 * 1024)
  assert.equal(typeof fixture.fs.writeText, 'undefined', 'the adapter has no write capability')
  const rendered = tool.output.render({ plan: 'active.md' }, result)[0].text
  assert.match(rendered, /untrusted plan text/u)
  assert.doesNotMatch(rendered, /SECRET BODY SHOULD NOT BE RETURNED/u)
})

test('reports fixed advisory warnings for malformed structured rows on explicit read only', async () => {
  const fixture = makeWorkspace({ markdown: [
    '## TODOs',
    '- [ ] 1. Valid task',
    '- [ ] Missing structured label',
    '-\u00a0[ ] Malformed Unicode-spacing row',
    '## Final Verification Wave',
    '- [ ] F-1. Invalid final-wave label',
    '## Notes',
    '- [ ] Not part of a structured task section',
    '```md',
    '## TODOs',
    '- [ ] T2. Fenced example',
    '```',
  ].join('\n') })
  const tool = toolFor(fixture)
  const warningSchema = tool.output.schema.properties.formatWarnings
  assert.equal(warningSchema.type, 'array')
  assert.equal(warningSchema.items.type, 'string')
  const result = await tool.execute({ plan: 'active' }, { agent: AGENT })
  assert.equal(result.total, 1)
  assert.deepEqual(result.formatWarnings, [
    'A recognized TODOs or Final Verification Wave section contains no valid structured task rows.',
    'Some checkbox labels in structured sections do not match the required task format.',
  ])
  const rendered = tool.output.render({ plan: 'active' }, result)[0].text
  assert.match(rendered, /Advisory format warnings/u)
  assert.doesNotMatch(rendered, /Missing structured label|Malformed Unicode-spacing row|Invalid final-wave label|Not part of|Fenced example/u)
  assert.equal(typeof fixture.fs.writeText, 'undefined', 'the checklist remains read-only')

  const unicodeWhitespace = makeWorkspace({ markdown: '## TODOs\n-\u00a0[ ] Non-breaking space row' })
  const unicodeResult = await toolFor(unicodeWhitespace).execute({ plan: 'active' }, { agent: AGENT })
  assert.deepEqual(unicodeResult.formatWarnings, [
    'A recognized TODOs or Final Verification Wave section contains no valid structured task rows.',
    'Some checkbox labels in structured sections do not match the required task format.',
  ])
})

test('renders hostile task labels inside a dynamically fenced Markdown code span', async () => {
  const label = '[click](https://example.test) <img src=x onerror=1> `inline`'
  const fixture = makeWorkspace({ markdown: `- [ ] ${label}\n` })
  const tool = toolFor(fixture)
  const result = await tool.execute({ plan: 'active' }, { agent: AGENT })
  const rendered = tool.output.render({ plan: 'active' }, result)[0].text
  assert.equal(result.nextTaskLabel, label)
  assert.ok(rendered.includes(`\`\` ${label} \`\``), rendered)
  assert.match(rendered, /Next open label \(untrusted plan text\):/u)
})

test('rejects path-like plan selectors before observing the session or touching the filesystem', async () => {
  const fixture = makeWorkspace()
  const tool = toolFor(fixture)
  for (const plan of ['../outside', '/etc/passwd', 'folder/plan', 'folder\\plan', '..', 'bad\u202e-name']) {
    await assert.rejects(tool.execute({ plan }, { agent: AGENT }), /safe basename/u)
  }
  assert.equal(fixture.calls.observe.length, 0)
  assert.equal(fixture.calls.resolve.length, 0)
  assert.equal(fixture.calls.lstat.length, 0)
})

test('requires the exact current session identity and an absolute cwd, then releases observations', async () => {
  const wrongId = makeWorkspace({ headerId: 'other-session' })
  await assert.rejects(toolFor(wrongId).execute({ plan: 'active' }, { agent: AGENT }), /current-session identity/u)
  assert.equal(wrongId.calls.disposed, 1)
  assert.equal(wrongId.calls.resolve.length, 0)

  const missingCwd = makeWorkspace({ headerCwd: null })
  await assert.rejects(toolFor(missingCwd).execute({ plan: 'active' }, { agent: AGENT }), /safe absolute working directory/u)
  assert.equal(missingCwd.calls.disposed, 1)
  assert.equal(missingCwd.calls.resolve.length, 0)

  const relativeCwd = makeWorkspace({ headerCwd: 'relative/workspace' })
  await assert.rejects(toolFor(relativeCwd).execute({ plan: 'active' }, { agent: AGENT }), /safe absolute working directory/u)
  assert.equal(relativeCwd.calls.disposed, 1)
})

test('returns an empty summary for a missing plan without reading content', async () => {
  const fixture = makeWorkspace()
  fixture.nodes.delete(PLAN_PATH)
  const result = await toolFor(fixture).execute({ plan: 'active' }, { agent: AGENT })
  assert.deepEqual(result, {
    plan: 'active.md', exists: false, completed: 0, remaining: 0, total: 0,
    hasNextTask: false, nextTaskLabel: '', nextTaskLabelTruncated: false, formatWarnings: [],
  })
  assert.equal(fixture.calls.readBytes.length, 0)
  assert.equal(fixture.calls.disposed, 1)
})

test('rejects symlinked plan directory components and plan files', async () => {
  const cases = [
    { path: `${CWD}/.omo`, type: 'symlink' },
    { path: `${CWD}/.omo/plans`, type: 'symlink' },
    { path: PLAN_PATH, type: 'symlink' },
  ]
  for (const item of cases) {
    const fixture = makeWorkspace({ nodeOverrides: { [item.path]: { type: item.type, version: 'symlink-v1' } } })
    await assert.rejects(toolFor(fixture).execute({ plan: 'active' }, { agent: AGENT }), /not a safe regular/u)
    assert.equal(fixture.calls.readBytes.length, 0)
    assert.equal(fixture.calls.disposed, 1)
  }
})

test('rejects a canonical plan target outside the current workspace', async () => {
  const fixture = makeWorkspace({ resolveMap: { '.omo/plans/active.md': '/outside/active.md' } })
  await assert.rejects(toolFor(fixture).execute({ plan: 'active' }, { agent: AGENT }), /outside the current Agent workspace/u)
  assert.equal(fixture.calls.readBytes.length, 0)
  assert.equal(fixture.calls.disposed, 1)
})

test('rejects oversized, malformed UTF-8, and changed-during-read plans', async () => {
  const oversized = makeWorkspace({ markdown: 'x'.repeat(128 * 1024 + 1) })
  await assert.rejects(toolFor(oversized).execute({ plan: 'active' }, { agent: AGENT }), /exceeds 131072 bytes/u)
  assert.equal(oversized.calls.readBytes.length, 0)

  const underreportedSize = makeWorkspace({ markdown: 'x'.repeat(128 * 1024 + 1) })
  underreportedSize.nodes.get(PLAN_PATH).size = 1
  await assert.rejects(toolFor(underreportedSize).execute({ plan: 'active' }, { agent: AGENT }), /exceeds 131072 bytes/u)
  assert.equal(underreportedSize.calls.readBytes.length, 1, 'FS_TOO_LARGE from readBytes is translated safely')

  const invalidUtf8 = makeWorkspace({ markdown: '' })
  invalidUtf8.nodes.get(PLAN_PATH).bytes = new Uint8Array([0xff, 0xfe])
  invalidUtf8.nodes.get(PLAN_PATH).size = 2
  await assert.rejects(toolFor(invalidUtf8).execute({ plan: 'active' }, { agent: AGENT }), /not valid UTF-8/u)

  const changed = makeWorkspace({ onRead: ({ node }) => { node.version = 'changed-v2' } })
  await assert.rejects(toolFor(changed).execute({ plan: 'active' }, { agent: AGENT }), /changed during inspection/u)
  assert.equal(changed.calls.disposed, 1)

  const changedDirectory = makeWorkspace({ onRead: ({ nodes }) => { nodes.get(`${CWD}/.omo/plans`).version = 'directory-v2' } })
  await assert.rejects(toolFor(changedDirectory).execute({ plan: 'active' }, { agent: AGENT }), /changed during inspection/u)

  const retargetedDirectory = makeWorkspace({ onRead: ({ nodes }) => { nodes.get(`${CWD}/.omo/plans`).type = 'symlink' } })
  await assert.rejects(toolFor(retargetedDirectory).execute({ plan: 'active' }, { agent: AGENT }), /not a safe regular directory/u)
})

test('bounds next-label output without returning the plan body', async () => {
  const fixture = makeWorkspace({ markdown: `- [ ] ${'x'.repeat(500)}\nsecret body` })
  const result = await toolFor(fixture).execute({ plan: 'active' }, { agent: AGENT })
  assert.equal(Buffer.byteLength(result.nextTaskLabel, 'utf8'), 256)
  assert.equal(result.nextTaskLabelTruncated, true)
})

test('cancellation during a pending observation disposes a late lease without filesystem access', async () => {
  const fixture = makeWorkspace()
  let resolveObservation
  let markObserved
  let markDisposed
  const observed = new Promise(resolve => { markObserved = resolve })
  const disposed = new Promise(resolve => { markDisposed = resolve })
  fixture.sessionQuery.observeSession = (id, options) => {
    fixture.calls.observe.push({ id, options })
    markObserved()
    return new Promise(resolve => { resolveObservation = resolve })
  }
  const controller = new AbortController()
  const execution = toolFor(fixture).execute({ plan: 'active' }, { agent: AGENT, signal: controller.signal })
  await observed
  controller.abort()
  await assert.rejects(execution, /was cancelled/u)
  assert.equal(fixture.calls.resolve.length, 0)
  assert.equal(fixture.calls.lstat.length, 0)

  resolveObservation({
    header: { id: AGENT.id, cwd: CWD },
    [Symbol.dispose]() { fixture.calls.disposed += 1; markDisposed() },
  })
  await disposed
  assert.equal(fixture.calls.disposed, 1)
  assert.equal(fixture.calls.readBytes.length, 0)
})

test('cancellation releases the observation even if a bounded filesystem read remains pending', async () => {
  const fixture = makeWorkspace()
  let resolveRead
  let markReadStarted
  const readStarted = new Promise(resolve => { markReadStarted = resolve })
  fixture.fs.readBytes = (_target, _signal, maxBytes) => {
    fixture.calls.readBytes.push({ maxBytes })
    markReadStarted()
    return new Promise(resolve => { resolveRead = resolve })
  }
  const controller = new AbortController()
  const execution = toolFor(fixture).execute({ plan: 'active' }, { agent: AGENT, signal: controller.signal })
  await readStarted
  controller.abort()
  await assert.rejects(execution, /was cancelled/u)
  assert.equal(fixture.calls.disposed, 1)
  resolveRead(new Uint8Array())
})

test('registration is disposable and plugin-lifecycle cancellation aborts in-flight reads', async () => {
  const fixture = makeWorkspace()
  let resolveRead
  let markReadStarted
  const readStarted = new Promise(resolve => { markReadStarted = resolve })
  fixture.fs.readBytes = () => {
    markReadStarted()
    return new Promise(resolve => { resolveRead = resolve })
  }
  const registered = new Map()
  const ctx = { tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } } }
  const dispose = registerPlanChecklistTool(ctx, fixture.sessionQuery, fixture.fs)
  const execution = registered.get('dsh_omo_plan_checklist').execute({ plan: 'active' }, { agent: AGENT })
  await readStarted
  dispose()
  await assert.rejects(execution, /was cancelled/u)
  assert.equal(fixture.calls.disposed, 1)
  assert.equal(registered.size, 0)
  resolveRead(new Uint8Array())
  dispose()
})

test('post-write advisory appends only fixed warnings after successful verified plan writes and edits', async () => {
  const secret = 'SECRET TASK LABEL MUST NOT LEAK'
  const markdown = `## TODOs\n- [ ] T1. Valid task\n- [ ] ${secret}\n## Final Verification Wave\n- [ ] F1. Verify\n`
  const fixture = makeWorkspace({ markdown })
  const lifecycle = new AbortController()
  const listener = createPlanFormatAdvisoryListener(fixture.sessionQuery, fixture.fs, lifecycle.signal)
  const existing = { role: 'user', content: [{ type: 'text', text: 'Existing context.' }] }
  const originalDecision = { kind: 'accept', value: { ok: true }, additionalContexts: [existing] }

  for (const name of ['write', 'edit']) {
    const decision = await listener(
      planWriteExec({ name }),
      { isError: false, value: { ok: true }, content: [] },
      async () => originalDecision,
    )
    assert.equal(decision.kind, 'accept')
    assert.deepEqual(decision.value, { ok: true })
    assert.equal(decision.additionalContexts[0], existing)
    assert.equal(decision.additionalContexts.length, 2)
    assert.equal(originalDecision.additionalContexts.length, 1, 'the downstream decision remains unchanged')
    const advisory = decision.additionalContexts[1].content[0].text
    assert.match(advisory, /Some checkbox labels in structured sections do not match the required task format\./u)
    assert.match(advisory, /do not rewrite the plan without an explicit instruction/u)
    assert.doesNotMatch(advisory, /SECRET TASK LABEL|Valid task|F1\. Verify/u)
  }
  assert.equal(fixture.calls.observe.length, 2)
  assert.equal(fixture.calls.disposed, 2)
  assert.equal(fixture.calls.readBytes.length, 2)
  assert.ok(fixture.calls.readBytes.every(call => call.maxBytes === 128 * 1024))
  assert.equal(typeof fixture.fs.writeText, 'undefined')

  const valid = makeWorkspace({ markdown: '## TODOs\n- [ ] T1. Correct structured task\n' })
  const validDecision = { kind: 'accept', value: { ok: true } }
  const validListener = createPlanFormatAdvisoryListener(valid.sessionQuery, valid.fs)
  assert.equal(await validListener(
    planWriteExec(), { isError: false, value: { ok: true }, content: [] }, async () => validDecision,
  ), validDecision, 'well-formed plans add no context')
})

test('post-write advisory fails closed for unknown schemas, non-plan paths, failures, and blocked decisions', async () => {
  const fixture = makeWorkspace({ markdown: '## TODOs\n- [ ] Missing required label\n' })
  const listener = createPlanFormatAdvisoryListener(fixture.sessionQuery, fixture.fs)
  const accepted = { kind: 'accept', value: { ok: true } }
  const successful = { isError: false, value: { ok: true }, content: [] }
  const calls = []
  const next = async decision => { calls.push(true); return decision ?? accepted }

  const noSchema = planWriteExec()
  delete noSchema.schema
  await listener(noSchema, successful, () => next())
  await listener(planWriteExec({ schema: {
    name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: [] },
  } }), successful, () => next())
  await listener({ ...planWriteExec(), name: 'unknown' }, successful, () => next())
  await listener(planWriteExec({ filePath: `${CWD}/notes/active.md` }), successful, () => next())
  await listener(planWriteExec({ filePath: `${CWD}/notes/.omo/plans/active.md` }), successful, () => next())
  await listener(planWriteExec(), { ...successful, isError: true }, () => next())
  await listener(planWriteExec(), successful, () => next({ kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }))

  assert.equal(calls.length, 7, 'next is preserved for every dispatch')
  assert.equal(fixture.calls.readBytes.length, 0)
  assert.equal(fixture.calls.observe.length, 1, 'ordinary non-plan writes are rejected before session observation')
  assert.equal(fixture.calls.resolve.some(call => call.value === `${CWD}/notes/.omo/plans/active.md`), false,
    'reject a lexically outside absolute candidate before filesystem resolution')
  assert.equal(fixture.calls.disposed, 1, 'only the absolute lookalike candidate observes a session')
})

test('post-write advisory fails open on version changes and lifecycle cancellation', async () => {
  const markdown = '## TODOs\n- [ ] Missing required label\n'
  const changed = makeWorkspace({ markdown, onRead: ({ node }) => { node.version = 'changed-after-read' } })
  const unchangedDecision = { kind: 'accept', value: { ok: true } }
  const changedListener = createPlanFormatAdvisoryListener(changed.sessionQuery, changed.fs)
  const afterRace = await changedListener(planWriteExec(), { isError: false, value: {}, content: [] }, async () => unchangedDecision)
  assert.equal(afterRace, unchangedDecision)
  assert.equal(changed.calls.disposed, 1)

  const fixture = makeWorkspace({ markdown })
  let resolveRead
  let markReadStarted
  const readStarted = new Promise(resolve => { markReadStarted = resolve })
  fixture.fs.readBytes = (_target, _signal, maxBytes) => {
    fixture.calls.readBytes.push({ maxBytes })
    markReadStarted()
    return new Promise(resolve => { resolveRead = resolve })
  }
  const lifecycle = new AbortController()
  const listener = createPlanFormatAdvisoryListener(fixture.sessionQuery, fixture.fs, lifecycle.signal)
  const decision = { kind: 'accept', value: { ok: true } }
  const pending = listener(planWriteExec(), { isError: false, value: {}, content: [] }, async () => decision)
  await readStarted
  lifecycle.abort()
  assert.equal(await pending, decision)
  assert.equal(fixture.calls.disposed, 1)
  resolveRead(new TextEncoder().encode(markdown))
})
