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

function createToolResultPruningListener(toolService, pruner, eligibleToolNames) {
  let disposed = false

  const listener = async (exec, result, next) => {
    // Deliberately leave next() outside the fail-open catch: its errors belong to the waterfall.
    const decision = await next()
    if (disposed) return decision

    try {
      if (!exec || exec.parent !== undefined) return decision
      const name = exec.name
      if (name === 'run_code' || (eligibleToolNames && !eligibleToolNames.has(name))) return decision
      const agent = exec.agent
      if (!agent || typeof agent !== 'object') return decision
      if (result?.isError !== false) return decision

      const signal = exec.signal
      if (!signal || signal.aborted !== false) return decision

      if (!decision || typeof decision !== 'object' || Array.isArray(decision)
        || decision.kind !== 'accept' || Reflect.has(decision, 'value')) return decision
      const content = decision.content
      if (!Array.isArray(content) || disposed || signal.aborted !== false) return decision

      if (!toolService || typeof toolService.get !== 'function') return decision
      const definition = toolService.get(name, agent)
      if (!definition || (typeof definition !== 'object' && typeof definition !== 'function')
        || definition.name !== name
        || definition.projectContent !== undefined
        || definition.finalizeContent !== undefined) return decision

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
    listener,
    dispose() {
      disposed = true
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
