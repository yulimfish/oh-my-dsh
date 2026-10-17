const SEARCH_TOOL_NAMES = new Set(['grep', 'glob'])

/** Name-routed, not native-provenance: same-name scoped shadows may match. */
export function createSearchToolResultPruningListener(toolService, pruner) {
  let disposed = false

  const listener = async (exec, result, next) => {
    // Deliberately leave next() outside the fail-open catch: its errors belong to the waterfall.
    const decision = await next()
    if (disposed) return decision

    try {
      if (!exec || exec.parent !== undefined) return decision
      const name = exec.name
      if (!SEARCH_TOOL_NAMES.has(name)) return decision
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
