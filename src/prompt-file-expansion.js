import { isAbsolute } from 'node:path'
import { MAX_PROMPT_APPEND_BYTES } from './roles.js'

const FILE_REFERENCE_PREFIX = 'file://'
const MAX_CWD_CHARS = 4_096
const MAX_TARGET_KEY_CHARS = 4_096
const MAX_REFERENCE_PATH_CHARS = 1_024
const MAX_REFERENCE_SEGMENTS = 32
const PROMPT_FILE_READ_TIMEOUT_MS = 5_000
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/u
const ABORTED = Symbol('prompt file operation cancelled')

class PromptFileExpansionError extends Error {
  constructor(message, kind = 'invalid') {
    super(message)
    this.name = 'PromptFileExpansionError'
    this.kind = kind
  }
}

function validSignal(signal) {
  return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw ABORTED
}

function awaitWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(ABORTED)
  let pending
  try {
    pending = operation()
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      try { signal.removeEventListener('abort', onAbort) } catch {}
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

function linkSignals(signals) {
  const controller = new AbortController()
  const removers = []
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  for (const signal of signals) {
    if (signal === undefined || signal === null) continue
    if (!validSignal(signal)) throw new TypeError('Prompt-file expansion received an invalid cancellation signal.')
    if (signal.aborted) {
      abort()
      break
    }
    const onAbort = () => abort()
    signal.addEventListener('abort', onAbort, { once: true })
    removers.push(() => {
      try { signal.removeEventListener('abort', onAbort) } catch {}
    })
    if (signal.aborted) {
      abort()
      break
    }
  }
  return {
    signal: controller.signal,
    dispose() { for (const remove of removers) remove() },
  }
}

function createOperationSignal(execSignal, lifecycleSignal, timeoutMs) {
  const deadline = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    deadline.abort()
  }, timeoutMs)
  let linked
  try {
    linked = linkSignals([execSignal, lifecycleSignal, deadline.signal])
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
  return {
    signal: linked.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      linked.dispose()
    },
  }
}

function targetKey(target) {
  const key = target?.targetKey
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_TARGET_KEY_CHARS
    && !/[\u0000-\u001f\u007f]/u.test(key)
    ? key
    : undefined
}

function contained(fs, parent, child) {
  try { return fs.contains(parent, child) === true } catch { return false }
}

function safeSize(info, maximum) {
  return info?.size === undefined
    || (Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= maximum)
}

function sameFileVersion(before, after, bytes) {
  return after?.type === 'file'
    && (before.version === undefined || after.version === before.version)
    && (before.size === undefined || after.size === before.size)
    && (after.size === undefined || (Number.isSafeInteger(after.size) && after.size >= 0 && after.size === bytes.byteLength))
}

function currentSessionCwd(agents, sessions, agent) {
  const id = agent?.id
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CWD_CHARS) {
    throw new PromptFileExpansionError('Prompt-file expansion requires a live Agent session with a working directory.')
  }
  let liveAgent
  let session
  try {
    liveAgent = agents.get(id)
    session = sessions.get(id)
  } catch {
    throw new PromptFileExpansionError('Prompt-file expansion requires a live Agent session with a working directory.')
  }
  const cwd = session?.header?.cwd
  if (liveAgent !== agent || session?.header?.id !== id || typeof cwd !== 'string'
    || cwd.length === 0 || cwd.length > MAX_CWD_CHARS || !isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd)) {
    throw new PromptFileExpansionError('Prompt-file expansion requires the exact live Agent session and its absolute working directory.')
  }
  return cwd
}

export function parsePromptFileReference(value) {
  if (typeof value !== 'string' || !value.startsWith(FILE_REFERENCE_PREFIX)) return undefined
  let relativePath = value.slice(FILE_REFERENCE_PREFIX.length)
  if (!relativePath || relativePath.length > MAX_REFERENCE_PATH_CHARS
    || relativePath.startsWith('~') || relativePath.startsWith('/') || isAbsolute(relativePath)
    || relativePath.includes('\\') || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}%?#:]/u.test(relativePath)
    || /[*\[\]{}]/u.test(relativePath)) {
    throw new PromptFileExpansionError('Prompt-file references must use a bounded relative path inside the current session working directory.')
  }
  const segments = relativePath.split('/')
  if (segments[0] === '.') segments.shift()
  if (segments.length === 0 || segments.length > MAX_REFERENCE_SEGMENTS
    || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new PromptFileExpansionError('Prompt-file references must not be empty or traverse outside the current session working directory.')
  }
  relativePath = segments.join('/')
  return relativePath
}

async function readPromptFile({ fs, agents, sessions, agent, cwd, rootTarget, relativePath, signal }) {
  const segments = relativePath.split('/')
  let resolvedPath = ''
  const beforePathInfos = []
  for (let index = 0; index < segments.length; index += 1) {
    resolvedPath = resolvedPath ? `${resolvedPath}/${segments[index]}` : segments[index]
    const expectedType = index === segments.length - 1 ? 'file' : 'directory'
    const pathInfo = await awaitWithSignal(() => fs.lstat(resolvedPath, { cwd }, signal), signal)
    assertNotAborted(signal)
    if (pathInfo?.type !== expectedType) {
      throw new PromptFileExpansionError('Configured prompt file is missing, a symlink, or not a regular in-directory file.', 'unavailable')
    }
    beforePathInfos.push({ path: resolvedPath, info: pathInfo })
  }

  const fileTarget = await awaitWithSignal(() => fs.resolve(resolvedPath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (!targetKey(fileTarget) || !contained(fs, rootTarget, fileTarget)) {
    throw new PromptFileExpansionError('Configured prompt file is outside the current session working directory.', 'unavailable')
  }
  const beforeInfo = await awaitWithSignal(() => fs.stat(fileTarget, signal), signal)
  assertNotAborted(signal)
  if (beforeInfo?.type !== 'file' || !safeSize(beforeInfo, MAX_PROMPT_APPEND_BYTES)) {
    throw new PromptFileExpansionError('Configured prompt file exceeds the supported size limit or is not a regular file.', 'too-large')
  }
  if (currentSessionCwd(agents, sessions, agent) !== cwd) {
    throw new PromptFileExpansionError('Agent session working directory changed before prompt-file read.', 'unavailable')
  }

  let bytes
  try {
    bytes = await awaitWithSignal(() => fs.readBytes(fileTarget, signal, MAX_PROMPT_APPEND_BYTES), signal)
  } catch (error) {
    if (signal.aborted || error === ABORTED) throw ABORTED
    if (error?.code === 'FS_TOO_LARGE') {
      throw new PromptFileExpansionError('Configured prompt file exceeds the supported size limit.', 'too-large')
    }
    throw new PromptFileExpansionError('Configured prompt file could not be read safely.', 'unavailable')
  }
  assertNotAborted(signal)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PROMPT_APPEND_BYTES
    || (beforeInfo.size !== undefined && bytes.byteLength !== beforeInfo.size)) {
    throw new PromptFileExpansionError('Configured prompt file changed or exceeded the supported size limit.', 'unavailable')
  }

  for (const { path: checkedPath, info: beforePathInfo } of beforePathInfos) {
    const afterPathInfo = await awaitWithSignal(() => fs.lstat(checkedPath, { cwd }, signal), signal)
    assertNotAborted(signal)
    if (afterPathInfo?.type !== beforePathInfo.type
      || (beforePathInfo.version !== undefined && afterPathInfo.version !== beforePathInfo.version)) {
      throw new PromptFileExpansionError('Configured prompt path changed during inspection.', 'unavailable')
    }
  }
  const afterTarget = await awaitWithSignal(() => fs.resolve(resolvedPath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (targetKey(afterTarget) !== targetKey(fileTarget) || !contained(fs, rootTarget, afterTarget)) {
    throw new PromptFileExpansionError('Configured prompt file identity changed during inspection.', 'unavailable')
  }
  const afterInfo = await awaitWithSignal(() => fs.stat(afterTarget, signal), signal)
  assertNotAborted(signal)
  if (!sameFileVersion(beforeInfo, afterInfo, bytes)) {
    throw new PromptFileExpansionError('Configured prompt file changed during inspection.', 'unavailable')
  }
  if (currentSessionCwd(agents, sessions, agent) !== cwd) {
    throw new PromptFileExpansionError('Agent session working directory changed during prompt-file expansion.', 'unavailable')
  }

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new PromptFileExpansionError('Configured prompt file is not valid UTF-8.', 'invalid')
  }
  text = text.replace(/\r\n?/gu, '\n').trim()
  if (CONTROL_OR_BIDI.test(text) || new TextEncoder().encode(text).byteLength > MAX_PROMPT_APPEND_BYTES) {
    throw new PromptFileExpansionError('Configured prompt file contains unsafe text or exceeds the supported size limit.', 'invalid')
  }
  return text
}

export function createPromptFileExpander({ fs, agents, sessions, lifecycleSignal, timeoutMs = PROMPT_FILE_READ_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PROMPT_FILE_READ_TIMEOUT_MS) {
    throw new TypeError(`Prompt-file read timeout must be between 1 and ${PROMPT_FILE_READ_TIMEOUT_MS} milliseconds.`)
  }
  for (const method of ['resolve', 'contains', 'lstat', 'stat', 'readBytes']) {
    if (!fs || typeof fs[method] !== 'function') throw new TypeError(`Prompt-file expansion requires DSH fs.${method}.`)
  }
  if (!agents || typeof agents.get !== 'function' || !sessions || typeof sessions.get !== 'function') {
    throw new TypeError('Prompt-file expansion requires DSH agents.get and sessions.get.')
  }

  async function expand({ categoryPromptAppend, rolePromptAppend, agent, signal }) {
    const categoryPath = parsePromptFileReference(categoryPromptAppend)
    const rolePath = parsePromptFileReference(rolePromptAppend)
    if (categoryPath === undefined && rolePath === undefined) {
      return { categoryPromptAppend, rolePromptAppend, expanded: false }
    }

    const operation = createOperationSignal(signal, lifecycleSignal, timeoutMs)
    try {
      const cwd = currentSessionCwd(agents, sessions, agent)
      const rootTarget = await awaitWithSignal(() => fs.resolve(cwd, { signal: operation.signal }), operation.signal)
      assertNotAborted(operation.signal)
      if (!targetKey(rootTarget)) throw new PromptFileExpansionError('Current session working directory could not be resolved safely.', 'unavailable')
      const rootInfo = await awaitWithSignal(() => fs.stat(rootTarget, operation.signal), operation.signal)
      assertNotAborted(operation.signal)
      if (rootInfo?.type !== 'directory') throw new PromptFileExpansionError('Current session working directory is not a directory.', 'unavailable')

      const expandedCategory = categoryPath === undefined
        ? categoryPromptAppend
        : await readPromptFile({ fs, agents, sessions, agent, cwd, rootTarget, relativePath: categoryPath, signal: operation.signal })
      const expandedRole = rolePath === undefined
        ? rolePromptAppend
        : await readPromptFile({ fs, agents, sessions, agent, cwd, rootTarget, relativePath: rolePath, signal: operation.signal })
      const afterRootTarget = await awaitWithSignal(() => fs.resolve(cwd, { signal: operation.signal }), operation.signal)
      assertNotAborted(operation.signal)
      if (targetKey(afterRootTarget) !== targetKey(rootTarget)) {
        throw new PromptFileExpansionError('Current session working directory identity changed during prompt-file expansion.', 'unavailable')
      }
      const afterRootInfo = await awaitWithSignal(() => fs.stat(afterRootTarget, operation.signal), operation.signal)
      assertNotAborted(operation.signal)
      if (afterRootInfo?.type !== 'directory' || currentSessionCwd(agents, sessions, agent) !== cwd) {
        throw new PromptFileExpansionError('Current session working directory changed during prompt-file expansion.', 'unavailable')
      }
      const totalBytes = new TextEncoder().encode(expandedCategory ?? '').byteLength
        + new TextEncoder().encode(expandedRole ?? '').byteLength
      if (totalBytes > MAX_PROMPT_APPEND_BYTES * 2) {
        throw new PromptFileExpansionError('Expanded category and role guidance exceeds the combined size limit.', 'too-large')
      }
      return { categoryPromptAppend: expandedCategory, rolePromptAppend: expandedRole, expanded: true }
    } catch (error) {
      if (error === ABORTED || operation.signal.aborted) {
        if (operation.timedOut()) throw new PromptFileExpansionError('Prompt-file expansion timed out.', 'timeout')
        throw new PromptFileExpansionError('Prompt-file expansion was cancelled.', 'cancelled')
      }
      if (error instanceof PromptFileExpansionError) throw error
      throw new PromptFileExpansionError('Configured prompt-file expansion failed safely.', 'unavailable')
    } finally {
      operation.dispose()
    }
  }

  return Object.freeze({ expand })
}
