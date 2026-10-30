import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskJobMonitor } from '../src/task-job-monitor.js'

const PRIVATE_OUTPUT = 'PRIVATE_CHILD_BODY_MUST_NOT_ENTER_JOB_OUTPUT'
const PRIVATE_ERROR = 'PRIVATE_RAW_ERROR_MUST_NOT_ENTER_JOB_DETAIL'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function agent(id = 'parent-1') {
  return Object.freeze({ id })
}

function fixture({ result = new Promise(() => {}), jobs: overrides = {}, logger } = {}) {
  const parent = agent()
  const run = { id: 'child-1', result }
  const calls = {
    starts: [],
    waits: [],
    interrupts: [],
    warnings: [],
    removes: 0,
    appends: 0,
    progress: 0,
  }
  const jobs = {
    start(spec) {
      calls.starts.push(spec)
      calls.hooks = spec.run({
        append() { calls.appends += 1 },
        updateProgress() { calls.progress += 1 },
      })
      return 'omo-subagent-job-1'
    },
    wait(...args) {
      calls.waits.push(args)
      return new Promise(() => {})
    },
    remove() { calls.removes += 1 },
    ...overrides,
  }
  const monitor = createTaskJobMonitor({
    jobs,
    subagents: {
      interrupt(...args) { calls.interrupts.push(args) },
    },
    logger: logger ?? { warn(message) { calls.warnings.push(message) } },
  })
  const input = { run, parent, role: 'reviewer', task: 'Inspect the bounded change' }
  return { monitor, input, run, parent, calls }
}

test('starts one mirror and synchronously installs exactly one owner-fenced long waiter', async () => {
  const child = deferred()
  const state = fixture({ result: child.promise })

  assert.equal(state.monitor.start(state.input), 'omo-subagent-job-1')
  assert.equal(state.calls.starts.length, 1)
  assert.equal(state.calls.waits.length, 1, 'wait is called before the child settles')
  assert.deepEqual(state.calls.waits[0], ['omo-subagent-job-1', 2_147_483_647, state.parent.id])
  const spec = state.calls.starts[0]
  assert.equal(spec.kind, 'omo-subagent')
  assert.equal(spec.owner, state.parent.id)
  assert.equal(spec.label, 'OMO reviewer: Inspect the bounded change')
  assert.equal('output' in spec, false)
  assert.equal('result' in state.calls.hooks.done, false)

  child.resolve({ stopReason: 'completed', output: [{ type: 'text', text: PRIVATE_OUTPUT }] })
  assert.deepEqual(await state.calls.hooks.done, { status: 'completed' })
  assert.equal(state.calls.waits.length, 1)
  assert.equal(state.calls.removes, 0, 'settled jobs remain owned by the native Jobs lifecycle')
})

test('the retained waiter marks native settlement collected instead of requesting another notice', async () => {
  const child = deferred()
  const parent = agent()
  const run = { id: 'child-native', result: child.promise }
  const waiters = new Set()
  let job
  let settledEvent
  const jobs = {
    start(spec) {
      const hooks = spec.run()
      job = { id: 'omo-subagent-native', owner: spec.owner, status: 'running' }
      void hooks.done.then(outcome => {
        job = { ...job, ...outcome }
        for (const resolve of waiters) resolve(job)
        settledEvent = { type: 'settled', job, awaited: waiters.size > 0 }
        waiters.clear()
      })
      return job.id
    },
    wait(id, timeout, owner) {
      assert.equal(id, job.id)
      assert.equal(owner, parent.id)
      if (job.status !== 'running') return Promise.resolve(job)
      return new Promise(resolve => waiters.add(resolve))
    },
  }
  const monitor = createTaskJobMonitor({ jobs, subagents: { interrupt() {} } })
  monitor.start({ run, parent, role: 'quick', task: 'Collect native terminal status' })
  child.resolve({ stopReason: 'completed', output: [{ type: 'text', text: PRIVATE_OUTPUT }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settledEvent?.awaited, true, 'tool-jobs skips a settlement already collected by a waiter')
  assert.equal(settledEvent?.job.status, 'completed')
})

test('maps aborted and every non-completed stop reason to native terminal outcomes', async () => {
  const cases = [
    ['aborted', { status: 'killed', detail: 'aborted' }],
    ['max-tokens', { status: 'failed', detail: 'max-tokens' }],
    ['error', { status: 'failed', detail: 'error' }],
    [undefined, { status: 'failed' }],
  ]
  for (const [stopReason, expected] of cases) {
    const state = fixture({ result: Promise.resolve({ stopReason, output: PRIVATE_OUTPUT }) })
    state.monitor.start(state.input)
    assert.deepEqual(await state.calls.hooks.done, expected)
  }
})

test('maps child rejection to a safe error name without the raw error or output', async () => {
  const failure = new Error(PRIVATE_ERROR)
  failure.name = 'ProviderFailure'
  const state = fixture({ result: Promise.reject(failure) })
  state.monitor.start(state.input)

  const outcome = await state.calls.hooks.done
  assert.deepEqual(outcome, { status: 'failed', detail: 'ProviderFailure' })
  assert.equal(JSON.stringify(outcome).includes(PRIVATE_ERROR), false)
  assert.equal(JSON.stringify(outcome).includes(PRIVATE_OUTPUT), false)

  const nonError = fixture({ result: Promise.reject(PRIVATE_ERROR) })
  nonError.monitor.start(nonError.input)
  assert.deepEqual(await nonError.calls.hooks.done, { status: 'failed', detail: 'UnknownError' })
})

test('cancel requests exact ancestor interruption fire-and-return', () => {
  const state = fixture()
  state.monitor.start(state.input)

  const returned = state.calls.hooks.cancel('native cancellation reason')
  assert.equal(returned, undefined)
  assert.deepEqual(state.calls.interrupts, [[
    state.run.id,
    { kind: 'ancestor', agent: state.parent },
  ]])
  assert.equal(state.calls.removes, 0)
})

test('bounds and flattens labels, stop reasons, error names, and diagnostics', async () => {
  const bidi = String.fromCodePoint(0x202e)
  const labelled = fixture()
  labelled.input.role = `review\n${bidi}er`
  labelled.input.task = ` first line\r\nsecond${bidi} ${'x'.repeat(300)} `
  labelled.monitor.start(labelled.input)
  const label = labelled.calls.starts[0].label
  assert.ok(label.startsWith('OMO review er: first line second '))
  assert.ok(label.length <= 240)
  assert.doesNotMatch(label, /[\r\n\u202e]/u)

  const stopped = fixture({
    result: Promise.resolve({ stopReason: ` failure\n${bidi}${'r'.repeat(100)} ` }),
  })
  stopped.monitor.start(stopped.input)
  const stoppedOutcome = await stopped.calls.hooks.done
  assert.equal(stoppedOutcome.status, 'failed')
  assert.ok(stoppedOutcome.detail.startsWith('failure r'))
  assert.equal(stoppedOutcome.detail.length, 80)
  assert.doesNotMatch(stoppedOutcome.detail, /[\r\n\u202e]/u)

  const longName = new Error(PRIVATE_ERROR)
  longName.name = 'E'.repeat(100)
  const rejected = fixture({ result: Promise.reject(longName) })
  rejected.monitor.start(rejected.input)
  const boundedName = await rejected.calls.hooks.done
  assert.ok(boundedName.detail.length <= 64)
  assert.doesNotMatch(boundedName.detail, /PRIVATE|[\r\n]/u)

  const unsafeName = new Error(PRIVATE_ERROR)
  unsafeName.name = `Bad\n${PRIVATE_OUTPUT}`
  const unsafe = fixture({ result: Promise.reject(unsafeName) })
  unsafe.monitor.start(unsafe.input)
  assert.deepEqual(await unsafe.calls.hooks.done, { status: 'failed', detail: 'Error' })

  const waitFailure = new Error(PRIVATE_ERROR)
  waitFailure.name = `Wait\n${PRIVATE_OUTPUT}`
  const waiting = fixture({ jobs: { wait() { return Promise.reject(waitFailure) } } })
  waiting.monitor.start(waiting.input)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(waiting.calls.warnings.length, 1)
  assert.ok(waiting.calls.warnings[0].length <= 160)
  assert.doesNotMatch(waiting.calls.warnings[0], /PRIVATE|[\r\n]/u)
})

test('missing jobs or interruption services decline start without touching the child', async () => {
  const child = deferred()
  const parent = agent()
  const input = { run: { id: 'child-missing', result: child.promise }, parent, role: 'quick', task: 'Continue' }
  let starts = 0
  const jobs = {
    start() { starts += 1; return 'job-unused' },
    wait() { return new Promise(() => {}) },
  }
  const subagents = { interrupt() {} }
  const variants = [
    { jobs: undefined, subagents },
    { jobs: { wait: jobs.wait }, subagents },
    { jobs: { start: jobs.start }, subagents },
    { jobs, subagents: undefined },
    { jobs, subagents: {} },
  ]
  for (const services of variants) {
    const monitor = createTaskJobMonitor(services)
    assert.equal(monitor.start(input), undefined)
  }
  assert.equal(starts, 0, 'preflight fails before registering a partial mirror')

  const result = { stopReason: 'completed', output: PRIVATE_OUTPUT }
  child.resolve(result)
  assert.equal(await child.promise, result)
})

test('jobs start and synchronous wait failures are isolated from the child', async () => {
  const startFailure = new Error(PRIVATE_ERROR)
  startFailure.name = 'StartFailure'
  const startBroken = fixture({ jobs: { start() { throw startFailure } } })
  assert.equal(startBroken.monitor.start(startBroken.input), undefined)
  assert.deepEqual(startBroken.run, { id: 'child-1', result: startBroken.run.result })
  assert.equal(startBroken.calls.warnings.length, 1)
  assert.doesNotMatch(startBroken.calls.warnings[0], /PRIVATE/u)

  const child = deferred()
  const waitFailure = new Error(PRIVATE_ERROR)
  waitFailure.name = 'WaitFailure'
  const waitBroken = fixture({
    result: child.promise,
    jobs: { wait() { throw waitFailure } },
  })
  assert.doesNotThrow(() => waitBroken.monitor.start(waitBroken.input))
  assert.equal(waitBroken.calls.warnings.length, 1)
  assert.doesNotMatch(waitBroken.calls.warnings[0], /PRIVATE/u)
  child.resolve({ stopReason: 'completed', output: PRIVATE_OUTPUT })
  assert.deepEqual(await waitBroken.calls.hooks.done, { status: 'completed' })
  assert.equal(waitBroken.calls.removes, 0)
})

test('mirror never emits child body through output, progress, outcome, or logs', async () => {
  const state = fixture({ result: Promise.resolve({ stopReason: 'completed', output: PRIVATE_OUTPUT }) })
  state.monitor.start(state.input)
  const outcome = await state.calls.hooks.done
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(state.calls.appends, 0)
  assert.equal(state.calls.progress, 0)
  assert.equal(state.calls.warnings.length, 0)
  assert.equal('result' in outcome, false)
  assert.equal('output' in outcome, false)
  const visible = JSON.stringify({
    spec: { ...state.calls.starts[0], run: undefined },
    outcome,
    warnings: state.calls.warnings,
  })
  assert.equal(visible.includes(PRIVATE_OUTPUT), false)
})
