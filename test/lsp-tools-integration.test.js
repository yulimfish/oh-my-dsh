import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { registerLspNavigationTools } from '../src/lsp-tools.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

for (const stage of ['root', 'file']) {
  for (const settlement of ['resolve', 'reject']) {
    for (const name of ['lsp_goto_definition', 'lsp_hover']) {
      test(`native ${name}: abort during ${stage} resolution before late ${settlement}`, { timeout: 3000 }, async t => {
        const ctx = new Context()
        const gate = deferred()
        const entered = deferred()
        const calls = []
        const secret = 'PRIVATE_LATE_RESOLUTION_CONTENT'
        const agent = { id: 'lsp-integration-agent' }
        const cwd = '/workspace/project'
        const sessions = { get(id) { assert.equal(id, agent.id); return { header: { id, cwd } } } }
        const fs = {
          resolve(path, options) {
            const currentStage = path === cwd ? 'root' : 'file'
            calls.push(['resolve', currentStage, path, options])
            assert.ok(options.signal instanceof AbortSignal)
            if (currentStage === stage) {
              entered.resolve()
              return gate.promise // Deliberately ignore the signal.
            }
            return Promise.resolve({ path: cwd })
          },
          contains() { calls.push(['contains']); return true },
          processPath(target) { calls.push(['processPath']); return target.path },
        }
        const service = { query() { calls.push(['query']); throw new Error('Unexpected LSP query') } }
        let promptFiber, runtimeFiber, unregister
        t.after(async () => {
          gate.resolve({ path: secret })
          unregister?.()
          await runtimeFiber?.dispose()
          await promptFiber?.dispose()
        })
        promptFiber = await ctx.plugin(SystemPrompt)
        runtimeFiber = await ctx.plugin(ToolRuntime)
        unregister = registerLspNavigationTools(ctx, service, sessions, fs)
        const controller = new AbortController()
        const pending = ctx.tools.execute({
          callId: `${name}-${stage}-${settlement}`,
          name,
          arguments: { filePath: 'src/example.js', line: 1, character: 0 },
          agent,
          signal: controller.signal,
        })
        await entered.promise
        assert.deepEqual(calls.map(call => call[0] === 'resolve' ? call[1] : call[0]), stage === 'root' ? ['root'] : ['root', 'file'])
        if (stage === 'file') assert.equal(calls[1][3].cwd, cwd)
        controller.abort()
        const result = await pending
        assert.equal(result.isError, true)
        assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
        const beforeLateSettlement = calls.length
        if (settlement === 'resolve') gate.resolve({ path: secret })
        else gate.reject(new Error(secret))
        // Allow late continuations and Node's unhandled-rejection reporting to run.
        await tick()
        await tick()
        assert.equal(calls.length, beforeLateSettlement, 'no further filesystem or LSP work after cancellation')
        assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
      })
    }
  }
}
