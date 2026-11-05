import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { executeToolOnce, installNativeToolExecutor } from './dsh-runtime-compat.js'
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

test('allows only read/search names, selects NativeToolExecutor, and disposes in reverse ownership order', () => {
  const calls = []
  let guard
  let selectedExecutor
  const dispose = applySpecialistPolicy({
    tools: {
      setExecutor(executor) {
        selectedExecutor = executor
        calls.push('setExecutor')
        return () => calls.push('dispose:setExecutor')
      },
      guard(callback) {
        guard = callback
        calls.push('guard')
        return () => calls.push('dispose:guard')
      },
    },
  })

  assert.ok(selectedExecutor instanceof NativeToolExecutor)
  assert.equal(typeof guard, 'function')
  assert.deepEqual(calls, ['setExecutor', 'guard'])
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
    'setExecutor',
    'guard',
    'dispose:guard',
    'dispose:setExecutor',
  ])
})

test('real ToolRuntime scopes the guard to the specialist and global/scoped shadows cannot bypass it', async t => {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const nativeExecutorFiber = await installNativeToolExecutor(ctx)
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
    await nativeExecutorFiber.dispose()
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

  for (const name of ['read', 'glob', 'grep']) {
    const result = await executeToolOnce(ctx.tools, execution(name, specialist))
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
    const result = await executeToolOnce(ctx.tools, execution(name, specialist))
    assert.equal(result.isError, true, `${name} should be denied`)
    assert.equal(result.error.message, DENIAL)
    assert.equal(bodies.length, bodyCount, `${name} body must not execute`)
    assert.equal(dispatches.length, dispatchCount, `${name} must not reach around-dispatch listeners`)
  }

  for (const name of ['write', 'dsh_omo_task']) {
    const result = await executeToolOnce(ctx.tools, execution(name, main))
    assert.equal(result.isError, false, `main Agent must remain unaffected by the specialist guard (${name})`)
  }
  assert.deepEqual(bodies.slice(-2), ['global:write:main', 'global:dsh_omo_task:main'])
})

test('scoped policy selects NativeToolExecutor while main keeps its deployment executor', async t => {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const defaultDispatches = []
  const defaultExecutor = {
    describe: () => ({ schemas: [] }),
    async execute(input) {
      for (const call of input.calls) defaultDispatches.push(`${call.name}:${input.agent?.id ?? 'none'}`)
      return {
        results: input.calls.map(call => ({
          callId: call.id,
          result: {
            isError: false,
            content: [{ type: 'text', text: 'default deployment executor' }],
            value: { executor: 'default', name: call.name },
          },
        })),
        additionalContexts: [],
        concluded: false,
      }
    },
  }
  const disposeDefaultExecutor = ctx.tools.setExecutor(defaultExecutor)
  const bodies = []
  const unregisterRead = ctx.tools.register(fixtureTool('read', 'global', bodies))
  const scopes = []
  const makeAgent = async id => {
    const agent = { id, session: { id, append() {} } }
    const scope = createScope(ctx, agent)
    await scope.ctx.inject(['tools'], injected => { agent.ctx = injected })
    scopes.push(scope)
    return agent
  }
  const specialist = await makeAgent('executor-specialist')
  const main = await makeAgent('executor-main')
  applySpecialistPolicy(specialist.ctx)
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose()
    unregisterRead()
    disposeDefaultExecutor()
    await toolsFiber.dispose()
    await promptFiber.dispose()
  })

  const mainRunCode = await executeToolOnce(ctx.tools, execution('run_code', main, {
    code: 'return await tools.write({})',
    description: 'Verify default deployment executor',
  }))
  assert.equal(mainRunCode.isError, false)
  assert.equal(mainRunCode.value.executor, 'default')
  assert.deepEqual(defaultDispatches, ['run_code:executor-main'])

  const specialistRead = await executeToolOnce(ctx.tools, execution('read', specialist))
  assert.equal(specialistRead.isError, false)
  assert.deepEqual(bodies, ['global:read:executor-specialist'], 'the specialist call must run through NativeToolExecutor')
  assert.deepEqual(defaultDispatches, ['run_code:executor-main'])

  const denied = await executeToolOnce(ctx.tools, execution('run_code', specialist, {
    code: 'return await tools.write({})',
    description: 'Attempt to bypass the specialist Tool policy',
  }))
  assert.equal(denied.isError, true)
  assert.equal(denied.error.message, DENIAL)
  assert.deepEqual(defaultDispatches, ['run_code:executor-main'], 'the specialist must not fall back to the default executor')
  assert.deepEqual(bodies, ['global:read:executor-specialist'], 'guarded Tools must not execute')
})
