import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../src/index.js'
import { normalizeEnabledProjectSkills } from '../src/project-skills.js'
import { normalizeUserAgents } from '../src/user-agents.js'

const category = { name: 'research', provider: 'route-provider', model: 'route-model' }
const tick = () => new Promise(resolve => setImmediate(resolve))

// Every mount consumes the complete real Loader result, without raw overrides.
function makeContext() {
  const tools = new Map()
  const starts = []
  const skillReads = []
  const effects = []
  const parent = { id: 'normalization-parent', followup() {} }
  const services = {
    sessions: { get: id => id === parent.id ? { id, header: { cwd: '/workspace/project' } } : undefined },
  }
  const ctx = {
    get: key => services[key],
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get() {} },
    subagents: {
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => {
        starts.push(spec)
        return { childId: `normalization-child-${starts.length}`, result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: {
      register: () => () => {}, registerProvider: () => () => {},
      get: async (name, options) => {
        skillReads.push({ name, options })
        return { name, invocation: { modelInvocable: true }, content: `Normalized category skill: ${name}` }
      },
    },
    on() { return ctx },
    effect(execute) { const dispose = execute(); effects.push(dispose); return dispose },
    logger: { warn() {} },
  }
  return { ctx, parent, tools, starts, skillReads, effects }
}
function mount(fixture, input) {
  const config = Config(input)
  apply(fixture.ctx, config)
  return { config, tool: fixture.tools.get('dsh_omo_task') }
}
function execute(fixture, tool, args = {}) {
  return tool.execute({ role: 'explore', task: 'Verify complete Loader config normalization.', ...args }, {
    agent: fixture.parent, signal: new AbortController().signal,
  })
}

for (const optional of [{}, { tools: {} }, { skills: [], fallbackModels: [] }]) {
  test(`real Config category ${JSON.stringify(optional)} launches without synthetic restrictions or skill reads`, async () => {
    const fixture = makeContext()
    const { tool } = mount(fixture, { categoryRoutes: [{ ...category, ...optional }] })
    await execute(fixture, tool, { category: 'research' })
    assert.equal(fixture.starts.length, 1)
    assert.deepEqual(fixture.starts[0].request.agentOptions, { provider: category.provider, model: category.model })
    assert.equal(Object.hasOwn(fixture.starts[0].request, 'toolFilter'), false)
    assert.deepEqual(fixture.skillReads, [])
    await tick()
  })
}

test('real Config role optional arrays stay absent, including after JSON roundtrip', () => {
  const input = {
    roleRoutes: [{ role: 'explore', provider: 'p', model: 'm' }],
    userAgents: [{ name: 'preset-worker', agentPreset: 'trusted-preset' }],
  }
  const first = Config(input)
  const serialized = JSON.parse(JSON.stringify(first))
  const second = Config(serialized)
  for (const config of [first, second]) {
    for (const key of ['allowTools', 'denyTools', 'fallbackModels']) {
      assert.equal(config.roleRoutes[0][key], undefined)
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(config.roleRoutes[0])), key), false)
    }
    for (const key of ['description', 'prompt', 'mode']) assert.equal(config.userAgents[0][key], undefined)
  }
  assert.deepEqual(second, first)
})

test('real Config omitted role filters inherit and explicit denyTools [] remains a no-op', async () => {
  for (const extra of [{}, { denyTools: [] }]) {
    const fixture = makeContext()
    const { config, tool } = mount(fixture, { roleRoutes: [{ role: 'explore', ...extra }] })
    assert.equal(config.roleRoutes[0].allowTools, undefined)
    await execute(fixture, tool)
    assert.equal(fixture.starts.length, 1)
    assert.equal(fixture.starts[0].request.agentOptions, undefined)
    await tick()
  }
})

test('real Config explicit role allowTools [] preserves deny-all instead of becoming inherited access', async () => {
  const fixture = makeContext()
  const { config, tool } = mount(fixture, { roleRoutes: [{ role: 'explore', allowTools: [] }] })
  assert.deepEqual(config.roleRoutes[0].allowTools, [])
  assert.equal(config.roleRoutes[0].denyTools, undefined)
  await assert.rejects(execute(fixture, tool), /filter|allow|restrict/iu)
  assert.equal(fixture.starts.length, 0, 'modern Host cannot enforce this per-call filter and must reject')
})

test('real Config default category skills load once in declared order on modern activation', async () => {
  const fixture = makeContext()
  const { tool } = mount(fixture, {
    categoryRoutes: [{ ...category, skills: ['debugging', 'git-master'] }],
    roleRoutes: [{ role: 'explore', category: 'research' }],
  })
  await execute(fixture, tool)
  assert.deepEqual(fixture.skillReads.map(read => read.name), ['debugging', 'git-master'])
  assert.ok(fixture.skillReads.every(read => read.options.cwd === '/workspace/project'))
  const prompt = fixture.starts[0].request.prompt[0].text
  assert.ok(prompt.indexOf('Normalized category skill: debugging') < prompt.indexOf('Normalized category skill: git-master'))
  assert.equal(prompt.split('Normalized category skill: debugging').length - 1, 1)
  await tick()
})

test('real Config preset-only user agents preserve omitted metadata and accept explicit subagent mode', async () => {
  for (const mode of [undefined, 'subagent']) {
    const fixture = makeContext()
    const entry = { name: 'preset-worker', agentPreset: 'trusted-preset', ...(mode === undefined ? {} : { mode }) }
    const { config, tool } = mount(fixture, { userAgents: [entry] })
    assert.equal(config.userAgents[0].prompt, undefined)
    assert.equal(config.userAgents[0].description, undefined)
    assert.equal(config.userAgents[0].mode, mode)
    assert.equal(normalizeUserAgents(config.userAgents).get('preset-worker').mode, 'subagent')
    await execute(fixture, tool, { role: 'preset-worker' })
    assert.equal(fixture.starts[0].request.agentPreset, 'trusted-preset')
    assert.equal(Object.hasOwn(fixture.starts[0].request, 'persona'), false)
    await tick()
  }
  const invalid = makeContext()
  assert.throws(() => mount(invalid, { userAgents: [{ name: 'preset-worker', agentPreset: 'trusted-preset', mode: 'primary' }] }), /mode/iu)
  assert.equal(invalid.starts.length, 0)
})

test('real Config enabledProjectSkills absent and null mean unrestricted, [] means explicitly no project skills', () => {
  for (const input of [{}, { enabledProjectSkills: null }]) {
    const config = Config(input)
    assert.equal(normalizeEnabledProjectSkills(config.enabledProjectSkills), undefined)
    assert.equal(normalizeEnabledProjectSkills(Config(JSON.parse(JSON.stringify(config))).enabledProjectSkills), undefined)
  }
  const config = Config({ enabledProjectSkills: [] })
  assert.deepEqual(config.enabledProjectSkills, [])
  assert.deepEqual(normalizeEnabledProjectSkills(config.enabledProjectSkills), [])
  assert.deepEqual(Config(JSON.parse(JSON.stringify(config))).enabledProjectSkills, [])
})

test('real Config preserves literal empty route and alias lists without synthesizing routes', async () => {
  const fixture = makeContext()
  const { config, tool } = mount(fixture, { roleRoutes: [], categoryRoutes: [], roleCategoryRouteAliases: [], userAgents: [] })
  for (const key of ['roleRoutes', 'categoryRoutes', 'roleCategoryRouteAliases', 'userAgents']) assert.deepEqual(config[key], [])
  await execute(fixture, tool)
  assert.equal(fixture.starts.length, 1)
  assert.equal(fixture.starts[0].request.agentOptions, undefined)
  await tick()
})
