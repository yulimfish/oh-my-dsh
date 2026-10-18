import assert from 'node:assert/strict'
import test from 'node:test'
import { createContinuableTaskRegistry } from '../src/continuable-task-registry.js'

const makeAgent = id => ({ id })

test('accepts only nonempty IDs up to 256 UTF-16 code units', () => {
  const registry = createContinuableTaskRegistry()
  const maxId = 'x'.repeat(256)
  const tooLongId = 'x'.repeat(257)
  const surrogatePairId = '😀'.repeat(128)
  const tooManySurrogatePairs = '😀'.repeat(129)
  const parent = makeAgent(maxId)

  assert.equal(registry.record(parent, surrogatePairId), true)
  assert.deepEqual(registry.reserveSend(parent, surrogatePairId), { status: 'reserved' })
  assert.equal(registry.record(null, 'child'), false)
  assert.equal(registry.record(makeAgent('   '), 'child'), false)
  assert.equal(registry.record(makeAgent('parent'), ''), false)
  assert.equal(registry.record(makeAgent('parent'), tooLongId), false)
  assert.equal(registry.record(makeAgent(tooLongId), 'child'), false)
  assert.deepEqual(registry.reserveSend(makeAgent('parent'), tooManySurrogatePairs), { status: 'invalid' })
  assert.deepEqual(registry.reserveSend(null, 'child'), { status: 'invalid' })
})

test('evicts the least-recently-used parent at the 64-record cap', () => {
  const registry = createContinuableTaskRegistry()
  const parents = Array.from({ length: 65 }, (_value, index) => makeAgent(`parent-${index}`))
  for (let index = 0; index < 64; index += 1) {
    assert.equal(registry.record(parents[index], `child-${index}`), true)
  }

  assert.deepEqual(registry.reserveSend(parents[0], 'child-0'), { status: 'reserved' })
  assert.equal(registry.record(parents[64], 'child-64'), true)
  assert.deepEqual(registry.reserveSend(parents[0], 'child-0'), { status: 'reserved' })
  assert.deepEqual(registry.reserveSend(parents[1], 'child-1'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend(parents[64], 'child-64'), { status: 'reserved' })
})

test('evicts the least-recently-used child at the 32-child parent cap', () => {
  const registry = createContinuableTaskRegistry()
  const parent = makeAgent('parent')
  for (let index = 0; index < 32; index += 1) registry.record(parent, `child-${index}`)

  assert.deepEqual(registry.reserveSend(parent, 'child-0'), { status: 'reserved' })
  assert.equal(registry.record(parent, 'child-32'), true)
  assert.deepEqual(registry.reserveSend(parent, 'child-0'), { status: 'reserved' })
  assert.deepEqual(registry.reserveSend(parent, 'child-1'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend(parent, 'child-32'), { status: 'reserved' })
})

test('evicts the least-recently-used child at the 128-child global cap', () => {
  const registry = createContinuableTaskRegistry()
  const parents = Array.from({ length: 5 }, (_value, index) => makeAgent(`parent-${index}`))
  for (let parent = 0; parent < 4; parent += 1) {
    for (let child = 0; child < 32; child += 1) {
      registry.record(parents[parent], `child-${child}`)
    }
  }

  assert.deepEqual(registry.reserveSend(parents[0], 'child-0'), { status: 'reserved' })
  assert.equal(registry.record(parents[4], 'child-0'), true)
  assert.deepEqual(registry.reserveSend(parents[0], 'child-0'), { status: 'reserved' })
  assert.deepEqual(registry.reserveSend(parents[0], 'child-1'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend(parents[4], 'child-0'), { status: 'reserved' })
})

test('reserves at most eight sends per child and 32 per parent', () => {
  const registry = createContinuableTaskRegistry()
  const parent = makeAgent('parent')
  for (let index = 0; index < 5; index += 1) registry.record(parent, `child-${index}`)

  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.deepEqual(registry.reserveSend(parent, 'child-0'), { status: 'reserved' })
  }
  assert.deepEqual(registry.reserveSend(parent, 'child-0'), { status: 'quota' })

  for (const childId of ['child-1', 'child-2', 'child-3']) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      assert.deepEqual(registry.reserveSend(parent, childId), { status: 'reserved' })
    }
  }
  assert.deepEqual(registry.reserveSend(parent, 'child-4'), { status: 'quota' })
})

test('plugin-instance send quota survives parent-record LRU eviction', () => {
  const registry = createContinuableTaskRegistry()
  const parents = Array.from({ length: 8 }, (_value, index) => makeAgent(`parent-${index}`))
  for (let parent = 0; parent < 8; parent += 1) {
    for (let child = 0; child < 4; child += 1) registry.record(parents[parent], `child-${child}`)
  }
  for (let parent = 0; parent < 8; parent += 1) {
    for (let child = 0; child < 4; child += 1) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        assert.deepEqual(registry.reserveSend(parents[parent], `child-${child}`), { status: 'reserved' })
      }
    }
  }
  const extraParents = Array.from({ length: 57 }, (_value, index) => makeAgent(`extra-parent-${index}`))
  for (let index = 0; index < extraParents.length; index += 1) registry.record(extraParents[index], `extra-child-${index}`)
  assert.deepEqual(registry.reserveSend(parents[0], 'child-0'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend(extraParents[56], 'extra-child-56'), { status: 'quota' })
  assert.equal(registry.clearAgent(extraParents[56]), true)
  const replacement = makeAgent(extraParents[56].id)
  assert.equal(registry.record(replacement, 'fresh-child'), true)
  assert.deepEqual(registry.reserveSend(replacement, 'fresh-child'), { status: 'quota' })
})

test('distinguishes unseen children and removes only the requested child', () => {
  const registry = createContinuableTaskRegistry()
  const parent = makeAgent('parent')
  const otherParent = makeAgent('other-parent')
  assert.deepEqual(registry.reserveSend(parent, 'unseen'), { status: 'untracked' })
  assert.equal(registry.remove(parent, 'unseen'), false)

  assert.equal(registry.record(parent, 'child'), true)
  assert.equal(registry.record(otherParent, 'child'), true)
  assert.equal(registry.remove(parent, 'child'), true)
  assert.deepEqual(registry.reserveSend(parent, 'child'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend(otherParent, 'child'), { status: 'reserved' })
  assert.equal(registry.record(parent, 'child'), true)
  assert.deepEqual(registry.reserveSend(parent, 'child'), { status: 'reserved' })
})

test('clears only the disposed parent record, preserving child IDs elsewhere', () => {
  const registry = createContinuableTaskRegistry()
  const parent1 = makeAgent('parent-1')
  const parent2 = makeAgent('parent-2')
  registry.record(parent1, 'persistent-child')
  registry.record(parent2, 'persistent-child')

  assert.equal(registry.clearAgent(makeAgent('persistent-child')), false)
  assert.deepEqual(registry.reserveSend(parent1, 'persistent-child'), { status: 'reserved' })
  assert.equal(registry.clearAgent(parent1), true)
  assert.deepEqual(registry.reserveSend(parent1, 'persistent-child'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend(parent2, 'persistent-child'), { status: 'reserved' })
  assert.equal(registry.clearAgent(makeAgent('')), false)
})

test('same-ID parent replacement starts fresh; late disposal and stale operations cannot affect it', () => {
  const registry = createContinuableTaskRegistry()
  const oldAgent = makeAgent('reused-parent')
  assert.equal(registry.record(oldAgent, 'old-child'), true)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.deepEqual(registry.reserveSend(oldAgent, 'old-child'), { status: 'reserved' })
  }
  assert.deepEqual(registry.reserveSend(oldAgent, 'old-child'), { status: 'quota' })

  const replacement = makeAgent(oldAgent.id)
  assert.equal(registry.record(replacement, 'new-child'), true)
  assert.deepEqual(registry.reserveSend(replacement, 'old-child'), { status: 'untracked' }, 'old child IDs cannot be followed up through a replacement Agent')
  assert.deepEqual(registry.reserveSend(oldAgent, 'old-child'), { status: 'untracked' })
  assert.equal(registry.remove(oldAgent, 'new-child'), false)
  assert.deepEqual(registry.reserveSend(replacement, 'new-child'), { status: 'reserved' }, 'replacement starts with a fresh per-parent quota')

  assert.equal(registry.clearAgent(oldAgent), false, 'late disposal does not clear the replacement parent record')
  assert.equal(registry.record(oldAgent, 'late-old-child'), false, 'a disposed old Agent cannot recreate its stale parent record')
  assert.deepEqual(registry.reserveSend(oldAgent, 'new-child'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend(replacement, 'new-child'), { status: 'reserved' })
  assert.equal(registry.clearAgent(replacement), true)
  assert.deepEqual(registry.reserveSend(replacement, 'new-child'), { status: 'untracked' })
})

test('permanent disposal clears the registry and blocks future records or reservations', () => {
  const registry = createContinuableTaskRegistry()
  const parent = makeAgent('parent')
  registry.record(parent, 'child')
  registry.dispose()
  registry.dispose()

  assert.equal(registry.record(parent, 'child'), false)
  assert.deepEqual(registry.reserveSend(parent, 'child'), { status: 'disposed' })
  assert.equal(registry.remove(parent, 'child'), false)
  assert.equal(registry.clearAgent(parent), false)
  assert.deepEqual(registry.reserveSend(makeAgent(''), 'child'), { status: 'invalid' })
})
