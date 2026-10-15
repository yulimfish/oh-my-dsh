import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgentTerminalTools,
  readTerminalBackendTypes,
  registerAgentTerminalTools,
} from '../src/terminal-tools.js'

const ownerOne = Object.freeze({ id: 'agent-one' })
const ownerTwo = Object.freeze({ id: 'agent-two' })

function session(sessionId, owner, overrides = {}) {
  return {
    sessionId,
    owner,
    type: 'pty-default',
    name: 'test terminal',
    pid: 4321,
    status: { kind: 'running' },
    motd: 'ready',
    ...overrides,
  }
}

function makeTerminals(overrides = {}) {
  const sessions = new Map()
  const calls = { listBackends: 0, list: [], spawn: [], read: [], send: [], kill: [] }
  const service = {
    listBackends() { calls.listBackends += 1; return ['pty-default'] },
    list(owner) {
      calls.list.push(owner)
      return [...sessions.values()].filter(value => value.owner === owner).map(({ owner: _owner, motd: _motd, ...snapshot }) => snapshot)
    },
    async spawn(owner, request, signal) {
      calls.spawn.push({ owner, request, signal })
      if (signal?.aborted) throw new Error('aborted')
      const value = session(`pty-${sessions.size + 1}`, owner, { type: request.type, name: request.name, motd: 'ready' })
      sessions.set(value.sessionId, value)
      return { ...value, owner: undefined }
    },
    read(owner, sessionId, request) {
      calls.read.push({ owner, sessionId, request })
      const value = sessions.get(sessionId)
      if (!value || value.owner !== owner) throw new Error('not owned')
      return { text: 'output', totalLines: 12, lineBegin: 4, lineEnd: 6, truncated: false }
    },
    startSend(owner, sessionId, request) {
      calls.send.push({ owner, sessionId, request })
      const value = sessions.get(sessionId)
      if (!value || value.owner !== owner) throw new Error('not owned')
      return {
        done: Promise.resolve({
          viewport: 'private viewport ignored',
          waitReason: 'inferred_idle',
          sessionStatus: value.status,
          truncated: false,
        }),
        readOutput: () => ({ delta: 'command output', truncated: false }),
        cancel: () => true,
      }
    },
    async kill(owner, sessionId, reason) {
      calls.kill.push({ owner, sessionId, reason })
      const value = sessions.get(sessionId)
      if (!value || value.owner !== owner) throw new Error('not owned')
      sessions.delete(sessionId)
      return true
    },
    ...overrides,
  }
  return { service, calls, sessions }
}

function toolsFor(service) {
  return new Map(createAgentTerminalTools(service, service.listBackends()).map(tool => [tool.name, tool]))
}

test('validates a nonempty, unique, bounded backend list', () => {
  assert.deepEqual(readTerminalBackendTypes({ listBackends: () => ['pty-a', 'pty-b'] }), ['pty-a', 'pty-b'])
  assert.throws(() => readTerminalBackendTypes({}), /listBackends/u)
  assert.throws(() => readTerminalBackendTypes({ listBackends: () => [] }), /No usable/u)
  assert.throws(() => readTerminalBackendTypes({ listBackends: () => ['pty-a', 'pty-a'] }), /invalid terminal backend list/u)
  assert.throws(() => readTerminalBackendTypes({ listBackends: () => ['bad\u0000type'] }), /invalid terminal backend list/u)
  assert.throws(() => readTerminalBackendTypes({ listBackends: () => ['pty-\u202edefault'] }), /invalid terminal backend list/u)
})

test('fails closed without a current Agent before calling Host terminal methods', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  await assert.rejects(tools.get('dsh_omo_terminal_list').execute({}, {}), /live DSH Agent/u)
  assert.deepEqual(fixture.calls.list, [])
})

test('registers five profile-visible owner-fenced tools and disposes without killing sessions', () => {
  const fixture = makeTerminals()
  const registered = new Map()
  const ctx = { tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } } }
  const dispose = registerAgentTerminalTools(ctx, fixture.service, ['pty-default'])
  assert.deepEqual([...registered.keys()], [
    'dsh_omo_terminal_list',
    'dsh_omo_terminal_spawn',
    'dsh_omo_terminal_read',
    'dsh_omo_terminal_send',
    'dsh_omo_terminal_close',
  ])
  assert.equal(typeof registered.get('dsh_omo_terminal_spawn').execute, 'function')
  dispose()
  dispose()
  assert.equal(registered.size, 0)
  assert.deepEqual(fixture.calls.kill, [], 'plugin disposal does not close live Agent terminals')
})

test('spawn uses the exact Agent, registered backend, and no model cwd/owner input', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  const result = await tools.get('dsh_omo_terminal_spawn').execute({ type: 'pty-default', name: 'build' }, { agent: ownerOne })
  assert.equal(result.sessionId, 'pty-1')
  assert.equal(result.type, 'pty-default')
  assert.equal(result.name, 'build')
  assert.equal(result.motd, 'ready')
  assert.equal(fixture.calls.spawn[0].owner, ownerOne)
  assert.deepEqual(fixture.calls.spawn[0].request, { type: 'pty-default', name: 'build' })
  assert.ok(fixture.calls.spawn[0].signal instanceof AbortSignal)
  assert.deepEqual(Object.keys(tools.get('dsh_omo_terminal_spawn').parameters.properties), ['type', 'name'])
  await assert.rejects(tools.get('dsh_omo_terminal_spawn').execute({ type: 'not-registered' }, { agent: ownerOne }), /pty-default/u)
  await tools.get('dsh_omo_terminal_spawn').execute(
    { type: 'pty-default', cwd: '/tmp', ownerId: 'agent-two' },
    { agent: ownerOne },
  )
  assert.deepEqual(fixture.calls.spawn[1].request, { type: 'pty-default' }, 'extra cwd/owner fields are not forwarded')
  assert.equal(fixture.calls.spawn.length, 2)
})

test('list, read, send, and close always use exact exec.agent ownership', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  const spawn = await tools.get('dsh_omo_terminal_spawn').execute({ type: 'pty-default' }, { agent: ownerOne })
  const list = await tools.get('dsh_omo_terminal_list').execute({}, { agent: ownerOne })
  assert.equal(list.scope, 'current-agent')
  assert.equal(list.sessions[0].sessionId, spawn.sessionId)

  const read = await tools.get('dsh_omo_terminal_read').execute({ sessionId: spawn.sessionId, offset: 2, count: 3 }, { agent: ownerOne })
  assert.equal(read.text, 'output')
  assert.deepEqual(fixture.calls.read.at(-1), { owner: ownerOne, sessionId: spawn.sessionId, request: { offset: 2, count: 3 } })

  const send = await tools.get('dsh_omo_terminal_send').execute({ sessionId: spawn.sessionId, text: 'echo hello', submit: true }, { agent: ownerOne })
  assert.equal(send.output, 'command output')
  assert.equal(send.waitReason, 'inferred_idle')
  assert.equal(fixture.calls.send.at(-1).owner, ownerOne)
  assert.equal(fixture.calls.send.at(-1).request.submit, true)
  assert.equal(fixture.calls.send.at(-1).request.signal.aborted, false)

  const closed = await tools.get('dsh_omo_terminal_close').execute({ sessionId: spawn.sessionId }, { agent: ownerOne })
  assert.equal(closed.closed, true)
  assert.equal(fixture.calls.kill.at(-1).owner, ownerOne)
  assert.equal(fixture.calls.kill.at(-1).sessionId, spawn.sessionId)
  assert.deepEqual(fixture.calls.list, [ownerOne])
})

test('fails closed when the Host send result has a malformed truncation flag', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  const spawned = await tools.get('dsh_omo_terminal_spawn').execute({ type: 'pty-default' }, { agent: ownerOne })
  fixture.service.startSend = () => ({
    done: Promise.resolve({ waitReason: 'inferred_idle', sessionStatus: { kind: 'running' }, truncated: 'false' }),
    readOutput: () => ({ delta: 'output', truncated: false }),
    cancel: () => true,
  })
  await assert.rejects(
    tools.get('dsh_omo_terminal_send').execute({ sessionId: spawned.sessionId, text: 'echo test' }, { agent: ownerOne }),
    /invalid terminal result/u,
  )
})

test('a foreign Agent cannot list, read, send, or close another Agent terminal', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  const spawned = await tools.get('dsh_omo_terminal_spawn').execute({ type: 'pty-default' }, { agent: ownerOne })

  const foreignList = await tools.get('dsh_omo_terminal_list').execute({}, { agent: ownerTwo })
  assert.deepEqual(foreignList.sessions, [])
  await assert.rejects(tools.get('dsh_omo_terminal_read').execute({ sessionId: spawned.sessionId }, { agent: ownerTwo }), /Could not read/u)
  await assert.rejects(tools.get('dsh_omo_terminal_send').execute({ sessionId: spawned.sessionId, text: 'echo forbidden' }, { agent: ownerTwo }), /Could not start a send/u)
  await assert.rejects(tools.get('dsh_omo_terminal_close').execute({ sessionId: spawned.sessionId }, { agent: ownerTwo }), /Could not close/u)

  assert.deepEqual(fixture.calls.list, [ownerTwo])
  assert.equal(fixture.calls.read.at(-1).owner, ownerTwo)
  assert.equal(fixture.calls.send.at(-1).owner, ownerTwo)
  assert.equal(fixture.calls.kill.at(-1).owner, ownerTwo)
  assert.equal(fixture.sessions.has(spawned.sessionId), true, 'foreign operations leave the original PTY open')
})

test('caps and sanitizes terminal output while preserving Host truncation flags', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  const service = fixture.service
  const spawned = await tools.get('dsh_omo_terminal_spawn').execute({ type: 'pty-default' }, { agent: ownerOne })
  service.read = (_owner, _id, request) => ({
    text: `\u001b[31m${'x'.repeat(20_000)}\u001b[0m\u202e`,
    totalLines: 1,
    lineBegin: 0,
    lineEnd: 1,
    truncated: false,
  })
  const read = await tools.get('dsh_omo_terminal_read').execute({ sessionId: spawned.sessionId }, { agent: ownerOne })
  assert.equal(Buffer.byteLength(read.text, 'utf8'), 16 * 1024)
  assert.equal(read.text.includes('\u001b'), false)
  assert.equal(read.text.includes('\u202e'), false)
  assert.equal(read.truncated, true)

  service.startSend = () => ({
    done: Promise.resolve({ waitReason: 'inferred_idle', sessionStatus: { kind: 'running' }, truncated: false }),
    readOutput: () => ({ delta: `\u001b[32m${'y'.repeat(20_000)}\u001b[0m`, truncated: false }),
    cancel: () => true,
  })
  const send = await tools.get('dsh_omo_terminal_send').execute({ sessionId: spawned.sessionId, text: 'echo output' }, { agent: ownerOne })
  assert.equal(Buffer.byteLength(send.output, 'utf8'), 16 * 1024)
  assert.equal(send.output.includes('\u001b'), false)
  assert.equal(send.truncated, true)
})

test('cancelled spawn passes the signal and closes a session that publishes late', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  const controller = new AbortController()
  let seenSignal
  fixture.service.spawn = async (owner, request, signal) => {
    seenSignal = signal
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { ...session('late-pty', owner, { type: request.type }), owner: undefined }
  }
  const pending = tools.get('dsh_omo_terminal_spawn').execute({ type: 'pty-default' }, { agent: ownerOne, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /was cancelled/u)
  assert.notEqual(seenSignal, controller.signal, 'the adapter passes a linked deadline signal')
  assert.equal(seenSignal.aborted, true)
  assert.deepEqual(fixture.calls.kill, [{ owner: ownerOne, sessionId: 'late-pty', reason: 'cancelled dsh-omo terminal spawn' }])
})

test('cancelled send aborts its operation and bounded input validation precedes service calls', async () => {
  const fixture = makeTerminals()
  const tools = toolsFor(fixture.service)
  const spawned = await tools.get('dsh_omo_terminal_spawn').execute({ type: 'pty-default' }, { agent: ownerOne })
  let cancelled = 0
  let signalSeen
  fixture.service.startSend = (_owner, _id, request) => {
    signalSeen = request.signal
    return {
      done: new Promise(() => {}),
      readOutput: () => ({ delta: '', truncated: false }),
      cancel: () => { cancelled += 1; return true },
    }
  }
  const controller = new AbortController()
  const pending = tools.get('dsh_omo_terminal_send').execute(
    { sessionId: spawned.sessionId, text: 'long task' },
    { agent: ownerOne, signal: controller.signal },
  )
  controller.abort()
  await assert.rejects(pending, /did not settle/u)
  assert.notEqual(signalSeen, controller.signal, 'the adapter passes a linked deadline signal')
  assert.equal(signalSeen.aborted, true)
  assert.ok(cancelled >= 1)

  await assert.rejects(tools.get('dsh_omo_terminal_send').execute({ sessionId: spawned.sessionId, text: 'x'.repeat(5000) }, { agent: ownerOne }), /byte limit/u)
  await assert.rejects(tools.get('dsh_omo_terminal_send').execute({ sessionId: spawned.sessionId, text: '😀'.repeat(1025) }, { agent: ownerOne }), /byte limit/u)
  await assert.rejects(tools.get('dsh_omo_terminal_read').execute({ sessionId: spawned.sessionId, count: 201 }, { agent: ownerOne }), /count must be/u)
  assert.equal(fixture.calls.send.length, 0, 'invalid input never starts a PTY operation')
})
