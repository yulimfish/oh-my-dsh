import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCategoryRoutes, normalizeExplicitFallbackModels, resolveCategoryRoute } from '../src/category-routes.js'
import { normalizeRoleCategoryRouteAliases } from '../src/role-category-route-aliases.js'

const routes = () => normalizeCategoryRoutes([
  { name: 'build', provider: 'provider-build', model: 'model-build', reasoningEffort: 'medium', maxTokens: 2048 },
  { name: 'review', provider: 'provider-review', model: 'model-review', reasoningEffort: 'low', maxTokens: 1024 },
])

test('normalizes immutable category primary routes and rejects invalid entries', () => {
  assert.throws(() => normalizeCategoryRoutes(undefined), /array/u)
  assert.throws(() => normalizeCategoryRoutes([null]), /must be an object/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: '  ', provider: 'p', model: 'm' }]), /name/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'x'.repeat(65), provider: 'p', model: 'm' }]), /name/u)
  assert.throws(() => normalizeCategoryRoutes(Array.from({ length: 33 }, (_, index) => ({
    name: `category-${index}`, provider: 'p', model: 'm',
  }))), /at most 32/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: ' ', model: 'm' }]), /provider/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: '' }]), /model/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: `bu\u202Eild`, provider: 'p', model: 'm' }]), /name/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', description: `plain\u2066text` }]), /description/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', tools: { [`read\u202E`]: true } }]), /invalid tool name/u)
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
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', skills: 'debugging' }]), /skills must be an array/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', skills: ['bad name'] }]), /valid kebab-case skill name/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', skills: ['debugging', 'debugging'] }]), /duplicate names/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', skills: ['debugging', 'git-master', 'review-work', 'visual-qa', 'security-research'] }]), /at most 4/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', provider: 'p', model: 'm', disable: 'true' }]), /disable must be a boolean/u)
  assert.throws(() => normalizeCategoryRoutes([{ name: 'build', disable: true }]), /requires both provider and model/u)
  assert.throws(() => resolveCategoryRoute(routes(), 'build', { maxTokens: 1.5 }), /role route maxTokens must be a positive safe integer/u)
})

test('normalizes bounded explicit category fallback model chains immutably', () => {
  const categoryRoutes = normalizeCategoryRoutes([{
    name: 'chain', provider: 'primary-provider', model: 'primary-model',
    fallbackModels: [
      { provider: 'backup-provider', model: 'backup-model', reasoningEffort: 'high', maxTokens: 4096 },
      { provider: 'second-provider', model: 'second-model' },
    ],
  }])
  const route = categoryRoutes.get('chain')
  assert.deepEqual(route.fallbackModels, [
    { provider: 'backup-provider', model: 'backup-model', reasoningEffort: 'high', maxTokens: 4096 },
    { provider: 'second-provider', model: 'second-model' },
  ])
  assert.equal(Object.isFrozen(route.fallbackModels), true)
  assert.equal(Object.isFrozen(route.fallbackModels[0]), true)
  assert.strictEqual(resolveCategoryRoute(categoryRoutes, 'chain', {}).fallbackModels, route.fallbackModels)

  const empty = normalizeCategoryRoutes([{
    name: 'empty', provider: 'p', model: 'm', fallbackModels: [],
  }]).get('empty')
  assert.equal(Object.hasOwn(empty, 'fallbackModels'), false)

  const invalid = [
    ['not an array', 'backup-provider/backup-model'],
    ['too many candidates', Array.from({ length: 4 }, (_value, index) => ({ provider: `p${index}`, model: `m${index}` }))],
    ['non-object candidate', [null]],
    ['missing pair', [{ provider: 'backup-provider' }]],
    ['blank provider', [{ provider: ' ', model: 'backup-model' }]],
    ['blank model', [{ provider: 'backup-provider', model: ' ' }]],
    ['blank reasoning', [{ provider: 'backup-provider', model: 'backup-model', reasoningEffort: ' ' }]],
    ['zero fallback maxTokens', [{ provider: 'backup-provider', model: 'backup-model', maxTokens: 0 }]],
    ['fractional fallback maxTokens', [{ provider: 'backup-provider', model: 'backup-model', maxTokens: 1.5 }]],
    ['unsupported field', [{ provider: 'backup-provider', model: 'backup-model', temperature: 0 }]],
    ['duplicate primary', [{ provider: 'primary-provider', model: 'primary-model' }]],
    ['duplicate candidate', [
      { provider: 'backup-provider', model: 'backup-model' },
      { provider: ' backup-provider ', model: ' backup-model ' },
    ]],
  ]
  for (const [label, fallbackModels] of invalid) {
    assert.throws(() => normalizeCategoryRoutes([{
      name: 'invalid-chain', provider: 'primary-provider', model: 'primary-model', fallbackModels,
    }]), /fallbackModels/u, label)
  }
})

test('resolves fallback-only role chains without categories and preserves pinned precedence', () => {
  const categoryRoutes = normalizeCategoryRoutes([{
    name: 'chain', provider: 'category-primary', model: 'category-model',
    fallbackModels: [{ provider: 'category-backup', model: 'category-backup-model' }],
  }])
  const unpinnedRole = {
    role: 'explore',
    fallbackModels: [{ provider: 'role-backup', model: 'role-backup-model' }],
  }
  const fallbackOnly = resolveCategoryRoute(categoryRoutes, undefined, unpinnedRole)
  assert.deepEqual(fallbackOnly.fallbackModels, unpinnedRole.fallbackModels)
  assert.equal(Object.hasOwn(fallbackOnly, 'provider'), false)
  assert.equal(Object.hasOwn(fallbackOnly, 'model'), false)
  assert.equal(Object.isFrozen(fallbackOnly), true)
  assert.equal(Object.isFrozen(fallbackOnly.fallbackModels[0]), true)
  assert.deepEqual(resolveCategoryRoute(categoryRoutes, undefined, { ...unpinnedRole, category: undefined }).fallbackModels, unpinnedRole.fallbackModels)
  assert.throws(() => resolveCategoryRoute(categoryRoutes, 'chain', unpinnedRole), /cannot be combined/u)
  assert.throws(() => resolveCategoryRoute(categoryRoutes, undefined, { ...unpinnedRole, category: 'chain' }), /cannot be combined/u)

  const pinnedRole = {
    role: 'explore', provider: 'role-primary', model: 'role-primary-model',
    fallbackModels: [{ provider: 'role-backup', model: 'role-backup-model' }],
  }
  assert.strictEqual(resolveCategoryRoute(categoryRoutes, undefined, pinnedRole).fallbackModels, pinnedRole.fallbackModels)
  assert.strictEqual(resolveCategoryRoute(categoryRoutes, 'chain', pinnedRole).fallbackModels, pinnedRole.fallbackModels)

  const pinnedRoleWithoutFallback = {
    role: 'explore', provider: 'role-primary', model: 'role-primary-model',
  }
  const pinnedRoute = resolveCategoryRoute(categoryRoutes, 'chain', pinnedRoleWithoutFallback)
  assert.equal(Object.hasOwn(pinnedRoute, 'fallbackModels'), false,
    'a paired role pin without its own chain must not inherit the category fallback chain')
})

test('validates fallback-only candidates and retains normalized alias metadata', () => {
  const aliases = normalizeRoleCategoryRouteAliases(true, [
    { from: { provider: 'alias', model: 'm' }, to: { provider: 'actual', model: 'model' }, reasoningEffort: 'high' },
  ])
  const chain = normalizeExplicitFallbackModels([{ provider: 'alias', model: 'm', maxTokens: 200 }], 'fallbackModels', undefined, aliases)
  assert.equal(chain[0].provider, 'actual')
  assert.equal(chain[0].model, 'model')
  assert.equal(chain[0].routeAlias.reasoningEffort, 'high')
  const resolved = resolveCategoryRoute(routes(), undefined, { role: 'explore', fallbackModels: chain })
  assert.strictEqual(resolved.fallbackModels, chain)
  assert.throws(() => normalizeExplicitFallbackModels([
    { provider: 'alias', model: 'm' }, { provider: 'actual', model: 'model' },
  ], 'fallbackModels', undefined, aliases), /duplicate/u)

  for (const fallbackModels of [[], null, 'p/m', [null], [{ provider: 'p' }],
    [{ provider: 'p', model: 'm', extra: true }],
    [{ provider: 'p\u202e', model: 'm' }],
    [{ provider: 'p', model: 'm', maxTokens: 0 }],
    [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }],
    Array.from({ length: 4 }, (_, index) => ({ provider: 'p', model: `m${index}` })),
  ]) {
    assert.throws(() => resolveCategoryRoute(routes(), undefined, { role: 'explore', fallbackModels }), /fallback/u)
  }
  for (const pin of [{ provider: 'p' }, { model: 'm' }]) {
    assert.throws(() => resolveCategoryRoute(routes(), undefined, {
      role: 'explore', ...pin, fallbackModels: [{ provider: 'p2', model: 'm2' }],
    }), /must be set together/u)
  }
  assert.equal(resolveCategoryRoute(routes(), undefined, undefined), undefined)
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

test('resolves bounded category skill defaults from the selected category', () => {
  const categoryRoutes = normalizeCategoryRoutes([
    { name: 'build', provider: 'provider-build', model: 'model-build', skills: ['debugging', 'git-master'] },
    { name: 'review', provider: 'provider-review', model: 'model-review', skills: ['visual-qa'] },
    { name: 'empty', provider: 'provider-empty', model: 'model-empty', skills: [] },
  ])
  const roleRoute = Object.freeze({ category: 'build' })

  const defaulted = resolveCategoryRoute(categoryRoutes, undefined, roleRoute)
  assert.deepEqual(defaulted.categorySkills, ['debugging', 'git-master'])
  assert.equal(Object.isFrozen(defaulted.categorySkills), true)
  assert.deepEqual(resolveCategoryRoute(categoryRoutes, 'review', roleRoute).categorySkills, ['visual-qa'])
  assert.deepEqual(resolveCategoryRoute(categoryRoutes, 'empty', roleRoute).categorySkills, [])
  assert.equal(Object.hasOwn(resolveCategoryRoute(routes(), 'build', undefined), 'categorySkills'), false)
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

test('normalizes bounded single-line category descriptions for chooser prompts', () => {
  const routes = normalizeCategoryRoutes([
    { name: 'review', provider: 'p', model: 'm', description: '  Review patches for regressions.  ' },
    { name: 'blank', provider: 'p2', model: 'm2', description: '  \t  ' },
  ])
  const maximumDescription = 'é'.repeat(256)
  assert.equal(routes.get('review').description, 'Review patches for regressions.')
  assert.equal(routes.get('blank').description, undefined)
  assert.equal(normalizeCategoryRoutes([
    { name: 'limit', provider: 'p3', model: 'm3', description: maximumDescription },
  ]).get('limit').description, maximumDescription)

  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', description: 42 },
  ]), /description must be a string/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', description: 'é'.repeat(257) },
  ]), /512 UTF-8 bytes/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', description: ' '.repeat(513) },
  ]), /512 UTF-8 bytes/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', description: 'multi-line\ndescription' },
  ]), /single line/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', description: 'bad\u009ftext' },
  ]), /single line/u)
  for (const description of ['\nleading', 'trailing\r', 'before\u2028after', 'before\u2029after']) {
    assert.throws(() => normalizeCategoryRoutes([
      { name: 'bad', provider: 'p', model: 'm', description },
    ]), /single line/u)
  }
})

test('normalizes category tool maps to bounded inherited-tool allow/deny rules', () => {
  const categoryRoutes = normalizeCategoryRoutes([
    { name: 'restricted', provider: 'p', model: 'm', tools: { read: false, grep: true } },
    { name: 'grants-none', provider: 'p2', model: 'm2', tools: { read: true } },
  ])
  assert.deepEqual(categoryRoutes.get('restricted').categoryAllowTools, ['grep'])
  assert.deepEqual(categoryRoutes.get('restricted').categoryDenyTools, ['read'])
  assert.equal(Object.isFrozen(categoryRoutes.get('restricted').categoryAllowTools), true)
  assert.equal(Object.isFrozen(categoryRoutes.get('restricted').categoryDenyTools), true)
  assert.deepEqual(categoryRoutes.get('grants-none').categoryAllowTools, ['read'])
  assert.equal(categoryRoutes.get('grants-none').categoryDenyTools, undefined)
  const exactByteLimitName = 'é'.repeat(64)
  assert.deepEqual(normalizeCategoryRoutes([
    { name: 'byte-limit', provider: 'p3', model: 'm3', tools: { [exactByteLimitName]: false } },
  ]).get('byte-limit').categoryDenyTools, [exactByteLimitName])
  assert.deepEqual(normalizeCategoryRoutes([
    { name: 'byte-allow', provider: 'p3', model: 'm3', tools: { [exactByteLimitName]: true } },
  ]).get('byte-allow').categoryAllowTools, [exactByteLimitName])
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'byte-over-limit', provider: 'p3', model: 'm3', tools: { ['é'.repeat(65)]: false } },
  ]), /invalid tool name/u)
  for (const toolName of ['read\u009f', 'read\u2028', 'read\u2029']) {
    assert.throws(() => normalizeCategoryRoutes([
      { name: 'bad-control', provider: 'p3', model: 'm3', tools: { [toolName]: false } },
    ]), /invalid tool name/u)
  }
  const resolved = resolveCategoryRoute(categoryRoutes, 'restricted', {
    allowTools: Object.freeze(['read', 'grep']), denyTools: Object.freeze(['bash']),
  })
  assert.deepEqual(resolved.categoryAllowTools, ['grep'])
  assert.deepEqual(resolved.categoryDenyTools, ['read'])
  assert.deepEqual(resolved.allowTools, ['read', 'grep'])
  assert.deepEqual(resolved.denyTools, ['bash'])

  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', tools: [] },
  ]), /tools must be a plain object/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', tools: { read: 'false' } },
  ]), /tools values must be booleans/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', tools: { ' read': false } },
  ]), /invalid tool name/u)
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', tools: { 'read\n': false } },
  ]), /invalid tool name/u)
  for (const enabled of [true, false]) {
    assert.throws(() => normalizeCategoryRoutes([
      { name: 'reserved', provider: 'p', model: 'm', tools: { run_code: enabled } },
    ]), /reserved tool "run_code"/u)
  }
  assert.throws(() => normalizeCategoryRoutes([
    { name: 'bad', provider: 'p', model: 'm', tools: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`tool-${index}`, true])) },
  ]), /at most 64 tool rules/u)
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

test('applies role/category route aliases before route selection and fallback validation', () => {
  const aliases = normalizeRoleCategoryRouteAliases(true, [
    {
      from: { provider: 'legacy', model: 'primary-v1' },
      to: { provider: 'current', model: 'primary-v2' },
      reasoningEffort: 'high',
    },
    {
      from: { provider: 'legacy-backup', model: 'backup-v1' },
      to: { provider: 'current-backup', model: 'backup-v2' },
      reasoningEffort: 'low',
    },
  ])
  const categoryRoutes = normalizeCategoryRoutes([{
    name: 'review',
    provider: 'legacy',
    model: 'primary-v1',
    fallbackModels: [{ provider: 'legacy-backup', model: 'backup-v1', reasoningEffort: 'high' }],
  }], aliases)
  const categoryRoute = categoryRoutes.get('review')
  assert.deepEqual([categoryRoute.provider, categoryRoute.model], ['current', 'primary-v2'])
  assert.deepEqual(categoryRoute.routeAlias, {
    from: { provider: 'legacy', model: 'primary-v1' },
    to: { provider: 'current', model: 'primary-v2' },
    reasoningEffort: 'high',
  })
  assert.deepEqual(categoryRoute.reasoningEffort, undefined, 'an alias default stays separate from use-site controls')
  assert.deepEqual(categoryRoute.fallbackModels, [{
    provider: 'current-backup',
    model: 'backup-v2',
    routeAlias: {
      from: { provider: 'legacy-backup', model: 'backup-v1' },
      to: { provider: 'current-backup', model: 'backup-v2' },
      reasoningEffort: 'low',
    },
    reasoningEffort: 'high',
  }])
  assert.deepEqual(resolveCategoryRoute(categoryRoutes, 'review').routeAlias, categoryRoute.routeAlias)

  const roleAlias = {
    from: { provider: 'role-legacy', model: 'role-v1' },
    to: { provider: 'role-current', model: 'role-v2' },
    reasoningEffort: 'max',
  }
  const rolePinned = resolveCategoryRoute(categoryRoutes, 'review', {
    provider: 'role-current', model: 'role-v2', routeAlias: roleAlias,
  })
  assert.deepEqual([rolePinned.provider, rolePinned.model], ['role-current', 'role-v2'])
  assert.deepEqual(rolePinned.routeAlias, roleAlias, 'an explicit role pin keeps its own alias provenance')
  assert.equal(rolePinned.reasoningEffort, undefined, 'a role alias default remains separate until the selected route is materialized')

  assert.throws(() => normalizeCategoryRoutes([{
    name: 'duplicate-after-alias',
    provider: 'legacy',
    model: 'primary-v1',
    fallbackModels: [{ provider: 'current', model: 'primary-v2' }],
  }], aliases), /duplicate provider\/model candidates/u)
})
