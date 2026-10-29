import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeModelCatalog, resolveModelCatalogReference } from '../src/model-catalog.js'

test('normalizes copied immutable catalog entries and a readonly registry', () => {
  assert.equal(normalizeModelCatalog(undefined).size, 0)
  assert.deepEqual(normalizeModelCatalog({ a: { model: 'p/m', reasoning: undefined } }).get('a'), { provider: 'p', model: 'm' })
  const input = Object.create(null)
  input.fast = { model: 'provider/vendor/model', reasoning: 'medium' }
  const catalog = normalizeModelCatalog(input)
  input.fast.model = 'changed/model'
  assert.deepEqual(catalog.get('fast'), { provider: 'provider', model: 'vendor/model', reasoning: 'medium' })
  assert.equal(catalog.size, 1)
  assert.equal(catalog.get('missing'), undefined)
  assert.equal(Object.isFrozen(catalog), true)
  assert.equal(Object.isFrozen(catalog.get('fast')), true)
  assert.equal(catalog.set, undefined)
  assert.throws(() => { catalog.get('fast').model = 'mutated' }, TypeError)
})

test('accepts inclusive alias, count, selector and reasoning bounds', () => {
  const entries = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`a${i}`, { model: 'p/m' }]))
  entries['a'.repeat(64)] = entries.a0
  delete entries.a0
  const catalog = normalizeModelCatalog(entries)
  assert.equal(catalog.size, 64)
  const bounded = normalizeModelCatalog({ a: { model: `${'p'.repeat(128)}/${'m'.repeat(256)}`, reasoning: 'r'.repeat(64) } })
  assert.equal(bounded.get('a').provider.length, 128)
  assert.equal(bounded.get('a').model.length, 256)
})

test('rejects invalid records, aliases, count and selector shapes', () => {
  for (const input of [null, [], 'text', 3, new Date(), new Map(), Object.create({ inherited: true })]) {
    assert.throws(() => normalizeModelCatalog(input), TypeError)
  }
  for (const alias of ['', '1bad', 'a b', 'a/b', 'a'.repeat(65), '__proto__', 'prototype', 'constructor']) {
    assert.throws(() => normalizeModelCatalog(Object.fromEntries([[alias, { model: 'p/m' }]])), /alias/u)
  }
  assert.throws(() => normalizeModelCatalog(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a${i}`, { model: 'p/m' }]))), /at most 64/u)
  for (const value of [null, [], 'p/m', new Date(), {}, { model: 'otherAlias' }, { model: '/m' }, { model: 'p/' },
    { model: `${'p'.repeat(129)}/m` }, { model: `p/${'m'.repeat(257)}` },
    { model: ' p/m' }, { model: 'p/m ' }, { model: 'p /m' }, { model: 'p/ m' },
    { model: 'p/m', extra: true }, { model: 'p/m', reasoning: '' },
    { model: 'p/m', reasoning: null }, { model: 'p/m', reasoning: 'r'.repeat(65) },
  ]) assert.throws(() => normalizeModelCatalog({ a: value }), TypeError)
  assert.throws(() => normalizeModelCatalog({ a: { model: 'b' }, b: { model: 'a' } }), /provider\/model/u)
})

test('rejects symbols and accessors without invoking getters', () => {
  let calls = 0
  const accessor = {}
  Object.defineProperty(accessor, 'a', { get() { calls += 1; return { model: 'p/m' } } })
  assert.throws(() => normalizeModelCatalog(accessor), /data properties/u)
  const value = {}
  Object.defineProperty(value, 'model', { get() { calls += 1; return 'p/m' } })
  assert.throws(() => normalizeModelCatalog({ a: value }), /data properties/u)
  for (const input of [{ [Symbol('a')]: { model: 'p/m' } }, { a: { model: 'p/m', [Symbol('reason')]: 'high' } }]) {
    assert.throws(() => normalizeModelCatalog(input), /string-keyed/u)
  }
  assert.equal(calls, 0)
})

test('rejects controls, bidi and line separators in selectors and reasoning', () => {
  for (const control of ['\0', '\n', '\r', '\t', '\u007f', '\u0085', '\u2028', '\u2029', '\u202e', '\u2066']) {
    for (const value of [{ model: `p${control}/m` }, { model: `p/m${control}` }, { model: 'p/m', reasoning: `high${control}` }]) {
      assert.throws(() => normalizeModelCatalog({ a: value }), TypeError)
    }
  }
})

test('resolves exact trimmed model-only aliases once with use-site precedence', () => {
  const catalog = normalizeModelCatalog({ fast: { model: 'p/vendor/fast', reasoning: 'medium' } })
  const site = { role: 'explore', model: ' fast ', maxTokens: 300, promptAppend: 'guide' }
  const original = { ...site }
  const resolved = resolveModelCatalogReference(catalog, site)
  assert.deepEqual(resolved, { ...site, provider: 'p', model: 'vendor/fast', reasoningEffort: 'medium' })
  assert.deepEqual(site, original)
  assert.notStrictEqual(resolved, site)
  assert.deepEqual(Object.keys(resolved).sort(), ['maxTokens', 'model', 'promptAppend', 'provider', 'reasoningEffort', 'role'])
  for (const reasoningEffort of ['high', '', null]) {
    assert.equal(resolveModelCatalogReference(catalog, { model: 'fast', reasoningEffort }).reasoningEffort, reasoningEffort)
  }
  assert.equal(resolveModelCatalogReference(catalog, { model: 'fast', reasoningEffort: undefined }).reasoningEffort, 'medium')
  const noReason = normalizeModelCatalog({ a: { model: 'p/m' } })
  assert.equal(Object.hasOwn(resolveModelCatalogReference(noReason, { model: 'a' }), 'reasoningEffort'), false)
})

test('preserves explicit provider routes, unknown references and missing models by identity', () => {
  const catalog = normalizeModelCatalog({ fast: { model: 'p/model' } })
  for (const entry of [{ provider: 'other', model: 'fast' }, { provider: '', model: 'fast' },
    { provider: null, model: 'fast' }, { model: 'unknown' }, { model: 'p/fast' }, {}, { model: null }]) {
    assert.strictEqual(resolveModelCatalogReference(catalog, entry), entry)
  }
  const expanded = resolveModelCatalogReference(catalog, { model: 'fast' })
  assert.strictEqual(resolveModelCatalogReference(catalog, expanded), expanded)
  assert.equal(expanded.provider, 'p')
  assert.equal(expanded.model, 'model')
  const legacy = { model: 'unpaired' }
  assert.strictEqual(resolveModelCatalogReference(undefined, legacy), legacy)
  for (const model of ['fast\n', '\u202efast', ' '.repeat(257) + 'fast']) {
    assert.throws(() => resolveModelCatalogReference(catalog, { model }), /bounded text without controls/u)
  }
  assert.throws(() => resolveModelCatalogReference({ get() { throw Error('must not call') } }, { model: 'fast' }, 'selected role'), /selected role requires a normalized/u)
})
