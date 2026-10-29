import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

// Setup probes are distinct from launch-time provider capability checks.
function nativeContext() {
  const tools = new Map()
  const starts = []
  const providerLookups = []
  const probes = []
  const parent = { id: 'catalog-parent', followup() {} }
  const forbidden = label => () => { probes.push(label); assert.fail(`Unexpected catalog side effect: ${label}`) }
  const ctx = {
    get: key => {
      if (key === 'llm') return {
        resolveCallConfig: forbidden('resolveCallConfig'), listProviders: forbidden('listProviders'),
        getProvider: forbidden('llm.getProvider'),
      }
      return undefined
    },
    fs: { resolve: forbidden('fs.resolve'), readText: forbidden('fs.readText'), readBytes: forbidden('fs.readBytes'), listDir: forbidden('fs.listDir') },
    web: { fetch: forbidden('web.fetch'), search: forbidden('web.search') },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get() {} },
    subagents: {
      getProvider: name => {
        providerLookups.push(name)
        return { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }
      },
      startActivation: async spec => {
        starts.push(spec)
        return { childId: `catalog-child-${starts.length}`, result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    on() { return ctx },
    effect(execute) { return execute() },
    logger: { warn() {} },
  }
  return { ctx, tools, starts, probes, providerLookups, parent }
}
function mount(fixture, input) {
  const config = Config(input)
  apply(fixture.ctx, config)
  return { config, tool: fixture.tools.get('dsh_omo_task') }
}
async function launch(fixture, tool, args = {}) {
  await tool.execute({ role: 'explore', task: 'Select only the explicitly configured shared catalog reference.', ...args }, {
    agent: fixture.parent, signal: new AbortController().signal,
  })
  await tick()
  return fixture.starts.at(-1).request.agentOptions
}

const models = { careful: { model: 'catalog-provider/vendor/model-v1', reasoning: 'high' } }

test('full Config category catalog alias accepts omitted provider and retains the model ID tail', async () => {
  const fixture = nativeContext()
  const { config, tool } = mount(fixture, { models, categoryRoutes: [{ name: 'research', model: 'careful' }] })
  assert.deepEqual(config.models, models)
  assert.deepEqual(await launch(fixture, tool, { category: 'research' }), {
    provider: 'catalog-provider', model: 'vendor/model-v1', reasoningEffort: 'high',
  })
  assert.deepEqual(fixture.probes, [])
})

for (const reasoningEffort of [undefined, 'low']) {
  test(`full Config role catalog alias honors use-site reasoning precedence (${reasoningEffort ?? 'catalog default'})`, async () => {
    const fixture = nativeContext()
    const { tool } = mount(fixture, { models, roleRoutes: [{ role: 'explore', model: 'careful', ...(reasoningEffort ? { reasoningEffort } : {}) }] })
    assert.deepEqual(await launch(fixture, tool), {
      provider: 'catalog-provider', model: 'vendor/model-v1', reasoningEffort: reasoningEffort ?? 'high',
    })
    assert.deepEqual(fixture.probes, [])
  })
}

test('explicit provider/model remains literal even when the model matches a catalog alias', async () => {
  const fixture = nativeContext()
  const { tool } = mount(fixture, {
    models,
    roleRoutes: [{ role: 'explore', provider: 'literal-provider', model: 'careful' }],
    categoryRoutes: [{ name: 'research', provider: 'literal-category', model: 'careful' }],
  })
  assert.deepEqual(await launch(fixture, tool), { provider: 'literal-provider', model: 'careful' })
  assert.deepEqual(await launch(fixture, tool, { role: 'test', category: 'research' }), { provider: 'literal-category', model: 'careful' })
  assert.deepEqual(fixture.probes, [])
})

test('catalog expansion precedes existing exact-pair role/category route aliases', async () => {
  const fixture = nativeContext()
  const { tool } = mount(fixture, {
    models,
    enableRoleCategoryRouteAliases: true,
    roleCategoryRouteAliases: [{
      from: { provider: 'catalog-provider', model: 'vendor/model-v1' },
      to: { provider: 'target-provider', model: 'target-model' }, reasoningEffort: 'medium',
    }],
    roleRoutes: [{ role: 'explore', model: 'careful' }],
  })
  const selected = await launch(fixture, tool)
  assert.equal(selected.provider, 'target-provider')
  assert.equal(selected.model, 'target-model')
  assert.deepEqual(fixture.probes, [])
})

test('fallback deduplication sees a catalog-expanded primary exact pair', () => {
  const fixture = nativeContext()
  assert.throws(() => mount(fixture, {
    models,
    roleRoutes: [{ role: 'explore', model: 'careful', fallbackModels: [{ provider: 'catalog-provider', model: 'vendor/model-v1' }] }],
  }), /duplicate|repeat|primary/iu)
  assert.equal(fixture.tools.size, 0)
  assert.equal(fixture.starts.length, 0)
})

for (const input of [
  { models, roleRoutes: [{ role: 'explore', model: 'unknown' }] },
  { models, categoryRoutes: [{ name: 'research', model: 'unknown' }] },
  { models, roleRoutes: [{ role: 'explore', provider: 'missing-model' }] },
  { models, roleRoutes: [{ role: 'explore', model: 'careful', fallbackModels: [{ model: 'careful' }] }] },
  { models: { prototype: { model: 'p/m' } } },
  { models: { bad: { model: 'unqualified' } } },
  { models: { first: { model: 'second' }, second: { model: 'p/m' } } },
  { models: { first: { model: 'second' }, second: { model: 'first' } } },
  { models: { bad: { model: 'p/model\nunsafe' } } },
  { models: { bad: { model: 'p/m', reasoning: 'high\u202eunsafe' } } },
  { models: { 'unsafe\nkey': { model: 'p/m' } } },
  { models: JSON.parse('{"__proto__":{"model":"p/m"}}') },
  { models: { constructor: { model: 'p/m' } } },
  { models: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`entry-${i}`, { model: 'p/m' }])) },
]) {
  test(`invalid catalog/reference rejects before tool registration: ${JSON.stringify(input).slice(0, 130)}`, () => {
    const fixture = nativeContext()
    assert.throws(() => mount(fixture, input))
    assert.equal(fixture.tools.size, 0)
    assert.equal(fixture.starts.length, 0)
    assert.deepEqual(fixture.probes, [])
  })
}

test('catalog setup and an unselected catalog leave inherited parent routing unchanged without reads or discovery', async () => {
  const fixture = nativeContext()
  const { tool } = mount(fixture, { models })
  assert.equal(fixture.starts.length, 0)
  assert.deepEqual(fixture.probes, [])
  assert.deepEqual(fixture.providerLookups, [], 'catalog-only setup must not query even the subagent provider registry')
  assert.equal(await launch(fixture, tool), undefined)
  assert.deepEqual(fixture.probes, [])
})

test('default Loader schema remains catalog-free and JSON roundtrip retains selected catalog tuning', async () => {
  const defaults = Config({})
  assert.ok(defaults.models === undefined || Object.keys(defaults.models).length === 0)
  const config = Config({ models, roleRoutes: [{ role: 'explore', model: 'careful', reasoningEffort: 'low' }] })
  const fixture = nativeContext()
  const { tool } = mount(fixture, JSON.parse(JSON.stringify(config)))
  assert.deepEqual(await launch(fixture, tool), { provider: 'catalog-provider', model: 'vendor/model-v1', reasoningEffort: 'low' })
  assert.deepEqual(fixture.probes, [])
})
