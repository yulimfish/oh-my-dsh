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
  const source = '---\ndescription: Routed lifecycle review\n---\nReview $ARGUMENTS carefully.\n'
  const bytes = new TextEncoder().encode(source)
  nodes.set(`${DIRECTORY}/route-review.md`, {
    type: 'file', bytes, size: bytes.byteLength, version: 'route-review-v1',
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
      return node && {
        type: node.type,
        ...(node.size === undefined ? {} : { size: node.size }),
        version: node.version,
      }
    },
    async listDir(value) {
      return [...nodes.entries()]
        .filter(([path]) => path.startsWith(`${value.path}/`) && !path.slice(value.path.length + 1).includes('/'))
        .map(([path, node]) => ({
          name: path.slice(value.path.length + 1), type: node.type, target: target(path),
        }))
    },
    async readBytes(value, signal, maxBytes) {
      const node = nodes.get(value.path)
      assert.equal(node.type, 'file')
      assert.ok(node.size <= maxBytes)
      return new Uint8Array(node.bytes)
    },
  }
}

async function commandFixture(t, startActivation, maxPendingTasks = 0, withoutAgents = false) {
  const globalCommands = new Map()
  const scopedCommands = new Map()
  const tools = new Map()
  const listeners = new Map()
  const effects = []
  const starts = []
  const disposals = []
  const liveAgents = new Map()
  const session = { header: { id: 'agent-1', cwd: CWD } }
  const services = {
    agents: {
      get: id => liveAgents.get(id),
      withoutInitiator: fn => fn(),
      ...(withoutAgents ? { get: undefined } : {}),
    },
    sessions: { get: id => id === session.header.id ? session : undefined },
  }
  const ctx = {
    get: name => services[name],
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    commands: {
      find: (_agent, name) => globalCommands.get(name),
      register(definition) {
        globalCommands.set(definition.name, definition)
        return () => globalCommands.delete(definition.name)
      },
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
        starts.push(spec)
        return startActivation(spec)
      },
    },
    fs: projectCommandFs(),
    logger: { warn() {} },
    on(event, listener) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return ctx
    },
    effect(execute, label) {
      const dispose = execute()
      effects.push({ label, dispose })
      return async () => dispose?.()
    },
  }

  function makeAgent() {
    const followups = []
    const agent = {
      id: session.header.id,
      followup: message => followups.push(message),
    }
    agent.ctx = {
      inject(dependencies, callback) {
        assert.deepEqual(dependencies, ['commands'])
        const disposers = []
        const injected = {
          commands: {
            find: (_agent, name) => scopedCommands.get(name) ?? globalCommands.get(name),
            register(definition) {
              scopedCommands.set(definition.name, definition)
              return () => scopedCommands.delete(definition.name)
            },
          },
          effect(execute) {
            const dispose = execute()
            if (typeof dispose === 'function') disposers.push(dispose)
            return () => {}
          },
        }
        const fiber = Promise.resolve().then(() => callback(injected))
        fiber.dispose = async () => {
          await fiber
          for (let index = disposers.length - 1; index >= 0; index -= 1) await disposers[index]()
        }
        return fiber
      },
    }
    liveAgents.set(agent.id, agent)
    return { agent, followups }
  }

  async function emit(event, agent) {
    for (const listener of listeners.get(event) ?? []) {
      await listener({ agent, signal: new AbortController().signal })
    }
  }

  const config = Config({
    enableProjectCommands: true,
    enableTaskResultTool: true,
    commandRoutes: [{ name: 'route-review', role: 'reviewer' }],
    ...(maxPendingTasks > 0 ? { maxPendingTasks } : {}),
  })
  assert.equal(config.maxPendingTasks, maxPendingTasks, 'exercise the selected admission mode')
  apply(ctx, config)
  t.after(async () => {
    for (let index = effects.length - 1; index >= 0; index -= 1) await effects[index].dispose?.()
  })

  return {
    starts,
    disposals,
    tools,
    scopedCommands,
    async createAgent() {
      const parent = makeAgent()
      await emit('agent/created', parent.agent)
      assert.ok(scopedCommands.has('route-review'), 'the real apply registered the project command fixture')
      return parent
    },
    async replaceAgent(parent, { disposeOld = false } = {}) {
      const replacement = makeAgent()
      if (disposeOld) await emit('agent/disposed', parent.agent)
      await emit('agent/created', replacement.agent)
      return replacement
    },
  }
}

async function cachedStatus(fixture, parent, childId) {
  try {
    const cached = await fixture.tools.get('dsh_omo_task_result').execute({ childId }, { agent: parent.agent })
    return cached.status
  } catch (error) {
    assert.match(error.message, /No unexpired dsh-omo result/u)
    return null
  }
}

test('same-ID replacement during command activation disposes the late child without relay or cache', async t => {
  const activation = deferred()
  const childResult = deferred()
  const activationRequested = deferred()
  const fixture = await commandFixture(t, () => {
    activationRequested.resolve()
    return activation.promise
  })
  const original = await fixture.createAgent()
  const command = fixture.scopedCommands.get('route-review')
  const pendingCommand = command.handler({
    agent: original.agent, rawInput: 'lifecycle replacement', signal: new AbortController().signal,
  })
  await activationRequested.promise
  assert.equal(fixture.starts.length, 1)
  assert.equal(fixture.starts[0].request.parent, original.agent, 'the command captured the exact original parent')

  const replacement = await fixture.replaceAgent(original)
  activation.resolve({
    childId: 'late-command-child',
    result: childResult.promise,
    async dispose() { fixture.disposals.push('late-command-child') },
  })
  const commandResult = await pendingCommand
  const disposalsWhenCommandReturned = [...fixture.disposals]
  childResult.resolve({
    stopReason: 'completed',
    output: [{ type: 'text', text: 'late activation result must stay private' }],
  })
  await tick()

  assert.equal(commandResult.kind, 'error')
  assert.match(commandResult.text, /accepted child may (?:still have|have) run/u,
    'an ambiguous launch failure must not claim that the accepted child never started')
  assert.doesNotMatch(commandResult.text, /never started|was not started|did not start/iu)
  assert.deepEqual({
    starts: fixture.starts.length,
    disposalsWhenCommandReturned,
    originalRelays: original.followups.length,
    replacementRelays: replacement.followups.length,
    originalCache: await cachedStatus(fixture, original, 'late-command-child'),
    replacementCache: await cachedStatus(fixture, replacement, 'late-command-child'),
  }, {
    starts: 1,
    disposalsWhenCommandReturned: ['late-command-child'],
    originalRelays: 0,
    replacementRelays: 0,
    originalCache: null,
    replacementCache: null,
  })
})

test('stale command parent is rejected before Host activation on default and queued launchers', async t => {
  for (const maxPendingTasks of [0, 1]) {
    const fixture = await commandFixture(t, () => {
      throw new Error('stale parent must not reach Host activation')
    }, maxPendingTasks)
    const original = await fixture.createAgent()
    const command = fixture.scopedCommands.get('route-review')
    const replacement = await fixture.replaceAgent(original)
    const result = await command.handler({ agent: original.agent, rawInput: 'stale parent', signal: new AbortController().signal })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /stale|live parent|active/iu)
    assert.equal(fixture.starts.length, 0, `stale parent must fail before activation with maxPendingTasks=${maxPendingTasks}`)
    assert.equal(original.followups.length, 0)
    assert.equal(replacement.followups.length, 0)
  }
})

test('stale parent results cannot poison a same-ID replacement result cache', async t => {
  for (const outcome of ['completed', 'failed']) {
    const childResults = []
    const fixture = await commandFixture(t, () => {
      const result = deferred()
      childResults.push(result)
      return {
        childId: `stale-cache-${outcome}-${childResults.length}`,
        result: result.promise,
        async dispose() {},
      }
    })
    const original = await fixture.createAgent()
    const command = fixture.scopedCommands.get('route-review')
    await command.handler({ agent: original.agent, rawInput: 'cache ownership', signal: new AbortController().signal })
    const replacement = await fixture.replaceAgent(original, { disposeOld: false })
    if (outcome === 'completed') childResults[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'stale result' }] })
    else childResults[0].reject(new Error('stale failure'))
    await tick()
    assert.equal(original.followups.length, 0)
    assert.equal(replacement.followups.length, 0)
    assert.equal(await cachedStatus(fixture, original, `stale-cache-${outcome}-1`), null)
    const next = await fixture.scopedCommands.get('route-review').handler({ agent: replacement.agent, rawInput: 'replacement task', signal: new AbortController().signal })
    assert.equal(next.kind, 'success')
    const childId = next.text.match(/stale-cache-[\w-]+/)?.[0]
    assert.ok(childId, 'replacement receives its own child identity')
    childResults[1].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'replacement result' }] })
    await tick()
    assert.equal(await cachedStatus(fixture, replacement, childId), 'completed', 'replacement can track its own terminal result')
  }
})

test('command routes reject setup when the exact-agent liveness service is absent', async t => {
  await assert.rejects(commandFixture(t, () => { throw new Error('must not activate') }, 0, true), /agents\.get/u)
})
test('an accepted command child cannot relay its late result after parent disposal or to a same-ID replacement', async t => {
  const childResult = deferred()
  const fixture = await commandFixture(t, () => ({
    childId: 'accepted-command-child',
    result: childResult.promise,
    async dispose() { fixture.disposals.push('accepted-command-child') },
  }))
  const original = await fixture.createAgent()
  const commandResult = await fixture.scopedCommands.get('route-review').handler({
    agent: original.agent, rawInput: 'dispose before settlement', signal: new AbortController().signal,
  })
  assert.equal(commandResult.kind, 'success')
  assert.equal(fixture.starts.length, 1, 'the child was accepted before parent disposal')

  const replacement = await fixture.replaceAgent(original, { disposeOld: true })
  childResult.resolve({
    stopReason: 'completed',
    output: [{ type: 'text', text: 'disposed parent result must stay private' }],
  })
  await tick()

  assert.deepEqual({
    originalRelays: original.followups.length,
    replacementRelays: replacement.followups.length,
  }, { originalRelays: 0, replacementRelays: 0 })
})
