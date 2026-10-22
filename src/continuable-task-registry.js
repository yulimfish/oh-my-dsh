const MAX_ID_LENGTH = 256
const MAX_PARENTS = 64
const MAX_CHILDREN_PER_PARENT = 32
const MAX_CHILDREN_TOTAL = 128
const MAX_SENDS_PER_CHILD = 8
const MAX_SENDS_PER_PARENT = 32
const MAX_SENDS_TOTAL = 256

function isValidId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH
}

function parentIdentity(agent) {
  if (!agent || typeof agent !== 'object') return undefined
  let id
  try {
    id = agent.id
  } catch {
    return undefined
  }
  return isValidId(id) ? { agent, id } : undefined
}

/**
 * Create a bounded, in-memory registry for plugin-started continuable children.
 * Call record only after startContinuable has successfully returned the child ID.
 */
export function createContinuableTaskRegistry() {
  const parents = new Map()
  const disposedAgents = new WeakSet()
  // Insertion order is global child LRU order; entries are also stored per parent.
  const childLru = new Map()
  let disposed = false
  let totalSends = 0

  function touchParent(parentId, parent) {
    parents.delete(parentId)
    parents.set(parentId, parent)
  }

  function touchChild(parent, child) {
    parent.children.delete(child.id)
    parent.children.set(child.id, child)
    childLru.delete(child)
    childLru.set(child, child)
  }

  function removeParent(parentId, parent) {
    if (parents.get(parentId) !== parent) return false
    parents.delete(parentId)
    for (const child of parent.children.values()) childLru.delete(child)
    parent.children.clear()
    return true
  }

  function removeChild(parent, child) {
    if (parent.children.get(child.id) !== child) return false
    parent.children.delete(child.id)
    childLru.delete(child)
    // Keep an empty parent record so its parent-wide quota remains consumed.
    return true
  }

  function evictOldestParent() {
    const oldestParentId = parents.keys().next().value
    if (oldestParentId !== undefined) removeParent(oldestParentId, parents.get(oldestParentId))
  }

  function evictOldestChild() {
    const oldestChild = childLru.keys().next().value
    if (oldestChild === undefined) return
    const parent = parents.get(oldestChild.parentId)
    if (parent) removeChild(parent, oldestChild)
  }

  function record(parentAgent, childId) {
    const identity = parentIdentity(parentAgent)
    if (disposed || !identity || !isValidId(childId) || disposedAgents.has(parentAgent)) return false
    const { id: parentId } = identity

    let parent = parents.get(parentId)
    if (parent && parent.agent !== parentAgent) {
      // A same-ID replacement makes the displaced object stale. Prevent a late
      // start completion from that old Agent from reclaiming the new bucket.
      disposedAgents.add(parent.agent)
      removeParent(parentId, parent)
      parent = undefined
    }
    if (!parent) {
      if (parents.size >= MAX_PARENTS) evictOldestParent()
      parent = { agent: parentAgent, children: new Map(), sends: 0 }
      parents.set(parentId, parent)
    } else {
      touchParent(parentId, parent)
    }

    const existing = parent.children.get(childId)
    if (existing) {
      touchChild(parent, existing)
      return true
    }

    if (parent.children.size >= MAX_CHILDREN_PER_PARENT) {
      const oldestChild = parent.children.values().next().value
      removeChild(parent, oldestChild)
    }
    if (childLru.size >= MAX_CHILDREN_TOTAL) evictOldestChild()

    const child = { parentId, id: childId, sends: 0 }
    parent.children.set(childId, child)
    childLru.set(child, child)
    // The parent may have been removed only if the implementation's caps change;
    // keep the invariant explicit before adding the new child.
    if (parents.get(parentId) !== parent) parents.set(parentId, parent)
    return true
  }

  function reserveSend(parentAgent, childId) {
    const identity = parentIdentity(parentAgent)
    if (!identity || !isValidId(childId)) return { status: 'invalid' }
    if (disposed) return { status: 'disposed' }
    if (disposedAgents.has(parentAgent)) return { status: 'untracked' }

    const { id: parentId } = identity
    const parent = parents.get(parentId)
    const child = parent?.agent === parentAgent ? parent.children.get(childId) : undefined
    if (!parent || parent.agent !== parentAgent || !child) return { status: 'untracked' }

    touchParent(parentId, parent)
    touchChild(parent, child)
    if (child.sends >= MAX_SENDS_PER_CHILD || parent.sends >= MAX_SENDS_PER_PARENT || totalSends >= MAX_SENDS_TOTAL) {
      return { status: 'quota' }
    }

    // Reserve synchronously; callers must not refund this after later failures.
    child.sends += 1
    parent.sends += 1
    totalSends += 1
    return { status: 'reserved' }
  }

  function remove(parentAgent, childId) {
    const identity = parentIdentity(parentAgent)
    if (!identity || !isValidId(childId) || disposedAgents.has(parentAgent)) return false
    const { id: parentId } = identity
    const parent = parents.get(parentId)
    const child = parent?.agent === parentAgent ? parent.children.get(childId) : undefined
    return Boolean(parent && parent.agent === parentAgent && child && removeChild(parent, child))
  }

  function clearAgent(agent) {
    if (agent && typeof agent === 'object') disposedAgents.add(agent)
    const identity = parentIdentity(agent)
    if (!identity) return false
    const { id: parentId } = identity
    const parent = parents.get(parentId)
    return Boolean(parent && parent.agent === agent && removeParent(parentId, parent))
  }

  function dispose() {
    if (disposed) return
    disposed = true
    parents.clear()
    childLru.clear()
  }

  return { record, reserveSend, remove, clearAgent, dispose }
}
