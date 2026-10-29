import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'

const route = { provider: 'boundary', model: 'model' }
const tick = () => new Promise(resolve => setImmediate(resolve))

// Real Cordis and LlmRuntime; the deliberately noncompliant adapter never performs I/O.
function runtime() {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const calls = []
  class DeferredAdapter extends LlmAdapter {
    resolveModel(provider, id, signal) {
      return new Promise(resolve => calls.push({ provider, id, signal, release: () => resolve({ provider, id, name: id }) }))
    }
  }
  const dispose = llm.registerAdapter([route.provider], new DeferredAdapter())
  return { llm, calls, dispose }
}

// Only the LLM service is real; the plugin's registration and launch services are fixtures.
function plugin(llm) {
  const tools = new Map()
  const starts = []
  const ctx = {
    get: key => key === 'llm' ? llm : undefined,
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get() {} },
    subagents: {
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => { starts.push(spec); return { childId: 'child', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} } },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    on() { return ctx },
    effect(execute) { return execute() },
    logger: { warn() {} },
  }
  apply(ctx, Config({ enablePinnedRoutePreflight: true, roleRoutes: [{ role: 'explore', ...route }] }))
  return { tool: tools.get('dsh_omo_task'), starts }
}

test('real LlmRuntime forwards abort but waits for an adapter that ignores it', async () => {
  const { llm, calls, dispose } = runtime()
  const controller = new AbortController()
  controller.abort(new Error('already aborted'))
  let settled = false
  const pending = llm.resolveCallConfig(route, controller.signal).finally(() => { settled = true })
  try {
    assert.equal(calls.length, 1)
    assert.equal(calls[0].signal, controller.signal)
    await tick()
    assert.equal(settled, false)
    calls[0].release()
    assert.deepEqual(await pending, route)
  } finally {
    calls.forEach(call => call.release())
    await pending
    await dispose()
  }
})

test('gate does not track detached adapter work after the real LlmRuntime promise settles', async () => {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const detached = []
  class DetachedAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      let release
      const work = new Promise(resolve => { release = resolve })
      detached.push({ work, release })
      return { provider, id, name: id }
    }
  }
  const dispose = llm.registerAdapter([route.provider], new DetachedAdapter())
  const { tool, starts } = plugin(llm)
  try {
    for (let i = 0; i < 65; i += 1) {
      await tool.execute({ role: 'explore', task: 'test detached work' }, { agent: { id: 'parent', followup() {} }, signal: new AbortController().signal })
    }
    assert.equal(detached.length, 65, 'adapter-owned work can exceed the gate cap')
    assert.equal(starts.length, 65)
    let settled = false
    void detached[0].work.then(() => { settled = true })
    await tick()
    assert.equal(settled, false, 'the Host promise settled while detached adapter work stayed pending')
  } finally {
    detached.forEach(item => item.release())
    await Promise.all(detached.map(item => item.work))
    await dispose()
  }
})

test('route gate retains real LlmRuntime promises after caller abort until adapter settlement', async () => {
  const { llm, calls, dispose } = runtime()
  const { tool, starts } = plugin(llm)
  const controllers = []
  const execute = signal => tool.execute({ role: 'explore', task: 'test route preflight' }, { agent: { id: 'parent', followup() {} }, signal })
  try {
    for (let i = 0; i < 64; i += 1) {
      const controller = new AbortController()
      controllers.push(controller)
      const pending = execute(controller.signal)
      const rejected = assert.rejects(pending, /abort|cancel/iu)
      await tick()
      assert.equal(calls.length, i + 1)
      controller.abort()
      await rejected
      assert.equal(calls[i].signal.aborted, true)
    }
    await assert.rejects(execute(new AbortController().signal), /preflight is busy.*64/iu)
    assert.equal(calls.length, 64, 'caller cancellation did not settle the real LlmRuntime promises')
    assert.equal(starts.length, 0)
    calls[0].release()
    await tick()
    const next = execute(new AbortController().signal)
    await tick()
    assert.equal(calls.length, 65, 'adapter settlement releases one gate lease')
    await assert.rejects(execute(new AbortController().signal), /preflight is busy.*64/iu)
    calls[64].release()
    await next
    assert.equal(starts.length, 1)
  } finally {
    controllers.forEach(controller => controller.abort())
    calls.forEach(call => call.release())
    await tick()
    await dispose()
  }
})
