import { normalizeCategoryPromptAppend } from './roles.js'

const MAX_CATEGORY_ROUTES = 32
const MAX_CATEGORY_NAME_CHARS = 64
const MAX_CATEGORY_DESCRIPTION_BYTES = 512
const MAX_PROVIDER_CHARS = 128
const MAX_MODEL_CHARS = 256
const MAX_REASONING_EFFORT_CHARS = 64
const ALLOWED_CATEGORY_FIELDS = new Set(['name', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'disable', 'promptAppend', 'description'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const DESCRIPTION_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
const CATEGORY_ROUTE_DATA = new WeakMap()

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function normalizeString(value, label, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`)
  }
  const normalized = value.trim()
  if (!normalized || CONTROL_CHARACTERS.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`)
  }
  return normalized
}

function normalizeCategoryName(value, label = 'category name') {
  return normalizeString(value, label, MAX_CATEGORY_NAME_CHARS)
}

function normalizeCategoryDescription(value, categoryName) {
  if (value === undefined) return undefined
  const label = `category route "${categoryName}" description`
  if (typeof value !== 'string'
    || value.length > MAX_CATEGORY_DESCRIPTION_BYTES
    || new TextEncoder().encode(value).byteLength > MAX_CATEGORY_DESCRIPTION_BYTES) {
    throw new TypeError(`${label} must be a string of at most ${MAX_CATEGORY_DESCRIPTION_BYTES} UTF-8 bytes`)
  }
  const normalized = value.trim()
  if (!normalized) return undefined
  if (DESCRIPTION_CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${label} must be a single line without control characters`)
  }
  return normalized
}

function normalizeMaxTokens(value, label) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

function createReadonlyRegistry(routes) {
  const registry = Object.freeze({
    get(name) {
      return routes.get(name)
    },
    has(name) {
      return routes.has(name)
    },
    get size() {
      return routes.size
    },
    entries() {
      return routes.entries()
    },
    keys() {
      return routes.keys()
    },
    values() {
      return routes.values()
    },
    [Symbol.iterator]() {
      return routes[Symbol.iterator]()
    },
  })
  CATEGORY_ROUTE_DATA.set(registry, routes)
  return registry
}

/**
 * Validate one provider/model route per category plus optional reasoning,
 * positive safe-integer token ceiling, task-delegation disable flag, bounded
 * literal prompt guidance, and bounded single-line tool-prompt descriptions.
 * Routes cannot declare chains or fallback.
 */
export function normalizeCategoryRoutes(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_CATEGORY_ROUTES) {
    throw new TypeError(`categoryRoutes must be an array with at most ${MAX_CATEGORY_ROUTES} entries`)
  }

  const routes = new Map()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!isRecord(entry)) throw new TypeError(`categoryRoutes[${index}] must be an object`)

    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key !== 'string' || !ALLOWED_CATEGORY_FIELDS.has(key)) {
        throw new TypeError(`categoryRoutes[${index}] contains unsupported field "${String(key)}"`)
      }
    }

    if (!Object.hasOwn(entry, 'name')) throw new TypeError(`categoryRoutes[${index}].name is required`)
    const name = normalizeCategoryName(entry.name, `categoryRoutes[${index}].name`)
    if (routes.has(name)) throw new TypeError(`duplicate category route "${name}"`)

    const hasProvider = Object.hasOwn(entry, 'provider') && entry.provider !== undefined
    const hasModel = Object.hasOwn(entry, 'model') && entry.model !== undefined
    if (hasProvider !== hasModel) {
      throw new TypeError(`category route "${name}" must set provider and model together`)
    }
    if (!hasProvider) {
      throw new TypeError(`category route "${name}" requires both provider and model`)
    }

    const provider = normalizeString(entry.provider, `category route "${name}" provider`, MAX_PROVIDER_CHARS)
    const model = normalizeString(entry.model, `category route "${name}" model`, MAX_MODEL_CHARS)
    const rawReasoningEffort = Object.hasOwn(entry, 'reasoningEffort') ? entry.reasoningEffort : undefined
    const reasoningEffort = rawReasoningEffort === undefined
      ? undefined
      : normalizeString(rawReasoningEffort, `category route "${name}" reasoningEffort`, MAX_REASONING_EFFORT_CHARS)
    const maxTokens = normalizeMaxTokens(entry.maxTokens, `category route "${name}" maxTokens`)
    const disable = entry.disable === undefined ? false : entry.disable
    if (typeof disable !== 'boolean') {
      throw new TypeError(`category route "${name}" disable must be a boolean`)
    }
    const promptAppend = normalizeCategoryPromptAppend(entry.promptAppend, name)
    const description = normalizeCategoryDescription(entry.description, name)

    routes.set(name, Object.freeze({
      name,
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      disable,
      ...(promptAppend !== undefined ? { promptAppend } : {}),
      ...(description !== undefined ? { description } : {}),
    }))
  }

  return createReadonlyRegistry(routes)
}

function normalizeRolePin(roleRoute) {
  const hasProvider = Object.hasOwn(roleRoute, 'provider') && roleRoute.provider !== undefined
  const hasModel = Object.hasOwn(roleRoute, 'model') && roleRoute.model !== undefined
  if (hasProvider !== hasModel) {
    throw new TypeError('role route provider and model must be set together')
  }
  if (!hasProvider) return undefined
  return {
    provider: normalizeString(roleRoute.provider, 'role route provider', MAX_PROVIDER_CHARS),
    model: normalizeString(roleRoute.model, 'role route model', MAX_MODEL_CHARS),
  }
}

/**
 * Resolve explicit category over the role's default category. A role's explicit
 * provider/model pin, reasoning effort, and maxTokens override the category;
 * category promptAppend is carried separately from role promptAppend and filters.
 */
export function resolveCategoryRoute(categoryRoutes, explicitCategory, roleRoute) {
  if (roleRoute !== undefined && !isRecord(roleRoute)) {
    throw new TypeError('roleRoute must be an object when provided')
  }

  const hasExplicitCategory = explicitCategory !== undefined
  const hasRoleDefaultCategory = roleRoute !== undefined && Object.hasOwn(roleRoute, 'category')
  const selectedCategoryValue = hasExplicitCategory
    ? explicitCategory
    : hasRoleDefaultCategory ? roleRoute.category : undefined
  if (selectedCategoryValue === undefined) {
    if (roleRoute === undefined) return undefined
    return Object.isFrozen(roleRoute) ? roleRoute : Object.freeze({ ...roleRoute })
  }

  const selectedCategory = normalizeCategoryName(
    selectedCategoryValue,
    hasExplicitCategory ? 'explicit category' : 'role default category',
  )
  const routes = CATEGORY_ROUTE_DATA.get(categoryRoutes)
  if (!routes) {
    throw new TypeError(`categoryRoutes must be normalized before resolving category "${selectedCategory}"`)
  }
  const categoryRoute = routes.get(selectedCategory)
  if (!categoryRoute) {
    const source = hasExplicitCategory ? 'explicit' : 'default'
    throw new TypeError(`unknown ${source} category "${selectedCategory}"`)
  }
  if (categoryRoute.disable) {
    const source = hasExplicitCategory ? 'explicit' : 'default'
    throw new TypeError(`disabled ${source} category "${selectedCategory}" cannot be used for task delegation`)
  }

  const rolePin = roleRoute === undefined ? undefined : normalizeRolePin(roleRoute)
  const rawRoleReasoningEffort = roleRoute !== undefined && Object.hasOwn(roleRoute, 'reasoningEffort')
    ? roleRoute.reasoningEffort
    : undefined
  const roleReasoningEffort = rawRoleReasoningEffort === undefined
    ? undefined
    : normalizeString(rawRoleReasoningEffort, 'role route reasoningEffort', MAX_REASONING_EFFORT_CHARS)
  const roleMaxTokens = roleRoute === undefined
    ? undefined
    : normalizeMaxTokens(roleRoute.maxTokens, 'role route maxTokens')

  const resolved = {
    ...(roleRoute ?? {}),
    category: selectedCategory,
    provider: rolePin?.provider ?? categoryRoute.provider,
    model: rolePin?.model ?? categoryRoute.model,
  }
  const reasoningEffort = roleReasoningEffort ?? categoryRoute.reasoningEffort
  if (reasoningEffort === undefined) delete resolved.reasoningEffort
  else resolved.reasoningEffort = reasoningEffort
  const maxTokens = roleMaxTokens ?? categoryRoute.maxTokens
  if (maxTokens === undefined) delete resolved.maxTokens
  else resolved.maxTokens = maxTokens
  if (categoryRoute.promptAppend === undefined) delete resolved.categoryPromptAppend
  else resolved.categoryPromptAppend = categoryRoute.promptAppend
  return Object.freeze(resolved)
}
