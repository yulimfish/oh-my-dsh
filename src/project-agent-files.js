import { isAbsolute } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'

export const PROJECT_AGENT_FILE_NAME = /^[a-z][a-z0-9-]{0,63}$/u

const MAX_CWD_CHARS = 4_096
const MAX_TARGET_KEY_CHARS = 4_096
const MAX_AGENT_FILE_BYTES = 16_384
const MAX_LIST_SOURCE_BYTES = 131_072
const MAX_LIST_DIRECTORY_ENTRIES = 256
const MAX_PROJECT_AGENTS = 32
const PROJECT_AGENT_READ_TIMEOUT_MS = 5_000
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/u
const CONTROL_OR_BIDI_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/gu
const ABORTED = Symbol('project agent file operation cancelled')
const ALLOWED_FRONTMATTER_FIELDS = new Set(['name', 'description'])
const ALLOWED_SCALAR_STYLES = new Set(['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'])

class ProjectAgentFileError extends Error {
  constructor(message, kind = 'invalid') {
    super(message)
    this.name = 'ProjectAgentFileError'
    this.kind = kind
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object'
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
    if (!signal) continue
    if (!validSignal(signal)) throw new TypeError('Project agent file operation received an invalid cancellation signal.')
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

function createDeadline(milliseconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), milliseconds)
  return { signal: controller.signal, dispose() { clearTimeout(timer) } }
}

function escapePromptVariableSyntax(text) {
  return text
    .replace(/\{+/gu, run => run.length > 1 ? '\uFF5B'.repeat(run.length) : run)
    .replace(/\}+/gu, run => run.length > 1 ? '\uFF5D'.repeat(run.length) : run)
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

function safeAgentDescription(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 512 || new TextEncoder().encode(value).byteLength > 512
    || /[\r\n\u2028\u2029]/u.test(value) || CONTROL_OR_BIDI.test(value)) return undefined
  const description = value.trim()
  return description || undefined
}

function parseAgentDocument(bytes, fileName) {
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    throw new ProjectAgentFileError('Project agent file is not valid UTF-8.')
  }
  const normalized = source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') throw new ProjectAgentFileError('Project agent file must begin with YAML frontmatter.')
  const closing = lines.indexOf('---', 1)
  if (closing < 0) throw new ProjectAgentFileError('Project agent YAML frontmatter is not closed.')

  let document
  try {
    document = parseDocument(lines.slice(1, closing).join('\n'), { schema: 'core', uniqueKeys: true })
  } catch {
    throw new ProjectAgentFileError('Project agent YAML frontmatter is invalid.')
  }
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    throw new ProjectAgentFileError('Project agent YAML frontmatter is invalid or unsupported.')
  }

  const frontmatter = Object.create(null)
  for (const pair of document.contents.items) {
    const keyNode = pair?.key
    const valueNode = pair?.value
    if (!isScalar(keyNode) || !ALLOWED_SCALAR_STYLES.has(keyNode.type)
      || typeof keyNode.value !== 'string' || keyNode.tag !== undefined || keyNode.anchor !== undefined) {
      throw new ProjectAgentFileError('Project agent YAML keys must be plain scalar strings.')
    }
    const key = keyNode.value
    if (!ALLOWED_FRONTMATTER_FIELDS.has(key)) {
      throw new ProjectAgentFileError('Unsupported project agent frontmatter field.')
    }
    if (Object.hasOwn(frontmatter, key)) throw new ProjectAgentFileError('Project agent YAML frontmatter contains duplicate fields.')
    if (!isScalar(valueNode) || !ALLOWED_SCALAR_STYLES.has(valueNode.type)
      || typeof valueNode.value !== 'string' || valueNode.tag !== undefined || valueNode.anchor !== undefined) {
      throw new ProjectAgentFileError('Project agent frontmatter values must be single-line scalar strings.')
    }
    frontmatter[key] = valueNode.value
  }

  const name = frontmatter.name
  if (typeof name !== 'string' || !PROJECT_AGENT_FILE_NAME.test(name) || name !== fileName) {
    throw new ProjectAgentFileError('Project agent frontmatter name must match its safe filename stem.')
  }
  const description = safeAgentDescription(frontmatter.description)
  if (frontmatter.description !== undefined && description === undefined) {
    throw new ProjectAgentFileError('Project agent description must be a safe single-line string of at most 512 UTF-8 bytes.')
  }

  const body = lines.slice(closing + 1).join('\n').replace(/^\n/u, '')
  if (!body.trim() || CONTROL_OR_BIDI.test(body) || new TextEncoder().encode(body).byteLength > MAX_AGENT_FILE_BYTES) {
    throw new ProjectAgentFileError('Project agent body is empty, unsafe, or too large.')
  }
  return Object.freeze({
    agentFile: fileName,
    name,
    ...(description !== undefined ? { description } : {}),
    prompt: escapePromptVariableSyntax(body),
  })
}

function activeCwd(agents, sessions, exec) {
  const agent = exec?.agent
  const id = agent?.id
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CWD_CHARS) {
    throw new ProjectAgentFileError('Project agent files require a live Agent session with a working directory.')
  }
  let liveAgent
  let session
  try {
    liveAgent = agents.get(id)
    session = sessions.get(id)
  } catch {
    throw new ProjectAgentFileError('Project agent files require a live Agent session with a working directory.')
  }
  const cwd = session?.header?.cwd
  if (liveAgent !== agent || session?.header?.id !== id || typeof cwd !== 'string'
    || cwd.length === 0 || cwd.length > MAX_CWD_CHARS || !isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd)) {
    throw new ProjectAgentFileError('Project agent files require a live Agent session with an absolute working directory.')
  }
  return cwd
}

async function safeStat(fs, target, signal) {
  return awaitWithSignal(() => fs.stat(target, signal), signal)
}

async function resolveDirectory(fs, relativePath, cwd, parentTarget, signal) {
  const pathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd }, signal), signal)
  assertNotAborted(signal)
  if (pathInfo === undefined) return undefined
  if (pathInfo?.type !== 'directory') throw new ProjectAgentFileError('Project agent directory is not a real directory.')
  const target = await awaitWithSignal(() => fs.resolve(relativePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (!targetKey(target) || !contained(fs, parentTarget, target)) {
    throw new ProjectAgentFileError('Project agent directory is outside the active session working directory.')
  }
  const info = await safeStat(fs, target, signal)
  assertNotAborted(signal)
  if (info?.type !== 'directory') throw new ProjectAgentFileError('Project agent directory changed during inspection.')
  return { target, info }
}

async function resolveScope(fs, cwd, signal) {
  const rootTarget = await awaitWithSignal(() => fs.resolve(cwd, { signal }), signal)
  assertNotAborted(signal)
  if (!targetKey(rootTarget)) throw new ProjectAgentFileError('Active session working directory could not be resolved safely.')
  const rootInfo = await safeStat(fs, rootTarget, signal)
  assertNotAborted(signal)
  if (rootInfo?.type !== 'directory') throw new ProjectAgentFileError('Active session working directory is not a directory.')
  const claude = await resolveDirectory(fs, '.claude', cwd, rootTarget, signal)
  if (!claude) return { rootTarget, claudeTarget: undefined, claudeInfo: undefined, agentsTarget: undefined, agentsInfo: undefined }
  const agents = await resolveDirectory(fs, '.claude/agents', cwd, claude.target, signal)
  return {
    rootTarget,
    claudeTarget: claude.target,
    claudeInfo: claude.info,
    agentsTarget: agents?.target,
    agentsInfo: agents?.info,
  }
}

function sameDirectory(beforeTarget, beforeInfo, afterTarget, afterInfo) {
  return targetKey(afterTarget) === targetKey(beforeTarget)
    && (beforeInfo?.version === undefined || afterInfo?.version === beforeInfo.version)
}

async function scopeStillMatches(fs, cwd, before, signal) {
  const after = await resolveScope(fs, cwd, signal)
  return targetKey(after.rootTarget) === targetKey(before.rootTarget)
    && sameDirectory(before.claudeTarget, before.claudeInfo, after.claudeTarget, after.claudeInfo)
    && sameDirectory(before.agentsTarget, before.agentsInfo, after.agentsTarget, after.agentsInfo)
}

function agentFilename(entry) {
  if (!isObject(entry) || typeof entry.name !== 'string' || entry.name.length > 68
    || entry.type !== 'file' || !entry.name.endsWith('.md')) return undefined
  const stem = entry.name.slice(0, -3)
  return PROJECT_AGENT_FILE_NAME.test(stem) ? stem : undefined
}

async function readListedAgent(fs, cwd, scope, entry, stem, signal, maxBytes = MAX_AGENT_FILE_BYTES, onBytesRead) {
  const relativePath = `.claude/agents/${stem}.md`
  const listedKey = targetKey(entry?.target)
  if (!listedKey || entry?.name !== `${stem}.md` || entry?.type !== 'file') {
    throw new ProjectAgentFileError('Project agent file is not a direct listed file.')
  }
  const pathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd }, signal), signal)
  assertNotAborted(signal)
  if (pathInfo?.type !== 'file') throw new ProjectAgentFileError('Project agent file is not a regular in-directory file.')
  const fileTarget = await awaitWithSignal(() => fs.resolve(relativePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (!targetKey(fileTarget) || targetKey(fileTarget) !== listedKey
    || !contained(fs, scope.rootTarget, fileTarget) || !contained(fs, scope.agentsTarget, fileTarget)) {
    throw new ProjectAgentFileError('Project agent file is outside the active session working directory.')
  }
  const beforeInfo = await safeStat(fs, fileTarget, signal)
  assertNotAborted(signal)
  if (beforeInfo?.type !== 'file' || !safeSize(beforeInfo, maxBytes)) {
    throw new ProjectAgentFileError('Project agent file exceeds the supported size limit.', 'too-large')
  }

  let bytes
  try {
    bytes = await awaitWithSignal(() => fs.readBytes(fileTarget, signal, maxBytes), signal)
  } catch (error) {
    if (signal.aborted || error === ABORTED) throw ABORTED
    if (error?.code === 'FS_TOO_LARGE') throw new ProjectAgentFileError('Project agent file exceeds the supported size limit.', 'too-large')
    throw new ProjectAgentFileError('Project agent file could not be read safely.', 'unavailable')
  }
  assertNotAborted(signal)
  if (bytes instanceof Uint8Array) onBytesRead?.(bytes.byteLength)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes
    || (beforeInfo.size !== undefined && bytes.byteLength !== beforeInfo.size)) {
    throw new ProjectAgentFileError('Project agent file changed or exceeded the supported size limit.', 'unavailable')
  }

  const afterPathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd }, signal), signal)
  assertNotAborted(signal)
  if (afterPathInfo?.type !== 'file') throw new ProjectAgentFileError('Project agent file changed during inspection.')
  const afterTarget = await awaitWithSignal(() => fs.resolve(relativePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (targetKey(afterTarget) !== targetKey(fileTarget)
    || !contained(fs, scope.rootTarget, afterTarget) || !contained(fs, scope.agentsTarget, afterTarget)) {
    throw new ProjectAgentFileError('Project agent file identity changed during inspection.')
  }
  const afterInfo = await safeStat(fs, afterTarget, signal)
  assertNotAborted(signal)
  if (!sameFileVersion(beforeInfo, afterInfo, bytes)) {
    throw new ProjectAgentFileError('Project agent file changed during inspection.')
  }
  return { agent: parseAgentDocument(bytes, stem), byteLength: bytes.byteLength }
}

function operationSignal(execSignal, lifecycleSignal) {
  const deadline = createDeadline(PROJECT_AGENT_READ_TIMEOUT_MS)
  let linked
  try {
    linked = linkSignals([execSignal, lifecycleSignal, deadline.signal])
  } catch (error) {
    deadline.dispose()
    throw error
  }
  return {
    signal: linked.signal,
    dispose() {
      deadline.dispose()
      linked.dispose()
    },
  }
}

export function createProjectAgentFilesAdapter({ agents, sessions, fs, lifecycleSignal, excludedNames = [] }) {
  if (!agents || typeof agents.get !== 'function' || !sessions || typeof sessions.get !== 'function') {
    throw new TypeError('Project agent files require DSH agents.get and sessions.get.')
  }
  if (!Array.isArray(excludedNames) || excludedNames.some(name => typeof name !== 'string')) {
    throw new TypeError('Project agent files require an array of excluded specialist names.')
  }
  const excludedNameSet = new Set(excludedNames)
  for (const method of ['resolve', 'contains', 'lstat', 'stat', 'listDir', 'readBytes']) {
    if (!fs || typeof fs[method] !== 'function') throw new TypeError(`Project agent files require DSH fs.${method}.`)
  }

  async function scan(exec, selectedFile) {
    const cwd = activeCwd(agents, sessions, exec)
    const operation = selectedFile === undefined ? 'listing' : 'load'
    const linked = operationSignal(exec?.signal, lifecycleSignal)
    try {
      const { signal } = linked
      const scope = await resolveScope(fs, cwd, signal)
      assertNotAborted(signal)
      if (!scope.agentsTarget) return { agents: [], truncated: false, cwd, selectedAgent: undefined }
      const listing = await awaitWithSignal(() => fs.listDir(scope.agentsTarget, signal), signal)
      assertNotAborted(signal)
      if (!Array.isArray(listing)) throw new ProjectAgentFileError('Project agent directory listing is unavailable.')
      let truncated = listing.length > MAX_LIST_DIRECTORY_ENTRIES
      const entries = listing.slice(0, MAX_LIST_DIRECTORY_ENTRIES).sort((left, right) => {
        const a = typeof left?.name === 'string' ? left.name : ''
        const b = typeof right?.name === 'string' ? right.name : ''
        return a < b ? -1 : a > b ? 1 : 0
      })
      const seen = new Set()
      const agentsFound = []
      let selectedAgent
      let totalBytes = 0
      for (const entry of entries) {
        assertNotAborted(signal)
        const stem = agentFilename(entry)
        if (!stem || excludedNameSet.has(stem)) continue
        if (seen.has(stem)) throw new ProjectAgentFileError('Project agent directory contains duplicate file entries.')
        seen.add(stem)
        if (agentsFound.length >= MAX_PROJECT_AGENTS) {
          truncated = true
          break
        }
        const remaining = MAX_LIST_SOURCE_BYTES - totalBytes
        if (remaining <= 0) {
          truncated = true
          break
        }
        try {
          const read = await readListedAgent(
            fs, cwd, scope, entry, stem, signal, Math.min(MAX_AGENT_FILE_BYTES, remaining),
            byteLength => { totalBytes += byteLength },
          )
          if (stem === selectedFile) selectedAgent = read.agent
          agentsFound.push({
            agentFile: read.agent.agentFile,
            name: read.agent.name,
            ...(read.agent.description !== undefined ? { description: read.agent.description } : {}),
          })
        } catch (error) {
          if (signal.aborted || error === ABORTED) throw ABORTED
          if (stem === selectedFile) throw error
          if (error instanceof ProjectAgentFileError && error.kind === 'too-large'
            && totalBytes + Math.min(MAX_AGENT_FILE_BYTES, remaining) >= MAX_LIST_SOURCE_BYTES) {
            truncated = true
            break
          }
          // Invalid, unsupported, oversized, or unreadable files do not enter the safe roster.
        }
      }
      assertNotAborted(signal)
      if (!await scopeStillMatches(fs, cwd, scope, signal)) {
        throw new ProjectAgentFileError('Project agent directory changed during inspection.')
      }
      return { agents: agentsFound, truncated, cwd, selectedAgent }
    } catch (error) {
      if (error === ABORTED || linked.signal.aborted) {
        throw new ProjectAgentFileError(`Project agent ${operation} was cancelled or exceeded its time limit.`, 'aborted')
      }
      if (error instanceof ProjectAgentFileError) throw error
      throw new ProjectAgentFileError(`Project agent ${operation} could not be completed safely.`, 'unavailable')
    } finally {
      linked.dispose()
    }
  }

  async function list(exec) {
    const scanned = await scan(exec)
    return { agents: scanned.agents, truncated: scanned.truncated }
  }

  async function load(exec, fileName) {
    if (typeof fileName !== 'string' || !PROJECT_AGENT_FILE_NAME.test(fileName)) {
      throw new ProjectAgentFileError('agentFile must be a safe project agent filename stem.')
    }
    const scanned = await scan(exec, fileName)
    if (!scanned.selectedAgent || !scanned.agents.some(agent => agent.agentFile === fileName)) {
      throw new ProjectAgentFileError(`Project agent "${fileName}" is unavailable in the safe current-session roster.`, 'unavailable')
    }
    if (activeCwd(agents, sessions, exec) !== scanned.cwd) {
      throw new ProjectAgentFileError('Project agent session cwd changed during inspection.', 'unavailable')
    }
    return scanned.selectedAgent
  }

  return Object.freeze({ list, load })
}
