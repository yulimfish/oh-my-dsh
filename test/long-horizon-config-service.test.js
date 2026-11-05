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
    enableGoalTools: false,
    enableCompactionResumeAdvisory: false,
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
  assert.equal(result.values.enableGoalTools, false)
  assert.equal(result.values.enableCompactionResumeAdvisory, false)
})

test('enabling Goal tools and compaction resume preserves unrelated settings', async () => {
  const { service, state } = fixture({ maxConcurrent: 3 })
  const result = await service.update({ enableGoalTools: true, enableCompactionResumeAdvisory: true })
  assert.equal(result.values.enableGoalTools, true)
  assert.equal(result.values.enableCompactionResumeAdvisory, true)
  assert.equal(state.maxConcurrent, 3)
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

test('serves the Agent-tree snapshot through the same Host config service', async () => {
  const { editor, state } = fixture()
  const snapshot = {
    available: true,
    scope: 'live-roots',
    updatedAt: 1234,
    truncated: false,
    limits: { maxRoots: 16, maxDescendantsPerRoot: 128 },
    note: 'Current live roots only.',
    roots: [],
  }
  const service = createLongHorizonConfigService(editor, { readAgentTree: async () => snapshot })
  assert.deepEqual(await service.readAgentTree(), snapshot)
  assert.equal(state.enableFocusChain, false, 'tree reads do not mutate configuration')
})

test('reports unavailable tree dependencies without throwing', async () => {
  const { service } = fixture()
  const result = await service.readAgentTree()
  assert.equal(result.available, false)
  assert.equal(result.scope, 'live-roots')
  assert.deepEqual(result.roots, [])
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
