const MAX_AGENT_STATES = 256
const MAX_AGENT_ID_CHARS = 256
const MAX_TEXT_CODE_UNITS = 65_536
const MAX_CONTENT_BLOCKS = 4_096
export const THINK_MODE_PREFLIGHT_TIMEOUT_MS = 5_000

const MULTILINGUAL_KEYWORDS = [
  '생각', '검토', '제대로',
  '思考', '考虑', '考慮',
  '思考', '考え', '熟考',
  'सोच', 'विचार',
  'تفكير', 'تأمل',
  'চিন্তা', 'ভাবনা',
  'думать', 'думай', 'размышлять', 'размышляй',
  'pensar', 'pense', 'refletir', 'reflita',
  'pensar', 'piensa', 'reflexionar', 'reflexiona',
  'penser', 'pense', 'réfléchir', 'réfléchis',
  'denken', 'denk', 'nachdenken',
  'suy nghĩ', 'cân nhắc',
  'düşün', 'düşünmek',
  'pensare', 'pensa', 'riflettere', 'rifletti',
  'คิด', 'พิจารณา',
  'myśl', 'myśleć', 'zastanów',
  'denken', 'denk', 'nadenken',
  'berpikir', 'pikir', 'pertimbangkan',
  'думати', 'думай', 'роздумувати',
  'σκέψου', 'σκέφτομαι',
  'myslet', 'mysli', 'přemýšlet',
  'gândește', 'gândi', 'reflectă',
  'tänka', 'tänk', 'fundera',
  'gondolkodj', 'gondolkodni',
  'ajattele', 'ajatella', 'pohdi',
  'tænk', 'tænke', 'overvej',
  'tenk', 'tenke', 'gruble',
  'חשוב', 'לחשוב', 'להרהר',
  'fikir', 'berfikir',
]
const THINK_PATTERN = new RegExp(`\\b(?:ultrathink|think)\\b|${MULTILINGUAL_KEYWORDS.join('|')}`, 'i')
const FENCED_CODE_PATTERN = /```[\s\S]*?```/gu
const INLINE_CODE_PATTERN = /`[^`]+`/gu

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validAgentId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_AGENT_ID_CHARS
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function isAgentObject(agent) {
  return isRecord(agent) && validAgentId(agent.id)
}

function validPosition(payload) {
  return Number.isSafeInteger(payload?.turn) && payload.turn >= 0
    && Number.isSafeInteger(payload?.step) && payload.step >= 0
}

function validSignal(signal) {
  return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'
}

function isCurrentAgent(agent, agents, disposedAgents) {
  if (!isAgentObject(agent) || disposedAgents.has(agent)) return false
  if (!agents) return true
  try {
    return agents.get(agent.id) === agent
  } catch {
    return false
  }
}

function prepareAgent(agent, states, generations, agents, disposedAgents) {
  if (!isCurrentAgent(agent, agents, disposedAgents)) return false
  const state = states.get(agent.id)
  const generation = generations.get(agent.id)
  if ((state && state.agent !== agent) || (generation && generation.agent !== agent)) {
    // Without the live registry, a conflicting same-ID object cannot claim another Agent's state.
    if (!agents) return false
    if (state && state.agent !== agent) states.delete(agent.id)
    if (generation && generation.agent !== agent) generations.delete(agent.id)
  }
  return true
}

function latestRealUserText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const latest = messages[messages.length - 1]
  if (!isRecord(latest) || latest.role !== 'user' || !isRecord(latest.source)
    || latest.source.kind !== 'user' || !Array.isArray(latest.content)) return ''

  if (latest.content.length > MAX_CONTENT_BLOCKS) return ''
  let text = ''
  for (const block of latest.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.length > MAX_TEXT_CODE_UNITS - text.length) return ''
    text += block.text
  }
  return text
}

export function detectThinkKeyword(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CODE_UNITS) return false
  const withoutCode = text.replace(FENCED_CODE_PATTERN, '').replace(INLINE_CODE_PATTERN, '')
  return THINK_PATTERN.test(withoutCode)
}

function abortReason(signal) {
  return signal?.reason ?? new Error('Think-mode reasoning preflight was cancelled.')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

async function awaitWithSignalAndTimeout(operation, signal, timeoutMs) {
  throwIfAborted(signal)
  const controller = new AbortController()
  let removeAbortListener
  let timeoutHandle
  const callerAborted = validSignal(signal)
    ? new Promise((_, reject) => {
      const abort = () => {
        const reason = abortReason(signal)
        controller.abort(reason)
        reject(reason)
      }
      if (signal.aborted) abort()
      else {
        signal.addEventListener('abort', abort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', abort)
        if (signal.aborted) abort()
      }
    })
    : new Promise(() => {})
  const timedOut = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error('Think-mode reasoning preflight timed out.')
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Think-mode reasoning preflight aborted.')
    return operation(controller.signal)
  })
  try {
    const result = await Promise.race([pending, callerAborted, timedOut])
    throwIfAborted(signal)
    return result
  } finally {
    clearTimeout(timeoutHandle)
    removeAbortListener?.()
  }
}

function beginGeneration(agent, turn, step, states, generations) {
  const generation = { agent, turn, step, token: Symbol('think-mode-pre-step') }
  const state = states.get(agent.id)
  if (state?.agent === agent) states.delete(agent.id)
  generations.delete(agent.id)
  generations.set(agent.id, generation)
  while (generations.size > MAX_AGENT_STATES) {
    const oldestId = generations.keys().next().value
    const oldest = generations.get(oldestId)
    generations.delete(oldestId)
    const oldestState = states.get(oldestId)
    if (oldestState?.generation === oldest) states.delete(oldestId)
  }
  return generation
}

function clearOwnedState(states, agentId, agent) {
  const current = states.get(agentId)
  if (current?.agent === agent) states.delete(agentId)
}

function clearExactState(states, agentId, expected) {
  if (expected && states.get(agentId) === expected) states.delete(agentId)
}

function clearOwnedGeneration(generations, agentId, agent) {
  const current = generations.get(agentId)
  if (current?.agent === agent) generations.delete(agentId)
}

function createController(llm, options = {}) {
  if (!llm || typeof llm.resolveCallConfig !== 'function') {
    throw new TypeError('enableThinkModeReasoning requires DSH llm.resolveCallConfig')
  }
  const agents = typeof options.agents?.get === 'function' ? options.agents : undefined
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, THINK_MODE_PREFLIGHT_TIMEOUT_MS)
    : THINK_MODE_PREFLIGHT_TIMEOUT_MS
  const states = new Map()
  const generations = new Map()
  const disposedAgents = new WeakSet()
  let disposed = false

  async function onPreStep(payload, next) {
    if (typeof next !== 'function') throw new TypeError('agent/pre-step requires next()')
    const agent = payload?.agent
    const canCapture = !disposed && validPosition(payload)
      && prepareAgent(agent, states, generations, agents, disposedAgents)
    const generation = canCapture ? beginGeneration(agent, payload.turn, payload.step, states, generations) : undefined
    let decision
    try {
      decision = await next()
    } catch (error) {
      if (generation && generations.get(agent.id) === generation) generations.delete(agent.id)
      throw error
    }
    if (!generation || disposed || !isCurrentAgent(agent, agents, disposedAgents)
      || generations.get(agent.id) !== generation) return decision
    if (!validSignal(payload.signal) || payload.signal.aborted || decision?.kind !== 'enter') {
      clearOwnedGeneration(generations, agent.id, agent)
      clearOwnedState(states, agent.id, agent)
      return decision
    }

    const text = latestRealUserText(decision.messages)
    if (!detectThinkKeyword(text) || (states.size >= MAX_AGENT_STATES && !states.has(agent.id))) {
      clearOwnedGeneration(generations, agent.id, agent)
      return decision
    }
    states.set(agent.id, {
      agent,
      turn: payload.turn,
      step: payload.step,
      generation,
      inFlight: false,
    })
    clearOwnedGeneration(generations, agent.id, agent)
    return decision
  }

  async function onRequest(payload, next) {
    if (typeof next !== 'function') throw new TypeError('agent/request requires next()')
    const agent = payload?.agent
    const initialState = isAgentObject(agent) ? states.get(agent.id) : undefined
    let base
    try {
      base = await next()
    } catch (error) {
      if (isAgentObject(agent)) clearExactState(states, agent.id, initialState)
      throw error
    }
    if (disposed || !validPosition(payload) || !validSignal(payload.signal) || payload.signal.aborted
      || !prepareAgent(agent, states, generations, agents, disposedAgents)) return base
    const state = states.get(agent.id)
    if (!state || state !== initialState || state.agent !== agent
      || state.turn !== payload.turn || state.step !== payload.step) return base
    if (state.inFlight) return base
    if (!isRecord(base) || typeof base.provider !== 'string' || !base.provider
      || typeof base.model !== 'string' || !base.model) {
      clearExactState(states, agent.id, state)
      return base
    }
    if (Object.prototype.hasOwnProperty.call(base, 'reasoningEffort') && base.reasoningEffort !== undefined) {
      clearExactState(states, agent.id, state)
      return base
    }

    state.inFlight = true
    const candidate = Object.freeze({ ...base, reasoningEffort: 'high' })
    let resolved
    try {
      resolved = await awaitWithSignalAndTimeout(
        preflightSignal => llm.resolveCallConfig(candidate, preflightSignal),
        payload.signal,
        timeoutMs,
      )
    } catch {
      clearExactState(states, agent.id, state)
      return base
    }

    if (disposed || payload.signal.aborted || !isCurrentAgent(agent, agents, disposedAgents)
      || states.get(agent.id) !== state) {
      clearExactState(states, agent.id, state)
      return base
    }
    clearExactState(states, agent.id, state)
    if (resolved !== undefined && (!isRecord(resolved) || resolved.provider !== base.provider
      || resolved.model !== base.model || resolved.reasoningEffort !== 'high')) return base
    return candidate
  }

  function onAgentDisposed(payload) {
    const agent = payload?.agent
    if (!isAgentObject(agent)) return
    disposedAgents.add(agent)
    clearOwnedState(states, agent.id, agent)
    clearOwnedGeneration(generations, agent.id, agent)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    states.clear()
    generations.clear()
  }

  return Object.freeze({ onPreStep, onRequest, onAgentDisposed, dispose })
}

export function createThinkModeReasoningController(llm, options = {}) {
  return createController(llm, options)
}

export function registerThinkModeReasoning(ctx, llm, options = {}) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') {
    throw new TypeError('enableThinkModeReasoning requires Cordis ctx.on and ctx.effect')
  }
  const controller = createController(llm, options)
  try {
    // Register before route-rewriting listeners so this outer waterfall validates the final selected route.
    ctx.on('agent/pre-step', controller.onPreStep)
    ctx.on('agent/request', controller.onRequest)
    ctx.on('agent/disposed', controller.onAgentDisposed)
    ctx.effect(() => controller.dispose, 'dsh-omo think-mode reasoning-effort adapter')
  } catch (error) {
    controller.dispose()
    throw error
  }
  return controller.dispose
}
