import { posix as path } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { normalizeProjectRootPath } from './agents-context.js'

const MAX_FILE_PATH_CHARS = 4_096
const MAX_CWD_CHARS = 4_096
const MAX_TARGET_KEY_CHARS = 4_096
const MAX_DIRECTORY_DEPTH = 8
const MAX_DEDUPED_DIRECTORIES_PER_AGENT = 256
const MAX_CONTEXT_FILE_BYTES = 16_384
const MAX_TOTAL_SOURCE_BYTES = 32_768
const READ_PIPELINE_TIMEOUT_MS = 5_000
const READ_TOOL_NAME = 'read'
const README_CONTEXT_FILE = Object.freeze({
  fileName: 'README.md',
  sectionLabel: 'Project README',
  endLabel: 'End project README',
})
const AGENTS_CONTEXT_FILE = Object.freeze({
  fileName: 'AGENTS.md',
  sectionLabel: 'Project AGENTS.md',
  endLabel: 'End project AGENTS.md',
})
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/u
const CONTROL_OR_BIDI_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/gu
const ABORTED = Symbol('directory context injection cancelled')
const DEDUPED = Symbol('directory context already injected')
const DIRECTORY_COMMITTED = Symbol('directory context committed')
const DIRECTORY_RELEASED = Symbol('directory context reservation released')
const MAX_PENDING_DIRECTORY_RETRIES = 1

export function normalizeProjectReadRoot(value, fieldName = 'projectRoot') {
  const root = normalizeProjectRootPath(value, fieldName)
  if (root !== undefined && root.includes('\\')) {
    throw new TypeError(`${fieldName} must use POSIX separators without backslashes`)
  }
  return root
}

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

function validSignal(signal) {
  return isObject(signal) && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw ABORTED
}

function awaitWithSignal(operation, signal) {
  if (signal?.aborted) return Promise.reject(ABORTED)
  let pending
  try {
    pending = operation()
  } catch (error) {
    return Promise.reject(error)
  }
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
    // Observe the operation even if abort wins; a late backend rejection must not be unhandled.
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
    if (!signal) continue
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
  return {
    signal: controller.signal,
    dispose() {
      for (const remove of removers) remove()
    },
  }
}

function createDeadline(milliseconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), milliseconds)
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer) },
  }
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

function validSize(size, limit) {
  return size === undefined || (Number.isSafeInteger(size) && size >= 0 && size <= limit)
}

function validateReadPath(args, cwd) {
  let descriptor
  try {
    if (!isPlainRecord(args)) return undefined
    descriptor = Object.getOwnPropertyDescriptor(args, 'file_path')
  } catch {
    return undefined
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined
  const filePath = descriptor.value
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_FILE_PATH_CHARS
    || filePath !== filePath.trim() || filePath.includes('\\') || CONTROL_OR_BIDI.test(filePath)
    || filePath.startsWith('~') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(filePath)) return undefined
  const absolutePath = path.isAbsolute(filePath)
  if (absolutePath && filePath.slice(1).split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  const relativePath = absolutePath ? path.relative(cwd, filePath) : filePath
  if (relativePath.length === 0 || relativePath === '.' || relativePath === '..'
    || relativePath.startsWith('../') || path.isAbsolute(relativePath)) return undefined
  const segments = relativePath.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return { filePath, segments }
}

function validateCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 && cwd.length <= MAX_CWD_CHARS
    && path.isAbsolute(cwd) && !CONTROL_OR_BIDI.test(cwd)
}

function directoryAncestors(segments) {
  const directories = [{ relative: '', depth: 0 }]
  for (let length = 1; length < segments.length && directories.length < MAX_DIRECTORY_DEPTH; length++) {
    directories.push({ relative: segments.slice(0, length).join('/'), depth: length })
  }
  return directories
}

function escapePromptVariableSyntax(text) {
  return text
    .replace(/\{+/gu, run => run.length > 1 ? '\uFF5B'.repeat(run.length) : run)
    .replace(/\}+/gu, run => run.length > 1 ? '\uFF5D'.repeat(run.length) : run)
}

function getAgentState(states, agent) {
  let state = states.get(agent)
  if (!state) {
    state = { generation: 0, generationController: new AbortController(), directories: new Map() }
    states.set(agent, state)
  }
  return state
}

function isContained(fs, rootTarget, target) {
  try {
    return fs.contains(rootTarget, target) === true
  } catch {
    return false
  }
}

function createDirectoryReservation(directoryKey) {
  let resolveSettled
  let settled = false
  return {
    directoryKey,
    settled: new Promise(resolve => { resolveSettled = resolve }),
    settle(result) {
      if (settled) return
      settled = true
      resolveSettled(result)
    },
  }
}

function releaseDirectoryReservation(state, reservation) {
  if (state.directories.get(reservation.directoryKey) === reservation) {
    state.directories.delete(reservation.directoryKey)
  }
  reservation.settle(DIRECTORY_RELEASED)
}

function resetDirectoryReservations(state) {
  // Clear/compact invalidates pending work and must wake waiters before dropping the map.
  for (const reservation of state.directories.values()) {
    if (reservation !== DEDUPED) reservation.settle(DIRECTORY_RELEASED)
  }
  state.directories.clear()
}

function advanceDirectoryGeneration(state) {
  const previousController = state.generationController
  state.generation += 1
  state.generationController = new AbortController()
  previousController.abort()
  resetDirectoryReservations(state)
}

function trackActiveRead(activeReads, agent, state) {
  const id = agent.id
  let entry = activeReads.get(id)
  if (entry && (entry.agent !== agent || entry.state !== state)) {
    advanceDirectoryGeneration(entry.state)
    if (activeReads.get(id) === entry) activeReads.delete(id)
    entry = undefined
  }
  if (!entry) {
    entry = { agent, state, readers: 0 }
    activeReads.set(id, entry)
  }
  entry.readers += 1

  let released = false
  return () => {
    if (released) return
    released = true
    entry.readers = Math.max(0, entry.readers - 1)
    if (entry.readers === 0 && activeReads.get(id) === entry) activeReads.delete(id)
  }
}

async function statTarget(fs, target, signal) {
  return awaitWithSignal(() => fs.stat(target, signal), signal)
}

async function resolveTarget(fs, relativePath, cwd, signal) {
  return awaitWithSignal(() => fs.resolve(relativePath, { cwd, signal }), signal)
}

async function readDirectoryContextFile(
  fs, cwd, rootTarget, readTargetKey, directory, state, generation, signal, aggregateBytes, contextFile,
  localDirectories, retriesRemaining = MAX_PENDING_DIRECTORY_RETRIES,
) {
  assertNotAborted(signal)
  let directoryTarget
  try {
    if (directory.relative === '') directoryTarget = rootTarget
    else directoryTarget = await resolveTarget(fs, directory.relative, cwd, signal)
    assertNotAborted(signal)
    const directoryKey = safeTargetKey(directoryTarget)
    if (!directoryKey || !isContained(fs, rootTarget, directoryTarget)) return undefined
    const directoryInfo = directory.relative === '' ? { type: 'directory' } : await statTarget(fs, directoryTarget, signal)
    assertNotAborted(signal)
    if (directoryInfo?.type !== 'directory' || state.generation !== generation) return undefined

    const existing = state.directories.get(directoryKey)
    if (existing === DEDUPED) {
      localDirectories.add(directoryKey)
      return undefined
    }
    if (localDirectories.has(directoryKey)) return undefined
    if (existing) {
      // This call's linked signal bounds waiting; release permits one retry, commit dedupes.
      const settled = await awaitWithSignal(() => existing.settled, signal)
      assertNotAborted(signal)
      if (state.generation !== generation || state.directories.get(directoryKey) === DEDUPED
        || settled === DIRECTORY_COMMITTED) return undefined
      if (settled !== DIRECTORY_RELEASED || retriesRemaining <= 0) return undefined
      return readDirectoryContextFile(
        fs, cwd, rootTarget, readTargetKey, directory, state, generation, signal,
        aggregateBytes, contextFile, localDirectories, retriesRemaining - 1,
      )
    }

    while (state.directories.size >= MAX_DEDUPED_DIRECTORIES_PER_AGENT) {
      const oldestDeduped = [...state.directories].find(([, value]) => value === DEDUPED)
      if (!oldestDeduped) return undefined
      state.directories.delete(oldestDeduped[0])
    }

    const reservation = createDirectoryReservation(directoryKey)
    state.directories.set(directoryKey, reservation)
    localDirectories.add(directoryKey)
    try {
      const contextPath = directory.relative ? `${directory.relative}/${contextFile.fileName}` : contextFile.fileName
      const pathInfo = await awaitWithSignal(() => fs.lstat(contextPath, { cwd }, signal), signal)
      assertNotAborted(signal)
      if (pathInfo?.type !== 'file') {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }

      const fileTarget = await resolveTarget(fs, contextPath, cwd, signal)
      assertNotAborted(signal)
      const fileKey = safeTargetKey(fileTarget)
      if (!fileKey || !isContained(fs, rootTarget, fileTarget) || fileKey === readTargetKey) {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }

      const fileInfo = await statTarget(fs, fileTarget, signal)
      assertNotAborted(signal)
      if (fileInfo?.type !== 'file' || !validSize(fileInfo.size, MAX_CONTEXT_FILE_BYTES)) {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }
      const remainingBytes = MAX_TOTAL_SOURCE_BYTES - aggregateBytes
      if (remainingBytes <= 0) {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }
      const readLimit = Math.min(MAX_CONTEXT_FILE_BYTES, remainingBytes)
      const bytes = await awaitWithSignal(() => fs.readBytes(fileTarget, signal, readLimit), signal)
      assertNotAborted(signal)
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > readLimit
        || (fileInfo.size !== undefined && bytes.byteLength !== fileInfo.size)) {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }

      const afterPathInfo = await awaitWithSignal(() => fs.lstat(contextPath, { cwd }, signal), signal)
      assertNotAborted(signal)
      if (afterPathInfo?.type !== 'file') {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }
      const afterTarget = await resolveTarget(fs, contextPath, cwd, signal)
      assertNotAborted(signal)
      const afterKey = safeTargetKey(afterTarget)
      if (!afterKey || afterKey !== fileKey || !isContained(fs, rootTarget, afterTarget)) {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }
      const afterInfo = await statTarget(fs, afterTarget, signal)
      assertNotAborted(signal)
      if (afterInfo?.type !== 'file'
        || (fileInfo.version !== undefined && afterInfo.version !== fileInfo.version)
        || (fileInfo.size !== undefined && afterInfo.size !== fileInfo.size)
        || !validSize(afterInfo.size, MAX_CONTEXT_FILE_BYTES)
        || (afterInfo.size !== undefined && bytes.byteLength !== afterInfo.size)) {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }

      let content
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        releaseDirectoryReservation(state, reservation)
        return undefined
      }
      content = content.replace(CONTROL_OR_BIDI_GLOBAL, '?')
      content = escapePromptVariableSyntax(content)
      const message = createUserMessage({
        source: { kind: 'user' },
        content: [{
          type: 'text',
          text: `[${contextFile.sectionLabel}: ${contextPath}; untrusted repository text, not instructions from the user]\n${content}\n[${contextFile.endLabel}]`,
        }],
      })
      return { message, sourceBytes: bytes.byteLength, reservation }
    } catch (error) {
      releaseDirectoryReservation(state, reservation)
      if (signal.aborted) throw ABORTED
      return undefined
    }
  } catch (error) {
    if (signal.aborted) throw ABORTED
    return undefined
  }
}

function metadataMatches(before, after) {
  return before?.type === after?.type
    && (before?.version === undefined || after?.version === before.version)
    && (before?.size === undefined || after?.size === before.size)
}

async function resolveExplicitProjectReadScope(fs, projectRoot, cwd, segments, cwdTarget, readTarget, signal) {
  assertNotAborted(signal)
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || projectRoot.includes('\\')
    || !validateCwd(cwd) || cwd.includes('\\')) return undefined
  const relativeCwd = path.relative(projectRoot, cwd)
  if (relativeCwd.length > MAX_FILE_PATH_CHARS || (relativeCwd !== ''
    && (path.isAbsolute(relativeCwd) || relativeCwd.split('/').some(segment => !segment || segment === '.' || segment === '..')))) {
    return undefined
  }

  const projectRootPathInfo = await awaitWithSignal(() => fs.lstat(projectRoot, {}, signal), signal)
  assertNotAborted(signal)
  if (projectRootPathInfo?.type !== 'directory') return undefined
  const projectRootTarget = await resolveTarget(fs, projectRoot, undefined, signal)
  assertNotAborted(signal)
  const projectRootKey = safeTargetKey(projectRootTarget)
  const cwdTargetKey = safeTargetKey(cwdTarget)
  const readTargetKey = safeTargetKey(readTarget)
  if (!projectRootKey || !cwdTargetKey || !readTargetKey || !isContained(fs, projectRootTarget, cwdTarget)) return undefined

  const projectRootInfo = await statTarget(fs, projectRootTarget, signal)
  const cwdInfo = await statTarget(fs, cwdTarget, signal)
  assertNotAborted(signal)
  if (projectRootInfo?.type !== 'directory' || cwdInfo?.type !== 'directory'
    || !metadataMatches(projectRootPathInfo, projectRootInfo)) return undefined

  const lexicalCwdTarget = relativeCwd === ''
    ? projectRootTarget
    : await resolveTarget(fs, relativeCwd, projectRoot, signal)
  assertNotAborted(signal)
  if (safeTargetKey(lexicalCwdTarget) !== cwdTargetKey) return undefined

  const rootRelativeReadPath = [...(relativeCwd === '' ? [] : relativeCwd.split('/')), ...segments].join('/')
  const rootReadTarget = await resolveTarget(fs, rootRelativeReadPath, projectRoot, signal)
  assertNotAborted(signal)
  if (safeTargetKey(rootReadTarget) !== readTargetKey || !isContained(fs, projectRootTarget, rootReadTarget)) return undefined

  return {
    projectRootTarget,
    projectRootKey,
    projectRootPathInfo,
    projectRootInfo,
    cwdTargetKey,
    cwdInfo,
    readTargetKey,
    relativeCwd,
  }
}

async function explicitProjectReadScopeStillCurrent(fs, projectRoot, cwd, filePath, segments, previous, signal) {
  try {
    const cwdTarget = await resolveTarget(fs, cwd, cwd, signal)
    assertNotAborted(signal)
    if (safeTargetKey(cwdTarget) !== previous.cwdTargetKey) return false
    const readTarget = await resolveTarget(fs, filePath, cwd, signal)
    assertNotAborted(signal)
    const current = await resolveExplicitProjectReadScope(
      fs, projectRoot, cwd, segments, cwdTarget, readTarget, signal,
    )
    return current !== undefined
      && current.projectRootKey === previous.projectRootKey
      && current.cwdTargetKey === previous.cwdTargetKey
      && current.readTargetKey === previous.readTargetKey
      && current.relativeCwd === previous.relativeCwd
      && metadataMatches(previous.projectRootPathInfo, current.projectRootPathInfo)
      && metadataMatches(previous.projectRootInfo, current.projectRootInfo)
      && metadataMatches(previous.cwdInfo, current.cwdInfo)
  } catch {
    if (signal.aborted) throw ABORTED
    return false
  }
}

async function collectDirectoryContexts({
  fs, cwd, filePath, segments, state, generation, signal, skipRoot, contextFile,
  projectRoot, includeCwd = true, skipProjectRoot = false, skipCwdRootForProject = false,
}) {
  assertNotAborted(signal)
  const cwdRootTarget = await resolveTarget(fs, cwd, cwd, signal)
  assertNotAborted(signal)
  if (!cwdRootTarget || !safeTargetKey(cwdRootTarget)) return { messages: [], reservations: [] }
  const cwdRootInfo = await statTarget(fs, cwdRootTarget, signal)
  assertNotAborted(signal)
  if (cwdRootInfo?.type !== 'directory') return { messages: [], reservations: [] }

  const readTarget = await resolveTarget(fs, filePath, cwd, signal)
  assertNotAborted(signal)
  const readTargetKey = safeTargetKey(readTarget)
  if (!readTargetKey || !isContained(fs, cwdRootTarget, readTarget)) return { messages: [], reservations: [] }

  let projectScope
  if (projectRoot !== undefined) {
    try {
      projectScope = await resolveExplicitProjectReadScope(
        fs, projectRoot, cwd, segments, cwdRootTarget, readTarget, signal,
      )
    } catch (error) {
      if (signal.aborted) throw ABORTED
    }
  }

  const roots = []
  if (projectScope) {
    const projectSegments = [
      ...(projectScope.relativeCwd === '' ? [] : projectScope.relativeCwd.split('/')),
      ...segments,
    ]
    roots.push({
      kind: 'project',
      cwd: projectRoot,
      rootTarget: projectScope.projectRootTarget,
      segments: projectSegments,
      relativeCwd: projectScope.relativeCwd,
    })
  }
  if (includeCwd) {
    roots.push({
      kind: 'cwd',
      cwd,
      rootTarget: cwdRootTarget,
      segments,
      skipRoot: skipRoot || (projectScope !== undefined
        && projectScope.projectRootKey === projectScope.cwdTargetKey && skipProjectRoot),
    })
  }

  const messages = []
  const reservations = []
  // Root and CWD walks share one pending read; avoid waiting on our own reservations for overlapping directories.
  const localDirectories = new Set()
  let aggregateBytes = 0
  try {
    for (const root of roots) {
      const messagesBefore = messages.length
      const reservationsBefore = reservations.length
      const bytesBefore = aggregateBytes
      const localDirectoriesBefore = new Set(localDirectories)
      for (const directory of directoryAncestors(root.segments)) {
        if ((root.kind === 'cwd' && root.skipRoot && directory.depth === 0)
          || (root.kind === 'project' && (skipProjectRoot
            || (projectScope !== undefined && projectScope.projectRootKey === projectScope.cwdTargetKey && skipRoot))
            && directory.depth === 0)
          || (root.kind === 'project' && skipCwdRootForProject && directory.relative === root.relativeCwd)) continue
        assertNotAborted(signal)
        if (state.generation !== generation) {
          releaseReservations(state, reservations)
          return { messages: [], reservations: [] }
        }
        const outcome = await readDirectoryContextFile(
          fs, root.cwd, root.rootTarget, readTargetKey, directory, state, generation, signal,
          aggregateBytes, contextFile, localDirectories,
        )
        if (outcome) {
          messages.push(outcome.message)
          reservations.push(outcome.reservation)
          aggregateBytes += outcome.sourceBytes
        }
        if (aggregateBytes >= MAX_TOTAL_SOURCE_BYTES) break
      }
      if (root.kind === 'project' && !await explicitProjectReadScopeStillCurrent(
        fs, projectRoot, cwd, filePath, segments, projectScope, signal,
      )) {
        releaseReservations(state, reservations.slice(reservationsBefore))
        messages.length = messagesBefore
        reservations.length = reservationsBefore
        aggregateBytes = bytesBefore
        localDirectories.clear()
        for (const directoryKey of localDirectoriesBefore) localDirectories.add(directoryKey)
      }
      if (aggregateBytes >= MAX_TOTAL_SOURCE_BYTES) break
    }
    return { messages, reservations }
  } catch (error) {
    releaseReservations(state, reservations)
    throw error
  }
}

function releaseReservations(state, reservations) {
  for (const reservation of reservations) releaseDirectoryReservation(state, reservation)
}

function commitReservations(state, reservations) {
  for (const reservation of reservations) {
    const ownsReservation = state.directories.get(reservation.directoryKey) === reservation
    if (ownsReservation) state.directories.set(reservation.directoryKey, DEDUPED)
    reservation.settle(ownsReservation ? DIRECTORY_COMMITTED : DIRECTORY_RELEASED)
  }
}

function validateOptions(options) {
  if (options === undefined) {
    return {
      skipRoot: false,
      rootSnapshotAvailable: undefined,
      projectRoot: undefined,
      projectRootSnapshotAvailable: undefined,
      includeCwd: true,
    }
  }
  if (!isPlainRecord(options)) throw new TypeError('directory context injection options must be a plain object')
  let skipRootDescriptor
  let rootSnapshotDescriptor
  let projectRootDescriptor
  let projectRootSnapshotDescriptor
  let includeCwdDescriptor
  try {
    skipRootDescriptor = Object.getOwnPropertyDescriptor(options, 'skipRoot')
    rootSnapshotDescriptor = Object.getOwnPropertyDescriptor(options, 'rootSnapshotAvailable')
    projectRootDescriptor = Object.getOwnPropertyDescriptor(options, 'projectRoot')
    projectRootSnapshotDescriptor = Object.getOwnPropertyDescriptor(options, 'projectRootSnapshotAvailable')
    includeCwdDescriptor = Object.getOwnPropertyDescriptor(options, 'includeCwd')
  } catch {
    throw new TypeError('directory context injection options must use data properties')
  }
  const descriptors = [skipRootDescriptor, rootSnapshotDescriptor, projectRootDescriptor,
    projectRootSnapshotDescriptor, includeCwdDescriptor]
  if (descriptors.some(descriptor => descriptor && !Object.hasOwn(descriptor, 'value'))) {
    throw new TypeError('directory context injection options must use data properties')
  }
  const skipRoot = skipRootDescriptor?.value
  if (skipRoot !== undefined && typeof skipRoot !== 'boolean') {
    throw new TypeError('directory context injection skipRoot must be a boolean')
  }
  const rootSnapshotAvailable = rootSnapshotDescriptor?.value
  if (rootSnapshotAvailable !== undefined && typeof rootSnapshotAvailable !== 'function') {
    throw new TypeError('directory context injection rootSnapshotAvailable must be a function')
  }
  const projectRoot = normalizeProjectReadRoot(projectRootDescriptor?.value)
  const projectRootSnapshotAvailable = projectRootSnapshotDescriptor?.value
  if (projectRootSnapshotAvailable !== undefined && typeof projectRootSnapshotAvailable !== 'function') {
    throw new TypeError('directory context injection projectRootSnapshotAvailable must be a function')
  }
  const includeCwd = includeCwdDescriptor?.value
  if (includeCwd !== undefined && typeof includeCwd !== 'boolean') {
    throw new TypeError('directory context injection includeCwd must be a boolean')
  }
  if (includeCwd === false && projectRoot === undefined) {
    throw new TypeError('directory context injection without cwd requires projectRoot')
  }
  return {
    skipRoot: skipRoot === true,
    rootSnapshotAvailable,
    projectRoot,
    projectRootSnapshotAvailable,
    includeCwd: includeCwd !== false,
  }
}

function createDirectoryOnReadContextListener(agents, sessions, fs, options = {}, contextFile) {
  if (!agents || typeof agents.get !== 'function') throw new TypeError('directory context injection requires DSH agents.get')
  if (!sessions || typeof sessions.get !== 'function') throw new TypeError('directory context injection requires DSH sessions.get')
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function'
    || typeof fs.lstat !== 'function' || typeof fs.stat !== 'function' || typeof fs.readBytes !== 'function') {
    throw new TypeError('directory context injection requires DSH fs.resolve, contains, lstat, stat, and readBytes')
  }
  const {
    skipRoot,
    rootSnapshotAvailable,
    projectRoot,
    projectRootSnapshotAvailable,
    includeCwd,
  } = validateOptions(options)
  const states = new WeakMap()
  const activeReads = new Map()
  const lifecycle = new AbortController()
  let disposed = false

  const onAgentCreated = ({ agent, source } = {}) => {
    if (disposed || (source !== 'clear' && source !== 'compact') || !isObject(agent)) return
    let id
    try {
      id = agent.id
    } catch {
      return
    }
    if (typeof id !== 'string' || id.length === 0) return
    let liveAgent
    try {
      liveAgent = agents.get(id)
      if (!isObject(liveAgent) || liveAgent.id !== id) return
    } catch {
      return
    }
    const active = activeReads.get(id)
    if (active && active.agent !== liveAgent) {
      advanceDirectoryGeneration(active.state)
      if (activeReads.get(id) === active) activeReads.delete(id)
    }
    const state = states.get(liveAgent)
    if (!state) return
    advanceDirectoryGeneration(state)
  }

  const onAgentDisposed = ({ agent } = {}) => {
    if (disposed || !isObject(agent)) return
    let id
    try {
      id = agent.id
    } catch {
      return
    }
    if (typeof id !== 'string' || id.length === 0) return
    const active = activeReads.get(id)
    if (!active || active.agent !== agent) return
    advanceDirectoryGeneration(active.state)
    if (activeReads.get(id) === active) activeReads.delete(id)
  }

  const listener = async (exec, result, next) => {
    // This is a waterfall participant, not an observer: always pass through exactly once first.
    const decision = await next()
    if (disposed || exec?.name !== READ_TOOL_NAME || result?.isError !== false || decision?.kind !== 'accept') return decision
    const projection = exec?.agent
    if (!isObject(projection) || typeof projection.id !== 'string' || projection.id.length === 0
      || !validSignal(exec.signal) || exec.signal.aborted) return decision

    let liveAgent
    let session
    try {
      liveAgent = agents.get(projection.id)
      if (!isObject(liveAgent) || liveAgent.id !== projection.id) return decision
      session = sessions.get(liveAgent.id)
    } catch {
      return decision
    }
    const cwd = session?.header?.cwd
    if (session?.header?.id !== liveAgent.id || !validateCwd(cwd)) return decision
    let cwdSnapshotForAgent = false
    if (rootSnapshotAvailable) {
      try {
        cwdSnapshotForAgent = rootSnapshotAvailable(liveAgent) === true
      } catch {
        cwdSnapshotForAgent = false
      }
    }
    const skipRootForAgent = skipRoot && rootSnapshotAvailable ? cwdSnapshotForAgent : skipRoot
    let projectRootSnapshotForAgent = false
    if (projectRootSnapshotAvailable) {
      try {
        projectRootSnapshotForAgent = projectRootSnapshotAvailable(liveAgent) === true
      } catch {
        projectRootSnapshotForAgent = false
      }
    }
    const validatedPath = validateReadPath(exec.arguments, cwd)
    if (!validatedPath) return decision
    const projectRootForRead = projectRoot !== undefined && exec.parent === undefined ? projectRoot : undefined
    if (!includeCwd && projectRootForRead === undefined) return decision

    const state = getAgentState(states, liveAgent)
    const generation = state.generation
    let deadline
    let linked
    let releaseActiveRead
    try {
      deadline = createDeadline(READ_PIPELINE_TIMEOUT_MS)
      linked = linkSignals([exec.signal, lifecycle.signal, state.generationController.signal, deadline.signal])
      releaseActiveRead = trackActiveRead(activeReads, liveAgent, state)
    } catch {
      linked?.dispose()
      releaseActiveRead?.()
      deadline?.dispose()
      return decision
    }

    let outcome
    try {
      outcome = await collectDirectoryContexts({
        fs,
        cwd,
        ...validatedPath,
        state,
        generation,
        signal: linked.signal,
        skipRoot: skipRootForAgent,
        contextFile,
        projectRoot: projectRootForRead,
        includeCwd,
        skipProjectRoot: projectRootSnapshotForAgent,
        skipCwdRootForProject: cwdSnapshotForAgent,
      })
    } catch {
      outcome = { messages: [], reservations: [] }
    } finally {
      linked.dispose()
      deadline.dispose()
      releaseActiveRead()
    }

    const stillCurrent = !disposed && !linked.signal.aborted && !exec.signal.aborted
      && state.generation === generation && states.get(liveAgent) === state
    try {
      if (!stillCurrent || agents.get(projection.id) !== liveAgent || exec.signal.aborted) {
        releaseReservations(state, outcome.reservations)
        return decision
      }
    } catch {
      releaseReservations(state, outcome.reservations)
      return decision
    }
    if (outcome.messages.length === 0) {
      releaseReservations(state, outcome.reservations)
      return decision
    }

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const enriched = { ...decision, additionalContexts: [...previousContexts, ...outcome.messages] }
    commitReservations(state, outcome.reservations)
    return enriched
  }

  listener.onAgentCreated = onAgentCreated
  listener.onAgentDisposed = onAgentDisposed
  listener.dispose = () => {
    if (disposed) return
    disposed = true
    lifecycle.abort()
    activeReads.clear()
    return undefined
  }
  return listener
}

/** Add bounded root-to-nested README UserMessages to accepted DSH `read` results. */
export function createReadmeOnReadContextListener(agents, sessions, fs, options = {}) {
  return createDirectoryOnReadContextListener(agents, sessions, fs, options, README_CONTEXT_FILE)
}

/** Add bounded root-to-nested AGENTS.md UserMessages to accepted DSH `read` results. */
export function createAgentsOnReadContextListener(agents, sessions, fs, options = {}) {
  return createDirectoryOnReadContextListener(agents, sessions, fs, options, AGENTS_CONTEXT_FILE)
}

function registerDirectoryOnReadContext(ctx, agents, sessions, fs, options, contextFile) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') {
    throw new TypeError('registerDirectoryOnReadContext requires Cordis ctx.on and ctx.effect')
  }
  const listener = createDirectoryOnReadContextListener(agents, sessions, fs, options, contextFile)
  try {
    ctx.on('tools/post-execute', listener)
    ctx.on('agent/created', listener.onAgentCreated)
    ctx.on('agent/disposed', listener.onAgentDisposed)
    ctx.effect(() => listener.dispose, `dsh-omo directory ${contextFile.fileName} post-read context`)
  } catch (error) {
    listener.dispose()
    throw error
  }
  return listener.dispose
}

/** Register the README adapter; clear/compact and same-ID Agent replacement cancel active reads. */
export function registerReadmeOnReadContext(ctx, agents, sessions, fs, options = {}) {
  return registerDirectoryOnReadContext(ctx, agents, sessions, fs, options, README_CONTEXT_FILE)
}

/** Register the AGENTS.md adapter; clear/compact and same-ID Agent replacement cancel active reads. */
export function registerAgentsOnReadContext(ctx, agents, sessions, fs, options = {}) {
  return registerDirectoryOnReadContext(ctx, agents, sessions, fs, options, AGENTS_CONTEXT_FILE)
}
