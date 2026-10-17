import assert from 'node:assert/strict'
import test from 'node:test'
import { createContinuableTaskRegistry } from '../src/continuable-task-registry.js'

test('accepts only nonempty IDs up to 256 UTF-16 code units', () => {
  const registry = createContinuableTaskRegistry()
  const maxId = 'x'.repeat(256)
  const tooLongId = 'x'.repeat(257)
  const surrogatePairId = '😀'.repeat(128)
  const tooManySurrogatePairs = '😀'.repeat(129)

  assert.equal(registry.record(maxId, surrogatePairId), true)
  assert.deepEqual(registry.reserveSend(maxId, surrogatePairId), { status: 'reserved' })
  assert.equal(registry.record('', 'child'), false)
  assert.equal(registry.record('   ', 'child'), false)
  assert.equal(registry.record('parent', ''), false)
  assert.equal(registry.record('parent', tooLongId), false)
  assert.equal(registry.record(tooLongId, 'child'), false)
  assert.deepEqual(registry.reserveSend('parent', tooManySurrogatePairs), { status: 'invalid' })
  assert.deepEqual(registry.reserveSend(null, 'child'), { status: 'invalid' })
})

test('evicts the least-recently-used parent at the 64-record cap', () => {
  const registry = createContinuableTaskRegistry()
  for (let index = 0; index < 64; index += 1) {
    assert.equal(registry.record(`parent-${index}`, `child-${index}`), true)
  }

  assert.deepEqual(registry.reserveSend('parent-0', 'child-0'), { status: 'reserved' })
  assert.equal(registry.record('parent-64', 'child-64'), true)
  assert.deepEqual(registry.reserveSend('parent-0', 'child-0'), { status: 'reserved' })
  assert.deepEqual(registry.reserveSend('parent-1', 'child-1'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend('parent-64', 'child-64'), { status: 'reserved' })
})

test('evicts the least-recently-used child at the 32-child parent cap', () => {
  const registry = createContinuableTaskRegistry()
  for (let index = 0; index < 32; index += 1) registry.record('parent', `child-${index}`)

  assert.deepEqual(registry.reserveSend('parent', 'child-0'), { status: 'reserved' })
  assert.equal(registry.record('parent', 'child-32'), true)
  assert.deepEqual(registry.reserveSend('parent', 'child-0'), { status: 'reserved' })
  assert.deepEqual(registry.reserveSend('parent', 'child-1'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend('parent', 'child-32'), { status: 'reserved' })
})

test('evicts the least-recently-used child at the 128-child global cap', () => {
  const registry = createContinuableTaskRegistry()
  for (let parent = 0; parent < 4; parent += 1) {
    for (let child = 0; child < 32; child += 1) {
      registry.record(`parent-${parent}`, `child-${child}`)
    }
  }

  assert.deepEqual(registry.reserveSend('parent-0', 'child-0'), { status: 'reserved' })
  assert.equal(registry.record('parent-4', 'child-0'), true)
  assert.deepEqual(registry.reserveSend('parent-0', 'child-0'), { status: 'reserved' })
  assert.deepEqual(registry.reserveSend('parent-0', 'child-1'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend('parent-4', 'child-0'), { status: 'reserved' })
})

test('reserves at most eight sends per child and 32 per parent', () => {
  const registry = createContinuableTaskRegistry()
  for (let index = 0; index < 5; index += 1) registry.record('parent', `child-${index}`)

  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.deepEqual(registry.reserveSend('parent', 'child-0'), { status: 'reserved' })
  }
  assert.deepEqual(registry.reserveSend('parent', 'child-0'), { status: 'quota' })

  for (const childId of ['child-1', 'child-2', 'child-3']) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      assert.deepEqual(registry.reserveSend('parent', childId), { status: 'reserved' })
    }
  }
  assert.deepEqual(registry.reserveSend('parent', 'child-4'), { status: 'quota' })
})

test('plugin-instance send quota survives parent-record LRU eviction', () => {
  const registry = createContinuableTaskRegistry()
  for (let parent = 0; parent < 8; parent += 1) {
    for (let child = 0; child < 4; child += 1) registry.record(`parent-${parent}`, `child-${child}`)
  }
  for (let parent = 0; parent < 8; parent += 1) {
    for (let child = 0; child < 4; child += 1) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        assert.deepEqual(registry.reserveSend(`parent-${parent}`, `child-${child}`), { status: 'reserved' })
      }
    }
  }
  for (let index = 0; index < 57; index += 1) registry.record(`extra-parent-${index}`, `extra-child-${index}`)
  assert.deepEqual(registry.reserveSend('parent-0', 'child-0'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend('extra-parent-56', 'extra-child-56'), { status: 'quota' })
  assert.equal(registry.clearAgent({ id: 'extra-parent-56' }), true)
  assert.equal(registry.record('extra-parent-56', 'fresh-child'), true)
  assert.deepEqual(registry.reserveSend('extra-parent-56', 'fresh-child'), { status: 'quota' })
})

test('distinguishes unseen children and removes only the requested child', () => {
  const registry = createContinuableTaskRegistry()
  assert.deepEqual(registry.reserveSend('parent', 'unseen'), { status: 'untracked' })
  assert.equal(registry.remove('parent', 'unseen'), false)

  assert.equal(registry.record('parent', 'child'), true)
  assert.equal(registry.record('other-parent', 'child'), true)
  assert.equal(registry.remove('parent', 'child'), true)
  assert.deepEqual(registry.reserveSend('parent', 'child'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend('other-parent', 'child'), { status: 'reserved' })
  assert.equal(registry.record('parent', 'child'), true)
  assert.deepEqual(registry.reserveSend('parent', 'child'), { status: 'reserved' })
})

test('clears only the disposed parent record, preserving child IDs elsewhere', () => {
  const registry = createContinuableTaskRegistry()
  registry.record('parent-1', 'persistent-child')
  registry.record('parent-2', 'persistent-child')

  assert.equal(registry.clearAgent({ id: 'persistent-child' }), false)
  assert.deepEqual(registry.reserveSend('parent-1', 'persistent-child'), { status: 'reserved' })
  assert.equal(registry.clearAgent({ id: 'parent-1' }), true)
  assert.deepEqual(registry.reserveSend('parent-1', 'persistent-child'), { status: 'untracked' })
  assert.deepEqual(registry.reserveSend('parent-2', 'persistent-child'), { status: 'reserved' })
  assert.equal(registry.clearAgent({ id: '' }), false)
})

test('permanent disposal clears the registry and blocks future records or reservations', () => {
  const registry = createContinuableTaskRegistry()
  registry.record('parent', 'child')
  registry.dispose()
  registry.dispose()

  assert.equal(registry.record('parent', 'child'), false)
  assert.deepEqual(registry.reserveSend('parent', 'child'), { status: 'disposed' })
  assert.equal(registry.remove('parent', 'child'), false)
  assert.equal(registry.clearAgent({ id: 'parent' }), false)
  assert.deepEqual(registry.reserveSend('', 'child'), { status: 'invalid' })
})
