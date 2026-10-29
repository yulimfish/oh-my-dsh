import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applySpecialistPolicy } from '../src/specialist-preset-policy.js'

const systemPromptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(systemPromptRequire.resolve('@deepseek-ai/dsh-scope'))
const DENIAL = 'dsh-omo read/search preset denies this Tool; use an approved read, glob, or grep Tool.'

function fixtureTool(name, origin, bodies) {
  return defineContentToolFixture({
    name,
    description: `Test-only ${name} tool.`,
    parameters: {},
    async execute(_args, exec) {
      bodies.push(`${origin}:${name}:${exec.agent?.id ?? 'none'}`)
      return [{ type: 'text', text: `${origin}:${name}` }]
    },
  })
}

let callSequence = 0
function execution(name, agent, args = {}) {
  return {
    callId: `${agent.id}:${name}:${++callSequence}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }
}

test('allows only read/search names, selects native presentation, and disposes in reverse ownership order', () => {
  const calls = []
  let guard
  const dispose = applySpecialistPolicy({
    tools: {
      presentAs(mode) {
        calls.push(`presentAs:${mode}`)
        return () => calls.push('dispose:presentAs')
      },
      guard(callback) {
        guard = callback
        calls.push('guard')
        return () => calls.push('dispose:guard')
      },
    },
  })

  assert.equal(typeof guard, 'function')
  assert.deepEqual(calls, ['presentAs:native', 'guard'])
  for (const name of ['read', 'glob', 'grep']) {
    assert.equal(guard({ name }), undefined, `${name} must remain subject to other monotonic guards`)
  }
  for (const name of ['write', 'edit', 'bash', 'delegation', 'run_code', 'unknownTool']) {
    assert.equal(guard({ name }), DENIAL)
  }
  for (const exec of [undefined, null, {}, { name: 42 }]) {
    assert.equal(guard(exec), DENIAL, 'malformed and unknown Tool names fail closed')
  }

  dispose()
  assert.deepEqual(calls, [
    'presentAs:native',
    'guard',
    'dispose:guard',
    'dispose:presentAs',
  ])
})

test('real ToolRuntime scopes the guard to the specialist and global/scoped shadows cannot bypass it', async t => {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const bodies = []
  const dispatches = []
  const globalDisposers = []
  const scopes = []
  const makeAgent = async id => {
    const agent = { id, session: { id, append() {} } }
    const scope = createScope(ctx, agent)
    await scope.ctx.inject(['tools'], injected => { agent.ctx = injected })
    scopes.push(scope)
    return agent
  }
  const specialist = await makeAgent('specialist')
  const main = await makeAgent('main')
  const preExecuteFiber = await ctx.plugin(pluginCtx => pluginCtx.on('tools/pre-execute', async (_exec, next) => {
    await next()
    return { kind: 'allow' }
  }))
  const dispatchFiber = await ctx.plugin(pluginCtx => pluginCtx.on('tools/execute', (exec, next) => {
    dispatches.push(`${exec.name}:${exec.agent.id}`)
    return next()
  }))
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose()
    for (const dispose of globalDisposers.reverse()) dispose()
    await dispatchFiber.dispose()
    await preExecuteFiber.dispose()
    await toolsFiber.dispose()
    await promptFiber.dispose()
  })

  for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'delegation', 'dsh_omo_task', 'dsh_omo_task_continuable']) {
    globalDisposers.push(ctx.tools.register(fixtureTool(name, 'global', bodies)))
  }
  applySpecialistPolicy(specialist.ctx)
  // A later non-denying guard cannot turn the policy's denial back into permission.
  specialist.ctx.tools.guard(() => undefined)
  // Scoped tools shadow global registrations but remain subject to the same guard.
  specialist.ctx.tools.register(fixtureTool('read', 'scoped', bodies))
  specialist.ctx.tools.register(fixtureTool('write', 'scoped', bodies))

  assert.equal(ctx.tools.modeFor(specialist), 'native')
  assert.equal(ctx.tools.modeFor(main), 'native')
  for (const name of ['read', 'glob', 'grep']) {
    const result = await ctx.tools.execute(execution(name, specialist))
    assert.equal(result.isError, false, `${name} should be allowed`)
  }
  assert.deepEqual(bodies, [
    'scoped:read:specialist',
    'global:glob:specialist',
    'global:grep:specialist',
  ])

  for (const name of ['write', 'edit', 'bash', 'delegation', 'dsh_omo_task', 'dsh_omo_task_continuable', 'run_code', 'unknownTool']) {
    const bodyCount = bodies.length
    const dispatchCount = dispatches.length
    const result = await ctx.tools.execute(execution(name, specialist))
    assert.equal(result.isError, true, `${name} should be denied`)
    assert.equal(result.error.message, DENIAL)
    assert.equal(bodies.length, bodyCount, `${name} body must not execute`)
    assert.equal(dispatches.length, dispatchCount, `${name} must not reach around-dispatch listeners`)
  }

  for (const name of ['write', 'dsh_omo_task']) {
    const result = await ctx.tools.execute(execution(name, main))
    assert.equal(result.isError, false, `main Agent must remain unaffected by the specialist guard (${name})`)
  }
  assert.deepEqual(bodies.slice(-2), ['global:write:main', 'global:dsh_omo_task:main'])
})

test('real PTC transport cannot bypass the specialist policy while the main Agent remains usable', async t => {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const ptcRuns = []
  const releases = []
  const ptcRuntime = {
    language: 'typescript',
    programFormat: 'function-body',
    resolve: input => input,
    async run(input) {
      ptcRuns.push(input.program)
      const value = await input.bindings[0].functions.write({})
      return { logs: [], value }
    },
    async release(agent) {
      releases.push(agent.id)
    },
  }
  const ptcFiber = await ctx.plugin(pluginCtx => pluginCtx.provide('ptcRuntime', ptcRuntime))
  const workingDirectoryFiber = await ctx.plugin(pluginCtx => pluginCtx.provide('workingDirectory', {
    ensure: async () => '/workspace/project',
  }))
  const toolsFiber = await ctx.plugin(ToolRuntime, { mode: 'ptc' })
  const bodies = []
  const unregisterWrite = ctx.tools.register(fixtureTool('write', 'global', bodies))
  const scopes = []
  const makeAgent = async id => {
    const appended = []
    const agent = { id, session: { id, append: (...event) => appended.push(event) } }
    const scope = createScope(ctx, agent)
    await scope.ctx.inject(['tools'], injected => { agent.ctx = injected })
    scopes.push(scope)
    return agent
  }
  const specialist = await makeAgent('ptc-specialist')
  const main = await makeAgent('ptc-main')
  applySpecialistPolicy(specialist.ctx)
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose()
    unregisterWrite()
    await toolsFiber.dispose()
    await workingDirectoryFiber.dispose()
    await ptcFiber.dispose()
    await promptFiber.dispose()
  })

  assert.equal(ctx.tools.modeFor(specialist), 'native', 'the preset shadows a PTC deployment default')
  assert.equal(ctx.tools.modeFor(main), 'ptc', 'the main Agent keeps the deployment presentation')
  const denied = await ctx.tools.execute(execution('run_code', specialist, {
    code: 'return await tools.write({})',
    description: 'Attempt PTC policy bypass',
  }))
  assert.equal(denied.isError, true)
  assert.equal(denied.error.message, DENIAL)
  assert.deepEqual(ptcRuns, [], 'the guarded Agent must not enter the PTC runtime')
  assert.deepEqual(bodies, [], 'the PTC write body must not execute')

  const allowed = await ctx.tools.execute(execution('run_code', main, {
    code: 'return await tools.write({})',
    description: 'Verify main PTC execution',
  }))
  assert.equal(allowed.isError, false, allowed.error?.message)
  assert.deepEqual(ptcRuns, ['return await tools.write({})'])
  assert.deepEqual(bodies, ['global:write:ptc-main'], 'main Agent PTC sub-calls are not guarded')
  await scopes[1].dispose()
  assert.deepEqual(releases, ['ptc-main'])
})
