import assert from 'node:assert/strict'
import test from 'node:test'
import { createPendingAcknowledgement } from '../src/pending-acknowledgement.js'

function setup() {
  const calls = []
  const gate = createPendingAcknowledgement({
    activate: (parent, taskId) => { calls.push(['activate', parent, taskId]); return true },
    cancel: (parent, taskId) => calls.push(['cancel', parent, taskId]),
  })
  const parent = { id: 'parent' }
  const token = Symbol('call')
  const exec = { name: 'dsh_omo_task', token, agent: parent }
  const value = { role: 'quick', status: 'pending', taskId: 'bg_example' }
  const content = [{ type: 'text', text: 'Queued bg_example.' }]
  return { gate, calls, parent, exec, value, content }
}

test('activates once only after exact final token, owner, value and content', () => {
  const f = setup()
  f.gate.track(f.exec, f.value, f.content)
  f.gate.onResult({ ...f.exec, token: Symbol('other') }, { isError: false, value: f.value, content: f.content })
  f.gate.onResult({ ...f.exec, agent: { id: f.parent.id } }, { isError: false, value: f.value, content: f.content })
  assert.deepEqual(f.calls, [])
  f.gate.onResult(f.exec, { isError: false, value: { ...f.value }, content: f.content.map(block => ({ ...block })) })
  f.gate.onResult(f.exec, { isError: false, value: f.value, content: f.content })
  assert.deepEqual(f.calls, [['activate', f.parent, f.value.taskId]])
})

test('rejects blocked, replaced and content-redacted final outcomes', () => {
  for (const change of [
    f => ({ isError: true, error: { message: 'blocked' }, content: [] }),
    f => ({ isError: false, value: { ...f.value, taskId: 'bg_other' }, content: f.content }),
    f => ({ isError: false, value: f.value, content: [{ type: 'text', text: 'redacted' }] }),
    f => ({ isError: false, value: { ...f.value, extra: 'x' }, content: f.content }),
  ]) {
    const f = setup()
    f.gate.track(f.exec, f.value, f.content)
    f.gate.onResult(f.exec, change(f))
    assert.deepEqual(f.calls, [['cancel', f.parent, f.value.taskId]])
  }
})

test('clearing an owner or expiring a task releases acknowledgement capacity', () => {
  const f = setup()
  f.gate.track(f.exec, f.value, f.content)
  f.gate.forgetTask(f.value.taskId)
  f.gate.onResult(f.exec, { isError: false, value: f.value, content: f.content })
  assert.deepEqual(f.calls, [])
  f.gate.track(f.exec, f.value, f.content)
  f.gate.clearAgent(f.parent)
  assert.deepEqual(f.calls, [['cancel', f.parent, f.value.taskId]])
  f.gate.onResult(f.exec, { isError: false, value: f.value, content: f.content })
  assert.equal(f.calls.length, 1)
})
