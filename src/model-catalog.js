const MAX_ENTRIES = 64
const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u
const RESERVED_ALIASES = new Set(['__proto__', 'prototype', 'constructor'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/u
const CATALOG_DATA = new WeakMap()

function isRecord(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function dataProperties(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError(`${label} must contain only string-keyed data properties`)
    }
  }
  return descriptors
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${label} must contain 1–${maximum} characters without surrounding whitespace or controls`)
  }
  return value
}

/** Normalize explicit user-authored aliases only; never discover or infer routes. */
export function normalizeModelCatalog(entries) {
  const descriptors = dataProperties(entries === undefined ? {} : entries, 'models')
  const keys = Object.keys(descriptors)
  if (keys.length > MAX_ENTRIES) throw new TypeError(`models must contain at most ${MAX_ENTRIES} entries`)
  const values = new Map()
  for (const alias of keys) {
    if (!ALIAS_PATTERN.test(alias) || RESERVED_ALIASES.has(alias)) {
      throw new TypeError('models contains an invalid or reserved alias')
    }
    const fields = dataProperties(descriptors[alias].value, `models.${alias}`)
    for (const key of Object.keys(fields)) {
      if (key !== 'model' && key !== 'reasoning') throw new TypeError(`models.${alias} contains an unsupported field`)
    }
    const selector = fields.model?.value
    if (typeof selector !== 'string' || selector.length > 385 || CONTROL_CHARACTERS.test(selector)) {
      throw new TypeError(`models.${alias}.model must be an explicit provider/model selector`)
    }
    const separator = selector.indexOf('/')
    if (separator <= 0 || separator === selector.length - 1) {
      throw new TypeError(`models.${alias}.model must be an explicit provider/model selector`)
    }
    const provider = boundedText(selector.slice(0, separator), `models.${alias} provider`, 128)
    const model = boundedText(selector.slice(separator + 1), `models.${alias} model`, 256)
    const reasoning = fields.reasoning?.value === undefined
      ? undefined
      : boundedText(fields.reasoning.value, `models.${alias}.reasoning`, 64)
    values.set(alias, Object.freeze({ provider, model, ...(reasoning !== undefined ? { reasoning } : {}) }))
  }
  const registry = Object.freeze({
    get(alias) { return values.get(alias) },
    get size() { return values.size },
  })
  CATALOG_DATA.set(registry, values)
  return registry
}

/** Expand a model-only alias once, preserving every explicitly supplied use-site control. */
export function resolveModelCatalogReference(catalog, entry, label = 'model route') {
  if (entry.provider !== undefined || typeof entry.model !== 'string' || catalog === undefined) return entry
  if (entry.model.length > 256 || CONTROL_CHARACTERS.test(entry.model)) {
    throw new TypeError(`${label} model reference must be bounded text without controls`)
  }
  const values = CATALOG_DATA.get(catalog)
  if (!values) throw new TypeError(`${label} requires a normalized model catalog`)
  const target = values.get(entry.model.trim())
  if (!target) return entry
  return {
    ...entry,
    provider: target.provider,
    model: target.model,
    ...(entry.reasoningEffort === undefined && target.reasoning !== undefined
      ? { reasoningEffort: target.reasoning } : {}),
  }
}
