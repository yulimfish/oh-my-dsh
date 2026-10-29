import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const patchRequire = createRequire(patchUrl)
const patch = parse(await readFile(patchUrl, 'utf8'))
const declaration = patch
  .flatMap(operation => operation.insert ?? [])
  .find(row => row.id === 'preset-omo-read-search')
assert.ok(declaration, 'cordis.patch.yml must declare preset-omo-read-search')
const definition = declaration.config
const policyRow = definition.plugins.find(row => row.id === 'omo-read-search-policy')
assert.ok(policyRow, 'the preset must declare its specialist policy row')

// The registry is an optional Host peer of dsh-subagent, not a dependency of
// this bundle. Load every DSH module beside that registry so a temporary or
// monorepo installation cannot mix Cordis/scope instances with this project.
async function loadPresetRuntime() {
  let paths
  try {
    const registryPath = patchRequire.resolve('@deepseek-ai/dsh-agent-preset-registry')
    const runtimeRequire = createRequire(registryPath)
    paths = Object.fromEntries([
      '@deepseek-ai/cordis',
      '@deepseek-ai/cordis-plugin-loader',
      '@deepseek-ai/dsh-agent-preset',
      '@deepseek-ai/dsh-agent-preset-registry',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
    ].map(name => [name, runtimeRequire.resolve(name)]))
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return { skip: `optional Host preset runtime is not installed: ${error.message}` }
  }
  const modules = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [
    name,
    await import(pathToFileURL(path).href),
  ])))
  return {
    Context: modules['@deepseek-ai/cordis'].Context,
    Loader: modules['@deepseek-ai/cordis-plugin-loader'].default,
    AgentPreset: modules['@deepseek-ai/dsh-agent-preset'].default,
    AgentPresetRegistry: modules['@deepseek-ai/dsh-agent-preset-registry'].default,
    createScope: modules['@deepseek-ai/dsh-scope'].createScope,
    scopeOf: modules['@deepseek-ai/dsh-scope'].scopeOf,
    SessionProjectionRegistry: modules['@deepseek-ai/dsh-session-projection'].default,
    SystemPrompt: modules['@deepseek-ai/dsh-system-prompt'].default,
    ToolRuntime: modules['@deepseek-ai/dsh-tools'].ToolRuntime,
    defineContentToolFixture: modules['@deepseek-ai/dsh-tools'].defineContentToolFixture,
  }
}

const runtime = await loadPresetRuntime()
const registrySkip = runtime.skip ?? false
const unresolvedRows = registrySkip ? [] : definition.plugins.filter(row => {
  try {
    patchRequire.resolve(row.name)
    return false
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') return true
    throw error
  }
})
const fullPresetSkip = registrySkip || (unresolvedRows.length > 0
  ? `declared preset plugins are not installed: ${unresolvedRows.map(row => row.name).join(', ')}`
  : false)

async function createHarness(presetDefinition) {
  assert.equal(typeof runtime.Context, 'function', registrySkip || 'real registry runtime is required')
  const {
    Context, Loader, AgentPreset, AgentPresetRegistry, SessionProjectionRegistry,
    SystemPrompt, ToolRuntime,
  } = runtime
  const ctx = new Context()
  const fibers = []
  const scopes = []
  const unregistrars = []
  const dispose = async () => {
    for (const scope of scopes.reverse()) await scope.dispose()
    for (const unregister of unregistrars.reverse()) unregister()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
  try {
    fibers.push(await ctx.plugin(Loader, { baseUrl: patchUrl.href }))
    fibers.push(await ctx.plugin(SessionProjectionRegistry))
    fibers.push(await ctx.plugin(hostCtx => {
      hostCtx.provide('settings', { configure() {} })
      // Activation-only Host fixtures. Policy behavior is exercised through the
      // real ToolRuntime below; no fake Tool registry or guard is substituted.
      hostCtx.provide('fs', {})
      hostCtx.provide('workingDirectory', { ensure: async () => process.cwd() })
      hostCtx.provide('subprocess', {
        spawn() { throw new Error('the mount integration test must not spawn processes') },
      })
    }))
    fibers.push(await ctx.plugin(SystemPrompt))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(await ctx.plugin(AgentPresetRegistry, { default: presetDefinition.id }))
    const declaringCtx = ctx.extend({ baseUrl: patchUrl.href })
    fibers.push(await declaringCtx.plugin(AgentPreset, presetDefinition))
    return { ctx, fibers, scopes, unregistrars, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function makeAgent(harness, id, presetId) {
  const agent = {
    id,
    session: { id, header: { cwd: process.cwd() }, append() {} },
  }
  const scope = runtime.createScope(harness.ctx, agent)
  harness.scopes.push(scope)
  if (presetId) await harness.ctx.agentPresets.mount(scope.ctx, presetId)
  await scope.ctx.inject(['tools'], injected => { agent.ctx = injected })
  return agent
}

let callSequence = 0
function execute(harness, name, agent) {
  return harness.ctx.tools.execute({
    callId: `${agent.id}:${name}:${++callSequence}`,
    name,
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
}

function registerFixture(harness, name, bodies) {
  harness.unregistrars.push(harness.ctx.tools.register(runtime.defineContentToolFixture({
    name,
    description: `Preset integration ${name} fixture.`,
    parameters: {},
    async execute(_args, exec) {
      bodies.push(`${name}:${exec.agent.id}`)
      return [{ type: 'text', text: name }]
    },
  })))
}

async function assertHealthyRegistration(harness, expectedRows) {
  const resolved = await harness.ctx.agentPresets.resolve(definition.id)
  assert.deepEqual(resolved, { id: definition.id })
  const listed = await harness.ctx.agentPresets.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].broken, undefined)
  const [inventory] = await harness.ctx.agentPresets.compositionInventory()
  assert.equal(inventory.broken, undefined)
  assert.deepEqual(
    inventory.rows.map(row => row.entryId),
    expectedRows.map(row => row.id),
  )
}

test('omo-read-search declaration carries the injectable policy plugin', () => {
  assert.equal(declaration.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(definition.id, 'omo-read-search')
  assert.equal(policyRow.name, 'dsh-omo/specialist-preset-policy')
  assert.deepEqual(policyRow.inject, ['tools'])
})

test('real registry mounts the declared policy row and isolates the main Agent', {
  skip: registrySkip,
}, async t => {
  const harness = await createHarness({ ...definition, plugins: [policyRow] })
  t.after(harness.dispose)
  await assertHealthyRegistration(harness, [policyRow])
  const bodies = []
  for (const name of ['read', 'write', 'dsh_omo_task']) registerFixture(harness, name, bodies)
  const specialist = await makeAgent(harness, 'preset-policy-specialist', definition.id)
  const main = await makeAgent(harness, 'preset-policy-main')

  assert.equal(harness.ctx.agentPresets.composedPreset(specialist.ctx), definition.id)
  assert.equal(harness.ctx.agentPresets.composedPreset(main.ctx), undefined)
  const [composition] = harness.ctx.agentPresets.inspectCompositions(specialist.ctx)
  assert.deepEqual(composition.modules.map(row => row.moduleName), [policyRow.name])
  assert.deepEqual(composition.leakedServices, [])
  assert.deepEqual(harness.ctx.agentPresets.inspectCompositions(main.ctx), [])

  for (const name of ['write', 'dsh_omo_task']) {
    const result = await execute(harness, name, specialist)
    assert.equal(result.isError, true)
    assert.match(result.error.message, /read, glob, or grep/u)
  }
  assert.deepEqual(bodies, [], 'denied Tool bodies must not execute')
  assert.equal((await execute(harness, 'read', specialist)).isError, false)
  assert.equal((await execute(harness, 'write', main)).isError, false)
  assert.equal((await execute(harness, 'dsh_omo_task', main)).isError, false)
  assert.deepEqual(bodies, [
    'read:preset-policy-specialist',
    'write:preset-policy-main',
    'dsh_omo_task:preset-policy-main',
  ])
})

test('real registry mounts the complete shipped declaration without leaking Tools to main', {
  skip: fullPresetSkip,
}, async t => {
  const harness = await createHarness(definition)
  t.after(harness.dispose)
  await assertHealthyRegistration(harness, definition.plugins)
  const bodies = []
  for (const name of ['write', 'dsh_omo_task']) registerFixture(harness, name, bodies)
  const specialist = await makeAgent(harness, 'full-preset-specialist', definition.id)
  const main = await makeAgent(harness, 'full-preset-main')

  const [composition] = harness.ctx.agentPresets.inspectCompositions(specialist.ctx)
  assert.deepEqual(
    composition.modules.map(row => row.moduleName),
    definition.plugins.map(row => row.name),
  )
  assert.deepEqual(composition.leakedServices, [])
  const specialistScope = runtime.scopeOf(specialist.ctx)
  const mainScope = runtime.scopeOf(main.ctx)
  for (const name of ['read', 'glob', 'grep']) {
    assert.ok(harness.ctx.tools.get(name, specialistScope), `${name} must mount for the specialist`)
    assert.equal(harness.ctx.tools.get(name, mainScope), undefined, `${name} must not leak to main`)
  }

  for (const name of ['write', 'dsh_omo_task']) {
    const result = await execute(harness, name, specialist)
    assert.equal(result.isError, true)
    assert.match(result.error.message, /read, glob, or grep/u)
    assert.equal((await execute(harness, name, main)).isError, false)
  }
  assert.deepEqual(bodies, [
    'write:full-preset-main',
    'dsh_omo_task:full-preset-main',
  ])
})
