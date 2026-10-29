import assert from 'node:assert/strict'
import test from 'node:test'
import { collectBashResults, createVerifyCommand } from '../src/verify-command.js'

const cwd = '/workspace/project'
const manifest = JSON.stringify({
  scripts: {
    check: 'node --check src/index.js && node --test',
    test: 'node --test',
    'test:tool-outputs': 'node --import ./scripts/audit-tool-outputs.mjs --test',
    build: 'pnpm build',
    lint: 'eslint .',
    typecheck: 'tsc --noEmit',
    dev: 'vite --host 0.0.0.0',
  },
})

function fsFixture() {
  return {
    resolve: async (value) => ({ targetKey: value === '.' ? cwd : `${cwd}/${value}` }),
    contains: (parent, child) => parent.targetKey === cwd && child.targetKey.startsWith(`${cwd}/`),
    lstat: async () => ({ type: 'file', size: manifest.length, version: 'v1' }),
    stat: async target => target.targetKey === cwd
      ? { type: 'directory', version: 'dir-v1' }
      : { type: 'file', size: manifest.length, version: 'v1' },
    readBytes: async () => new TextEncoder().encode(manifest),
  }
}

function observation(events = []) {
  return { header: { id: 'agent-1', cwd }, events, [Symbol.dispose]: async () => {} }
}

function call(seq, callId, command, description = 'Run project checks') {
  return { seq, type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify({ command, description }) } }
}

function resultEvent(seq, callId, text, isError = false) {
  return {
    seq,
    type: 'tool/result',
    data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } },
  }
}

test('collectBashResults pairs only bash calls and ignores other tools or malformed arguments', () => {
  const events = [
    call(1, 'one', 'pnpm test'),
    resultEvent(2, 'one', 'tests 10 pass'),
    { seq: 3, type: 'tool/call', data: { callId: 'read', name: 'read', arguments: '{}' } },
    resultEvent(4, 'read', 'file text'),
    { seq: 5, type: 'tool/call', data: { callId: 'bad', name: 'bash', arguments: '{bad json' } },
    resultEvent(6, 'bad', 'must not appear'),
    call(7, 'failed', 'pnpm lint'),
    resultEvent(8, 'failed', 'exit code 1', true),
    resultEvent(9, 'missing', 'missing call'),
  ]
  assert.deepEqual(collectBashResults(events), [
    { seq: 2, command: 'pnpm test', description: 'Run project checks', isError: false, text: 'tests 10 pass' },
    { seq: 8, command: 'pnpm lint', description: 'Run project checks', isError: true, text: 'exit code 1' },
  ])
  assert.throws(() => collectBashResults({}), /not an array/u)
  assert.throws(() => collectBashResults(Array.from({ length: 129 }, () => ({}))), /exceeds/u)
})

test('reports scripts and latest evidence without executing tests or changing state', async () => {
  const events = [call(1, 'test', 'pnpm test'), resultEvent(2, 'test', '1750 pass')]
  const calls = []
  const command = createVerifyCommand({
    async observeSession(...args) { calls.push(['observe', ...args]); return observation(events) },
    async filterEvents(...args) { calls.push(['filter', ...args]); return events.map(event => ({ seq: event.seq, type: event.type, text: 'semantic-only' })) },
  }, fsFixture())
  const response = await command.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'success')
  assert.match(response.text, /No tests were run and no Goal or workspace state was changed/u)
  assert.match(response.text, /test:tool-outputs/u)
  assert.doesNotMatch(response.text, /vite --host/u)
  assert.match(response.text, /completed without Tool error.*pnpm test/u)
  assert.match(response.text, /1750 pass/u)
  assert.match(response.text, /Missing evidence means unverified, not failed/u)
  assert.deepEqual(calls.map(call => call[0]), ['observe'], 'raw observation is sufficient; semantic filterEvents is not used')
})

test('uses raw observation evidence without requiring semantic filterEvents', async () => {
  const command = createVerifyCommand({
    observeSession: async () => observation([call(1, 'test', 'pnpm test'), resultEvent(2, 'test', 'ok')]),
    filterEvents: undefined,
  }, fsFixture())
  const response = await command.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'success')
  assert.match(response.text, /pnpm test/u)
})

test('reports failure evidence and empty history honestly', async () => {
  const failed = createVerifyCommand({
    observeSession: async () => observation([call(1, 'lint', 'pnpm lint'), resultEvent(2, 'lint', 'exit code 2', true)]),
    filterEvents: async () => [],
  }, fsFixture())
  const response = await failed.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.match(response.text, /FAIL\/ERROR: pnpm lint/u)
  assert.match(response.text, /exit code 2/u)

  const empty = createVerifyCommand({
    observeSession: async () => observation(),
    filterEvents: async () => [],
  }, fsFixture())
  const emptyResponse = await empty.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.match(emptyResponse.text, /no completed bash Tool results observed/u)
  assert.match(emptyResponse.text, /not proof that checks were never run elsewhere/u)
})

test('rejects arguments, unavailable services, unsafe sessions, and invalid manifests before claims', async () => {
  const command = createVerifyCommand({}, fsFixture())
  assert.equal((await command.handler({ agent: null, rawInput: '' })).kind, 'error')
  assert.match((await command.handler({ agent: { id: 'a' }, rawInput: 'run tests' })).text, /Usage: \/omo verify/u)
  assert.match((await command.handler({ agent: { id: 'a' }, rawInput: '' })).text, /unavailable/u)
  const cancelled = new AbortController()
  cancelled.abort()
  assert.match((await command.handler({ agent: { id: 'a' }, rawInput: '', signal: cancelled.signal })).text, /cancelled/u)

  const badCwd = createVerifyCommand({
    observeSession: async () => ({ header: { id: 'a', cwd: 'relative/path' }, [Symbol.dispose]: async () => {} }),
    filterEvents: async () => { throw new Error('must not be called') },
  }, fsFixture())
  assert.match((await badCwd.handler({ agent: { id: 'a' }, rawInput: '' })).text, /no safe absolute working directory/u)

  const badManifest = createVerifyCommand({
    observeSession: async () => observation(),
    filterEvents: async () => [],
  }, { ...fsFixture(), readBytes: async () => new TextEncoder().encode('{bad') })
  assert.match((await badManifest.handler({ agent: { id: 'agent-1' }, rawInput: '' })).text, /not valid UTF-8 JSON/u)
})

test('releases session observation on success and query failure', async () => {
  let disposals = 0
  const service = {
    observeSession: async () => ({ header: { id: 'agent-1', cwd }, events: [], [Symbol.dispose]: async () => { disposals += 1 } }),
    filterEvents: async () => { throw new Error('filterEvents must not be called') },
  }
  const failingFs = { ...fsFixture(), readBytes: async () => { throw new Error('private query failure') } }
  const response = await createVerifyCommand(service, failingFs).handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'error')
  assert.match(response.text, /private query failure/u)
  assert.equal(disposals, 1)

  disposals = 0
  const success = await createVerifyCommand(service, fsFixture()).handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(success.kind, 'success')
  assert.equal(disposals, 1)
})
