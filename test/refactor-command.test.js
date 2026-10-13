import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRefactorDirective,
  parseRefactorInput,
  REFACTOR_COMMAND_HINT,
} from '../src/refactor-command.js'

function parse(input, limit) {
  return parseRefactorInput(input, limit)
}

test('requires a bounded target and defaults locally to target-only safe mode', () => {
  const parsed = parse('  src/components/date picker.ts refactor  ')
  assert.deepEqual(parsed, {
    ok: true,
    target: 'src/components/date picker.ts refactor',
    scope: 'target',
    strategy: 'safe',
    scopeExplicit: false,
    strategyExplicit: false,
  })
  assert.equal(parse('   ').ok, false)
  assert.equal(parse(undefined).ok, false)
  assert.equal(parse('src/large.ts', 5).ok, false)
  assert.equal(parse(`src/${'x'.repeat(12_000)}`, 20_000).ok, false, 'hard parser bound applies even if config is larger')
})

test('accepts exact trailing options in either order and preserves target spacing', () => {
  const parsed = parse('Refactor the auth module --scope=module --strategy=safe')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.target, 'Refactor the auth module')
  assert.equal(parsed.scope, 'module')
  assert.equal(parsed.strategy, 'safe')
  assert.equal(parsed.scopeExplicit, true)
  assert.equal(parsed.strategyExplicit, true)

  const reverse = parse('"src/quoted file.ts" --strategy=aggressive --scope=file')
  assert.equal(reverse.ok, true)
  assert.equal(reverse.target, '"src/quoted file.ts"', 'quotes remain literal target text; no shell parsing occurs')
  assert.equal(reverse.scope, 'file')
  assert.equal(reverse.strategy, 'aggressive')
})

test('supports explicit project and aggressive opt-in', () => {
  const parsed = parse('Refactor the module boundaries --scope=project --strategy=aggressive')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.scope, 'project')
  assert.equal(parsed.strategy, 'aggressive')
  const directive = buildRefactorDirective(parsed)
  assert.match(directive, /explicitly opted into by the user/u)
  assert.match(directive, /Scope guidance: the user-requested project scope/u)
})

test('rejects duplicate, unknown, misplaced, malformed, and invalid options', () => {
  const invalid = [
    'target --scope=file --scope=module',
    'target --strategy=safe --strategy=aggressive',
    'target --unknown=value',
    'target --scope',
    'target --scope file',
    'target --scope=',
    'target --scope=workspace',
    'target --strategy=fast',
    'target --scope=file trailing words',
    '--scope=file --strategy=safe',
  ]
  for (const input of invalid) {
    assert.equal(parse(input).ok, false, `expected rejection for: ${input}`)
  }
})

test('directive distinguishes prompt guidance from DSH enforcement and available tools', () => {
  const directive = buildRefactorDirective({ scope: 'target', strategy: 'safe' })
  assert.match(directive, /dsh-omo local default/u)
  assert.match(directive, /not a filesystem, cwd, tool, or permission boundary/u)
  assert.match(directive, /LSP rename\/navigation, AST-grep, and codemap tools are unverified/u)
  assert.match(directive, /not guaranteed or automatically enforced phases/u)
  assert.match(directive, /review the final diff/u)
  assert.match(REFACTOR_COMMAND_HINT, /^<target> \[--scope=/u)
})
