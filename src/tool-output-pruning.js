export function createToolResultPruningFinalizer(pruner) {
  if (!pruner || typeof pruner.pruneContent !== 'function') return undefined

  return (_exec, result) => {
    const original = result?.content
    if (!Array.isArray(original)) return []
    if (result.isError !== false) return original

    try {
      const pruned = pruner.pruneContent(original)
      // Keep the exact canonical blocks for in-budget output, errors, and pruner failures.
      // Returning the existing array also avoids depending on undefined-finalizer semantics.
      return Array.isArray(pruned) ? pruned : original
    } catch {
      // Output pruning is advisory; it must never turn a successful Tool call into a failure.
      return original
    }
  }
}
