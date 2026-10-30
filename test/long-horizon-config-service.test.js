import assert from 'node:assert/strict'
import test from 'node:test'
import { createLongHorizonConfigService } from '../src/long-horizon-config-service.js'

function fixture(overrides = {}) {
  const entry = { id: 'dsh-omo', patchId: 'dsh-omo' }
  const state = {
    enableTaskResultTool: false,
    enableFocusChain: false,
    enableRepeatedCallAdvisory: false,
    enableProgressContext: false,
    enableGoalCompletionReview: false,
    enableVerifyCommand: false,
    enableTaskHandoffCommand: false,
    maxConcurrent: 4,
    ...overrides,
  }
  const editor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: { enableProgressContext: true, maxTaskChars: 9000 }, override: { ...state } }],
    async edit(target, change) {
      assert.equal(target, entry)
      Object.assign(state, change({ ...state }, {}))
    },
  }
  return { editor, state, service: createLongHorizonConfigService(editor) }
}

test('reads enabled settings and preserves unrelated configuration', async () => {
  const { service, state } = fixture({ enableFocusChain: true, enableVerifyCommand: true })
  delete state.enableProgressContext
  const result = await service.read()
  assert.equal(result.found, true)
  assert.equal(result.values.enableFocusChain, true)
  assert.equal(result.values.enableVerifyCommand, true)
  assert.equal(result.values.enableProgressContext, true, 'inherited settings remain visible until explicitly overridden')
  assert.equal(result.values.enableTaskResultTool, false)
})

test('enabling handoff enables its task-result prerequisite and preserves other fields', async () => {
  const { service, state } = fixture({ enableFocusChain: true })
  const result = await service.update({ enableTaskHandoffCommand: true })
  assert.equal(result.values.enableTaskHandoffCommand, true)
  assert.equal(result.values.enableTaskResultTool, true)
  assert.equal(state.enableFocusChain, true)
  assert.equal(state.maxConcurrent, 4)
})

test('disabling the prerequisite also disables handoff', async () => {
  const { service, state } = fixture({ enableTaskResultTool: true, enableTaskHandoffCommand: true })
  await service.update({ enableTaskResultTool: false })
  assert.equal(state.enableTaskResultTool, false)
  assert.equal(state.enableTaskHandoffCommand, false)
})

test('rejects unknown and non-boolean changes without editing', async () => {
  const { service, state } = fixture()
  await assert.rejects(() => service.update({ unknown: true }), /boolean settings/u)
  await assert.rejects(() => service.update({ enableFocusChain: 'yes' }), /boolean settings/u)
  assert.equal(state.enableFocusChain, false)
})

test('reports a missing plugin entry without writing', async () => {
  const entry = { id: 'dsh-omo', patchId: 'dsh-omo' }
  const service = createLongHorizonConfigService({
    entries: () => [entry],
    configuration: () => [],
    edit: async () => { throw new Error('must not edit') },
  })
  const result = await service.read()
  assert.equal(result.found, true)
  assert.equal(result.values.enableTaskHandoffCommand, false)
})
