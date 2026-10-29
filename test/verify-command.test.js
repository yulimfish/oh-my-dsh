import assert from 'node:assert/strict'
import test from 'node:test'
import { collectBashResults, createVerifyCommand as createVerifyCommandWithServices } from '../src/verify-command.js'

function createVerifyCommand(sessionQuery, fs, currentCwd = cwd) {
  return createVerifyCommandWithServices(sessionQuery, fs, { get: () => currentCwd }, {
    get: id => ({ header: { id } }),
  })
}

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
    { seq: 2, callId: 'one', command: 'pnpm test', description: 'Run project checks', isError: false, text: 'tests 10 pass', hasNonText: false },
    { seq: 8, callId: 'failed', command: 'pnpm lint', description: 'Run project checks', isError: true, text: 'exit code 1', hasNonText: false },
  ])
  assert.throws(() => collectBashResults({}), /not an array/u)
  assert.deepEqual(collectBashResults(Array.from({ length: 129 }, (_value, seq) => ({
    seq, type: 'step/end', data: { turn: 1, step: seq },
  }))), [])
  const reused = collectBashResults([
    call(1, 'same-id', 'pnpm test -- first'),
    resultEvent(2, 'same-id', 'first result'),
    call(3, 'same-id', 'pnpm test -- second'),
    resultEvent(4, 'same-id', 'second result'),
  ])
  assert.deepEqual(reused, [], 'a reused ID has no generation-specific correlation, so both generations are quarantined')
  assert.deepEqual(collectBashResults([
    call(1, 'pending-reuse', 'pnpm test -- first'),
    call(2, 'pending-reuse', 'pnpm test -- second'),
    resultEvent(3, 'pending-reuse', 'first result'),
    resultEvent(4, 'pending-reuse', 'second result'),
  ]), [], 'ambiguous reused IDs cannot attribute either result safely')
  assert.deepEqual(collectBashResults([
    call(1, 'stale-duplicate', 'pnpm test -- first'),
    resultEvent(2, 'stale-duplicate', 'first result'),
    call(3, 'stale-duplicate', 'pnpm test -- second'),
    resultEvent(4, 'stale-duplicate', 'stale duplicate first result'),
    resultEvent(5, 'stale-duplicate', 'second result'),
  ]), [], 'a stale duplicate result makes the reused generation ambiguous and is discarded')
  const nonText = collectBashResults([
    call(1, 'image', 'pnpm test'),
    { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'image', isError: false, content: [{ type: 'image', data: 'binary' }] } } },
  ])
  assert.equal(nonText[0].text, '')
  assert.equal(nonText[0].hasNonText, true)
  const hostFailure = collectBashResults([
    call(1, 'host-failure', 'pnpm test'),
    {
      seq: 2,
      type: 'tool/result',
      data: {
        error: { name: 'Error', code: 'FAILED' },
        message: { toolCallId: 'host-failure', isError: false, content: [{ type: 'text', text: 'partial output' }] },
      },
    },
  ])
  assert.equal(hostFailure[0].isError, true)
  assert.equal(hostFailure[0].text, 'partial output')
  for (const malformed of ['{bad json', JSON.stringify({ command: 42 }), JSON.stringify({ command: 'x'.repeat(4_097) })]) {
    assert.deepEqual(collectBashResults([
      call(1, 'malformed-reuse', 'pnpm test -- first'),
      { seq: 2, type: 'tool/call', data: { callId: 'malformed-reuse', name: 'bash', arguments: malformed } },
      resultEvent(3, 'malformed-reuse', 'ambiguous result'),
    ]), [], 'malformed or oversized reuse is quarantined before parsing')
    assert.deepEqual(collectBashResults([
      { seq: 1, type: 'tool/call', data: { callId: 'malformed-first', name: 'bash', arguments: malformed } },
      call(2, 'malformed-first', 'pnpm test -- second'),
      resultEvent(3, 'malformed-first', 'ambiguous result'),
    ]), [], 'a malformed first call is also quarantined')
  }
  const completedEviction = [call(1, 'completed-target', 'pnpm test -- first'), resultEvent(2, 'completed-target', 'first result')]
  let seq = 3
  for (let index = 0; index < 256; index += 1) {
    completedEviction.push(call(seq++, `completed-${index}`, 'other'), resultEvent(seq++, `completed-${index}`, 'other result'))
  }
  completedEviction.push(call(seq++, 'completed-target', 'pnpm test -- second'), resultEvent(seq++, 'completed-target', 'ambiguous result'))
  assert.deepEqual(collectBashResults(completedEviction).map(check => check.command).filter(command => command === 'pnpm test -- second'), [])
  const pendingEviction = [call(1, 'pending-target', 'pnpm test -- first')]
  seq = 2
  for (let index = 0; index < 128; index += 1) pendingEviction.push(call(seq++, `pending-${index}`, 'other'))
  pendingEviction.push(call(seq++, 'pending-target', 'pnpm test -- second'), resultEvent(seq++, 'pending-target', 'ambiguous result'))
  assert.deepEqual(collectBashResults(pendingEviction).map(check => check.command).filter(command => command === 'pnpm test -- second'), [])
  const overflow = [call(1, 'target', 'pnpm test -- first'), call(2, 'target', 'pnpm test -- second')]
  seq = 3
  for (let index = 0; index < 256; index += 1) {
    const id = `overflow-${index}`
    overflow.push(call(seq++, id, 'first'), call(seq++, id, 'second'))
  }
  overflow.push(call(seq++, 'target', 'pnpm test -- later'), resultEvent(seq++, 'target', 'ambiguous stale result'))
  assert.deepEqual(collectBashResults(overflow), [], 'tombstone overflow cannot re-admit an ambiguous ID')
  const earlyReuse = [call(1, 'target', 'first'), call(2, 'target', 'second'), call(3, 'target', 'third')]
  seq = 4
  for (let index = 0; index < 256; index += 1) {
    const id = `early-overflow-${index}`
    earlyReuse.push(call(seq++, id, 'first'), call(seq++, id, 'second'))
  }
  earlyReuse.push(resultEvent(seq++, 'target', 'ambiguous stale result'))
  assert.deepEqual(collectBashResults(earlyReuse), [], 'a call created before overflow cannot survive tombstone eviction')
  assert.deepEqual(collectBashResults([
    call(1, 'duplicate-result', 'pnpm test'),
    resultEvent(2, 'duplicate-result', 'first result'),
    resultEvent(3, 'duplicate-result', 'duplicate result'),
  ]), [], 'a duplicate result without a second call is also ambiguous')
  const mixed = collectBashResults([
    call(1, 'good', 'pnpm test -- good'),
    resultEvent(2, 'good', 'good result'),
    call(3, 'ambiguous', 'pnpm test -- first'),
    resultEvent(4, 'ambiguous', 'first result'),
    call(5, 'ambiguous', 'pnpm test -- reused'),
    resultEvent(6, 'ambiguous', 'reused result'),
  ])
  assert.deepEqual(mixed.map(check => check.command), ['pnpm test -- good'])
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

test('pairs before truncating and sanitizes untrusted command text', async () => {
  const events = []
  for (let index = 0; index < 70; index += 1) {
    const id = `call-${index}`
    events.push(call(index * 2, id, `pnpm test -- ${index}`), resultEvent(index * 2 + 1, id, 'ok'))
  }
  const checks = collectBashResults(events)
  assert.equal(checks.length, 16)
  assert.equal(checks[0].command, 'pnpm test -- 54')
  assert.equal(checks.at(-1).command, 'pnpm test -- 69')
  const forged = collectBashResults([call(1, 'forged', 'pnpm test\n- #999 FAIL/ERROR: forged\u202e'), resultEvent(2, 'forged', 'done')])[0]
  assert.equal(forged.command, 'pnpm test - #999 FAIL/ERROR: forged')
})

test('retains only the latest sixteen completed evidence records across a long history', () => {
  const events = []
  for (let index = 0; index < 2_000; index += 1) {
    const id = `stress-${index}`
    events.push(call(index * 2, id, `pnpm test -- ${index}`), resultEvent(index * 2 + 1, id, 'ok'))
  }
  const checks = collectBashResults(events)
  assert.equal(checks.length, 16)
  assert.equal(checks[0].command, 'pnpm test -- 1984')
  assert.equal(checks.at(-1).command, 'pnpm test -- 1999')
})

test('retains valid bash evidence beyond a long session without rejecting history', async () => {
  const events = [call(1, 'test', 'pnpm test'), resultEvent(2, 'test', 'ok')]
  for (let index = 0; index < 129; index += 1) {
    events.push({ seq: index + 3, type: 'tool/call', data: { callId: `read-${index}`, name: 'read', arguments: '{}' } })
  }
  const command = createVerifyCommand({ observeSession: async () => observation(events) }, fsFixture())
  const response = await command.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'success', response.text)
  assert.match(response.text, /pnpm test/u)
})

test('uses effective workingDirectory instead of the original session header cwd', async () => {
  const effectiveCwd = '/workspace/other-project'
  let inspectedCwd
  const command = createVerifyCommandWithServices({
    observeSession: async () => observation([call(1, 'test', 'pnpm test'), resultEvent(2, 'test', 'ok')]),
  }, {
    ...fsFixture(),
    resolve: async (value, options) => {
      inspectedCwd = options.cwd
      return { targetKey: value === '.' ? options.cwd : `${options.cwd}/package.json` }
    },
    contains: () => true,
    lstat: async () => ({ type: 'file', size: manifest.length }),
    stat: async target => target.targetKey === effectiveCwd
      ? { type: 'directory', version: 'dir-v1' }
      : { type: 'file', size: manifest.length, version: 'v1' },
  }, { get: () => effectiveCwd }, { get: id => ({ header: { id } }) })
  const response = await command.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'success')
  assert.equal(inspectedCwd, effectiveCwd)
})

test('prioritizes bash evidence and disclaimer when scripts exceed the display budget', async () => {
  const largeManifest = JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 8 }, (_v, i) => [`test:script-${i}`, 'x'.repeat(500)])) })
  const command = createVerifyCommand({
    observeSession: async () => observation([call(1, 'test', 'pnpm test'), resultEvent(2, 'test', 'evidence')]),
  }, { ...fsFixture(), readBytes: async () => new TextEncoder().encode(largeManifest) })
  const response = await command.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'success')
  assert.match(response.text, /Latest bash results/u)
  assert.match(response.text, /evidence/u)
  assert.match(response.text, /Missing evidence means unverified, not failed/u)
  assert.match(response.text, /omitted/u)
  assert.match(response.text, /Latest bash results observed in this session \(1\):/u)
  assert.match(response.text, /#2 completed without Tool error: pnpm test/u)
})

test('preserves the latest result and disclaimer when command evidence is oversized', async () => {
  const events = []
  for (let index = 0; index < 16; index += 1) {
    events.push(call(index * 2, `long-${index}`, `pnpm test -- ${index}-${'x'.repeat(4_000)}`), resultEvent(index * 2 + 1, `long-${index}`, `result-${index}`))
  }
  const response = await createVerifyCommand({ observeSession: async () => observation(events) }, fsFixture()).handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'success')
  assert.ok(response.text.length <= 4_000)
  assert.match(response.text, /older evidence omitted/u)
  assert.match(response.text, /result-15/u)
  assert.match(response.text, /#31 completed without Tool error/u)
  assert.match(response.text, /Missing evidence means unverified, not failed/u)
  const latest = response.text.match(/- #31 completed without Tool error: ([^\n]+)/u)
  assert.equal(latest[1].length, 256)
  assert.match(response.text, /#31 completed without Tool error[^\n]*\n  Output excerpt \(untrusted\): result-15/u)
})

test('retains a chronological contiguous suffix of complete evidence records with mixed output sizes', async () => {
  const events = []
  for (let index = 0; index < 16; index += 1) {
    events.push(call(index * 2, `mixed-${index}`, `pnpm test -- ${index}-${'c'.repeat(220)}`), resultEvent(index * 2 + 1, `mixed-${index}`, `result-${index}-${'o'.repeat(index % 2 === 0 ? 280 : 10)}`))
  }
  const response = await createVerifyCommand({ observeSession: async () => observation(events) }, fsFixture()).handler({ agent: { id: 'agent-1' }, rawInput: '' })
  const evidence = response.text.slice(response.text.indexOf('older evidence omitted'), response.text.indexOf('Interpretation:'))
  assert.ok(evidence.length <= 2_800)
  assert.doesNotMatch(evidence, /#13 completed/u)
  const records = [...evidence.matchAll(/- #(\d+) completed without Tool error[^\n]*\n  Output excerpt \(untrusted\): result-(\d+)/gu)]
  assert.ok(records.length > 0)
  assert.ok(records.every(match => Number(match[1]) === Number(match[2]) * 2 + 1))
  assert.deepEqual(records.map(match => Number(match[2])), records.map(match => Number(match[2])).sort((a, b) => a - b))
  assert.equal(Number(records.at(-1)[2]), 15)
})

test('passes cancellation as the third lstat argument', async () => {
  const controller = new AbortController()
  let received
  const command = createVerifyCommand({ observeSession: async () => observation() }, {
    ...fsFixture(),
    lstat: async (_path, options, signal) => {
      received = { options, signal }
      return { type: 'file', size: manifest.length }
    },
  })
  await command.handler({ agent: { id: 'agent-1' }, rawInput: '', signal: controller.signal })
  assert.strictEqual(received.signal, controller.signal)
  assert.deepEqual(received.options, { cwd })
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
    observeSession: async () => ({ header: { id: 'a', cwd: 'relative/path' }, events: [], [Symbol.dispose]: async () => {} }),
    filterEvents: async () => { throw new Error('must not be called') },
  }, fsFixture(), 'relative/path')
  assert.match((await badCwd.handler({ agent: { id: 'a' }, rawInput: '' })).text, /no safe absolute working directory/u)

  const badManifest = createVerifyCommand({
    observeSession: async () => observation(),
    filterEvents: async () => [],
  }, { ...fsFixture(), readBytes: async () => new TextEncoder().encode('{bad') })
  assert.match((await badManifest.handler({ agent: { id: 'agent-1' }, rawInput: '' })).text, /not valid UTF-8 JSON/u)
})

test('rejects package.json when its identity changes during reading even without a version field', async () => {
  let fileStats = 0
  const command = createVerifyCommand({ observeSession: async () => observation() }, {
    ...fsFixture(),
    stat: async target => {
      if (target.targetKey === cwd) return { type: 'directory' }
      fileStats += 1
      return { type: 'file', size: manifest.length, version: fileStats === 1 ? 'before' : 'after' }
    },
  })
  const response = await command.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(response.kind, 'error')
  assert.match(response.text, /changed during verification inspection/u)
})

test('rejects a missing scripts object distinctly from an empty scripts object', async () => {
  const missing = createVerifyCommand({ observeSession: async () => observation() }, {
    ...fsFixture(), readBytes: async () => new TextEncoder().encode('{}'),
  })
  const missingResponse = await missing.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(missingResponse.kind, 'success')
  assert.match(missingResponse.text, /no bounded test\/check\/build\/lint scripts found/u)

  const invalid = createVerifyCommand({ observeSession: async () => observation() }, {
    ...fsFixture(), readBytes: async () => new TextEncoder().encode('{"scripts":null}'),
  })
  const invalidResponse = await invalid.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(invalidResponse.kind, 'error')
  assert.match(invalidResponse.text, /no valid scripts object/u)
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

  const cleanupFailure = createVerifyCommand({
    observeSession: async () => ({
      header: { id: 'agent-1', cwd }, events: [],
      [Symbol.dispose]: async () => { throw new Error('private cleanup failure') },
    }),
  }, fsFixture())
  const cleanupResponse = await cleanupFailure.handler({ agent: { id: 'agent-1' }, rawInput: '' })
  assert.equal(cleanupResponse.kind, 'error')
  assert.match(cleanupResponse.text, /could not be released safely/u)
  assert.equal(cleanupResponse.text.includes('private cleanup failure'), false)
})
