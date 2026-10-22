import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskResultRegistry, createTaskResultTool } from '../src/task-result-tool.js'

function agent(id) {
  return Object.freeze({ id })
}

const result = {
  status: 'completed',
  output: 'Child answer.',
  truncated: false,
  omittedNonText: false,
  stopReason: 'completed',
}

test('tracks pending and terminal results only for the exact parent Agent', () => {
  const registry = createTaskResultRegistry()
  const parent = agent('parent-1')
  assert.equal(registry.recordStart(parent, 'child-1'), true)
  assert.deepEqual(registry.read(parent, 'child-1'), { childId: 'child-1', status: 'running' })
  assert.equal(registry.recordResult(parent, 'child-1', result), true)
  const snapshot = registry.read(parent, 'child-1')
  assert.deepEqual(snapshot, { childId: 'child-1', ...result })
  snapshot.output = 'mutated'
  assert.equal(registry.read(parent, 'child-1').output, result.output)
  assert.equal(registry.read(agent(parent.id), 'child-1'), undefined)
  assert.equal(registry.read(agent('other-parent'), 'child-1'), undefined)
})

test('keeps failures generic, rejects malformed summaries, and clears exact Agents', () => {
  const registry = createTaskResultRegistry()
  const parent = agent('parent-2')
  assert.equal(registry.recordStart(parent, 'child-2'), true)
  assert.equal(registry.recordResult(parent, 'child-2', { ...result, output: 'x'.repeat(8_193) }), false)
  assert.equal(registry.recordFailure(parent, 'child-2'), true)
  assert.deepEqual(registry.read(parent, 'child-2'), {
    childId: 'child-2', status: 'failed', output: '', truncated: false, omittedNonText: false,
  })
  assert.equal(registry.clearAgent(agent(parent.id)), false)
  assert.equal(registry.clearAgent(parent), true)
  assert.equal(registry.read(parent, 'child-2'), undefined)
  registry.recordStart(parent, 'child-after-clear')
  registry.dispose()
  assert.equal(registry.size(), 0)
  assert.equal(registry.recordStart(parent, 'child-after-dispose'), false)
})

test('failure records use one timestamp for an exact bounded expiry', () => {
  let time = 100
  const registry = createTaskResultRegistry({ now: () => time++ })
  const parent = agent('failure-expiry')
  assert.equal(registry.recordStart(parent, 'child-failure'), true)
  assert.equal(registry.recordFailure(parent, 'child-failure'), true)
  time = 101 + 30 * 60 * 1_000
  assert.equal(registry.read(parent, 'child-failure'), undefined)
})

test('retains long-running entries and expires terminal results from settlement time', () => {
  let time = 100
  const registry = createTaskResultRegistry({ now: () => time })
  const parent = agent('long-running-parent')

  assert.equal(registry.recordStart(parent, 'long-running-child'), true)
  time += 30 * 60 * 1_000 + 1
  assert.deepEqual(registry.read(parent, 'long-running-child'), {
    childId: 'long-running-child', status: 'running',
  })
  assert.equal(registry.recordStart(parent, 'another-child'), true, 'unrelated cache activity does not prune a live child')
  assert.equal(registry.recordResult(parent, 'long-running-child', result), true)

  const settledAt = time
  time = settledAt + 30 * 60 * 1_000 - 1
  assert.equal(registry.read(parent, 'long-running-child')?.status, 'completed')
  time = settledAt + 30 * 60 * 1_000
  assert.equal(registry.read(parent, 'long-running-child'), undefined, 'reading does not extend the result TTL')
})

test('caps each parent and refuses excess active records without expiring live work', () => {
  let time = 100
  const registry = createTaskResultRegistry({ now: () => time })
  const parent = agent('parent-3')
  for (let i = 0; i < 32; i += 1) assert.equal(registry.recordStart(parent, `child-${i}`), true)
  assert.equal(registry.recordStart(parent, 'child-overflow'), false)
  assert.equal(registry.recordResult(parent, 'child-0', result), true)
  assert.equal(registry.recordStart(parent, 'child-overflow'), true)
  assert.equal(registry.size(), 32)
  time += 30 * 60 * 1_000 + 1
  assert.deepEqual(registry.read(parent, 'child-overflow'), {
    childId: 'child-overflow', status: 'running',
  })
  assert.equal(registry.size(), 32)
})

test('caps parent buckets and total records, evicting completed entries before active ones', () => {
  const registry = createTaskResultRegistry()
  const parents = Array.from({ length: 64 }, (_, i) => agent(`parent-${i}`))
  for (let i = 0; i < parents.length; i += 1) {
    assert.equal(registry.recordStart(parents[i], `child-${i}`), true)
    assert.equal(registry.recordResult(parents[i], `child-${i}`, result), true)
  }
  assert.equal(registry.recordStart(agent('parent-64'), 'child-64'), true)
  assert.equal(registry.size(), 64)

  const busyRegistry = createTaskResultRegistry()
  for (let p = 0; p < 8; p += 1) {
    const owner = agent(`busy-${p}`)
    for (let c = 0; c < 32; c += 1) assert.equal(busyRegistry.recordStart(owner, `task-${p}-${c}`), true)
  }
  assert.equal(busyRegistry.size(), 256)
  assert.equal(busyRegistry.recordStart(agent('busy-extra'), 'overflow'), false)
})

test('result Tool reads only IDs tracked for its exact invoking Agent', async () => {
  const registry = createTaskResultRegistry()
  const parent = agent('parent-tool')
  registry.recordStart(parent, 'child-tool')
  const tool = createTaskResultTool(registry)
  assert.deepEqual(await tool.execute({ childId: 'child-tool' }, { agent: parent }), {
    childId: 'child-tool', status: 'running',
  })
  await assert.rejects(tool.execute({ childId: 'arbitrary-session' }, { agent: parent }), /No unexpired dsh-omo result/u)
  await assert.rejects(tool.execute({ childId: 'child-tool' }, { agent: agent(parent.id) }), /No unexpired dsh-omo result/u)
  await assert.rejects(tool.execute({ childId: 'x'.repeat(257) }, { agent: parent }), /bounded childId/u)
})
