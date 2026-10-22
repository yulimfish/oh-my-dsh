const TEXT_HEAVY_TOOL_NAMES = new Set(['grep', 'glob', 'web_fetch'])
const MAX_ADDITIONAL_TOOL_NAMES = 32
const MAX_TOOL_NAME_BYTES = 128
const TOOL_NAME_ENCODER = new TextEncoder()
const UNSAFE_TOOL_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u

export function normalizeAdditionalToolResultPruningNames(value) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new TypeError('dsh-omo: additionalSearchToolResultPruningTools must be an array')
  if (value.length > MAX_ADDITIONAL_TOOL_NAMES) {
    throw new TypeError(`dsh-omo: additionalSearchToolResultPruningTools may contain at most ${MAX_ADDITIONAL_TOOL_NAMES} names`)
  }
  const names = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const name = value[index]
    if (typeof name !== 'string' || name.length === 0 || name.trim() !== name
      || TOOL_NAME_ENCODER.encode(name).byteLength > MAX_TOOL_NAME_BYTES || UNSAFE_TOOL_NAME.test(name)
      || name === 'run_code') {
      throw new TypeError(`dsh-omo: additionalSearchToolResultPruningTools[${index}] must be an exact safe Tool name of at most ${MAX_TOOL_NAME_BYTES} UTF-8 bytes and must not be run_code`)
    }
    if (seen.has(name)) throw new TypeError('dsh-omo: additionalSearchToolResultPruningTools must not contain duplicates')
    seen.add(name)
    names.push(name)
  }
  return Object.freeze(names)
}

const MAX_PENDING_TOOL_EXECUTIONS = 128

function isEligibleDefinition(definition, name) {
  return Boolean(definition && (typeof definition === 'object' || typeof definition === 'function')
    && definition.name === name
    && definition.projectContent === undefined
    && definition.finalizeContent === undefined)
}

function createToolResultPruningListener(toolService, pruner, eligibleToolNames) {
  let disposed = false
  let registryGeneration = {}
  const pending = new Map()

  function clearPending(token) {
    const entry = pending.get(token)
    if (!entry) return
    pending.delete(token)
    try { entry.signal.removeEventListener('abort', entry.onAbort) } catch {}
  }

  function clearAllPending() {
    for (const token of pending.keys()) clearPending(token)
  }

  const onToolsChange = () => {
    if (disposed) return
    registryGeneration = {}
    clearAllPending()
  }

  const preExecute = async (exec, next) => {
    let entry
    try {
      if (!disposed && exec && exec.parent === undefined) {
        const name = exec.name
        const token = exec.token
        const agent = exec.agent
        const signal = exec.signal
        if (typeof token === 'symbol' && typeof name === 'string' && name !== 'run_code'
          && (!eligibleToolNames || eligibleToolNames.has(name))
          && agent && typeof agent === 'object'
          && signal && signal.aborted === false
          && typeof signal.addEventListener === 'function'
          && typeof signal.removeEventListener === 'function'
          && toolService && typeof toolService.get === 'function') {
          const definition = toolService.get(name, agent)
          if (isEligibleDefinition(definition, name)) {
            entry = { token, name, agent, definition, signal, registryGeneration }
          }
        }
      }
    } catch {
      // An unknown execution identity or visible definition is never a pruning authorization.
    }

    // This is a pre-dispatch waterfall: propagate its decision and errors unchanged.
    const decision = await next()
    if (!entry || disposed) return decision

    try {
      if (decision?.kind !== 'allow'
        || entry.signal.aborted !== false
        || registryGeneration !== entry.registryGeneration
        || exec?.token !== entry.token
        || exec?.name !== entry.name
        || exec?.agent !== entry.agent
        || exec?.parent !== undefined
        || toolService.get(entry.name, entry.agent) !== entry.definition
        || !isEligibleDefinition(entry.definition, entry.name)) return decision
      if (pending.has(entry.token)) {
        clearPending(entry.token)
        return decision
      }
      entry.onAbort = () => clearPending(entry.token)
      pending.set(entry.token, entry)
      try { entry.signal.addEventListener('abort', entry.onAbort, { once: true }) } catch {
        clearPending(entry.token)
        return decision
      }
      if (entry.signal.aborted !== false) {
        clearPending(entry.token)
        return decision
      }
      while (pending.size > MAX_PENDING_TOOL_EXECUTIONS) {
        clearPending(pending.keys().next().value)
      }
    } catch {
      clearPending(entry.token)
    }
    return decision
  }

  const listener = async (exec, result, next) => {
    let entry
    let definitionMatchesBeforeNext = false
    try {
      const token = exec?.token
      if (!disposed && typeof token === 'symbol') {
        entry = pending.get(token)
        if (entry) {
          clearPending(token)
          definitionMatchesBeforeNext = registryGeneration === entry.registryGeneration
            && exec?.name === entry.name
            && exec?.agent === entry.agent
            && exec?.parent === undefined
            && toolService?.get(entry.name, entry.agent) === entry.definition
            && isEligibleDefinition(entry.definition, entry.name)
        }
      }
    } catch {
      entry = undefined
    }

    // Deliberately leave next() outside the fail-open catch: its errors belong to the waterfall.
    const decision = await next()
    if (disposed || !entry || !definitionMatchesBeforeNext) return decision

    try {
      if (registryGeneration !== entry.registryGeneration
        || exec?.token !== entry.token
        || exec?.name !== entry.name
        || exec?.agent !== entry.agent
        || exec?.parent !== undefined) return decision
      if (result?.isError !== false) return decision

      const signal = exec.signal
      if (!signal || signal.aborted !== false) return decision

      if (!decision || typeof decision !== 'object' || Array.isArray(decision)
        || decision.kind !== 'accept' || Reflect.has(decision, 'value')) return decision
      const content = decision.content
      if (!Array.isArray(content) || disposed || signal.aborted !== false) return decision

      if (!toolService || typeof toolService.get !== 'function'
        || toolService.get(entry.name, entry.agent) !== entry.definition
        || !isEligibleDefinition(entry.definition, entry.name)) return decision

      if (disposed || signal.aborted !== false) return decision
      const pruned = pruner.pruneContent(content)
      if (disposed || signal.aborted !== false) return decision
      if (!Array.isArray(pruned)) return decision

      const enriched = { ...decision, content: pruned }
      if (disposed || signal.aborted !== false) return decision
      return enriched
    } catch {
      // Pruning is advisory; malformed runtime values and service errors preserve the exact decision.
      return decision
    }
  }

  return {
    preExecute,
    listener,
    onToolsChange,
    dispose() {
      disposed = true
      clearAllPending()
    },
  }
}

/** Name-routed, not native-provenance: same-name scoped shadows may match. */
export function createSearchToolResultPruningListener(toolService, pruner, additionalNames = []) {
  const normalizedAdditionalNames = normalizeAdditionalToolResultPruningNames(additionalNames)
  const eligibleToolNames = new Set([...TEXT_HEAVY_TOOL_NAMES, ...normalizedAdditionalNames])
  return createToolResultPruningListener(toolService, pruner, eligibleToolNames)
}

/** Opt-in pruning for any visible, top-level Tool without a content finalizer. */
export function createGeneralToolResultPruningListener(toolService, pruner) {
  return createToolResultPruningListener(toolService, pruner, undefined)
}
