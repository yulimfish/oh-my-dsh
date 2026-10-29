import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'
import { normalizeCategoryRoutes, normalizeExplicitFallbackModels } from '../src/category-routes.js'
import { normalizeModelCatalog } from '../src/model-catalog.js'

test('strict route keys are checked before catalog expansion can discard hidden unsupported fields', () => {
  const catalog = normalizeModelCatalog({ backup: { model: 'p/m' } })
  let reads = 0
  for (const enumerable of [false, true]) {
    for (const candidate of [{ model: 'backup' }, { provider: 'p', model: 'm' }]) {
      Object.defineProperty(candidate, 'unexpected', { enumerable, get() { reads += 1; return true } })
      assert.throws(() => normalizeExplicitFallbackModels([candidate], 'fallbacks', undefined, undefined, catalog), /unsupported field/u)
    }
    const category = { name: 'research', model: 'backup' }
    Object.defineProperty(category, 'unexpected', { enumerable, get() { reads += 1; return true } })
    assert.throws(() => normalizeCategoryRoutes([category], undefined, catalog), /unsupported field/u)
  }
  assert.equal(reads, 0)
})

const models = {
  backup: { model: 'backup-provider/vendor/model-v2', reasoning: 'high' },
  alternate: { model: 'alternate-provider/model-v3', reasoning: 'medium' },
}
const primary = { provider: 'primary-provider', model: 'primary-model' }
const backup = { provider: 'backup-provider', model: 'vendor/model-v2' }
const tick = () => new Promise(resolve => setImmediate(resolve))

function nativeContext(resolveCallConfig) {
  const tools = new Map()
  const starts = []
  const calls = []
  const parent = { id: 'fallback-catalog-parent', followup() {} }
  const forbidden = () => assert.fail('Catalog fallback normalization must not read files, network, or discover models')
  const llm = resolveCallConfig ? {
    resolveCallConfig: (config, signal) => { calls.push(config); return resolveCallConfig(config, signal) },
    listProviders: forbidden, getProvider: forbidden,
  } : undefined
  const ctx = {
    get: key => key === 'llm' ? llm : undefined,
    fs: { resolve: forbidden, readText: forbidden, readBytes: forbidden, listDir: forbidden },
    web: { fetch: forbidden, search: forbidden },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get() {} },
    subagents: {
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => {
        starts.push(spec)
        return { childId: `fallback-catalog-child-${starts.length}`, result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    on() { return ctx }, effect(execute) { return execute() }, logger: { warn() {} },
  }
  return { ctx, parent, tools, starts, calls }
}
function mount(fixture, input) {
  apply(fixture.ctx, Config({ models, ...input }))
  assert.deepEqual(fixture.calls, [], 'setup must not preflight or discover models')
  assert.deepEqual(fixture.starts, [])
  return fixture.tools.get('dsh_omo_task')
}
function execute(fixture, tool, args = {}, signal = new AbortController().signal) {
  return tool.execute({ role: 'explore', task: 'Use only declared fallback model catalog references.', ...args }, { agent: fixture.parent, signal })
}
const rejectPrimary = async config => {
  if (config.provider === primary.provider) throw new Error('primary unavailable')
  return config
}

test('full Config category falls back to catalog alias with exact model tail, default reasoning, and candidate tokens', async () => {
  const fixture = nativeContext(rejectPrimary)
  const tool = mount(fixture, { categoryRoutes: [{ name: 'research', ...primary, fallbackModels: [{ model: 'backup', maxTokens: 512 }] }] })
  await execute(fixture, tool, { category: 'research' })
  assert.deepEqual(fixture.calls, [primary, { ...backup, reasoningEffort: 'high', maxTokens: 512 }])
  assert.deepEqual(fixture.starts[0].request.agentOptions, { ...backup, reasoningEffort: 'high', maxTokens: 512 })
  await tick()
})

test('full Config pinned role fallback alias uses candidate reasoning over catalog default', async () => {
  const fixture = nativeContext(rejectPrimary)
  const tool = mount(fixture, { roleRoutes: [{ role: 'explore', ...primary, fallbackModels: [{ model: 'backup', reasoningEffort: 'low', maxTokens: 768 }] }] })
  await execute(fixture, tool)
  assert.deepEqual(fixture.starts[0].request.agentOptions, { ...backup, reasoningEffort: 'low', maxTokens: 768 })
  await tick()
})

for (const winner of ['backup-provider', 'alternate-provider']) {
  test(`fallback-only role catalog chain selects ${winner} in declaration order`, async () => {
    const fixture = nativeContext(async config => { if (config.provider !== winner) throw new Error('unavailable'); return config })
    const tool = mount(fixture, { roleRoutes: [{ role: 'explore', fallbackModels: [{ model: 'backup' }, { model: 'alternate' }] }] })
    await execute(fixture, tool)
    const expectedCalls = [{ ...backup, reasoningEffort: 'high' }]
    if (winner === 'alternate-provider') expectedCalls.push({ provider: 'alternate-provider', model: 'model-v3', reasoningEffort: 'medium' })
    assert.deepEqual(fixture.calls, expectedCalls)
    assert.deepEqual(fixture.starts[0].request.agentOptions, expectedCalls.at(-1))
    await tick()
  })
}

test('role override wins over catalog and candidate reasoning while selected candidate tokens win over role tokens', async () => {
  const fixture = nativeContext(rejectPrimary)
  const tool = mount(fixture, { roleRoutes: [{
    role: 'explore', ...primary, reasoningEffort: 'medium', maxTokens: 1024,
    fallbackModels: [{ model: 'backup', reasoningEffort: 'low', maxTokens: 256 }],
  }] })
  await execute(fixture, tool)
  assert.deepEqual(fixture.calls, [
    { ...primary, reasoningEffort: 'medium', maxTokens: 1024 },
    { ...backup, reasoningEffort: 'medium', maxTokens: 256 },
  ])
  assert.deepEqual(fixture.starts[0].request.agentOptions, { ...backup, reasoningEffort: 'medium', maxTokens: 256 })
  await tick()
})

test('explicit fallback provider/model remains literal even if its model names a catalog alias', async () => {
  const fixture = nativeContext(rejectPrimary)
  const tool = mount(fixture, { roleRoutes: [{ role: 'explore', ...primary, fallbackModels: [{ provider: 'literal-provider', model: 'backup' }] }] })
  await execute(fixture, tool)
  assert.deepEqual(fixture.starts[0].request.agentOptions, { provider: 'literal-provider', model: 'backup' })
  await tick()
})

for (const route of [
  { ...backup, fallbackModels: [{ model: 'backup' }] },
  { ...primary, fallbackModels: [{ model: 'backup' }, { ...backup }] },
  { ...primary, fallbackModels: [{ model: 'backup' }, { model: 'backup' }] },
]) {
  for (const kind of ['role', 'category']) {
    test(`${kind} rejects duplicate catalog-normalized fallback pairs ${JSON.stringify(route)}`, () => {
      const fixture = nativeContext(rejectPrimary)
      const input = kind === 'role' ? { roleRoutes: [{ role: 'explore', ...route }] } : { categoryRoutes: [{ name: 'research', ...route }] }
      assert.throws(() => mount(fixture, input), /duplicate|repeat|primary/iu)
      assert.equal(fixture.tools.size, 0)
      assert.deepEqual(fixture.calls, [])
    })
  }
}

test('fallback catalog expansion precedes exact-pair route-alias collapse duplicate checks', () => {
  const fixture = nativeContext(rejectPrimary)
  assert.throws(() => mount(fixture, {
    enableRoleCategoryRouteAliases: true,
    roleCategoryRouteAliases: [{ from: backup, to: primary }],
    roleRoutes: [{ role: 'explore', ...primary, fallbackModels: [{ model: 'backup' }] }],
  }), /duplicate|repeat|primary/iu)
  assert.equal(fixture.tools.size, 0)
})

for (const unknown of ['undeclared-alias', 'provider/unqualified-as-reference']) {
  for (const kind of ['role', 'category']) {
    test(`${kind} fallback model-only unknown reference ${unknown} fails before registrations`, () => {
      const fixture = nativeContext(rejectPrimary)
      const route = { ...primary, fallbackModels: [{ model: unknown }] }
      assert.throws(() => mount(fixture, kind === 'role' ? { roleRoutes: [{ role: 'explore', ...route }] } : { categoryRoutes: [{ name: 'research', ...route }] }))
      assert.equal(fixture.tools.size, 0)
      assert.deepEqual(fixture.calls, [])
    })
  }
}

test('catalog fallback chain fails closed without the Host resolver', async () => {
  const fixture = nativeContext()
  const tool = mount(fixture, { roleRoutes: [{ role: 'explore', fallbackModels: [{ model: 'backup' }] }] })
  await assert.rejects(execute(fixture, tool), /resolver|resolveCallConfig|preflight|LLM/iu)
  assert.equal(fixture.starts.length, 0)
})

test('catalog fallback cancellation cannot admit a late successful preflight spawn', async () => {
  let release
  let notify
  const entered = new Promise(resolve => { notify = resolve })
  const fixture = nativeContext(config => { notify(); return new Promise(resolve => { release = () => resolve(config) }) })
  const tool = mount(fixture, { roleRoutes: [{ role: 'explore', fallbackModels: [{ model: 'backup' }] }] })
  const controller = new AbortController()
  const rejected = assert.rejects(execute(fixture, tool, {}, controller.signal), /cancel|abort/iu)
  await entered
  controller.abort()
  await rejected
  release()
  await tick()
  assert.equal(fixture.starts.length, 0)
})
