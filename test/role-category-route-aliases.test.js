import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeRoleCategoryRouteAliases,
  resolveRoleCategoryRouteAlias,
} from '../src/role-category-route-aliases.js'

const alias = (fromProvider = 'legacy', fromModel = 'model-v1', toProvider = 'current', toModel = 'model-v2', reasoningEffort) => ({
  from: { provider: fromProvider, model: fromModel },
  to: { provider: toProvider, model: toModel },
  ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
})

test('normalizes a bounded, exact, opt-in one-hop alias table', () => {
  assert.equal(normalizeRoleCategoryRouteAliases(false).size, 0)
  assert.throws(() => normalizeRoleCategoryRouteAliases(false, [alias()]), /requires enableRoleCategoryRouteAliases/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, [alias(), alias()]), /repeat source route/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, [
    alias('legacy', 'model-v1', 'middle', 'model-v2'),
    alias('middle', 'model-v2', 'current', 'model-v3'),
  ]), /must not chain or cycle/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, [alias('same', 'model', 'same', 'model')]), /must not map a route to itself/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, [alias('legacy', 'model\u202e', 'current', 'model-v2')]), /without control or bidi/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, [alias('legacy', 'model-v1', 'current', 'model-v2', ' ')]), /reasoningEffort.*non-empty string/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, [alias('legacy', 'model-v1', 'current', 'model-v2', 'x'.repeat(65))]), /reasoningEffort.*64 characters/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, Array.from({ length: 33 }, (_, index) => alias(`provider-${index}`, 'model'))), /at most 32/u)
  assert.throws(() => normalizeRoleCategoryRouteAliases(true, [{ ...alias(), prefix: 'legacy-' }]), /unsupported field/u)
})

test('matches exact provider/model pairs and preserves optional reasoning defaults', () => {
  const aliases = normalizeRoleCategoryRouteAliases(true, [
    alias('legacy', 'model-v1', 'current', 'model-v2', 'high'),
    alias('backup-legacy', 'backup-v1', 'backup-current', 'backup-v2', 'medium'),
  ])
  const resolved = resolveRoleCategoryRouteAlias(aliases, 'legacy', 'model-v1')
  assert.deepEqual(resolved, {
    from: { provider: 'legacy', model: 'model-v1' },
    to: { provider: 'current', model: 'model-v2' },
    reasoningEffort: 'high',
  })
  assert.equal(resolveRoleCategoryRouteAlias(aliases, 'legacy', 'different-model'), undefined)
  assert.equal(resolveRoleCategoryRouteAlias(aliases, 'different-provider', 'model-v1'), undefined)
})
