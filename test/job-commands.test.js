import assert from 'node:assert/strict'
import test from 'node:test'
import { createJobKillCommand } from '../src/job-commands.js'

const SESSION_ID = 'session-current'

function makeCommand(kill) {
  const calls = []
  const command = createJobKillCommand({
    kill(request) {
      calls.push(request)
      return kill(request)
    },
  })
  return { command, calls }
}

test('human job-kill command derives the session fence from the invoking Agent and reports Host outcomes', () => {
  const outcomes = [{ outcome: 'requested' }, { outcome: 'already-finished' }]
  const fixture = makeCommand(() => outcomes.shift())
  assert.equal(fixture.command.name, 'omo-job-kill')
  assert.deepEqual(fixture.command.input, { hint: '<jobId>' })
  assert.match(fixture.command.description, /Human-only/u)
  assert.match(fixture.command.description, /not a model tool/u)

  const requested = fixture.command.handler({ agent: { id: SESSION_ID }, rawInput: '  job-1  ' })
  assert.deepEqual(fixture.calls, [{ sessionId: SESSION_ID, jobId: 'job-1' }])
  assert.equal(requested.kind, 'success')
  assert.match(requested.text, /accepted the kill request/u)
  assert.match(requested.text, /does not confirm termination/u)
  assert.match(requested.text, /completion notice to the owning Agent/u)

  const alreadyFinished = fixture.command.handler({ agent: { id: SESSION_ID }, rawInput: 'job-2' })
  assert.deepEqual(fixture.calls[1], { sessionId: SESSION_ID, jobId: 'job-2' })
  assert.equal(alreadyFinished.kind, 'success')
  assert.match(alreadyFinished.text, /already finished/u)
  assert.match(alreadyFinished.text, /no kill request was needed/u)
})

test('human job-kill command rejects malformed IDs and missing Agents before Host calls', () => {
  let calls = 0
  const command = createJobKillCommand({ kill() { calls += 1; return { outcome: 'requested' } } })
  for (const rawInput of [undefined, null, '', '   ', 'job-1 job-2', 'x'.repeat(257)]) {
    assert.equal(command.handler({ agent: { id: SESSION_ID }, rawInput }).kind, 'error')
  }
  assert.equal(command.handler({ rawInput: 'job-1' }).kind, 'error')
  assert.equal(command.handler({ agent: { id: '' }, rawInput: 'job-1' }).kind, 'error')
  assert.equal(calls, 0)
})

test('human job-kill command rejects raw NUL/C0/C1 controls before trimming or Host calls', () => {
  const fixture = makeCommand(() => ({ outcome: 'requested' }))
  const invalidInputs = [
    'job\u0000-1',
    'job\u0001-1',
    'job-1\n',
    ' \tjob-1',
    'job\u007f-1',
    'job\u0085-1',
    '\u009fjob-1',
  ]
  for (const rawInput of invalidInputs) {
    const result = fixture.command.handler({ agent: { id: SESSION_ID }, rawInput })
    assert.equal(result.kind, 'error', `reject ${JSON.stringify(rawInput)}`)
    assert.match(result.text, /exactly one non-empty DSH job ID/u)
    assert.deepEqual(fixture.calls, [], `do not call Host for ${JSON.stringify(rawInput)}`)
  }
})

test('human job-kill command fails closed on Host errors and malformed outcomes', () => {
  assert.throws(() => createJobKillCommand({}), /jobController\.kill/u)

  const thrown = createJobKillCommand({ kill() { throw new Error('private host detail') } })
    .handler({ agent: { id: SESSION_ID }, rawInput: 'job-1' })
  assert.equal(thrown.kind, 'error')
  assert.doesNotMatch(thrown.text, /private host detail/u)

  const malformed = createJobKillCommand({ kill() { return { outcome: 'killed' } } })
    .handler({ agent: { id: SESSION_ID }, rawInput: 'job-1' })
  assert.equal(malformed.kind, 'error')
  assert.match(malformed.text, /invalid cancellation result/u)
})
