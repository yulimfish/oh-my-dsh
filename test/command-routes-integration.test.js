import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { apply, Config, inject } from '../src/index.js'

const scopeRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(scopeRequire.resolve('@deepseek-ai/dsh-scope'))

const CWD = '/workspace/project'
const DIRECTORY = `${CWD}/.opencode/commands`
const tick = () => new Promise(resolve => setImmediate(resolve))

function projectCommandFs(commands) {
  const nodes = new Map()
  const addDirectory = path => nodes.set(path, { type: 'directory', version: `dir-${path}` })
  for (const path of [CWD, `${CWD}/.opencode`, DIRECTORY]) addDirectory(path)
  for (const [name, body] of Object.entries(commands)) {
    const bytes = new TextEncoder().encode(`---\ndescription: Project command ${name}\n---\n${body}\n`)
    nodes.set(`${DIRECTORY}/${name}.md`, { type: 'file', bytes, size: bytes.byteLength, version: `file-${name}` })
  }
  const target = path => ({ targetKey: path, path })
  return {
    async resolve(path, options = {}) {
      return target(path.startsWith('/') ? path : `${options.cwd ?? CWD}/${path}`)
    },
    contains(parent, child) {
      return child.path === parent.path || child.path.startsWith(`${parent.path}/`)
    },
    async lstat(path, options = {}) {
      const absolute = path.startsWith('/') ? path : `${options.cwd ?? CWD}/${path}`
      const node = nodes.get(absolute)
      return node && { type: node.type, ...(node.size === undefined ? {} : { size: node.size }) }
    },
    async stat(value) {
      const node = nodes.get(value.path)
      return node && { type: node.type, ...(node.size === undefined ? {} : { size: node.size }), version: node.version }
    },
    async listDir(value) {
      return [...nodes.entries()]
        .filter(([path]) => path.startsWith(`${value.path}/`) && !path.slice(value.path.length + 1).includes('/'))
        .map(([path, node]) => ({ name: path.slice(value.path.length + 1), type: node.type, target: target(path) }))
    },
    async readBytes(value, signal, maxBytes) {
      const node = nodes.get(value.path)
      assert.equal(node.type, 'file')
      assert.ok(node.size <= maxBytes)
      return new Uint8Array(node.bytes)
    },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function commandFixture(t, config) {
  const ctx = new Context()
  const commandFiber = await ctx.plugin(CommandRuntime)
  const events = []
  const queued = []
  const starts = []
  const disposals = []
  const child = deferred()
  const agent = {
    id: 'command-route-parent',
    followup: message => queued.push(message),
  }
  agent.session = {
    header: { id: agent.id, cwd: CWD },
    append(type, data) { events.push({ type, data }) },
  }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  const agents = { get: id => id === agent.id ? agent : undefined }
  const sessions = { get: id => id === agent.id ? agent.session : undefined }
  const serviceFibers = []
  const provide = async (name, value) => serviceFibers.push(await ctx.plugin(serviceCtx => serviceCtx.provide(name, value)))
  await provide('agents', agents)
  await provide('sessions', sessions)
  await provide('tools', { register: () => () => {} })
  await provide('systemPrompt', { section: () => () => {}, context: () => () => {} })
  await provide('skills', {
    register: () => () => {},
    registerProvider: create => {
      create({ signal: new AbortController().signal, invalidate() {} })
      return () => {}
    },
  })
  await provide('subagents', {
    getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true } }),
    async startActivation(spec) {
      starts.push(spec)
      return {
        childId: `route-child-${starts.length}`,
        result: child.promise,
        async dispose() { disposals.push(`route-child-${starts.length}`) },
      }
    },
  })
  await provide('fs', projectCommandFs({
    'route-review': 'Review $ARGUMENTS carefully.',
    'queue-review': 'Queue $ARGUMENTS for the parent.',
  }))
  const pluginFiber = await ctx.plugin({ apply, inject }, Config({ enableProjectCommands: true, ...config }))
  t.after(async () => {
    child.resolve({ stopReason: 'completed', output: [] })
    await tick()
    await pluginFiber.dispose()
    await scope.dispose()
    for (const fiber of serviceFibers.reverse()) await fiber.dispose()
    await commandFiber.dispose()
  })
  await ctx.events.serial('agent/created', { agent, signal: new AbortController().signal })
  assert.ok(ctx.commands.find(agent, 'route-review'), 'the real apply scanned and scoped the project command')
  return { ctx, agent, events, queued, starts, disposals }
}

test('CommandRuntime.execute routes a project command to a child with the exact parent and signal', async t => {
  const fixture = await commandFixture(t, { commandRoutes: [{ name: 'route-review', role: 'reviewer' }] })
  const controller = new AbortController()
  const execution = await fixture.ctx.commands.execute(
    fixture.agent, '/route-review  src/changed.ts  ', [], controller.signal,
  )

  assert.equal(execution.result.kind, 'success')
  assert.match(execution.result.text, /route-child-1/u)
  assert.equal(fixture.starts.length, 1)
  assert.equal(fixture.starts[0].request.parent, fixture.agent)
  assert.equal(fixture.starts[0].signal, controller.signal)
  assert.match(fixture.starts[0].request.prompt[0].text, /<command-instruction>[\s\S]*src\/changed\.ts/u)
  assert.equal(fixture.queued.length, 0, 'a routed command does not queue its prompt on the parent')
  assert.deepEqual(fixture.events.map(event => event.type), ['command/run', 'command/done'])
  assert.ok(fixture.events.every(event => event.data.commandId === execution.commandId))
})

test('CommandRuntime attachment admission rejects before the routed handler starts a child', async t => {
  const fixture = await commandFixture(t, { commandRoutes: [{ name: 'route-review', role: 'reviewer' }] })
  const execution = await fixture.ctx.commands.execute(
    fixture.agent,
    '/route-review do not start',
    [{ type: 'image', mediaType: 'image/png', data: 'not-admitted' }],
    new AbortController().signal,
  )

  assert.deepEqual(execution.result, { kind: 'error', text: '/route-review does not accept attachments' })
  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.queued.length, 0)
  assert.deepEqual(fixture.events.map(event => event.type), ['command/run', 'command/done'])
})

test('automatic pre-step rewrites only a registered project command without queueing or starting a child', async t => {
  const fixture = await commandFixture(t, { enableAutomaticSlashCommands: true })
  const message = {
    id: 'automatic-command-message', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '/queue-review  preserve this request  ' }],
  }
  const decision = await fixture.ctx.events.waterfall('agent/pre-step', {
    agent: fixture.agent, messages: [message], turn: 1, step: 0, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [message] }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0].id, message.id)
  assert.equal(decision.messages[0].source, message.source)
  assert.match(decision.messages[0].content[0].text, /<command-instruction>[\s\S]*preserve this request/u)
  assert.equal(fixture.queued.length, 0)
  assert.equal(fixture.starts.length, 0)
})

test('automatic pre-step does not turn a routed command into a model prompt', async t => {
  const fixture = await commandFixture(t, {
    enableAutomaticSlashCommands: true,
    commandRoutes: [{ name: 'route-review', role: 'reviewer' }],
  })
  const message = {
    id: 'automatic-routed-message', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '/route-review review this' }],
  }
  const decision = await fixture.ctx.events.waterfall('agent/pre-step', {
    agent: fixture.agent, messages: [message], turn: 1, step: 0, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [message] }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0].content[0].text, '/route-review review this', 'routed commands retain their explicit execution semantics')
  assert.equal(fixture.queued.length, 0)
  assert.equal(fixture.starts.length, 0, 'automatic prompt rewriting must not invoke the routed handler')
})

test('an unconfigured project command still queues its prompt through CommandRuntime.execute', async t => {
  const fixture = await commandFixture(t, { commandRoutes: [{ name: 'route-review', role: 'reviewer' }] })
  const execution = await fixture.ctx.commands.execute(
    fixture.agent, '/queue-review  keep the default  ', [], new AbortController().signal,
  )

  assert.equal(execution.result.kind, 'success')
  assert.match(execution.result.text, /Queued project command/u)
  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.queued.length, 1)
  assert.deepEqual(fixture.queued[0].source, { kind: 'user' })
  assert.equal(fixture.queued[0].content[0].text, '<command-instruction>\nQueue   keep the default   for the parent.\n</command-instruction>\n\n<user-request>\n  keep the default  \n</user-request>')
  assert.deepEqual(fixture.events.map(event => event.type), ['command/run', 'command/done'])
})
