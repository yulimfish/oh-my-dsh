import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyPolicy } from '../src/specialist-preset-policy.js'
import { createRequire } from 'node:module'

const scopeRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'))
const { createScope } = await import(scopeRequire.resolve('@deepseek-ai/dsh-scope'))

for (const name of ['write', 'edit', 'bash', 'subagent', 'run_code', 'unknown']) {
  test(`preset policy denies ${name} before its body executes`, async t => {
    let ctx = new Context()
    const promptFiber = await ctx.plugin(SystemPrompt)
    const runtimeFiber = await ctx.plugin(ToolRuntime)
    let executions = 0
    const agent = { id: 'preset-agent' }
    const scope = createScope(ctx, agent)
    await scope.ctx.inject(['tools'], injected => { ctx = injected })
    t.after(async () => { await scope.dispose() })
    const unregister = name === 'run_code' ? () => {} : ctx.tools.register(defineTool({
      name,
      description: 'test tool',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      async execute() { executions += 1; return {} },
    }))
    const dispose = applyPolicy(ctx)
    t.after(async () => {
      dispose()
      unregister()
      await runtimeFiber.dispose()
      await promptFiber.dispose()
    })
    const result = await ctx.tools.execute({ callId: `denied-${name}`, name, arguments: {}, agent, signal: new AbortController().signal })
    assert.equal(result.isError, true)
    assert.equal(executions, 0)
    assert.match(JSON.stringify(result), /read, glob, or grep/u)
  })
}

test('preset policy allows read, glob, grep and presents native Tools without affecting another scope', async t => {
  let ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const runtimeFiber = await ctx.plugin(ToolRuntime)
  const agent = { id: 'preset-agent' }
  const scope = createScope(ctx, agent)
  await scope.ctx.inject(['tools'], injected => { ctx = injected })
  const dispose = applyPolicy(ctx)
  t.after(async () => { await scope.dispose() })
  t.after(async () => {
    dispose()
    await runtimeFiber.dispose()
    await promptFiber.dispose()
  })
  for (const name of ['read', 'glob', 'grep']) {
    ctx.tools.register(defineTool({
      name,
      description: 'read tool',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { value: { type: 'string', required: true } } }, render: () => [] },
      async execute() { return { value: name } },
    }))
    const result = await ctx.tools.execute({ callId: name, name, arguments: {}, agent, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.value, name)
  }
})
