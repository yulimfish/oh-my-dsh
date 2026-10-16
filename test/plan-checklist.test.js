import assert from 'node:assert/strict'
import test from 'node:test'
import { posix as path } from 'node:path'
import { createPlanChecklistTool, parsePlanChecklist, registerPlanChecklistTool } from '../src/plan-checklist.js'

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
    hasNextTask: false, nextTaskLabel: '', nextTaskLabelTruncated: false,
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
