import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCategoryRoutes, resolveCategoryRoute } from '../src/category-routes.js'

const routes = () => normalizeCategoryRoutes([
  { name: 'build', provider: 'provider-build', model: 'model-build', reasoningEffort: 'medium' },
  { name: 'review', provider: 'provider-review', model: 'model-review', reasoningEffort: 'low' },
])

test('normalizes immutable single provider/model routes and rejects invalid category entries', () => {
  assert.throws(() => normalizeCategoryRoutes(undefined), /array/u)
  assert.throws(() => normalizeCategoryRoutes([null]), /must be an object/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: '  ', provider: 'p', model: 'm' }]), /name/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'x'.repeat(65), provider: 'p', model: 'm' }]), /name/u)
  assert.throws(() => normalizeCategoryRoutes(Array.from({ length: 33 }, (_, index) => ({
    name: `category-${index}`, provider: 'p', model: 'm',
  }))), /at most 32/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: ' ', model: 'm' }]), /provider/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: '' }]), /model/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p' }]), /together/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build' }]), /requires both provider and model/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', reasoningEffort: ' ' }]), /reasoningEffort/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'build', provider: 'p', model: 'm' },
    { name: ' build ', provider: 'p2', model: 'm2' },
  ]), /duplicate category route/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', maxTokens: 100 }]), /unsupported field.*maxTokens/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', fallback: ['p2/m2'] }]), /unsupported field.*fallback/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', chains: [] }]), /unsupported field.*chains/u)
})

test('resolves explicit category before the role default category', () => {
  const categoryRoutes = routes()
  const roleRoute = Object.freeze({ category: 'build', allowTools: Object.freeze(['read']) })

  const explicit = resolveCategoryRoute(categoryRoutes, 'review', roleRoute)
  assert.equal(explicit.category, 'review')
  assert.equal(explicit.provider, 'provider-review')
  assert.equal(explicit.model, 'model-review')
  assert.equal(explicit.reasoningEffort, 'low')

  const defaulted = resolveCategoryRoute(categoryRoutes, undefined, roleRoute)
  assert.equal(defaulted.category, 'build')
  assert.equal(defaulted.provider, 'provider-build')
  assert.equal(defaulted.model, 'model-build')
})

test('explicit per-role provider/model and reasoning settings override a category route', () => {
  const categoryRoutes = routes()
  const allowTools = Object.freeze(['read', 'grep'])
  const roleRoute = Object.freeze({
    role: 'explore',
    category: 'build',
    provider: 'role-provider',
    model: 'role-model',
    reasoningEffort: 'high',
    allowTools,
    maxTokens: 2048,
  })

  const resolved = resolveCategoryRoute(categoryRoutes, 'review', roleRoute)
  assert.deepEqual(
    { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort },
    { provider: 'role-provider', model: 'role-model', reasoningEffort: 'high' },
  )
  assert.strictEqual(resolved.allowTools, allowTools)
  assert.equal(resolved.maxTokens, 2048)
  assert.equal(resolved.role, 'explore')
  assert.equal(resolved.category, 'review')
})

test('preserves category reasoning when a role has no reasoning override', () => {
  const resolved = resolveCategoryRoute(routes(), 'build', { allowTools: ['read'], maxTokens: 512 })
  assert.equal(resolved.reasoningEffort, 'medium')
})

test('omitted category with no role default preserves legacy role-route behavior', () => {
  const categoryRoutes = routes()
  const legacyRoleRoute = Object.freeze({
    provider: 'legacy-provider',
    model: 'legacy-model',
    reasoningEffort: 'low',
    allowTools: Object.freeze(['read']),
    maxTokens: 1024,
  })

  assert.strictEqual(resolveCategoryRoute(categoryRoutes, undefined, legacyRoleRoute), legacyRoleRoute)
  assert.equal(resolveCategoryRoute(categoryRoutes, undefined, undefined), undefined)
  const mutableLegacyRoute = { provider: 'legacy-provider', model: 'legacy-model' }
  const frozenCopy = resolveCategoryRoute(categoryRoutes, undefined, mutableLegacyRoute)
  assert.deepEqual(frozenCopy, mutableLegacyRoute)
  assert.notStrictEqual(frozenCopy, mutableLegacyRoute)
  assert.equal(Object.isFrozen(frozenCopy), true)
})

test('unknown explicit and default categories fail closed with clear errors', () => {
  const categoryRoutes = routes()
  assert.throws(
    () => resolveCategoryRoute(categoryRoutes, 'missing', { category: 'build' }),
    /unknown explicit category "missing"/u,
  )
  assert.throws(
    () => resolveCategoryRoute(categoryRoutes, undefined, { category: 'missing' }),
    /unknown default category "missing"/u,
  )
})

test('normalizer registry, category routes, and resolved routes are immutable', () => {
  const categoryRoutes = routes()
  const categoryRoute = categoryRoutes.get('build')
  const resolved = resolveCategoryRoute(categoryRoutes, 'build', { maxTokens: 128 })

  assert.equal(Object.isFrozen(categoryRoutes), true)
  assert.equal(categoryRoutes.size, 2)
  assert.equal(categoryRoutes.has('build'), true)
  assert.equal(categoryRoutes.set, undefined)
  assert.equal(Object.isFrozen(categoryRoute), true)
  assert.equal(Object.isFrozen(resolved), true)
  assert.throws(() => { categoryRoute.provider = 'mutated' }, TypeError)
  assert.throws(() => { resolved.provider = 'mutated' }, TypeError)
})
