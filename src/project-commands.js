import { basename, isAbsolute, join, normalize, parse as parsePath, relative, sep } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'

export const PROJECT_COMMAND_DIRECTORY = '.opencode/commands'
export const PROJECT_COMMAND_DIRECTORIES = Object.freeze([PROJECT_COMMAND_DIRECTORY, '.opencode/command', '.claude/commands'])
export const PROJECT_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

export const MAX_USER_OPENCODE_COMMAND_ROOTS = 2
export const MAX_USER_CLAUDE_COMMAND_ROOTS = 1
export const MAX_USER_AGENTS_COMMAND_ROOTS = 2

const TRAILING_PATH_SEPARATORS = sep === '\\' ? /[\\/]+$/u : /\/+$/u

function normalizeUserCommandRoots(value, { field, maxRoots, allowedBasenames, provider }) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new TypeError(`dsh-omo: ${field} must be an array of absolute ${provider} command directories`)
  if (value.length > maxRoots) {
    throw new TypeError(`dsh-omo: ${field} may contain at most ${maxRoots} roots`)
  }
  const roots = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const inputRoot = value[index]
    const root = typeof inputRoot === 'string' ? inputRoot.replace(TRAILING_PATH_SEPARATORS, '') || inputRoot : inputRoot
    if (typeof inputRoot !== 'string' || !inputRoot || inputRoot.trim() !== inputRoot || inputRoot.length > 4_096
      || !isAbsolute(root) || normalize(root) !== root
      || !allowedBasenames.includes(basename(root))
      || CONTROL_OR_BIDI.test(inputRoot)) {
      const allowed = allowedBasenames.length === 1 ? allowedBasenames[0] : allowedBasenames.join(' or ')
      throw new TypeError(`dsh-omo: ${field}[${index}] must be a normalized absolute ${provider} command directory named ${allowed}`)
    }
    if (seen.has(root)) throw new TypeError(`dsh-omo: ${field} must not contain duplicates`)
    seen.add(root)
    roots.push(root)
  }
  return Object.freeze(roots)
}

export function normalizeUserOpenCodeCommandRoots(value) {
  return normalizeUserCommandRoots(value, {
    field: 'userOpenCodeCommandRoots',
    maxRoots: MAX_USER_OPENCODE_COMMAND_ROOTS,
    allowedBasenames: ['command', 'commands'],
    provider: 'OpenCode',
  })
}

export function normalizeUserClaudeCommandRoots(value) {
  return normalizeUserCommandRoots(value, {
    field: 'userClaudeCommandRoots',
    maxRoots: MAX_USER_CLAUDE_COMMAND_ROOTS,
    allowedBasenames: ['commands'],
    provider: 'Claude',
  })
}

export function normalizeUserAgentsCommandRoots(value) {
  return normalizeUserCommandRoots(value, {
    field: 'userAgentsCommandRoots',
    maxRoots: MAX_USER_AGENTS_COMMAND_ROOTS,
    allowedBasenames: ['skills'],
    provider: 'Agents',
  })
}

export function normalizeProjectCommandsRoot(value) {
  if (value === undefined || value === '') return undefined
  const root = typeof value === 'string' ? value.replace(TRAILING_PATH_SEPARATORS, '') || value : value
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 4_096
    || !isAbsolute(root) || normalize(root) !== root || root === parsePath(root).root || CONTROL_OR_BIDI.test(value)) {
    throw new TypeError('dsh-omo: projectCommandsRoot must be one normalized absolute non-filesystem-root path')
  }
  return root
}

const MAX_CWD_CHARS = 4_096
const MAX_COMMAND_NAME_CHARS = 64
const MAX_TARGET_KEY_CHARS = 4_096
const MAX_DIRECTORY_ENTRIES = 128
const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_READ_BYTES = 256 * 1024
const MAX_DESCRIPTION_CHARS = 1_000
const MAX_ARGUMENT_HINT_CHARS = 160
const MAX_ARGUMENT_BYTES = 16 * 1024
const MAX_RENDERED_BYTES = 128 * 1024
const ARGUMENTS_TOKEN = '$ARGUMENTS'
const COMMAND_INSTRUCTION_PREFIX = '<command-instruction>\n'
const COMMAND_USER_REQUEST_SEPARATOR = '\n</command-instruction>\n\n<user-request>\n'
const COMMAND_USER_REQUEST_SUFFIX = '\n</user-request>'
const COMMAND_PROMPT_WRAPPER_BYTES = new TextEncoder().encode(
  `${COMMAND_INSTRUCTION_PREFIX}${COMMAND_USER_REQUEST_SEPARATOR}${COMMAND_USER_REQUEST_SUFFIX}`,
).byteLength
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/u
const ABORTED = Symbol('project command operation cancelled')
const FS_BUSY = Symbol('project command filesystem capacity busy')
const FS_BUSY_MESSAGE = 'Project command filesystem capacity is busy (64 unsettled Host calls); retry after one settles.'
const FS_BUSY_ERRORS = new WeakSet()
const MAX_PENDING_FS_CALLS = 64

export function isProjectCommandFsBusy(error) {
  try { return FS_BUSY_ERRORS.has(error) } catch { return false }
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function isProjectCommandName(value) {
  return typeof value === 'string' && value.length <= MAX_COMMAND_NAME_CHARS && PROJECT_COMMAND_NAME.test(value)
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
  if (!signal) return Promise.resolve(pending)
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

function createFilesystemCallGate() {
  let active = 0
  return async (operation, signal) => {
    assertNotAborted(signal)
    if (active >= MAX_PENDING_FS_CALLS) throw FS_BUSY
    active += 1
    let host
    try { host = operation() } catch (error) {
      active -= 1
      throw error
    }
    let leased
    try {
      leased = Promise.resolve(host).then(
        value => { active -= 1; return value },
        error => { active -= 1; throw error },
      )
    } catch (error) {
      active -= 1
      throw error
    }
    // A native Host Promise may already be rejected; observe it immediately
    // before a signal race or Host accessor can detach the local waiter.
    if (host instanceof Promise) {
      try { void Reflect.apply(Promise.prototype.then, host, [undefined, () => {}]) } catch {}
    }
    // Even an already-aborted caller must not abandon the leased Promise's
    // rejection. Cancellation ends this wait, not the underlying Host call.
    void leased.catch(() => {})
    try { return await awaitWithSignal(() => leased, signal) } catch (error) {
      if (signal?.aborted || error === ABORTED) throw ABORTED
      if (error === FS_BUSY) throw FS_BUSY
      throw error
    }
  }
}

function targetKey(target) {
  const key = target?.targetKey
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_TARGET_KEY_CHARS
    && !/[\u0000-\u001f\u007f]/u.test(key)
    ? key
    : undefined
}

function safeContainment(fs, parent, child) {
  try { return fs.contains(parent, child) === true } catch { return false }
}

function safeSize(info, maximum) {
  return info?.size === undefined
    || (Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= maximum)
}

function sameVersion(before, after, bytes) {
  return after?.type === 'file'
    && (before.version === undefined || after.version === before.version)
    && (before.size === undefined || after.size === before.size)
    && (after.size === undefined || (Number.isSafeInteger(after.size) && after.size >= 0 && after.size === bytes.byteLength))
}

function safeAgentCwd(agent, sessions) {
  const id = agent?.id
  if (typeof id !== 'string' || !id || id.length > MAX_CWD_CHARS || CONTROL_OR_BIDI.test(id)) {
    throw new TypeError('Project commands require a valid Agent session id.')
  }
  let session
  try { session = sessions.get(id) } catch {
    throw new TypeError('Project commands require a readable Agent session.')
  }
  const cwd = session?.header?.cwd
  if (session?.header?.id !== id || typeof cwd !== 'string' || cwd.length === 0
    || cwd.length > MAX_CWD_CHARS || !isAbsolute(cwd) || CONTROL_OR_BIDI.test(cwd)) {
    throw new TypeError('Project commands require an absolute CWD from the Agent session header.')
  }
  return cwd
}

async function resolveTarget(fs, path, cwd, signal) {
  return awaitWithSignal(() => fs.resolve(path, { cwd, signal }), signal)
}

async function safeStat(fs, target, signal) {
  return awaitWithSignal(() => fs.stat(target, signal), signal)
}

async function resolveDirectory(fs, relativePath, cwd, rootTarget, signal) {
  const pathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (pathInfo === undefined) return undefined
  if (pathInfo?.type !== 'directory') throw new TypeError(`Project command path ${relativePath} is not a real directory.`)
  const target = await resolveTarget(fs, relativePath, cwd, signal)
  assertNotAborted(signal)
  if (!targetKey(target) || !safeContainment(fs, rootTarget, target)) {
    throw new TypeError(`Project command path ${relativePath} is outside the active Agent CWD.`)
  }
  const info = await safeStat(fs, target, signal)
  assertNotAborted(signal)
  if (info?.type !== 'directory') throw new TypeError(`Project command path ${relativePath} changed during inspection.`)
  return { target, info, boundaryTarget: rootTarget }
}

/** Resolve only an absent conventional project parent for a bounded creation watcher. */
async function resolveMissingProjectParentWatchTarget(fs, relativePath, cwd, rootTarget, signal) {
  let target
  try {
    target = await resolveTarget(fs, relativePath, cwd, signal)
  } catch (error) {
    if (signal?.aborted || error === ABORTED) throw ABORTED
      if (error === FS_BUSY) throw FS_BUSY
    return undefined
  }
  assertNotAborted(signal)
  if (!targetKey(target) || !safeContainment(fs, rootTarget, target)) return undefined

  const pathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (pathInfo === undefined) return target
  if (pathInfo?.type !== 'directory') return undefined

  try {
    const directory = await resolveDirectory(fs, relativePath, cwd, rootTarget, signal)
    return directory?.target ?? target
  } catch (error) {
    if (signal?.aborted || error === ABORTED) throw ABORTED
      if (error === FS_BUSY) throw FS_BUSY
    return undefined
  }
}

async function resolveUserCommandDirectory(fs, absolutePath, cwd, signal, source) {
  const provider = source === 'claude' ? 'Claude' : 'OpenCode'
  const pathInfo = await awaitWithSignal(() => fs.lstat(absolutePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (pathInfo === undefined) return undefined
  if (pathInfo?.type !== 'directory') throw new TypeError(`User ${provider} command path ${absolutePath} is not a real directory.`)
  const target = await resolveTarget(fs, absolutePath, cwd, signal)
  assertNotAborted(signal)
  if (!targetKey(target)) throw new TypeError(`User ${provider} command path ${absolutePath} could not be resolved safely.`)
  const info = await safeStat(fs, target, signal)
  assertNotAborted(signal)
  if (info?.type !== 'directory') throw new TypeError(`User ${provider} command path ${absolutePath} changed during inspection.`)
  return { target, info, path: absolutePath, boundaryTarget: target, source, userRoot: true }
}

/** Resolve only a missing explicitly configured user root for bounded creation observation. */
async function resolveMissingUserCommandRootWatchTarget(fs, absolutePath, cwd, signal, source) {
  let target
  try {
    target = await resolveTarget(fs, absolutePath, cwd, signal)
  } catch (error) {
    if (signal?.aborted || error === ABORTED) throw ABORTED
      if (error === FS_BUSY) throw FS_BUSY
    return undefined
  }
  assertNotAborted(signal)
  if (!targetKey(target)) return undefined

  const pathInfo = await awaitWithSignal(() => fs.lstat(absolutePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (pathInfo === undefined) return target
  if (pathInfo?.type !== 'directory') return undefined

  try {
    const directory = await resolveUserCommandDirectory(fs, absolutePath, cwd, signal, source)
    return directory?.target ?? target
  } catch (error) {
    if (signal?.aborted || error === ABORTED) throw ABORTED
      if (error === FS_BUSY) throw FS_BUSY
    return undefined
  }
}

function metadataMatches(before, after) {
  return Boolean(before && after) && before.type === after.type
    && (before.version === undefined || after.version === before.version)
    && (before.size === undefined || after.size === before.size)
}

/** Use the explicit root only when canonical and lexical checks both confirm the live Agent CWD. */
async function resolveExplicitProjectCommandsRoot(fs, rootPath, cwd, cwdTarget, signal) {
  const pathInfo = await awaitWithSignal(() => fs.lstat(rootPath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (pathInfo?.type !== 'directory') return undefined
  const target = await resolveTarget(fs, rootPath, cwd, signal)
  assertNotAborted(signal)
  const targetIdentity = targetKey(target)
  const cwdKey = targetKey(cwdTarget)
  if (!targetIdentity || !cwdKey || !safeContainment(fs, target, cwdTarget)) return undefined
  const info = await safeStat(fs, target, signal)
  assertNotAborted(signal)
  if (info?.type !== 'directory' || !metadataMatches(pathInfo, info)) return undefined

  const relativeCwd = relative(rootPath, cwd)
  if (relativeCwd === '..' || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) return undefined
  const lexicalCwdTarget = await resolveTarget(fs, relativeCwd || '.', rootPath, signal)
  assertNotAborted(signal)
  if (targetKey(lexicalCwdTarget) !== cwdKey) return undefined
  return { target, pathInfo, info, relativeCwd }
}

function sameProjectCommandsRoot(before, after) {
  return (!before && !after) || (before && after
    && targetKey(before.target) === targetKey(after.target)
    && (before.info?.version === undefined || after.info?.version === before.info.version)
    && (before.pathInfo?.version === undefined || after.pathInfo?.version === before.pathInfo.version)
    && before.relativeCwd === after.relativeCwd)
}

async function resolveScope(fs, cwd, signal, userOpenCodeCommandRoots = [], userClaudeCommandRoots = [], watchMissingProjectParents = false, watchMissingUserRoots = false, projectCommandsRoot, userAgentsCommandRoots = [], nearestProjectOpenCode = false) {
  const rootPathInfo = await awaitWithSignal(() => fs.lstat(cwd, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (rootPathInfo?.type !== 'directory') throw new TypeError('Agent CWD is not a real directory.')
  const rootTarget = await resolveTarget(fs, cwd, cwd, signal)
  assertNotAborted(signal)
  if (!targetKey(rootTarget)) throw new TypeError('Agent CWD could not be resolved safely.')
  const rootInfo = await safeStat(fs, rootTarget, signal)
  assertNotAborted(signal)
  if (rootInfo?.type !== 'directory') throw new TypeError('Agent CWD is not a directory.')
  const directories = []
  const watchDirectories = new Map()
  const addWatchTarget = target => {
    const key = targetKey(target)
    if (key) watchDirectories.set(key, target)
  }
  const addWatchDirectory = directory => addWatchTarget(directory?.target)
  const seenDirectoryKeys = new Set()
  let configuredProjectRoot
  if (projectCommandsRoot) {
    try {
      configuredProjectRoot = await resolveExplicitProjectCommandsRoot(fs, projectCommandsRoot, cwd, rootTarget, signal)
    } catch (error) {
      if (signal?.aborted || error === ABORTED) throw ABORTED
      if (error === FS_BUSY) throw FS_BUSY
    }
    if (configuredProjectRoot) {
      addWatchTarget(configuredProjectRoot.target)
      for (const relativePath of PROJECT_COMMAND_DIRECTORIES) {
        const parentPath = relativePath.slice(0, relativePath.lastIndexOf('/'))
        let parent
        let directory
        try {
          parent = await resolveDirectory(fs, parentPath, projectCommandsRoot, configuredProjectRoot.target, signal)
          if (parent) addWatchDirectory(parent)
          else if (watchMissingProjectParents && (parentPath === '.opencode' || parentPath === '.claude')) {
            const missingParentTarget = await resolveMissingProjectParentWatchTarget(
              fs, parentPath, projectCommandsRoot, configuredProjectRoot.target, signal,
            )
            addWatchTarget(missingParentTarget)
          }
          if (parent) {
            directory = await resolveDirectory(fs, relativePath, projectCommandsRoot, configuredProjectRoot.target, signal)
            if (directory) addWatchDirectory(directory)
            if (directory && !safeContainment(fs, parent.target, directory.target)) {
              throw new TypeError(`Project command directory escaped ${parentPath}.`)
            }
          }
        } catch (error) {
          if (signal?.aborted || error === ABORTED) throw ABORTED
        if (error === FS_BUSY) throw FS_BUSY
          directories.push(undefined)
          continue
        }
        const key = targetKey(directory?.target)
        if (directory && key && seenDirectoryKeys.has(key)) directories.push(undefined)
        else {
          if (key) seenDirectoryKeys.add(key)
          directories.push(directory ? {
            ...directory,
            path: join(projectCommandsRoot, relativePath),
            source: relativePath === '.claude/commands' ? 'claude' : 'opencode',
            userRoot: true,
            boundaryTarget: configuredProjectRoot.target,
          } : undefined)
        }
      }
    }
  }
  for (const relativePath of PROJECT_COMMAND_DIRECTORIES) {
    const parentPath = relativePath.slice(0, relativePath.lastIndexOf('/'))
    const parent = await resolveDirectory(fs, parentPath, cwd, rootTarget, signal)
    if (parent) addWatchDirectory(parent)
    if (!parent) {
      if (watchMissingProjectParents && (parentPath === '.opencode' || parentPath === '.claude')) {
        const missingParentTarget = await resolveMissingProjectParentWatchTarget(fs, parentPath, cwd, rootTarget, signal)
        addWatchTarget(missingParentTarget)
      }
      directories.push(undefined)
      continue
    }
    const directory = await resolveDirectory(fs, relativePath, cwd, rootTarget, signal)
    if (directory) addWatchDirectory(directory)
    if (directory && !safeContainment(fs, parent.target, directory.target)) {
      throw new TypeError(`Project command directory escaped ${parentPath}.`)
    }
    const key = targetKey(directory?.target)
    if (directory && key && seenDirectoryKeys.has(key)) directories.push(undefined)
    else {
      if (key) seenDirectoryKeys.add(key)
      directories.push(directory ? {
        ...directory,
        path: relativePath,
        source: relativePath === '.claude/commands' ? 'claude' : 'opencode',
      } : undefined)
    }
  }
  for (const [roots, source] of [
    [userOpenCodeCommandRoots, 'opencode'],
    [userAgentsCommandRoots, 'opencode'],
    [userClaudeCommandRoots, 'claude'],
  ]) {
    for (const absolutePath of roots) {
      const directory = await resolveUserCommandDirectory(fs, absolutePath, cwd, signal, source)
      if (directory) addWatchDirectory(directory)
      else if (watchMissingUserRoots) {
        const missingRootTarget = await resolveMissingUserCommandRootWatchTarget(fs, absolutePath, cwd, signal, source)
        addWatchTarget(missingRootTarget)
      }
      const key = targetKey(directory?.target)
      if (directory && key && seenDirectoryKeys.has(key)) directories.push(undefined)
      else {
        if (key) seenDirectoryKeys.add(key)
        directories.push(directory)
      }
    }
  }
  const orderedDirectories = nearestProjectOpenCode && configuredProjectRoot
    ? [...directories.slice(3, 5), ...directories.slice(0, 2), directories[2], ...directories.slice(5)]
    : directories
  return {
    rootTarget,
    rootInfo,
    projectCommandsRoot,
    projectRoot: configuredProjectRoot,
    directories: orderedDirectories,
    watchDirectories: [...watchDirectories.values()],
    userOpenCodeCommandRoots,
    userClaudeCommandRoots,
    userAgentsCommandRoots,
    nearestProjectOpenCode,
  }
}

function sameDirectory(before, after) {
  return targetKey(before?.target) === targetKey(after?.target)
    && (before?.info?.version === undefined || after?.info?.version === before.info.version)
}

async function scopeStillMatches(fs, cwd, before, signal) {
  const after = await resolveScope(
    fs,
    cwd,
    signal,
    before.userOpenCodeCommandRoots,
    before.userClaudeCommandRoots,
    false,
    false,
    before.projectCommandsRoot,
    before.userAgentsCommandRoots,
    before.nearestProjectOpenCode,
  )
  return targetKey(after.rootTarget) === targetKey(before.rootTarget)
    && (before.rootInfo.version === undefined || after.rootInfo.version === before.rootInfo.version)
    && sameProjectCommandsRoot(before.projectRoot, after.projectRoot)
    && before.directories.length === after.directories.length
    && before.directories.every((directory, index) => sameDirectory(directory, after.directories[index]))
}

function directMarkdownName(entry, allowContainedSymlinks = false) {
  if (!isObject(entry) || (entry.type !== 'file' && (!allowContainedSymlinks || entry.type !== 'symlink')) || typeof entry.name !== 'string'
    || entry.name.length > MAX_COMMAND_NAME_CHARS + 3 || !entry.name.endsWith('.md')) return undefined
  const name = entry.name.slice(0, -3)
  return isProjectCommandName(name) ? name : undefined
}

function decodeStrictUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    throw new TypeError('Project command file is not valid UTF-8.')
  }
}

/** Parse one exact project command file, allowing only bounded, display-only argument hints. */
export function parseProjectCommandDocument(name, input, source = 'opencode', options = {}) {
  if (!isProjectCommandName(name)) {
    throw new TypeError('Project command name must be a safe flat lowercase ASCII stem (letters, digits, hyphens, underscores; letter first).')
  }
  if (source !== 'opencode' && source !== 'claude') throw new TypeError('Project command source must be opencode or claude.')
  if (options?.allowEmptyDescription !== undefined && typeof options.allowEmptyDescription !== 'boolean') {
    throw new TypeError('Project command allowEmptyDescription must be a boolean.')
  }
  if (options?.allowBlankDisplayMetadata !== undefined && typeof options.allowBlankDisplayMetadata !== 'boolean') {
    throw new TypeError('Project command allowBlankDisplayMetadata must be a boolean.')
  }
  if (options?.allowUnterminatedFrontmatter !== undefined && typeof options.allowUnterminatedFrontmatter !== 'boolean') {
    throw new TypeError('Project command allowUnterminatedFrontmatter must be a boolean.')
  }
  if (options?.allowMalformedFrontmatter !== undefined && typeof options.allowMalformedFrontmatter !== 'boolean') {
    throw new TypeError('Project command allowMalformedFrontmatter must be a boolean.')
  }
  if (options?.allowEmptyBody !== undefined && typeof options.allowEmptyBody !== 'boolean') {
    throw new TypeError('Project command allowEmptyBody must be a boolean.')
  }
  if (options?.preserveBodyLineEndings !== undefined && typeof options.preserveBodyLineEndings !== 'boolean') {
    throw new TypeError('Project command preserveBodyLineEndings must be a boolean.')
  }
  const sourceText = input instanceof Uint8Array ? decodeStrictUtf8(input) : input
  if (typeof sourceText !== 'string') throw new TypeError('Project command source must be UTF-8 text or bytes.')
  if (new TextEncoder().encode(sourceText).byteLength > MAX_FILE_BYTES) {
    throw new TypeError(`Project command file exceeds ${MAX_FILE_BYTES} bytes.`)
  }
  const unprefixed = sourceText.replace(/^\uFEFF/u, '')
  const pinnedFrontmatter = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/u.exec(unprefixed)
  const normalized = unprefixed.replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  const hasFrontmatter = lines[0] === '---'
  const closing = hasFrontmatter ? lines.indexOf('---', 1) : -1
  // Use the pinned match for both recognition and YAML/body extraction: its
  // closing marker may immediately follow the final YAML character.
  const plainFrontmatterFallback = hasFrontmatter && !pinnedFrontmatter && options?.allowUnterminatedFrontmatter === true
  if (hasFrontmatter && closing < 0 && !plainFrontmatterFallback && !pinnedFrontmatter) throw new TypeError('Project command YAML frontmatter has no closing delimiter.')
  const parseFrontmatter = hasFrontmatter && !plainFrontmatterFallback
  let originalBody
  if (parseFrontmatter && !pinnedFrontmatter && closing >= 0) {
    // Map the normalized standalone delimiter back to CR/LF/CRLF source text.
    let offset = 0
    for (let lineIndex = 0; lineIndex <= closing; lineIndex += 1) {
      const newline = unprefixed.indexOf('\n', offset)
      const carriage = unprefixed.indexOf('\r', offset)
      const candidates = [newline, carriage].filter(index => index >= 0)
      const breakIndex = candidates.length > 0 ? Math.min(...candidates) : -1
      if (lineIndex === closing) {
        originalBody = breakIndex < 0 ? '' : unprefixed.slice(breakIndex + (unprefixed[breakIndex] === '\r' && unprefixed[breakIndex + 1] === '\n' ? 2 : 1))
        break
      }
      if (breakIndex < 0) break
      offset = breakIndex + (unprefixed[breakIndex] === '\r' && unprefixed[breakIndex + 1] === '\n' ? 2 : 1)
    }
  }

  let document
  try {
    document = parseDocument(parseFrontmatter
      ? (pinnedFrontmatter ? pinnedFrontmatter[1] : lines.slice(1, closing).join('\n'))
      : '{}', { schema: 'core', uniqueKeys: true })
  } catch {
    throw new TypeError('Project command YAML frontmatter is invalid.')
  }
  const malformedFrontmatter = parseFrontmatter && options?.allowMalformedFrontmatter === true
    && document.errors.length > 0 && document.errors.every(error => error?.code !== 'DUPLICATE_KEY' && error?.code !== 'MULTIPLE_DOCS')
  if (document.warnings.length > 0 || (!malformedFrontmatter && document.errors.length > 0)
    || (!malformedFrontmatter && document.contents !== null && !isMap(document.contents))) {
    throw new TypeError('Project command YAML frontmatter must be a valid mapping.')
  }
  const allowedFrontmatterKeys = new Set(['description', 'argument-hint', 'name'])
  for (const pair of malformedFrontmatter ? [] : document.contents?.items ?? []) {
    if (!isScalar(pair?.key) || !allowedFrontmatterKeys.has(pair.key.value)
      || pair.key.tag !== undefined || pair.key.anchor !== undefined) {
      throw new TypeError('Project command frontmatter permits only description and argument-hint keys.')
    }
  }

  let frontmatter
  try { frontmatter = malformedFrontmatter ? {} : document.toJS({ maxAliasCount: 0 }) ?? {} } catch {
    throw new TypeError('Project command YAML frontmatter cannot be represented safely.')
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)
    || (Object.getPrototypeOf(frontmatter) !== Object.prototype && Object.getPrototypeOf(frontmatter) !== null)) {
    throw new TypeError('Project command YAML frontmatter must be a mapping.')
  }
  if (Object.keys(frontmatter).some(key => !allowedFrontmatterKeys.has(key))) {
    throw new TypeError('Project command frontmatter permits only description and argument-hint keys.')
  }
  const hasDescription = Object.hasOwn(frontmatter, 'description')
  const configuredDescription = hasDescription ? frontmatter.description : undefined
  if (hasDescription && (typeof configuredDescription !== 'string' || configuredDescription.length > MAX_DESCRIPTION_CHARS
    || CONTROL_OR_BIDI.test(configuredDescription))) {
    throw new TypeError(`Project command description must be non-empty and at most ${MAX_DESCRIPTION_CHARS} safe characters.`)
  }
  const blankDescription = typeof configuredDescription === 'string' && configuredDescription.length > 0
    && configuredDescription.trim() === '' && options?.allowBlankDisplayMetadata === true
  const description = !hasDescription || (configuredDescription === '' && options?.allowEmptyDescription === true) || blankDescription
    ? `Project command /${name}` : configuredDescription
  if (typeof description !== 'string' || !description.trim() || description.length > MAX_DESCRIPTION_CHARS
    || CONTROL_OR_BIDI.test(description)) {
    throw new TypeError(`Project command description must be non-empty and at most ${MAX_DESCRIPTION_CHARS} safe characters.`)
  }
  let argumentHint
  if (Object.hasOwn(frontmatter, 'argument-hint')) {
    const candidate = frontmatter['argument-hint']
    if (typeof candidate !== 'string' || (!candidate.trim() && options?.allowBlankDisplayMetadata !== true)
      || candidate.length > MAX_ARGUMENT_HINT_CHARS || /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(candidate)) {
      throw new TypeError(`Project command argument-hint must be one safe line of at most ${MAX_ARGUMENT_HINT_CHARS} characters.`)
    }
    if (candidate.trim()) argumentHint = candidate.trim()
  }

  const body = parseFrontmatter
    ? (pinnedFrontmatter ? pinnedFrontmatter[2] : originalBody ?? lines.slice(closing + 1).join('\n')).replace(/^(?:\r\n|\n|\r)/u, '')
    : unprefixed
  const outputBody = options?.preserveBodyLineEndings === true ? body : body.replace(/\r\n?/gu, '\n')
  const bodyBytes = new TextEncoder().encode(outputBody).byteLength
  if ((!outputBody.trim() && options?.allowEmptyBody !== true) || bodyBytes > MAX_FILE_BYTES || CONTROL_OR_BIDI.test(outputBody)) {
    throw new TypeError(`Project command body must be non-empty, free of control or bidi characters, and at most ${MAX_FILE_BYTES} bytes.`)
  }
  return Object.freeze({ name, description: description.trim(), ...(argumentHint === undefined ? {} : { argumentHint }), body: outputBody })
}

async function readProjectCommand(fs, cwd, scope, directory, entry, name, signal, readBudget, parseOptions, allowContainedSymlinks = false) {
  const relativePath = directory.userRoot ? join(directory.path, `${name}.md`) : `${directory.path}/${name}.md`
  const containmentRoot = directory.boundaryTarget ?? scope.rootTarget
  const listedKey = targetKey(entry?.target)
  if (!listedKey || entry?.name !== `${name}.md`
    || (entry?.type !== 'file' && (!allowContainedSymlinks || entry?.type !== 'symlink'))) return undefined

  const pathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (pathInfo?.type !== 'file' && (!allowContainedSymlinks || pathInfo?.type !== 'symlink')) return undefined
  const target = await resolveTarget(fs, relativePath, cwd, signal)
  assertNotAborted(signal)
  if (!targetKey(target) || targetKey(target) !== listedKey
    || !safeContainment(fs, containmentRoot, target)
    || !safeContainment(fs, directory.target, target)) return undefined
  const beforeInfo = await safeStat(fs, target, signal)
  assertNotAborted(signal)
  const readLimit = Math.min(MAX_FILE_BYTES, readBudget.remaining)
  if (readLimit <= 0 || beforeInfo?.type !== 'file' || !safeSize(beforeInfo, readLimit)) return undefined

  let bytes
  try {
    bytes = await awaitWithSignal(() => fs.readBytes(target, signal, readLimit), signal)
  } catch (error) {
    if (signal?.aborted || error === ABORTED) throw ABORTED
      if (error === FS_BUSY) throw FS_BUSY
    return undefined
  }
  assertNotAborted(signal)
  if (!(bytes instanceof Uint8Array)) return undefined
  readBudget.remaining = Math.max(0, readBudget.remaining - bytes.byteLength)
  if (bytes.byteLength > readLimit || bytes.byteLength > MAX_FILE_BYTES
    || (beforeInfo.size !== undefined && bytes.byteLength !== beforeInfo.size)) return undefined

  const afterPathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd, signal }), signal)
  assertNotAborted(signal)
  if (afterPathInfo?.type !== 'file' && (!allowContainedSymlinks || afterPathInfo?.type !== 'symlink')) return undefined
  const afterTarget = await resolveTarget(fs, relativePath, cwd, signal)
  assertNotAborted(signal)
  if (targetKey(afterTarget) !== targetKey(target)
    || !safeContainment(fs, containmentRoot, afterTarget)
    || !safeContainment(fs, directory.target, afterTarget)) return undefined
  const afterInfo = await safeStat(fs, afterTarget, signal)
  assertNotAborted(signal)
  if (!sameVersion(beforeInfo, afterInfo, bytes)) return undefined
  if (!await scopeStillMatches(fs, cwd, scope, signal)) return undefined
  const commandSource = directory.source ?? (directory.path === '.claude/commands' ? 'claude' : 'opencode')
  try { return parseProjectCommandDocument(name, bytes, commandSource, parseOptions) } catch { return undefined }
}

/**
 * Create a read-only project and explicit user-root command scanner. The caller chooses how to register each definition.
 * options.sessions is the DSH Session service; configured command roots are explicit provider-world absolute paths.
 */
export function createProjectCommandAdapter(fs, options = {}) {
  const sessions = options.sessions
  const userOpenCodeCommandRoots = normalizeUserOpenCodeCommandRoots(options.userOpenCodeCommandRoots)
  const userClaudeCommandRoots = normalizeUserClaudeCommandRoots(options.userClaudeCommandRoots)
  const userAgentsCommandRoots = normalizeUserAgentsCommandRoots(options.userAgentsCommandRoots)
  const projectCommandsRoot = normalizeProjectCommandsRoot(options.projectCommandsRoot)
  const allowEmptyDescription = options.allowEmptyDescription === true
  const allowBlankDisplayMetadata = options.allowBlankDisplayMetadata === true
  const allowUnterminatedFrontmatter = options.allowUnterminatedFrontmatter === true
  const allowMalformedFrontmatter = options.allowMalformedFrontmatter === true
  const allowEmptyBody = options.allowEmptyBody === true
  const preserveBodyLineEndings = options.preserveBodyLineEndings === true
  const nearestProjectOpenCode = options.nearestProjectOpenCode === true
  const allowContainedSymlinks = options.allowContainedSymlinks === true
  const commandFs = fs
  const callFs = createFilesystemCallGate()
  if (!sessions || typeof sessions.get !== 'function') throw new TypeError('Project commands require DSH sessions.get.')
  for (const method of ['resolve', 'contains', 'lstat', 'stat', 'listDir', 'readBytes']) {
    if (!fs || typeof fs[method] !== 'function') throw new TypeError(`Project commands require DSH fs.${method}.`)
  }
  const gatedFs = new Proxy(commandFs, {
    get(target, property) {
      if (property === 'resolve') return (path, options) => callFs(() => commandFs.resolve(path, options), options?.signal)
      if (property === 'lstat') return (path, options, callSignal) => callFs(() => commandFs.lstat(path, options, callSignal ?? options?.signal), callSignal ?? options?.signal)
      if (property === 'stat') return (target, callSignal) => callFs(() => commandFs.stat(target, callSignal), callSignal)
      if (property === 'listDir') return (target, callSignal) => callFs(() => commandFs.listDir(target, callSignal), callSignal)
      if (property === 'readBytes') return (target, callSignal, maxBytes) => callFs(() => commandFs.readBytes(target, callSignal, maxBytes), callSignal)
      const value = Reflect.get(commandFs, property)
      return typeof value === 'function' ? value.bind(commandFs) : value
    },
  })

  async function list(agent, signal) {
    try {
      return await listCommands(agent, signal)
    } catch (error) {
      if (error === FS_BUSY) {
        const busy = new Error(FS_BUSY_MESSAGE)
        FS_BUSY_ERRORS.add(busy)
        throw busy
      }
      throw error
    }
  }

  async function listCommands(agent, signal) {
    if (signal !== undefined && !validSignal(signal)) throw new TypeError('Project command listing requires a valid AbortSignal.')
    assertNotAborted(signal)
    const cwd = safeAgentCwd(agent, sessions)
    const scope = await resolveScope(gatedFs, cwd, signal, userOpenCodeCommandRoots, userClaudeCommandRoots, false, false, projectCommandsRoot, userAgentsCommandRoots, nearestProjectOpenCode)
    assertNotAborted(signal)
    if (!scope.directories.some(Boolean)) return Object.freeze({ commands: Object.freeze([]), truncated: false, skipped: 0 })

    let truncated = false
    let listedEntries = 0
    const candidates = []
    for (let priority = 0; priority < scope.directories.length; priority += 1) {
      const directory = scope.directories[priority]
      if (!directory) continue
      if (listedEntries >= MAX_DIRECTORY_ENTRIES) {
        truncated = true
        break
      }
      const entries = await awaitWithSignal(() => gatedFs.listDir(directory.target, signal), signal)
      assertNotAborted(signal)
      if (!Array.isArray(entries)) throw new TypeError('DSH fs.listDir returned an invalid project command listing.')
      const remaining = MAX_DIRECTORY_ENTRIES - listedEntries
      const boundedEntries = entries.slice(0, remaining)
      listedEntries += boundedEntries.length
      if (entries.length > remaining) truncated = true
      for (const entry of boundedEntries) {
        const name = directMarkdownName(entry, allowContainedSymlinks)
        if (!name) continue
        candidates.push({ directory, entry, name, priority })
      }
      if (truncated) break
    }
    candidates.sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))

    let skipped = 0
    const commands = []
    const seen = new Set()
    const readBudget = { remaining: MAX_TOTAL_READ_BYTES }
    for (let index = 0; index < candidates.length; index += 1) {
      assertNotAborted(signal)
      const { directory, entry, name } = candidates[index]
      if (seen.has(name)) {
        skipped += 1
        continue
      }
      if (readBudget.remaining <= 0) {
        truncated = true
        break
      }
      let command
      try {
        command = await readProjectCommand(gatedFs, cwd, scope, directory, entry, name, signal, readBudget, { allowEmptyDescription, allowBlankDisplayMetadata, allowUnterminatedFrontmatter, allowMalformedFrontmatter, allowEmptyBody, preserveBodyLineEndings }, allowContainedSymlinks)
      } catch (error) {
        if (signal?.aborted || error === ABORTED) throw ABORTED
        if (error === FS_BUSY) throw FS_BUSY
        skipped += 1
        continue
      }
      assertNotAborted(signal)
      if (command) {
        commands.push(command)
        seen.add(name)
      } else skipped += 1
    }
    if (commands.length + skipped < candidates.length && readBudget.remaining <= 0) truncated = true
    if (!await scopeStillMatches(gatedFs, cwd, scope, signal)) {
      return Object.freeze({ commands: Object.freeze([]), truncated: false, skipped: 0 })
    }
    return Object.freeze({ commands: Object.freeze(commands), truncated, skipped })
  }

  async function watchTargets(agent, signal) {
    try {
      return await discoverWatchTargets(agent, signal)
    } catch (error) {
      if (error === FS_BUSY) {
        const busy = new Error(FS_BUSY_MESSAGE)
        FS_BUSY_ERRORS.add(busy)
        throw busy
      }
      throw error
    }
  }

  async function discoverWatchTargets(agent, signal) {
    if (signal !== undefined && !validSignal(signal)) throw new TypeError('Project command watch target discovery requires a valid AbortSignal.')
    assertNotAborted(signal)
    const cwd = safeAgentCwd(agent, sessions)
    const scope = await resolveScope(gatedFs, cwd, signal, userOpenCodeCommandRoots, userClaudeCommandRoots, true, true, projectCommandsRoot, userAgentsCommandRoots, nearestProjectOpenCode)
    assertNotAborted(signal)
    return Object.freeze([...scope.watchDirectories])
  }

  return Object.freeze({ list, watchTargets })
}

function isParsedCommand(value) {
  return isObject(value) && isProjectCommandName(value.name)
    && typeof value.description === 'string' && value.description.trim().length > 0
    && value.description.length <= MAX_DESCRIPTION_CHARS && !CONTROL_OR_BIDI.test(value.description)
    && (value.argumentHint === undefined || (typeof value.argumentHint === 'string' && value.argumentHint.trim().length > 0
      && value.argumentHint.length <= MAX_ARGUMENT_HINT_CHARS
      && !/[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(value.argumentHint)))
    && typeof value.body === 'string'
    && !CONTROL_OR_BIDI.test(value.body)
    && new TextEncoder().encode(value.body).byteLength <= MAX_FILE_BYTES
}

function normalizeRawInput(rawInput) {
  if (rawInput === undefined || rawInput === null) return ''
  if (typeof rawInput !== 'string') throw new TypeError('Project command arguments must be text.')
  const byteLength = new TextEncoder().encode(rawInput).byteLength
  if (byteLength > MAX_ARGUMENT_BYTES) throw new RangeError(`Project command arguments exceed ${MAX_ARGUMENT_BYTES} bytes.`)
  return rawInput
}

function renderCommandBody(body, args) {
  const instruction = body.trim()
  const bodyBytes = new TextEncoder().encode(instruction).byteLength
  const argumentBytes = new TextEncoder().encode(args).byteLength
  const occurrences = instruction.split(ARGUMENTS_TOKEN).length - 1
  const estimatedBytes = bodyBytes
    + occurrences * (argumentBytes - ARGUMENTS_TOKEN.length)
    + argumentBytes
    + COMMAND_PROMPT_WRAPPER_BYTES
  if (estimatedBytes > MAX_RENDERED_BYTES) {
    throw new RangeError(`Rendered project command exceeds ${MAX_RENDERED_BYTES} bytes.`)
  }
  const renderedInstruction = instruction.split(ARGUMENTS_TOKEN).join(args)
  const rendered = `${COMMAND_INSTRUCTION_PREFIX}${renderedInstruction}${COMMAND_USER_REQUEST_SEPARATOR}${args}${COMMAND_USER_REQUEST_SUFFIX}`
  if (new TextEncoder().encode(rendered).byteLength > MAX_RENDERED_BYTES) {
    throw new RangeError(`Rendered project command exceeds ${MAX_RENDERED_BYTES} bytes.`)
  }
  return rendered
}

/** Wrap the instruction and always append the raw invocation in an untrusted request section. */
export function renderProjectCommand(projectCommand, rawInput) {
  if (!isParsedCommand(projectCommand)) {
    throw new TypeError('A parsed project command is required.')
  }
  return renderCommandBody(projectCommand.body, normalizeRawInput(rawInput))
}

export function renderExpandedProjectCommand(sourceCommand, expandedBody, rawInput) {
  if (!isParsedCommand(sourceCommand) || typeof expandedBody !== 'string'
    || CONTROL_OR_BIDI.test(expandedBody)) {
    throw new TypeError('Expanded project command text is invalid.')
  }
  return renderCommandBody(expandedBody, normalizeRawInput(rawInput))
}

/** Build a command definition only; the caller supplies its own explicit registration and queue adapters. */
export function makeProjectCommandDefinition(projectCommand, queue, expandCommand, automatic = false) {
  if (!isParsedCommand(projectCommand)) {
    throw new TypeError('A parsed project command is required.')
  }
  if (typeof queue !== 'function') throw new TypeError('Project command definition requires an explicit queue callback.')
  if (expandCommand !== undefined && typeof expandCommand !== 'function') {
    throw new TypeError('Project command file expansion must be an explicit callback when provided.')
  }
  const queueCommand = (invocation, command, expanded = false) => {
    const agent = invocation?.agent
    if (!agent || typeof agent !== 'object') return { kind: 'error', text: 'Project commands require an active Agent.' }
    if (invocation?.signal?.aborted === true) return { kind: 'error', text: 'Project command invocation was cancelled before it could be queued.' }
    let prompt
    try {
      prompt = expanded
        ? renderExpandedProjectCommand(projectCommand, command?.body, invocation?.rawInput)
        : renderProjectCommand(projectCommand, invocation?.rawInput)
    } catch (error) {
      return {
        kind: 'error',
        text: error instanceof RangeError
          ? error.message
          : error?.message === 'Project command arguments must be text.'
            ? error.message
            : 'Project command could not be rendered safely.',
      }
    }
    try {
      const context = invocation?.signal === undefined ? undefined : { signal: invocation.signal }
      return context === undefined
        ? queue(agent, prompt, projectCommand)
        : queue(agent, prompt, projectCommand, context)
    } catch {
      return { kind: 'error', text: 'Project command could not be queued.' }
    }
  }
  return Object.freeze({
    name: projectCommand.name,
    description: projectCommand.description,
    input: { hint: projectCommand.argumentHint ?? '[arguments]' },
    ...(automatic ? { automatic: true, projectCommand: Object.freeze({ ...projectCommand }) } : {}),
    handler: invocation => {
      if (Array.isArray(invocation?.attachments) && invocation.attachments.length > 0) {
        return { kind: 'error', text: 'Project commands do not support attachments in this adapter; no prompt was queued.' }
      }
      if (!expandCommand) return queueCommand(invocation, projectCommand)
      const agent = invocation?.agent
      if (!agent || typeof agent !== 'object') return { kind: 'error', text: 'Project commands require an active Agent.' }
      if (invocation?.signal?.aborted === true) return { kind: 'error', text: 'Project command invocation was cancelled before it could be queued.' }
      return (async () => {
        let expandedCommand
        try { expandedCommand = await expandCommand(projectCommand, { agent, signal: invocation?.signal }) } catch (error) {
          return {
            kind: 'error',
            text: error instanceof RangeError ? error.message : 'Project command file references could not be expanded safely; no prompt was queued.',
          }
        }
        return queueCommand(invocation, expandedCommand, true)
      })()
    },
  })
}

/** Register parsed command definitions through an explicit caller-owned registration callback. */
export async function registerProjectCommandDefinitions(adapter, agent, registerCommand, queue, signal) {
  if (!adapter || typeof adapter.list !== 'function') throw new TypeError('Project command registration requires an adapter.list function.')
  if (typeof registerCommand !== 'function') throw new TypeError('Project command registration requires an explicit register callback.')
  if (typeof queue !== 'function') throw new TypeError('Project command registration requires an explicit queue callback.')
  const scan = await adapter.list(agent, signal)
  const disposers = []
  try {
    for (const command of scan.commands) {
      const disposer = registerCommand(makeProjectCommandDefinition(command, queue))
      if (typeof disposer !== 'function') throw new TypeError(`Registration for project command ${command.name} did not return a disposer.`)
      disposers.push(disposer)
    }
  } catch (error) {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try { disposers[index]() } catch {}
    }
    throw error
  }
  let disposed = false
  return Object.freeze({
    commands: scan.commands,
    truncated: scan.truncated,
    skipped: scan.skipped,
    dispose() {
      if (disposed) return
      disposed = true
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try { disposers[index]() } catch {}
      }
    },
  })
}
