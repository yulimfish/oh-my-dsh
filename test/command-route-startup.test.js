import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'

const CWD = '/workspace/project'
const DIRECTORY = `${CWD}/.opencode/commands`
const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function projectCommandFs() {
  const nodes = new Map()
  const target = path => ({ targetKey: path, path })
  for (const path of [CWD, `${CWD}/.opencode`, DIRECTORY]) {
    nodes.set(path, { type: 'directory', version: `dir-${path}` })
  }
  const bytes = new TextEncoder().encode('---\ndescription: Delegated startup\n---\nReview $ARGUMENTS without queueing this prompt.\n')
  nodes.set(`${DIRECTORY}/route-start.md`, {
    type: 'file', bytes, size: bytes.byteLength, version: 'route-start-v1',
  })
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

async function commandRouteFixture(t) {
  const commands = new Map()
  const listeners = new Map()
  const effects = []
  const queued = []
  const activations = []
  const warnings = []
  const agent = { id: 'command-route-startup-parent', followup: message => queued.push(message) }
  agent.session = { header: { id: agent.id, cwd: CWD } }
  agent.ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['commands'])
      const disposers = []
      const fiber = Promise.resolve().then(() => callback({
        commands: {
          find: (_agent, name) => commands.get(name),
          register(definition) {
            commands.set(definition.name, definition)
            const dispose = () => commands.delete(definition.name)
            disposers.push(dispose)
            return dispose
          },
        },
        effect(execute) {
          const dispose = execute()
          if (typeof dispose === 'function') disposers.push(dispose)
          return () => {}
        },
      }))
      fiber.dispose = async () => {
        await fiber
        for (const dispose of disposers.reverse()) await dispose()
      }
      return fiber
    },
  }
  const services = {
    agents: { get: id => id === agent.id ? agent : undefined },
    sessions: { get: id => id === agent.id ? agent.session : undefined },
  }
  const ctx = {
    get: name => services[name],
    tools: { register: () => () => {} },
    commands: {
      find: (_agent, name) => commands.get(name),
      register: () => () => {},
    },
    skills: {
      register: () => () => {},
      registerProvider: create => {
        create({ signal: new AbortController().signal, invalidate() {} })
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    subagents: {
      getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true } }),
      startActivation(spec) {
        const pending = deferred()
        activations.push({ spec, pending })
        return pending.promise
      },
    },
    fs: projectCommandFs(),
    logger: { warn: message => warnings.push(message) },
    on(event, listener) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return ctx
    },
    effect(execute, label) {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => {}
    },
  }
  apply(ctx, Config({
    enableProjectCommands: true,
    commandRoutes: [{ name: 'route-start', role: 'reviewer' }],
    maxConcurrent: 1,
  }))
  for (const listener of listeners.get('agent/created') ?? []) {
    await listener({ agent, signal: new AbortController().signal })
  }
  const command = commands.get('route-start')
  assert.ok(command, 'the fake Host scanned and registered the routed project command')
  const invoke = (rawInput = 'startup race', signal = new AbortController().signal) => command.handler({ agent, rawInput, signal })
  let unloaded = false
  t.after(async () => {
    if (unloaded) return
    for (const activation of activations) activation.pending.reject(new Error('test cleanup'))
    for (const listener of listeners.get('agent/disposed') ?? []) await listener({ agent })
    for (const effect of effects.reverse()) await effect.dispose?.()
    await tick()
  })
  return {
    agent, activations, queued, warnings, invoke,
    async unload() {
      unloaded = true
      for (const effect of [...effects].reverse()) await effect.dispose?.()
    },
  }
}

function lateActivation(childId, dispose) {
  return {
    childId,
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'must not be relayed' }] }),
    dispose,
  }
}

function assertCommandStartError(result, pattern) {
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^Project command \/route-start: /u)
  assert.match(result.text, pattern)
  assert.doesNotMatch(result.text, /no child (?:was )?started|no prompt was queued/iu)
}

test('command-route caller abort holds capacity until late-activation disposal succeeds', async t => {
  const fixture = await commandRouteFixture(t)
  const controller = new AbortController()
  const starting = fixture.invoke('cancel this startup', controller.signal)
  const observed = starting.then(result => ({ result }), error => ({ error }))
  await tick()
  assert.equal(fixture.activations.length, 1)
  const activation = fixture.activations[0]
  assert.equal(activation.spec.signal, controller.signal)
  const disposal = deferred()
  let disposeCalls = 0
  controller.abort(new Error('caller cancelled'))
  activation.pending.resolve(lateActivation('late-abort-child', () => {
    disposeCalls += 1
    return disposal.promise
  }))
  await tick()

  assert.equal(disposeCalls, 1)
  const saturated = await fixture.invoke('must not over-admit during disposal')
  assertCommandStartError(saturated, /worker limit reached \(1\)/u)
  assert.equal(fixture.activations.length, 1)
  assert.equal(fixture.queued.length, 0)

  disposal.resolve()
  const outcome = await observed
  assert.ok(outcome.result, 'the command adapter converts launcher rejection into a command error')
  assertCommandStartError(outcome.result, /cancel|accepted child|successful specialist start/iu)
  assert.equal(fixture.queued.length, 0)

  const retryDisposal = deferred()
  const retry = fixture.invoke('capacity is reusable')
  const retryObserved = retry.then(result => ({ result }), error => ({ error }))
  await tick()
  fixture.activations[1].pending.resolve(lateActivation('capacity-released-child', () => retryDisposal.promise))
  assert.equal(fixture.activations.length, 2, 'successful late disposal released the worker reservation')
  retryDisposal.resolve()
  const retryOutcome = await retryObserved
  assert.equal(retryOutcome.result.kind, 'success')
  assert.match(retryOutcome.result.text, /capacity-released-child/u)
  await tick()
  assert.ok(fixture.queued.every(message => message.source?.kind !== 'user'),
    'settlement relays are allowed, but the original prompt is never queued as a user followup')
})

test('command-route caller abort retains capacity when late-activation disposal fails', async t => {
  const fixture = await commandRouteFixture(t)
  const controller = new AbortController()
  const starting = fixture.invoke('failed late cleanup', controller.signal)
  await tick()
  controller.abort()
  fixture.activations[0].pending.resolve(lateActivation('late-disposal-failure', async () => {
    throw new Error('private Host cleanup details')
  }))

  const result = await starting
  assertCommandStartError(result, /cancelled while starting.*Disposal failed.*retains the worker capacity/iu)
  assert.equal(fixture.queued.length, 0)
  assert.ok(fixture.warnings.includes('dsh-omo could not dispose a late specialist activation'))
  assert.doesNotMatch(fixture.warnings.join('\n'), /private Host cleanup details/u)

  const saturated = await fixture.invoke('capacity remains retained')
  assertCommandStartError(saturated, /worker limit reached \(1\)/u)
  assert.equal(fixture.activations.length, 1)
  assert.equal(fixture.queued.length, 0)
})

test('command-route plugin unload disposes a late activation without fallback queueing', async t => {
  const fixture = await commandRouteFixture(t)
  const controller = new AbortController()
  const starting = fixture.invoke('unload during startup', controller.signal)
  await tick()
  assert.equal(fixture.activations.length, 1)
  const disposal = deferred()
  let disposeCalls = 0
  await fixture.unload()
  assert.equal(controller.signal.aborted, false, 'plugin unload does not mutate the caller-owned signal')
  assert.equal(disposeCalls, 0, 'an unresolved Host activation has no handle to dispose yet')

  fixture.activations[0].pending.resolve(lateActivation('late-unload-child', () => {
    disposeCalls += 1
    return disposal.promise
  }))
  await tick()
  assert.equal(disposeCalls, 1)
  assert.equal(fixture.queued.length, 0)

  disposal.resolve()
  const result = await starting
  assertCommandStartError(result, /cancel|unload|accepted child/iu)
  assert.equal(fixture.queued.length, 0)
  await tick()
  assert.equal(fixture.queued.length, 0, 'the late child result is not relayed after plugin unload')
})
