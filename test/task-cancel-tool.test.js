import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskCancelTool } from '../src/task-cancel-tool.js'

function agent(id) {
  return Object.freeze({ id })
}

function fixture() {
  const interrupts = []
  const parent = agent('parent-1')
  const other = agent('parent-2')
  const activeRuns = new Map([['child-1', { id: 'child-1' }]])
  const activeRunOwners = new Map([['child-1', parent]])
  const tool = createTaskCancelTool({
    subagents: { interrupt: (childId, authority) => interrupts.push({ childId, authority }) },
    activeRuns,
    activeRunOwners,
  })
  return { tool, parent, other, activeRuns, activeRunOwners, interrupts }
}

test('requests interruption only for a tracked active one-shot child owned by the exact Agent', async () => {
  const state = fixture()
  assert.deepEqual(await state.tool.execute({ childId: 'child-1' }, { agent: state.parent }), {
    childId: 'child-1', status: 'interrupt-requested',
  })
  assert.deepEqual(state.interrupts, [{
    childId: 'child-1', authority: { kind: 'ancestor', agent: state.parent },
  }])
  assert.match(state.tool.output.render({}, { childId: 'child-1', status: 'interrupt-requested' })[0].text, /does not prove the child has stopped/u)
})

test('rejects arbitrary, settled, cross-Agent, malformed, and canceled requests before Host interruption', async () => {
  const state = fixture()
  await assert.rejects(state.tool.execute({ childId: 'child-1' }, { agent: agent(state.parent.id) }), /No active dsh-omo one-shot child/u)
  await assert.rejects(state.tool.execute({ childId: 'child-1' }, { agent: state.other }), /No active dsh-omo one-shot child/u)
  await assert.rejects(state.tool.execute({ childId: 'other-session' }, { agent: state.parent }), /No active dsh-omo one-shot child/u)
  await assert.rejects(state.tool.execute({ childId: 'x'.repeat(257) }, { agent: state.parent }), /bounded childId/u)
  await assert.rejects(state.tool.execute({ childId: 'child-1' }, { agent: state.parent, signal: AbortSignal.abort() }), /cancelled before interruption/u)
  state.activeRuns.delete('child-1')
  await assert.rejects(state.tool.execute({ childId: 'child-1' }, { agent: state.parent }), /No active dsh-omo one-shot child/u)
  assert.equal(state.interrupts.length, 0)
})

test('fails closed and hides raw Host errors', async () => {
  const parent = agent('parent-error')
  const tool = createTaskCancelTool({
    subagents: { interrupt() { throw new Error('private Host detail') } },
    activeRuns: new Map([['child-error', {}]]),
    activeRunOwners: new Map([['child-error', parent]]),
  })
  await assert.rejects(tool.execute({ childId: 'child-error' }, { agent: parent }), /DSH did not accept the interruption request/u)
  await assert.rejects(tool.execute({ childId: 'child-error' }, { agent: undefined }), /exact calling Agent/u)
})
