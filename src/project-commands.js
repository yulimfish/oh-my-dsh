import { isAbsolute } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'

export const PROJECT_COMMAND_DIRECTORY = '.opencode/commands'
export const PROJECT_COMMAND_DIRECTORIES = Object.freeze([PROJECT_COMMAND_DIRECTORY, '.opencode/command', '.claude/commands'])
export const PROJECT_COMMAND_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

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
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/u
const ABORTED = Symbol('project command operation cancelled')

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
  const pathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd }, signal), signal)
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
  return { target, info }
}

async function resolveScope(fs, cwd, signal) {
  const rootPathInfo = await awaitWithSignal(() => fs.lstat(cwd, { cwd }, signal), signal)
  assertNotAborted(signal)
  if (rootPathInfo?.type !== 'directory') throw new TypeError('Agent CWD is not a real directory.')
  const rootTarget = await resolveTarget(fs, cwd, cwd, signal)
  assertNotAborted(signal)
  if (!targetKey(rootTarget)) throw new TypeError('Agent CWD could not be resolved safely.')
  const rootInfo = await safeStat(fs, rootTarget, signal)
  assertNotAborted(signal)
  if (rootInfo?.type !== 'directory') throw new TypeError('Agent CWD is not a directory.')
  const directories = []
  for (const relativePath of PROJECT_COMMAND_DIRECTORIES) {
    const parentPath = relativePath.slice(0, relativePath.lastIndexOf('/'))
    const parent = await resolveDirectory(fs, parentPath, cwd, rootTarget, signal)
    if (!parent) {
      directories.push(undefined)
      continue
    }
    const directory = await resolveDirectory(fs, relativePath, cwd, rootTarget, signal)
    if (directory && !safeContainment(fs, parent.target, directory.target)) {
      throw new TypeError(`Project command directory escaped ${parentPath}.`)
    }
    directories.push(directory ? { ...directory, path: relativePath } : undefined)
  }
  return { rootTarget, rootInfo, directories }
}

function sameDirectory(before, after) {
  return targetKey(before?.target) === targetKey(after?.target)
    && (before?.info?.version === undefined || after?.info?.version === before.info.version)
}

async function scopeStillMatches(fs, cwd, before, signal) {
  const after = await resolveScope(fs, cwd, signal)
  return targetKey(after.rootTarget) === targetKey(before.rootTarget)
    && (before.rootInfo.version === undefined || after.rootInfo.version === before.rootInfo.version)
    && before.directories.length === after.directories.length
    && before.directories.every((directory, index) => sameDirectory(directory, after.directories[index]))
}

function directMarkdownName(entry) {
  if (!isObject(entry) || entry.type !== 'file' || typeof entry.name !== 'string'
    || entry.name.length > MAX_COMMAND_NAME_CHARS + 3 || !entry.name.endsWith('.md')) return undefined
  const name = entry.name.slice(0, -3)
  return isProjectCommandName(name) ? name : undefined
}

function decodeStrictUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    throw new TypeError('Project command file is not valid UTF-8.')
  }
}

/** Parse one exact project command file, allowing only bounded, display-only Claude argument hints. */
export function parseProjectCommandDocument(name, input, source = 'opencode') {
  if (!isProjectCommandName(name)) {
    throw new TypeError('Project command name must be safe kebab-case.')
  }
  if (source !== 'opencode' && source !== 'claude') throw new TypeError('Project command source must be opencode or claude.')
  const sourceText = input instanceof Uint8Array ? decodeStrictUtf8(input) : input
  if (typeof sourceText !== 'string') throw new TypeError('Project command source must be UTF-8 text or bytes.')
  if (new TextEncoder().encode(sourceText).byteLength > MAX_FILE_BYTES) {
    throw new TypeError(`Project command file exceeds ${MAX_FILE_BYTES} bytes.`)
  }
  const normalized = sourceText.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') throw new TypeError('Project command must begin with YAML frontmatter.')
  const closing = lines.indexOf('---', 1)
  if (closing < 0) throw new TypeError('Project command YAML frontmatter has no closing delimiter.')

  let document
  try {
    document = parseDocument(lines.slice(1, closing).join('\n'), { schema: 'core', uniqueKeys: true })
  } catch {
    throw new TypeError('Project command YAML frontmatter is invalid.')
  }
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    throw new TypeError('Project command YAML frontmatter must be a valid mapping.')
  }
  const allowedFrontmatterKeys = source === 'claude'
    ? new Set(['description', 'argument-hint'])
    : new Set(['description'])
  for (const pair of document.contents.items) {
    if (!isScalar(pair?.key) || !allowedFrontmatterKeys.has(pair.key.value)
      || pair.key.tag !== undefined || pair.key.anchor !== undefined) {
      throw new TypeError(source === 'claude'
        ? 'Claude project command frontmatter permits only description and argument-hint keys.'
        : 'OpenCode project command frontmatter permits only the description key.')
    }
  }

  let frontmatter
  try { frontmatter = document.toJS({ maxAliasCount: 0 }) } catch {
    throw new TypeError('Project command YAML frontmatter cannot be represented safely.')
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)
    || (Object.getPrototypeOf(frontmatter) !== Object.prototype && Object.getPrototypeOf(frontmatter) !== null)) {
    throw new TypeError('Project command YAML frontmatter must be a mapping.')
  }
  if (Object.keys(frontmatter).some(key => !allowedFrontmatterKeys.has(key))) {
    throw new TypeError(source === 'claude'
      ? 'Claude project command frontmatter permits only description and argument-hint keys.'
      : 'OpenCode project command frontmatter permits only the description key.')
  }
  const description = frontmatter.description
  if (typeof description !== 'string' || !description.trim() || description.length > MAX_DESCRIPTION_CHARS
    || CONTROL_OR_BIDI.test(description)) {
    throw new TypeError(`Project command description must be non-empty and at most ${MAX_DESCRIPTION_CHARS} safe characters.`)
  }
  let argumentHint
  if (Object.hasOwn(frontmatter, 'argument-hint')) {
    const candidate = frontmatter['argument-hint']
    if (source !== 'claude' || typeof candidate !== 'string' || !candidate.trim()
      || candidate.length > MAX_ARGUMENT_HINT_CHARS || /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(candidate)) {
      throw new TypeError(`Claude project command argument-hint must be one safe line of at most ${MAX_ARGUMENT_HINT_CHARS} characters.`)
    }
    argumentHint = candidate.trim()
  }

  const body = lines.slice(closing + 1).join('\n').replace(/^\n/u, '')
  const bodyBytes = new TextEncoder().encode(body).byteLength
  if (!body.trim() || bodyBytes > MAX_FILE_BYTES || CONTROL_OR_BIDI.test(body)) {
    throw new TypeError(`Project command body must be non-empty, free of control or bidi characters, and at most ${MAX_FILE_BYTES} bytes.`)
  }
  return Object.freeze({ name, description: description.trim(), ...(argumentHint === undefined ? {} : { argumentHint }), body })
}

async function readProjectCommand(fs, cwd, scope, directory, entry, name, signal, readBudget) {
  const relativePath = `${directory.path}/${name}.md`
  const listedKey = targetKey(entry?.target)
  if (!listedKey || entry?.name !== `${name}.md` || entry?.type !== 'file') return undefined

  const pathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd }, signal), signal)
  assertNotAborted(signal)
  if (pathInfo?.type !== 'file') return undefined
  const target = await resolveTarget(fs, relativePath, cwd, signal)
  assertNotAborted(signal)
  if (!targetKey(target) || targetKey(target) !== listedKey
    || !safeContainment(fs, scope.rootTarget, target)
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
    return undefined
  }
  assertNotAborted(signal)
  if (!(bytes instanceof Uint8Array)) return undefined
  readBudget.remaining = Math.max(0, readBudget.remaining - bytes.byteLength)
  if (bytes.byteLength > readLimit || bytes.byteLength > MAX_FILE_BYTES
    || (beforeInfo.size !== undefined && bytes.byteLength !== beforeInfo.size)) return undefined

  const afterPathInfo = await awaitWithSignal(() => fs.lstat(relativePath, { cwd }, signal), signal)
  assertNotAborted(signal)
  if (afterPathInfo?.type !== 'file') return undefined
  const afterTarget = await resolveTarget(fs, relativePath, cwd, signal)
  assertNotAborted(signal)
  if (targetKey(afterTarget) !== targetKey(target)
    || !safeContainment(fs, scope.rootTarget, afterTarget)
    || !safeContainment(fs, directory.target, afterTarget)) return undefined
  const afterInfo = await safeStat(fs, afterTarget, signal)
  assertNotAborted(signal)
  if (!sameVersion(beforeInfo, afterInfo, bytes)) return undefined
  if (!await scopeStillMatches(fs, cwd, scope, signal)) return undefined
  const commandSource = directory.path === '.claude/commands' ? 'claude' : 'opencode'
  try { return parseProjectCommandDocument(name, bytes, commandSource) } catch { return undefined }
}

/**
 * Create a read-only project command scanner. The caller chooses how to register each definition.
 * options.sessions is the DSH Session service; no implicit context injection is performed.
 */
export function createProjectCommandAdapter(fs, options = {}) {
  const sessions = options.sessions
  if (!sessions || typeof sessions.get !== 'function') throw new TypeError('Project commands require DSH sessions.get.')
  for (const method of ['resolve', 'contains', 'lstat', 'stat', 'listDir', 'readBytes']) {
    if (!fs || typeof fs[method] !== 'function') throw new TypeError(`Project commands require DSH fs.${method}.`)
  }

  async function list(agent, signal) {
    if (signal !== undefined && !validSignal(signal)) throw new TypeError('Project command listing requires a valid AbortSignal.')
    assertNotAborted(signal)
    const cwd = safeAgentCwd(agent, sessions)
    const scope = await resolveScope(fs, cwd, signal)
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
      const entries = await awaitWithSignal(() => fs.listDir(directory.target, signal), signal)
      assertNotAborted(signal)
      if (!Array.isArray(entries)) throw new TypeError('DSH fs.listDir returned an invalid project command listing.')
      const remaining = MAX_DIRECTORY_ENTRIES - listedEntries
      const boundedEntries = entries.slice(0, remaining)
      listedEntries += boundedEntries.length
      if (entries.length > remaining) truncated = true
      for (const entry of boundedEntries) {
        const name = directMarkdownName(entry)
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
        command = await readProjectCommand(fs, cwd, scope, directory, entry, name, signal, readBudget)
      } catch (error) {
        if (signal?.aborted || error === ABORTED) throw ABORTED
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
    return Object.freeze({ commands: Object.freeze(commands), truncated, skipped })
  }

  return Object.freeze({ list })
}

function isParsedCommand(value) {
  return isObject(value) && isProjectCommandName(value.name)
    && typeof value.description === 'string' && value.description.trim().length > 0
    && value.description.length <= MAX_DESCRIPTION_CHARS && !CONTROL_OR_BIDI.test(value.description)
    && (value.argumentHint === undefined || (typeof value.argumentHint === 'string' && value.argumentHint.trim().length > 0
      && value.argumentHint.length <= MAX_ARGUMENT_HINT_CHARS
      && !/[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(value.argumentHint)))
    && typeof value.body === 'string' && value.body.trim().length > 0
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

/** Replace only the literal `$ARGUMENTS` token; all supplied text remains untrusted prompt data. */
export function renderProjectCommand(projectCommand, rawInput) {
  if (!isParsedCommand(projectCommand)) {
    throw new TypeError('A parsed project command is required.')
  }
  const args = normalizeRawInput(rawInput)
  const bodyBytes = new TextEncoder().encode(projectCommand.body).byteLength
  const argumentBytes = new TextEncoder().encode(args).byteLength
  const occurrences = projectCommand.body.split('$ARGUMENTS').length - 1
  const estimatedBytes = bodyBytes + occurrences * (argumentBytes - '$ARGUMENTS'.length)
  if (estimatedBytes > MAX_RENDERED_BYTES) {
    throw new RangeError(`Rendered project command exceeds ${MAX_RENDERED_BYTES} bytes.`)
  }
  const rendered = projectCommand.body.split('$ARGUMENTS').join(args)
  if (new TextEncoder().encode(rendered).byteLength > MAX_RENDERED_BYTES) {
    throw new RangeError(`Rendered project command exceeds ${MAX_RENDERED_BYTES} bytes.`)
  }
  return rendered
}

/** Build a command definition only; the caller supplies its own explicit registration and queue adapters. */
export function makeProjectCommandDefinition(projectCommand, queue) {
  if (!isParsedCommand(projectCommand)) {
    throw new TypeError('A parsed project command is required.')
  }
  if (typeof queue !== 'function') throw new TypeError('Project command definition requires an explicit queue callback.')
  return Object.freeze({
    name: projectCommand.name,
    description: projectCommand.description,
    input: { hint: projectCommand.argumentHint ?? '[arguments]' },
    handler: invocation => {
      const agent = invocation?.agent
      if (!agent || typeof agent !== 'object') return { kind: 'error', text: 'Project commands require an active Agent.' }
      if (invocation?.signal?.aborted === true) return { kind: 'error', text: 'Project command invocation was cancelled before it could be queued.' }
      let prompt
      try { prompt = renderProjectCommand(projectCommand, invocation?.rawInput) } catch (error) {
        return { kind: 'error', text: error instanceof RangeError ? error.message : 'Project command arguments must be text.' }
      }
      try { return queue(agent, prompt, projectCommand) } catch {
        return { kind: 'error', text: 'Project command could not be queued.' }
      }
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
