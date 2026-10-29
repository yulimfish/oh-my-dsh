const MAX_ROLE_CATEGORY_ROUTE_ALIASES = 32
const MAX_PROVIDER_CHARS = 128
const MAX_MODEL_CHARS = 256
const MAX_REASONING_EFFORT_CHARS = 64
const ALIAS_FIELDS = new Set(['from', 'to', 'reasoningEffort'])
const ROUTE_FIELDS = new Set(['provider', 'model'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/u

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function assertFields(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field "${String(key)}"`)
    }
  }
}

function normalizeText(value, label, maxChars) {
  if (typeof value !== 'string' || value.length > maxChars) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxChars} characters`)
  }
  const normalized = value.trim()
  if (!normalized || CONTROL_CHARACTERS.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxChars} characters without control or bidi characters`)
  }
  return normalized
}

function normalizePair(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain provider/model object`)
  assertFields(value, ROUTE_FIELDS, label)
  return Object.freeze({
    provider: normalizeText(value.provider, `${label}.provider`, MAX_PROVIDER_CHARS),
    model: normalizeText(value.model, `${label}.model`, MAX_MODEL_CHARS),
  })
}

function routeKey(provider, model) {
  return JSON.stringify([provider, model])
}

/**
 * Build exact, one-hop aliases for dsh-omo's explicit role/category routes.
 * Optional reasoning defaults are applied only after explicit route controls.
 * Aliases are opt-in and do not rewrite ambient Agent requests or global fallback.
 */
export function normalizeRoleCategoryRouteAliases(enabled, value = []) {
  if (!Array.isArray(value) || value.length > MAX_ROLE_CATEGORY_ROUTE_ALIASES) {
    throw new TypeError(`roleCategoryRouteAliases must be an array with at most ${MAX_ROLE_CATEGORY_ROUTE_ALIASES} entries`)
  }

  const aliases = new Map()
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    const label = `roleCategoryRouteAliases[${index}]`
    if (!isRecord(entry)) throw new TypeError(`${label} must be a plain object`)
    assertFields(entry, ALIAS_FIELDS, label)
    const from = normalizePair(entry.from, `${label}.from`)
    const to = normalizePair(entry.to, `${label}.to`)
    const reasoningEffort = entry.reasoningEffort === undefined
      ? undefined
      : normalizeText(entry.reasoningEffort, `${label}.reasoningEffort`, MAX_REASONING_EFFORT_CHARS)
    const fromKey = routeKey(from.provider, from.model)
    if (from.provider === to.provider && from.model === to.model) {
      throw new TypeError(`${label} must not map a route to itself`)
    }
    if (aliases.has(fromKey)) {
      throw new TypeError(`roleCategoryRouteAliases must not repeat source route ${JSON.stringify(from)}`)
    }
    aliases.set(fromKey, Object.freeze({
      from,
      to,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    }))
  }

  if (aliases.size > 0 && enabled !== true) {
    throw new TypeError('roleCategoryRouteAliases requires enableRoleCategoryRouteAliases')
  }
  for (const alias of aliases.values()) {
    if (aliases.has(routeKey(alias.to.provider, alias.to.model))) {
      throw new TypeError('roleCategoryRouteAliases must not chain or cycle through another source route')
    }
  }
  return aliases
}

export function resolveRoleCategoryRouteAlias(aliases, provider, model) {
  if (typeof provider !== 'string' || typeof model !== 'string' || typeof aliases?.get !== 'function') {
    return undefined
  }
  return aliases.get(routeKey(provider.trim(), model.trim()))
}
