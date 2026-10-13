import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCategoryRoutes, resolveCategoryRoute } from '../src/category-routes.js'

const routes = () => normalizeCategoryRoutes([
  { name: 'build', provider: 'provider-build', model: 'model-build', reasoningEffort: 'medium', maxTokens: 2048 },
  { name: 'review', provider: 'provider-review', model: 'model-review', reasoningEffort: 'low', maxTokens: 1024 },
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
  for (const maxTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
    assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', maxTokens }]), /maxTokens must be a positive safe integer/u)
  }
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', fallback: ['p2/m2'] }]), /unsupported field.*fallback/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', chains: [] }]), /unsupported field.*chains/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', disable: 'true' }]), /disable must be a boolean/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', disable: true }]), /requires both provider and model/u)
  assert.throws(() => resolveCategoryRoute(routes(), 'build', { maxTokens: 1.5 }), /role route maxTokens must be a positive safe integer/u)
})

test('resolves explicit category before the role default category', () => {
  const categoryRoutes = routes()
  const roleRoute = Object.freeze({ category: 'build', allowTools: Object.freeze(['read']) })

  const explicit = resolveCategoryRoute(categoryRoutes, 'review', roleRoute)
  assert.equal(explicit.category, 'review')
  assert.equal(explicit.provider, 'provider-review')
  assert.equal(explicit.model, 'model-review')
  assert.equal(explicit.reasoningEffort, 'low')
  assert.equal(explicit.maxTokens, 1024)

  const defaulted = resolveCategoryRoute(categoryRoutes, undefined, roleRoute)
  assert.equal(defaulted.category, 'build')
  assert.equal(defaulted.provider, 'provider-build')
  assert.equal(defaulted.model, 'model-build')
  assert.equal(defaulted.maxTokens, 2048)
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
  assert.equal(resolved.maxTokens, 512)
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

test('disabled categories are omitted from selection and rejected when resolved', () => {
  const categoryRoutes = normalizeCategoryRoutes([
    { name: 'enabled', provider: 'p', model: 'm' },
    { name: 'disabled', provider: 'p-disabled', model: 'm-disabled', disable: true },
  ])
  assert.equal(categoryRoutes.get('enabled').disable, false)
  assert.equal(categoryRoutes.get('disabled').disable, true)
  assert.throws(
    () => resolveCategoryRoute(categoryRoutes, 'disabled', undefined),
    /disabled explicit category "disabled"/u,
  )
  assert.throws(
    () => resolveCategoryRoute(categoryRoutes, undefined, { category: 'disabled' }),
    /disabled default category "disabled"/u,
  )
})

test('normalizes bounded literal category guidance and carries the selected append separately', () => {
  const categoryRoutes = normalizeCategoryRoutes([
    { name: 'build', provider: 'p', model: 'm', promptAppend: '  Prefer build-mode analysis.  ' },
    { name: 'review', provider: 'p2', model: 'm2', promptAppend: 'file:///tmp/category-guidance.md' },
    { name: 'blank', provider: 'p3', model: 'm3', promptAppend: ' \t\r\n ' },
  ])
  const roleRoute = Object.freeze({ category: 'build', promptAppend: 'Cite the changed files.' })

  assert.equal(categoryRoutes.get('build').promptAppend, 'Prefer build-mode analysis.')
  assert.equal(categoryRoutes.get('blank').promptAppend, undefined)
  const explicit = resolveCategoryRoute(categoryRoutes, 'review', roleRoute)
  assert.equal(explicit.categoryPromptAppend, 'file:///tmp/category-guidance.md')
  assert.equal(explicit.promptAppend, 'Cite the changed files.')
  const defaulted = resolveCategoryRoute(categoryRoutes, undefined, roleRoute)
  assert.equal(defaulted.categoryPromptAppend, 'Prefer build-mode analysis.')
  assert.equal(defaulted.promptAppend, 'Cite the changed files.')
  const maximumAppend = 'é'.repeat(2048)
  assert.equal(normalizeCategoryRoutes([
    { name: 'limit', provider: 'p4', model: 'm4', promptAppend: maximumAppend },
  ]).get('limit').promptAppend, maximumAppend)

  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', promptAppend: 42 },
  ]), /Category route "bad" promptAppend must be a string/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', promptAppend: 'é'.repeat(2049) },
  ]), /4096 UTF-8 bytes/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', promptAppend: ' '.repeat(4097) },
  ]), /4096 UTF-8 bytes/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', promptAppend: 'before\u0000after' },
  ]), /disallowed control characters/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', promptAppend: 'before\u009fafter' },
  ]), /disallowed control characters/u)
})

test('normalizer registry, category routes, and resolved routes are immutable', () => {
  const categoryRoutes = routes()
  const categoryRoute = categoryRoutes.get('build')
  const resolved = resolveCategoryRoute(categoryRoutes, 'build', { maxTokens: 128 })

  assert.equal(Object.isFrozen(categoryRoutes), true)
  assert.equal(categoryRoutes.size, 2)
  assert.equal(categoryRoutes.has('build'), true)
  assert.equal(categoryRoutes.set, undefined)
  assert.equal(categoryRoute.maxTokens, 2048)
  assert.equal(Object.isFrozen(categoryRoute), true)
  assert.equal(resolved.maxTokens, 128)
  assert.equal(Object.isFrozen(resolved), true)
  assert.throws(() => { categoryRoute.provider = 'mutated' }, TypeError)
  assert.throws(() => { resolved.provider = 'mutated' }, TypeError)
})
