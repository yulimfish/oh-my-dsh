import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const WARNING_THRESHOLD = 3
const MAX_AGENT_STATES = 256
const MAX_PENDING_CALLS = 128
const MAX_AGENT_ID_CHARS = 256
const MAX_TOOL_NAME_CHARS = 256
const MAX_DEPTH = 12
const MAX_NODES = 256
const MAX_STRING_BYTES = 2_048
const MAX_SIGNATURE_CHARS = 16_384
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

const INVALID_SIGNATURE = Symbol('invalid call signature')

function invalid() {
  return INVALID_SIGNATURE
}

/** Canonicalize bounded JSON-like input; unsupported or ambiguous input is skipped, never truncated. */
export function canonicalCallSignature(name, args) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME_CHARS
    || CONTROL_OR_BIDI.test(name)) return undefined
  const state = { nodes: 0, chars: 0 }

  function append(text) {
    state.chars += text.length
    if (state.chars > MAX_SIGNATURE_CHARS) throw invalid()
    return text
  }

  function visit(value, depth, ancestors) {
    if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) throw invalid()
    if (value === null) return append('null')
    const type = typeof value
    if (type === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) throw invalid()
      return append(JSON.stringify(value))
    }
    if (type === 'boolean') return append(value ? 'true' : 'false')
    if (type === 'number') {
      if (!Number.isFinite(value)) throw invalid()
      return append(JSON.stringify(value))
    }
    if (type === 'undefined') return append('undefined')
    if (type !== 'object') throw invalid()
    if (ancestors.has(value)) throw invalid()

    // Own enumerable values determine the signature; inherited properties and
    // custom prototype identity are irrelevant. Built-in non-JSON objects are not.
    if (!Array.isArray(value)) {
      const tag = Object.prototype.toString.call(value)
      if (tag !== '[object Object]') throw invalid()
    }
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        let output = append('[')
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) output += append(',')
          output += visit(value[index], depth + 1, ancestors)
        }
        return output + append(']')
      }

      // Reflect.ownKeys preserves Object.keys' own-key semantics without its
      // eager descriptor walk. Check only a bounded prefix before sorting.
      const keys = []
      const remaining = MAX_NODES - state.nodes + 1
      let inspected = 0
      for (const key of Reflect.ownKeys(value)) {
        inspected += 1
        if (inspected > MAX_NODES) throw invalid()
        if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key)) continue
        keys.push(key)
        if (keys.length >= remaining) break
      }
      keys.sort()
      let output = append('{')
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        if (Buffer.byteLength(key, 'utf8') > MAX_STRING_BYTES) throw invalid()
        if (index > 0) output += append(',')
        output += append(JSON.stringify(key)) + append(':')
        output += visit(value[key], depth + 1, ancestors)
      }
      return output + append('}')
    } finally {
      ancestors.delete(value)
    }
  }

  try {
    const canonical = visit(args, 0, new WeakSet())
    return createHash('sha256').update(name, 'utf8').update('\0').update(canonical, 'utf8').digest('hex')
  } catch {
    return undefined
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function exactLiveAgent(agentsService, agentId, agent) {
  try {
    return typeof agentsService?.get === 'function' && agentsService.get(agentId) === agent
  } catch {
    return false
  }
}

function validPosition(exec) {
  try {
    const agent = exec?.agent
    const agentId = agent?.id
    const signal = exec?.signal
    if (exec?.parent !== undefined || !isObject(agent)
      || typeof agentId !== 'string' || agentId.length === 0 || agentId.length > MAX_AGENT_ID_CHARS
      || typeof exec?.name !== 'string' || typeof exec?.token !== 'symbol'
      || !isObject(signal) || signal.aborted !== false
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') return undefined
    return { agent, agentId, signal, name: exec.name, token: exec.token }
  } catch {
    return undefined
  }
}

function warning(name) {
  return `[DSH repeated Tool call advisory]\n\nTool ${JSON.stringify(name)} has completed ${WARNING_THRESHOLD} consecutive times with identical arguments. Before repeating it, compare the result with the current user request, any active Goal, and evidence already gathered. If no new information is expected, use a different strategy or update the plan instead of repeating the same exploration. This is only a call-pattern warning, not proof of no progress; deliberate polling may continue. No arguments were retained for this advisory, and it grants no permissions.\n`
}

/** Add one soft warning at the third consecutive identical completed top-level call. */
export function createRepeatedCallAdvisory(agentsService) {
  const states = new Map()
  const pending = new Map()
  const disposedAgents = new WeakSet()
  let disposed = false

  function clearPending(token) {
    const entry = pending.get(token)
    if (!entry) return
    pending.delete(token)
    try { entry.signal.removeEventListener('abort', entry.onAbort) } catch {}
  }

  function clearAgent(agent) {
    if (isObject(agent)) disposedAgents.add(agent)
    let agentId
    try { agentId = agent?.id } catch { return }
    if (typeof agentId === 'string' && states.get(agentId)?.agent === agent) states.delete(agentId)
    for (const [token, entry] of pending) {
      if (entry.agent === agent) clearPending(token)
    }
  }

  function resetState(agentId, agent) {
    const state = states.get(agentId)
    if (state?.agent === agent) {
      state.signature = undefined
      state.count = 0
    }
  }

  function stateFor(agentId, agent) {
    const existing = states.get(agentId)
    if (existing?.agent === agent) return existing
    if (!existing && states.size >= MAX_AGENT_STATES) return undefined
    const state = { agent, signature: undefined, count: 0 }
    states.set(agentId, state)
    return state
  }

  const preExecute = async (exec, next) => {
    let position
    let signature
    try {
      position = validPosition(exec)
      if (position && !disposed && !disposedAgents.has(position.agent)
        && exactLiveAgent(agentsService, position.agentId, position.agent)) {
        signature = canonicalCallSignature(position.name, exec.arguments)
      } else {
        position = undefined
      }
    } catch {
      position = undefined
    }

    const decision = await next()
    if (disposed || !position || signature === undefined || decision?.kind !== 'allow') return decision

    let entry
    try {
      if (position.signal.aborted || pending.has(position.token)
        || !exactLiveAgent(agentsService, position.agentId, position.agent)
        || exec?.token !== position.token || exec?.name !== position.name
        || exec?.agent !== position.agent || exec?.parent !== undefined) return decision
      entry = { ...position, signature, onAbort: undefined }
      entry.onAbort = () => {
        if (pending.get(position.token) === entry) clearPending(position.token)
      }
      pending.set(position.token, entry)
      try {
        position.signal.addEventListener('abort', entry.onAbort, { once: true })
      } catch {
        clearPending(position.token)
        return decision
      }
      if (position.signal.aborted) clearPending(position.token)
      while (pending.size > MAX_PENDING_CALLS) clearPending(pending.keys().next().value)
    } catch {
      if (entry) clearPending(position.token)
    }
    return decision
  }

  const listener = async (exec, _result, next) => {
    let position
    let entry
    try {
      position = validPosition(exec)
      if (position) {
        entry = pending.get(position.token)
        if (entry) clearPending(position.token)
      }
    } catch {
      position = undefined
      entry = undefined
    }

    const decision = await next()
    if (disposed || !position || decision?.kind !== 'accept' || position.signal.aborted) return decision
    if (disposedAgents.has(position.agent) || !exactLiveAgent(agentsService, position.agentId, position.agent)) return decision

    const validEntry = !disposedAgents.has(position.agent)
      && entry && entry.agent === position.agent && entry.agentId === position.agentId
      && entry.name === position.name && entry.token === position.token
      && exec?.agent === position.agent && exec?.name === position.name
      && exec?.token === position.token && exec?.parent === undefined
    if (!validEntry) {
      resetState(position.agentId, position.agent)
      return decision
    }

    const state = stateFor(position.agentId, position.agent)
    if (!state) return decision
    if (state.signature === entry.signature) state.count += 1
    else {
      state.signature = entry.signature
      state.count = 1
    }
    if (state.count !== WARNING_THRESHOLD || disposed || position.signal.aborted
      || !exactLiveAgent(agentsService, position.agentId, position.agent)) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const reminder = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: warning(position.name) }],
    })
    return { ...decision, additionalContexts: [...previousContexts, reminder] }
  }

  // Terminal results may bypass post-execute after a pipeline failure. Clean up
  // only the token/listener here; accepted-completion accounting stays in listener.
  const onResult = exec => {
    try {
      if (typeof exec?.token === 'symbol') clearPending(exec.token)
    } catch {
      // Result observation must not affect the Tool outcome.
    }
  }

  function dispose() {
    disposed = true
    states.clear()
    for (const token of [...pending.keys()]) clearPending(token)
  }

  return { preExecute, listener, onResult, clearAgent, dispose }
}
