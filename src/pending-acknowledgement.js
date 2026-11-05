const MAX_PENDING_ACKNOWLEDGEMENTS = 64

/** Fence staged pending work until its exact startup result is finally visible. */
export function createPendingAcknowledgement({ activate, cancel } = {}) {
  if (typeof activate !== 'function' || typeof cancel !== 'function') {
    throw new TypeError('Pending acknowledgement requires activation and cancellation callbacks.')
  }
  const entries = new Map()
  let disposed = false

  function cancelEntry(entry) {
    try { cancel(entry.parent, entry.taskId) } catch {}
  }

  function track(exec, value, content) {
    if (disposed || exec?.name !== 'dsh_omo_task' || typeof exec.token !== 'symbol'
      || !exec.agent || typeof exec.agent !== 'object' || entries.has(exec.token)
      || entries.size >= MAX_PENDING_ACKNOWLEDGEMENTS
      || !value || value.status !== 'pending' || typeof value.role !== 'string'
      || typeof value.taskId !== 'string' || !value.taskId.startsWith('bg_') || value.taskId.length > 256
      || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
      || typeof content[0].text !== 'string' || content[0].text.length > 4096) {
      throw new Error('Pending task requires bounded, uniquely acknowledged native execution.')
    }
    entries.set(exec.token, { parent: exec.agent, taskId: value.taskId, role: value.role, text: content[0].text })
  }

  function onResult(exec, result) {
    if (disposed || exec?.name !== 'dsh_omo_task' || typeof exec.token !== 'symbol') return
    const entry = entries.get(exec.token)
    if (!entry || entry.parent !== exec.agent) return
    entries.delete(exec.token)
    const value = result?.value
    const content = result?.content
    const accepted = result?.isError === false && value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 3 && value.status === 'pending' && value.taskId === entry.taskId && value.role === entry.role
      && Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
      && content[0].text === entry.text && Object.keys(content[0]).length === 2
    if (!accepted) return cancelEntry(entry)
    try { if (activate(entry.parent, entry.taskId) !== true) cancelEntry(entry) } catch { cancelEntry(entry) }
  }

  function forgetTask(taskId) {
    for (const [token, entry] of entries) if (entry.taskId === taskId) entries.delete(token)
  }

  function clearAgent(parent) {
    for (const [token, entry] of entries) {
      if (entry.parent !== parent) continue
      entries.delete(token)
      cancelEntry(entry)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const entry of entries.values()) cancelEntry(entry)
    entries.clear()
  }

  return Object.freeze({ track, onResult, forgetTask, clearAgent, dispose })
}
