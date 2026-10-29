import { posix as path } from 'node:path'

const MAX_SESSIONS = 256
const MAX_GRANTS_PER_SESSION = 256
const MAX_PENDING_CALLS = 64
const MAX_IN_FLIGHT_PREFLIGHTS = 64
const MAX_OVERFLOW_CALLS = 64
const MAX_COLLIDED_TOKENS = 64
const MAX_SEEN_TOKENS = 16_384
const MAX_FILE_PATH_CHARS = 4_096
const MAX_CWD_CHARS = 4_096
const MAX_TARGET_KEY_CHARS = 4_096
const DEFAULT_PIPELINE_TIMEOUT_MS = 5_000
const READ_TOOL_NAME = 'read'
const WRITE_TOOL_NAME = 'write'
const FILE_ALREADY_EXISTS_REASON = 'File already exists. Use edit tool instead.'
const UNVERIFIED_TARGET_REASON = 'Write guard could not safely verify the target; write blocked.'
const UNSAFE_TARGET_REASON = 'Write guard refuses symlink and non-file targets.'
const BUSY_REASON = 'Write guard is busy; retry after rereading the file.'
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
const ABORTED = Symbol('write-existing-file guard operation aborted')
// Share bounded token history and unsettled FS leases across listeners using the same provider.
const sharedGuardStateByFs = new WeakMap()

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function isPlainRecord(value) {
  if (!isObject(value) || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function ownDataValue(value, key) {
  if (!isObject(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function validSignal(signal) {
  return isObject(signal) && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'
}

function validCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 && cwd.length <= MAX_CWD_CHARS
    && path.isAbsolute(cwd) && !CONTROL_OR_BIDI.test(cwd)
}

function safeTargetKey(target) {
  try {
    const key = target?.targetKey
    return typeof key === 'string' && key.length > 0 && key.length <= MAX_TARGET_KEY_CHARS
      && !CONTROL_OR_BIDI.test(key) ? key : undefined
  } catch {
    return undefined
  }
}

function safeVersion(info) {
  try {
    const version = info?.version
    return typeof version === 'string' && version.length > 0 && version.length <= MAX_TARGET_KEY_CHARS
      && !CONTROL_OR_BIDI.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

function validateFilePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILE_PATH_CHARS
    || value !== value.trim() || value.includes('\\') || CONTROL_OR_BIDI.test(value)
    || value.startsWith('~') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return undefined
  return value
}

function filePathSchemaMatches(exec) {
  const schema = ownDataValue(exec, 'schema')
  if (schema === undefined) return true
  if (!isPlainRecord(schema)) return false
  const name = ownDataValue(exec, 'name')
  const schemaName = ownDataValue(schema, 'name')
  if (typeof schemaName === 'string' && (typeof name !== 'string' || schemaName.toLowerCase() !== name.toLowerCase())) return false
  const parameters = ownDataValue(schema, 'parameters')
  const properties = ownDataValue(parameters, 'properties')
  const filePath = ownDataValue(properties, 'file_path')
  return isPlainRecord(filePath) && ownDataValue(filePath, 'type') === 'string'
}

function getToolName(exec) {
  const name = ownDataValue(exec, 'name')
  return typeof name === 'string' ? name.toLowerCase() : ''
}

function getExecToken(exec) {
  const token = ownDataValue(exec, 'token')
  return typeof token === 'symbol' ? token : undefined
}

function getExecAgentId(exec) {
  try {
    const id = exec?.agent?.id
    return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : undefined
  } catch {
    return undefined
  }
}

function getExecPath(exec) {
  const args = ownDataValue(exec, 'arguments')
  if (!isPlainRecord(args)) return undefined
  return validateFilePath(ownDataValue(args, 'file_path'))
}

function getOverwriteValue(exec) {
  const args = ownDataValue(exec, 'arguments')
  const overwrite = ownDataValue(args, 'overwrite')
  return overwrite === true || (typeof overwrite === 'string' && overwrite.toLowerCase() === 'true')
}

function isOmoPath(filePath) {
  // Apply the bypass to the effective POSIX lexical path, not a canceled raw segment.
  return path.normalize(filePath).split('/').includes('.omo')
}

function getAgentContext(exec, agents, sessions) {
  try {
    const projection = exec?.agent
    const id = getExecAgentId(exec)
    if (!projection || !id) return undefined
    const agent = agents.get(id)
    if (!isObject(agent) || agent.id !== id) return undefined
    const session = sessions.get(id)
    const header = session?.header
    if (header?.id !== id || !validCwd(header.cwd)) return undefined
    return { id, agent, cwd: header.cwd }
  } catch {
    return undefined
  }
}

function awaitWithSignal(pending, signal) {
  if (signal?.aborted) return Promise.reject(ABORTED)
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      try {
        signal.removeEventListener('abort', onAbort)
      } catch {}
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(ABORTED)
    }
    Promise.resolve(pending).then(value => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function createPreflightLease(releaseSlot) {
  let outstanding = 0
  let finished = false
  let released = false
  const releaseIfIdle = () => {
    if (!finished || outstanding > 0 || released) return
    released = true
    releaseSlot()
  }
  return {
    wait(operation, signal) {
      if (signal?.aborted) return Promise.reject(ABORTED)
      outstanding += 1
      let pending
      try {
        pending = Promise.resolve(operation())
      } catch (error) {
        outstanding -= 1
        releaseIfIdle()
        return Promise.reject(error)
      }
      pending.then(() => {
        outstanding -= 1
        releaseIfIdle()
      }, () => {
        outstanding -= 1
        releaseIfIdle()
      })
      return awaitWithSignal(pending, signal)
    },
    finish() {
      finished = true
      releaseIfIdle()
    },
  }
}

function createCallScope(execSignal, lifetimeSignal, agentId, activeByAgent, timeoutMs) {
  const controller = new AbortController()
  const removers = []
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  for (const signal of [execSignal, lifetimeSignal]) {
    if (!validSignal(signal)) continue
    if (signal.aborted) {
      abort()
      break
    }
    const onAbort = () => abort()
    signal.addEventListener('abort', onAbort, { once: true })
    removers.push(() => {
      try {
        signal.removeEventListener('abort', onAbort)
      } catch {}
    })
    if (signal.aborted) {
      abort()
      break
    }
  }
  const timer = setTimeout(abort, timeoutMs)
  let calls = activeByAgent.get(agentId)
  if (!calls) {
    calls = new Set()
    activeByAgent.set(agentId, calls)
  }
  calls.add(controller)
  return {
    signal: controller.signal,
    abort,
    dispose() {
      clearTimeout(timer)
      for (const remove of removers) remove()
      calls.delete(controller)
      if (calls.size === 0 && activeByAgent.get(agentId) === calls) activeByAgent.delete(agentId)
    },
  }
}

function isLiveAgent(agents, id, agent) {
  try {
    return agents.get(id) === agent && agent?.id === id
  } catch {
    return false
  }
}

function contains(fs, rootTarget, target) {
  try {
    const result = fs.contains(rootTarget, target)
    return typeof result === 'boolean' ? result : undefined
  } catch {
    return undefined
  }
}

async function inspectTarget(fs, filePath, cwd, signal, lease) {
  const rootTarget = await lease.wait(() => fs.resolve(cwd, { signal }), signal)
  const target = await lease.wait(() => fs.resolve(filePath, { cwd, signal }), signal)
  const key = safeTargetKey(target)
  if (!safeTargetKey(rootTarget) || !key) return { kind: 'unknown' }
  const inCwd = contains(fs, rootTarget, target)
  if (inCwd === undefined) return { kind: 'unknown' }
  if (!inCwd) return { kind: 'outside' }

  const pathInfo = await lease.wait(() => fs.lstat(filePath, { cwd }, signal), signal)
  if (pathInfo === undefined || pathInfo === null) return { kind: 'missing' }
  if (!isObject(pathInfo) || typeof pathInfo.type !== 'string') return { kind: 'unknown' }
  if (pathInfo.type !== 'file') return { kind: 'unsafe' }

  const info = await lease.wait(() => fs.stat(target, signal), signal)
  if (info === undefined || info === null) return { kind: 'missing' }
  if (!isObject(info) || info.type !== 'file') return { kind: 'unsafe' }
  const pathVersion = safeVersion(pathInfo)
  const infoVersion = safeVersion(info)
  if (!pathVersion || !infoVersion || pathVersion !== infoVersion) return { kind: 'unknown' }
  if ((pathInfo.size !== undefined && (!Number.isSafeInteger(pathInfo.size) || pathInfo.size < 0))
    || (info.size !== undefined && (!Number.isSafeInteger(info.size) || info.size < 0))
    || (pathInfo.size !== undefined && info.size !== undefined && pathInfo.size !== info.size)) return { kind: 'unknown' }
  return { kind: 'file', key }
}

function makeDenied(exec, token, reason, agentId, pendingByToken, overflowByToken, decisionByExecution, maxPendingCalls, overflowFailClosed, markTokenCollision) {
  const record = { kind: 'deny', reason, agentId, token, toolName: getToolName(exec) }
  if (token) {
    if (pendingByToken.has(token) || overflowByToken.has(token)) markTokenCollision(token)
    else if (pendingByToken.size < maxPendingCalls) pendingByToken.set(token, record)
    else if (overflowByToken.size < MAX_OVERFLOW_CALLS) overflowByToken.set(token, record)
    else overflowFailClosed.value = true
  }
  if (isObject(exec)) decisionByExecution.set(exec, record)
  return { kind: 'deny', reason }
}

function sameAgentContext(agents, record) {
  return record && isLiveAgent(agents, record.agentId, record.agent)
}

/**
 * Create an opt-in, process-local adapter for the upstream one-use read-before-write guard.
 * It governs case-insensitive Tool names `read`/`write` with scalar `file_path` arguments
 * (validating a supplied schema) and is not a filesystem or shell authorization boundary.
 */
export function createWriteExistingFileGuard(agents, sessions, fs, options = {}) {
  if (!agents || typeof agents.get !== 'function') throw new TypeError('Write guard requires DSH agents.get')
  if (!sessions || typeof sessions.get !== 'function') throw new TypeError('Write guard requires DSH sessions.get')
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function'
    || typeof fs.lstat !== 'function' || typeof fs.stat !== 'function') {
    throw new TypeError('Write guard requires DSH fs.resolve, contains, lstat, and stat')
  }
  const requestedMaxSessions = options.maxSessions ?? MAX_SESSIONS
  const requestedMaxGrantsPerSession = options.maxGrantsPerSession ?? MAX_GRANTS_PER_SESSION
  const requestedMaxPendingCalls = options.maxPendingCalls ?? MAX_PENDING_CALLS
  const requestedMaxInFlightPreflights = options.maxInFlightPreflights ?? MAX_IN_FLIGHT_PREFLIGHTS
  const requestedMaxSeenTokens = options.maxSeenTokens ?? MAX_SEEN_TOKENS
  const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS
  for (const [name, value] of [
    ['maxSessions', requestedMaxSessions], ['maxGrantsPerSession', requestedMaxGrantsPerSession],
    ['maxPendingCalls', requestedMaxPendingCalls], ['maxInFlightPreflights', requestedMaxInFlightPreflights],
    ['maxSeenTokens', requestedMaxSeenTokens], ['timeoutMs', requestedTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Write guard ${name} must be a positive safe integer`)
  }
  const maxSessions = Math.min(requestedMaxSessions, MAX_SESSIONS)
  const maxGrantsPerSession = Math.min(requestedMaxGrantsPerSession, MAX_GRANTS_PER_SESSION)
  const maxPendingCalls = Math.min(requestedMaxPendingCalls, MAX_PENDING_CALLS)
  const maxInFlightPreflights = Math.min(requestedMaxInFlightPreflights, MAX_IN_FLIGHT_PREFLIGHTS)
  const maxSeenTokens = Math.min(requestedMaxSeenTokens, MAX_SEEN_TOKENS)
  const timeoutMs = Math.min(requestedTimeoutMs, DEFAULT_PIPELINE_TIMEOUT_MS)

  const states = new Map()
  const pendingByToken = new Map()
  // A second bounded ledger retains tool decisions after the primary token map fills.
  const overflowByToken = new Map()
  // Unrecordable per-listener calls latch unknown writes closed until unload.
  const overflowFailClosed = { value: false }
  const decisionByExecution = new WeakMap()
  const activeByAgent = new Map()
  const lifetime = new AbortController()
  let disposed = false
  // Keep token history across listener disposal/re-registration for this live FS provider.
  let sharedState = sharedGuardStateByFs.get(fs)
  if (!sharedState) {
    sharedState = {
      count: 0, limit: maxInFlightPreflights,
      seenTokens: new Set(), seenTokenLimit: maxSeenTokens, tokenHistoryOverflow: false,
      collidedTokens: new Set(), collisionOverflow: false,
    }
    sharedGuardStateByFs.set(fs, sharedState)
  } else {
    sharedState.limit = Math.min(sharedState.limit, maxInFlightPreflights)
    sharedState.seenTokenLimit = Math.min(sharedState.seenTokenLimit, maxSeenTokens)
  }

  function markTokenCollision(token) {
    if (typeof token !== 'symbol' || sharedState.collidedTokens.has(token)) return
    if (sharedState.collidedTokens.size >= MAX_COLLIDED_TOKENS) {
      sharedState.collisionOverflow = true
      overflowFailClosed.value = true
      return
    }
    sharedState.collidedTokens.add(token)
  }

  function claimTokenUse(token) {
    if (typeof token !== 'symbol') return false
    if (sharedState.seenTokens.has(token)) {
      markTokenCollision(token)
      return false
    }
    if (sharedState.seenTokens.size >= sharedState.seenTokenLimit) {
      sharedState.tokenHistoryOverflow = true
      overflowFailClosed.value = true
      return false
    }
    sharedState.seenTokens.add(token)
    return true
  }

  function abortAgent(agentId) {
    const calls = activeByAgent.get(agentId)
    if (calls) for (const controller of calls) controller.abort()
  }

  function clearAgent(agentId) {
    if (typeof agentId !== 'string') return
    abortAgent(agentId)
    states.delete(agentId)
    for (const [token, record] of pendingByToken) {
      if (record.agentId === agentId) pendingByToken.delete(token)
    }
    for (const [token, record] of overflowByToken) {
      if (record.agentId === agentId) overflowByToken.delete(token)
    }
  }

  function getState(agentId, create = false) {
    let state = states.get(agentId)
    if (state) {
      states.delete(agentId)
      states.set(agentId, state)
      return state
    }
    if (!create || disposed) return undefined
    if (states.size >= maxSessions) {
      const oldestId = states.keys().next().value
      if (oldestId !== undefined) clearAgent(oldestId)
    }
    state = { grants: new Map() }
    states.set(agentId, state)
    return state
  }

  function addGrant(agentId, agent, targetKey) {
    if (disposed || !isLiveAgent(agents, agentId, agent)) return
    const state = getState(agentId, true)
    const previous = state.grants.get(targetKey)
    if (previous?.reservedBy) return
    state.grants.delete(targetKey)
    state.grants.set(targetKey, { reservedBy: undefined })
    while (state.grants.size > maxGrantsPerSession) {
      const oldestKey = state.grants.keys().next().value
      if (oldestKey === undefined) break
      state.grants.delete(oldestKey)
    }
  }

  function setPending(exec, token, record) {
    if (typeof token !== 'symbol') return false
    if (sharedState.collidedTokens.has(token) || pendingByToken.has(token) || overflowByToken.has(token)) {
      markTokenCollision(token)
      return false
    }
    record.token = token
    record.toolName = getToolName(exec)
    if (pendingByToken.size < maxPendingCalls) pendingByToken.set(token, record)
    else if (overflowByToken.size < MAX_OVERFLOW_CALLS) overflowByToken.set(token, record)
    else {
      overflowFailClosed.value = true
      return false
    }
    if (isObject(exec)) decisionByExecution.set(exec, record)
    return true
  }

  function acquirePreflightSlot() {
    if (disposed || sharedState.count >= sharedState.limit) return undefined
    sharedState.count += 1
    let released = false
    return () => {
      if (released) return
      released = true
      sharedState.count -= 1
    }
  }

  function startScope(exec, agentId) {
    const signal = ownDataValue(exec, 'signal')
    if (!validSignal(signal)) return undefined
    return createCallScope(signal, lifetime.signal, agentId, activeByAgent, timeoutMs)
  }

  function denyWrite(exec, token, reason, agentId) {
    return makeDenied(exec, token, reason, agentId, pendingByToken, overflowByToken, decisionByExecution, maxPendingCalls, overflowFailClosed, markTokenCollision)
  }

  async function before(exec, next) {
    if (disposed) return typeof next === 'function' ? next() : { kind: 'allow' }
    const toolName = getToolName(exec)
    if (toolName !== READ_TOOL_NAME && toolName !== WRITE_TOOL_NAME) {
      return typeof next === 'function' ? next() : { kind: 'allow' }
    }

    const token = getExecToken(exec)
    const firstTokenUse = claimTokenUse(token)
    const filePath = filePathSchemaMatches(exec) ? getExecPath(exec) : undefined
    if (toolName === READ_TOOL_NAME) {
      if (!firstTokenUse || sharedState.tokenHistoryOverflow || sharedState.collidedTokens.has(token)
        || sharedState.collisionOverflow || !filePath || pendingByToken.size >= maxPendingCalls) {
        return typeof next === 'function' ? next() : { kind: 'allow' }
      }
      const context = getAgentContext(exec, agents, sessions)
      if (!context) return typeof next === 'function' ? next() : { kind: 'allow' }
      const releaseSlot = acquirePreflightSlot()
      if (!releaseSlot) return typeof next === 'function' ? next() : { kind: 'allow' }
      let scope
      try {
        scope = startScope(exec, context.id)
      } catch {
        releaseSlot()
        return typeof next === 'function' ? next() : { kind: 'allow' }
      }
      if (!scope) {
        releaseSlot()
        return typeof next === 'function' ? next() : { kind: 'allow' }
      }
      const lease = createPreflightLease(releaseSlot)
      try {
        const target = await inspectTarget(fs, filePath, context.cwd, scope.signal, lease)
        if (target.kind === 'file' && !scope.signal.aborted && !disposed
          && filePathSchemaMatches(exec) && getExecPath(exec) === filePath
          && getExecAgentId(exec) === context.id && isLiveAgent(agents, context.id, context.agent)) {
          setPending(exec, token, { kind: 'read', agentId: context.id, agent: context.agent, filePath, targetKey: target.key })
        }
      } catch {
        // Reads remain native; uncertainty simply creates no future write grant.
      } finally {
        scope.dispose()
        lease.finish()
      }
      return typeof next === 'function' ? next() : { kind: 'allow' }
    }

    if (!filePath || !token) return denyWrite(exec, token, UNVERIFIED_TARGET_REASON)
    if (!firstTokenUse || sharedState.tokenHistoryOverflow || sharedState.collidedTokens.has(token)
      || sharedState.collisionOverflow) return denyWrite(exec, token, BUSY_REASON)
    const context = getAgentContext(exec, agents, sessions)
    if (!context) return denyWrite(exec, token, UNVERIFIED_TARGET_REASON)
    const overwriteBypass = getOverwriteValue(exec)
    const bypassKind = isOmoPath(filePath) ? 'omo' : overwriteBypass ? 'overwrite' : undefined
    if (bypassKind) {
      const record = { kind: 'bypass', bypassKind, overwriteBypass, agentId: context.id, agent: context.agent, filePath }
      if (!setPending(exec, token, record)) return denyWrite(exec, token, BUSY_REASON, context.id)
      return typeof next === 'function' ? next() : { kind: 'allow' }
    }
    if (pendingByToken.size >= maxPendingCalls) return denyWrite(exec, token, BUSY_REASON, context.id)
    const releaseSlot = acquirePreflightSlot()
    if (!releaseSlot) return denyWrite(exec, token, BUSY_REASON, context.id)
    let scope
    try {
      scope = startScope(exec, context.id)
    } catch {
      releaseSlot()
      return denyWrite(exec, token, UNVERIFIED_TARGET_REASON, context.id)
    }
    if (!scope) {
      releaseSlot()
      return denyWrite(exec, token, UNVERIFIED_TARGET_REASON, context.id)
    }
    const lease = createPreflightLease(releaseSlot)

    try {
      const target = await inspectTarget(fs, filePath, context.cwd, scope.signal, lease)
      if (scope.signal.aborted) {
        if (ownDataValue(exec, 'signal')?.aborted || disposed) return { kind: 'cancel' }
        return denyWrite(exec, token, UNVERIFIED_TARGET_REASON, context.id)
      }
      if (target.kind === 'outside' || target.kind === 'missing') {
        const record = {
          kind: 'pass', agentId: context.id, agent: context.agent, filePath,
          overwriteBypass: false, passKind: target.kind,
        }
        if (!setPending(exec, token, record)) return denyWrite(exec, token, BUSY_REASON, context.id)
        return typeof next === 'function' ? next() : { kind: 'allow' }
      }
      if (target.kind === 'unsafe') return denyWrite(exec, token, UNSAFE_TARGET_REASON, context.id)
      if (target.kind !== 'file') return denyWrite(exec, token, UNVERIFIED_TARGET_REASON, context.id)
      if (!isLiveAgent(agents, context.id, context.agent)) return denyWrite(exec, token, UNVERIFIED_TARGET_REASON, context.id)

      const state = getState(context.id)
      const grant = state?.grants.get(target.key)
      if (!grant || grant.reservedBy) return denyWrite(exec, token, FILE_ALREADY_EXISTS_REASON, context.id)
      const record = { kind: 'write', agentId: context.id, agent: context.agent, filePath, targetKey: target.key, consumed: false }
      if (!setPending(exec, token, record)) return denyWrite(exec, token, BUSY_REASON, context.id)
      grant.reservedBy = token
      return typeof next === 'function' ? next() : { kind: 'allow' }
    } catch {
      if (ownDataValue(exec, 'signal')?.aborted || disposed) return { kind: 'cancel' }
      return denyWrite(exec, token, UNVERIFIED_TARGET_REASON, context.id)
    } finally {
      scope.dispose()
      lease.finish()
    }
  }

  function guard(exec) {
    if (disposed) return undefined
    const token = getExecToken(exec)
    const toolName = getToolName(exec)
    const executionRecord = isObject(exec) ? decisionByExecution.get(exec) : undefined
    const tokenRecord = token ? pendingByToken.get(token) || overflowByToken.get(token) : undefined
    const record = executionRecord || tokenRecord
    if ((sharedState.collisionOverflow || sharedState.tokenHistoryOverflow)
      && (toolName === WRITE_TOOL_NAME || record?.toolName === WRITE_TOOL_NAME)) return BUSY_REASON
    if (token && sharedState.collidedTokens.has(token)
      && (toolName === WRITE_TOOL_NAME || record?.toolName === WRITE_TOOL_NAME)) return BUSY_REASON
    if (!record) {
      if (toolName !== WRITE_TOOL_NAME) return undefined
      return overflowFailClosed.value || overflowByToken.size >= MAX_OVERFLOW_CALLS
        ? BUSY_REASON : UNVERIFIED_TARGET_REASON
    }
    if (record.kind === 'deny') return record.reason
    if (record.token !== token || record.toolName !== toolName) return UNVERIFIED_TARGET_REASON
    if (record.kind === 'read') return toolName === READ_TOOL_NAME ? undefined : UNVERIFIED_TARGET_REASON
    if (toolName !== WRITE_TOOL_NAME) return UNVERIFIED_TARGET_REASON

    const filePath = getExecPath(exec)
    if (!filePathSchemaMatches(exec) || filePath !== record.filePath
      || getExecAgentId(exec) !== record.agentId || !sameAgentContext(agents, record)) return UNVERIFIED_TARGET_REASON

    if (record.kind === 'bypass') {
      const stillBypassed = record.bypassKind === 'omo'
        ? isOmoPath(filePath)
        : record.bypassKind === 'overwrite' && getOverwriteValue(exec)
      if (!stillBypassed || getOverwriteValue(exec) !== record.overwriteBypass) return UNVERIFIED_TARGET_REASON
      return undefined
    }
    if (record.kind === 'pass') {
      if (getOverwriteValue(exec) !== record.overwriteBypass) return UNVERIFIED_TARGET_REASON
      return undefined
    }
    if (record.kind !== 'write') return UNVERIFIED_TARGET_REASON

    const state = states.get(record.agentId)
    const grant = state?.grants.get(record.targetKey)
    if (!grant || grant.reservedBy !== token) return UNVERIFIED_TARGET_REASON
    state.grants.delete(record.targetKey)
    grant.reservedBy = undefined
    record.consumed = true
    return undefined
  }

  function onResult(exec, result) {
    const token = getExecToken(exec)
    const executionRecord = isObject(exec) ? decisionByExecution.get(exec) : undefined
    const tokenRecord = token ? pendingByToken.get(token) || overflowByToken.get(token) : undefined
    const record = executionRecord || tokenRecord
    const recordToken = record?.token
    if (record) {
      if (pendingByToken.get(recordToken) === record) pendingByToken.delete(recordToken)
      if (overflowByToken.get(recordToken) === record) overflowByToken.delete(recordToken)
      const tokenIsUnambiguous = !sharedState.collisionOverflow && !sharedState.tokenHistoryOverflow
        && !sharedState.collidedTokens.has(recordToken)
      if (record.kind === 'read' && tokenIsUnambiguous && record.toolName === READ_TOOL_NAME
        && getToolName(exec) === READ_TOOL_NAME && result?.isError === false && token === recordToken
        && filePathSchemaMatches(exec) && getExecPath(exec) === record.filePath
        && getExecAgentId(exec) === record.agentId && sameAgentContext(agents, record)) {
        addGrant(record.agentId, record.agent, record.targetKey)
      } else if (record.kind === 'write' && !record.consumed) {
        const grant = states.get(record.agentId)?.grants.get(record.targetKey)
        if (grant?.reservedBy === recordToken) grant.reservedBy = undefined
      }
    }
    if (isObject(exec)) decisionByExecution.delete(exec)
  }

  function onAgentCreated(payload) {
    if (disposed) return
    const agent = payload?.agent
    let id
    try { id = agent?.id } catch { return }
    if (typeof id !== 'string' || !isLiveAgent(agents, id, agent)) return
    clearAgent(id)
  }

  function onAgentDisposed(payload) {
    const agent = payload?.agent
    let id
    try { id = agent?.id } catch { return }
    if (typeof id !== 'string') return
    try {
      const current = agents.get(id)
      if (current !== undefined && current !== agent) return
    } catch {
      return
    }
    clearAgent(id)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    lifetime.abort()
    for (const calls of activeByAgent.values()) for (const controller of calls) controller.abort()
    activeByAgent.clear()
    pendingByToken.clear()
    overflowByToken.clear()
    states.clear()
  }

  return Object.freeze({ before, guard, onResult, onAgentCreated, onAgentDisposed, dispose })
}

/** Register the opt-in read-before-write adapter and its monotonic DSH Tool guard. */
export function registerWriteExistingFileGuard(ctx, agents, sessions, fs) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function'
    || typeof ctx?.tools?.guard !== 'function') {
    throw new TypeError('registerWriteExistingFileGuard requires Cordis ctx.on, ctx.effect, and tools.guard')
  }
  const listener = createWriteExistingFileGuard(agents, sessions, fs)
  let disposeGuard
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    listener.dispose()
    if (typeof disposeGuard === 'function') disposeGuard()
  }
  try {
    ctx.on('tools/pre-execute', listener.before)
    ctx.on('tools/result', listener.onResult)
    ctx.on('agent/created', listener.onAgentCreated)
    ctx.on('agent/disposed', listener.onAgentDisposed)
    disposeGuard = ctx.tools.guard(listener.guard)
    if (typeof disposeGuard !== 'function') throw new TypeError('DSH tools.guard must return a disposer')
    ctx.effect(() => dispose, 'dsh-omo write-existing-file guard')
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
