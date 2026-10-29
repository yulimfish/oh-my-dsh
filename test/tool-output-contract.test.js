import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { checkToolOutput } from '../scripts/tool-output-contract.js'

function definition(render = (_args, value) => [{ type: 'text', text: value }]) {
  return {
    name: 'audit-control',
    output: { schema: { type: 'string' }, render },
  }
}

test('output audit accepts matching values and actual rendered text', () => {
  assert.doesNotThrow(() => checkToolOutput(definition(), {}, 'valid', validateJsonSchemaValue))
})

test('output audit detects schema failures before invoking renderers', () => {
  let rendered = false
  assert.throws(() => checkToolOutput(definition(() => { rendered = true; return [] }), {}, 42, validateJsonSchemaValue), /output schema mismatch/u)
  assert.equal(rendered, false)
})

test('output audit detects thrown renderers and invalid content', () => {
  assert.throws(() => checkToolOutput(definition(() => { throw new Error('renderer failed') }), {}, 'valid', validateJsonSchemaValue), /renderer failed/u)
  for (const content of [undefined, {}, [null], [{ type: 'text', text: 42 }]]) {
    assert.throws(() => checkToolOutput(definition(() => content), {}, 'valid', validateJsonSchemaValue), /invalid content blocks/u)
  }
})

test('installed audit hook fails the process even when callers catch its contract errors', () => {
  for (const failure of ['schema', 'renderer']) {
    const script = `
      import { defineTool } from '@deepseek-ai/dsh-tools';
      const tool = defineTool({
        name: 'audit-negative-control', description: 'Never registered.', parameters: {},
        output: { schema: { type: 'string' }, render: () => {
          ${failure === 'renderer' ? "throw new Error('renderer-control');" : "return [{ type: 'text', text: 'valid' }];"}
        } },
        execute: async () => ${failure === 'schema' ? '42' : "'valid'"},
      });
      try { await tool.execute({}, {}); } catch {}
    `
    const observed = spawnSync(process.execPath, [
      '--import', new URL('../scripts/audit-tool-outputs.mjs', import.meta.url).href,
      '--input-type=module', '-e', script,
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 })
    assert.equal(observed.error, undefined)
    assert.equal(observed.status, 1, observed.stderr)
    assert.match(observed.stderr, /\[tool-output-audit\]/u)
    assert.match(observed.stderr, failure === 'schema' ? /output schema mismatch/u : /renderer-control/u)
  }
})

test('output audit catches the real defineTool missing-renderer regression', () => {
  const tool = defineTool({
    name: 'audit-missing-renderer',
    description: 'Positive control; never registered or executed.',
    parameters: {},
    output: { schema: { type: 'string' } },
    execute: async () => 'valid',
  })
  assert.equal(typeof tool.output.render, 'function', 'a wrapper alone does not prove a renderer exists')
  assert.throws(() => checkToolOutput(tool, {}, 'valid', validateJsonSchemaValue), /userRender is not a function/u)
})
