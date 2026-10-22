import { createHash } from 'node:crypto'
import { posix as path } from 'node:path'
import picomatch from 'picomatch'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const FILE_OPERATION_TOOL_NAMES = new Set(['read', 'write', 'edit'])
const OMO_PROJECT_RULES_DIRECTORY = '.omo/rules'
const RULES_DIRECTORY = '.claude/rules'
const CURSOR_PROJECT_RULES_DIRECTORY = '.cursor/rules'
const GITHUB_PROJECT_INSTRUCTIONS_DIRECTORY = '.github/instructions'
const GITHUB_INSTRUCTION_FILE_PATTERN = /\.instructions\.md$/u
const OPENCODE_USER_RULE_SOURCES = Object.freeze([
  Object.freeze({ suffix: '.omo/rules', labelPrefix: 'user/.omo/rules' }),
  Object.freeze({ suffix: '.opencode/rules', labelPrefix: 'user/.opencode/rules' }),
])
const SKIP_RULE_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.next', 'coverage'])
const MAX_CWD_CHARS = 4_096
const MAX_PATH_CHARS = 4_096
const MAX_TARGET_KEY_CHARS = 4_096
const MAX_RULE_DEPTH = 8
const MAX_RULE_DIRECTORIES = 32
const MAX_PROCESSED_ENTRIES = 256
const MAX_INJECTED_RULES = 8
const MAX_FILE_BYTES = 16_384
const MAX_TOTAL_BYTES = 32_768
const MAX_AGENT_CACHE_ENTRIES = 256
const READ_PIPELINE_TIMEOUT_MS = 5_000
const CONTROL_OR_BIDI_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}]/gu
const PATH_CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u
const ABORTED = Symbol('rules read context cancelled')
const LIMIT_REACHED = Symbol('rules scan limit reached')
const INVALID_RULE = Symbol('invalid rule frontmatter')

export function normalizeUserClaudeRulesRoots(value) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 1) {
    throw new TypeError('userClaudeRulesRoots must be an array with at most one absolute .claude/rules directory')
  }
  const roots = []
  for (let index = 0; index < value.length; index += 1) {
    const inputRoot = value[index]
    const root = typeof inputRoot === 'string' ? inputRoot.replace(/\/+$/u, '') || inputRoot : inputRoot
    if (typeof inputRoot !== 'string' || !inputRoot || inputRoot.trim() !== inputRoot
      || inputRoot.length > MAX_PATH_CHARS || PATH_CONTROL_OR_BIDI.test(inputRoot)
      || !path.isAbsolute(root) || path.normalize(root) !== root
      || path.basename(root) !== 'rules' || path.basename(path.dirname(root)) !== '.claude') {
      throw new TypeError(`userClaudeRulesRoots[${index}] must be a normalized absolute path ending in .claude/rules`)
    }
    roots.push(root)
  }
  return Object.freeze(roots)
}

export function normalizeUserOpenCodeRulesRoots(value) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > OPENCODE_USER_RULE_SOURCES.length) {
    throw new TypeError('userOpenCodeRulesRoots must contain at most one absolute root for each supported source')
  }
  const roots = []
  const seenSources = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const inputRoot = value[index]
    const root = typeof inputRoot === 'string' ? inputRoot.replace(/\/+$/u, '') || inputRoot : inputRoot
    const source = typeof root === 'string'
      ? OPENCODE_USER_RULE_SOURCES.find(candidate => root.endsWith(`/${candidate.suffix}`))
      : undefined
    if (typeof inputRoot !== 'string' || !inputRoot || inputRoot.trim() !== inputRoot
      || inputRoot.length > MAX_PATH_CHARS || PATH_CONTROL_OR_BIDI.test(inputRoot)
      || !path.isAbsolute(root) || path.normalize(root) !== root || !source) {
      throw new TypeError(`userOpenCodeRulesRoots[${index}] must be a normalized absolute path ending in .omo/rules or .opencode/rules`)
    }
    if (seenSources.has(source.suffix)) {
      throw new TypeError(`userOpenCodeRulesRoots accepts at most one root ending in ${source.suffix}`)
    }
    seenSources.add(source.suffix)
    roots.push(root)
  }
  roots.sort((left, right) => {
    const leftIndex = OPENCODE_USER_RULE_SOURCES.findIndex(source => left.endsWith(`/${source.suffix}`))
    const rightIndex = OPENCODE_USER_RULE_SOURCES.findIndex(source => right.endsWith(`/${source.suffix}`))
    return leftIndex - rightIndex
  })
  return Object.freeze(roots)
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

function ownDataValue(record, key) {
  if (!isPlainRecord(record)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
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
      && !PATH_CONTROL_OR_BIDI.test(key) ? key : undefined
  } catch {
    return undefined
  }
}

function validSize(size, limit) {
  return size === undefined || (Number.isSafeInteger(size) && size >= 0 && size <= limit)
}

function validCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_CWD_CHARS
    || !path.isAbsolute(cwd) || cwd.includes('\\') || PATH_CONTROL_OR_BIDI.test(cwd)) return false
  const normalized = cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  const segments = normalized === '/' ? [] : normalized.slice(1).split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function validateFileOperationPath(args, cwd) {
  const filePath = ownDataValue(args, 'file_path')
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_PATH_CHARS
    || filePath !== filePath.trim() || filePath.includes('\\') || PATH_CONTROL_OR_BIDI.test(filePath)
    || filePath.startsWith('~') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(filePath)) return undefined

  const absolute = path.isAbsolute(filePath)
  if (absolute && filePath.slice(1).split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    return undefined
  }
  const relativePath = absolute ? path.relative(cwd, filePath) : filePath
  if (relativePath.length === 0 || relativePath === '.' || relativePath === '..'
    || relativePath.startsWith('../') || path.isAbsolute(relativePath)) return undefined
  const segments = relativePath.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return { filePath, relativePath, basename: segments.at(-1) }
}

// ToolExecution.schema is optional; when present, require the inspected scalar path property.
function hasFilePathSchema(exec) {
  const schema = ownDataValue(exec, 'schema')
  if (schema === undefined) return true
  if (!isPlainRecord(schema)) return false
  const name = ownDataValue(schema, 'name')
  const execName = ownDataValue(exec, 'name')
  if (typeof name === 'string' && (typeof execName !== 'string' || name.toLowerCase() !== execName.toLowerCase())) return false
  const parameters = ownDataValue(schema, 'parameters')
  const properties = ownDataValue(parameters, 'properties')
  const filePath = ownDataValue(properties, 'file_path')
  return isPlainRecord(filePath) && ownDataValue(filePath, 'type') === 'string'
}

function escapePromptVariableSyntax(text) {
  return text
    .replace(/\{+/gu, run => run.length > 1 ? '\uff5b'.repeat(run.length) : run)
    .replace(/\}+/gu, run => run.length > 1 ? '\uff5d'.repeat(run.length) : run)
}

function contains(fs, parent, child) {
  try {
    return fs.contains(parent, child) === true
  } catch {
    return false
  }
}

function metadataMatches(left, right) {
  return (left?.version === undefined || right?.version === left.version)
    && (left?.size === undefined || right?.size === left.size)
}

function compareName(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function validEntryName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
    && !PATH_CONTROL_OR_BIDI.test(name)
}

function safeCall(operation, signal) {
  return awaitWithSignal(operation, signal)
}

async function resolve(fs, value, cwd, signal) {
  return safeCall(() => fs.resolve(value, { cwd, signal }), signal)
}

async function lstat(fs, relative, cwd, signal) {
  return safeCall(() => fs.lstat(relative, { cwd }, signal), signal)
}

async function stat(fs, target, signal) {
  return safeCall(() => fs.stat(target, signal), signal)
}

function assertFileSystem(fs) {
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function'
    || typeof fs.lstat !== 'function' || typeof fs.stat !== 'function'
    || typeof fs.readBytes !== 'function' || typeof fs.listDir !== 'function') {
    throw new TypeError('rules context requires DSH fs.resolve, contains, lstat, stat, readBytes, and listDir')
  }
}

async function getDirectoryTarget(fs, cwd, cwdTarget, relative, expectedKey, expectedEntry, signal, knownPathInfo) {
  assertNotAborted(signal)
  const pathInfo = knownPathInfo ?? await lstat(fs, relative, cwd, signal)
  assertNotAborted(signal)
  if (pathInfo?.type !== 'directory' || (expectedEntry && expectedEntry.type !== 'directory')) return undefined

  const target = await resolve(fs, relative, cwd, signal)
  assertNotAborted(signal)
  const key = safeTargetKey(target)
  if (!key || (expectedKey && key !== expectedKey) || !contains(fs, cwdTarget, target)) return undefined
  if (expectedEntry && safeTargetKey(expectedEntry.target) !== key) return undefined

  const info = await stat(fs, target, signal)
  assertNotAborted(signal)
  if (info?.type !== 'directory' || !metadataMatches(pathInfo, info)
    || (expectedEntry && (!metadataMatches(expectedEntry, pathInfo) || !metadataMatches(expectedEntry, info)))) return undefined
  return { target, key, pathInfo, info }
}

async function getFileTarget(fs, cwd, cwdTarget, rulesTarget, relative, entry, signal, knownPathInfo) {
  assertNotAborted(signal)
  const pathInfo = knownPathInfo ?? await lstat(fs, relative, cwd, signal)
  assertNotAborted(signal)
  if (pathInfo?.type !== 'file' || entry?.type !== 'file') return undefined

  const target = await resolve(fs, relative, cwd, signal)
  assertNotAborted(signal)
  const key = safeTargetKey(target)
  if (!key || safeTargetKey(entry.target) !== key
    || !contains(fs, cwdTarget, target) || !contains(fs, rulesTarget, target)) return undefined

  const info = await stat(fs, target, signal)
  assertNotAborted(signal)
  if (info?.type !== 'file' || !metadataMatches(pathInfo, info)
    || !metadataMatches(entry, pathInfo) || !metadataMatches(entry, info)) return undefined
  if (!validSize(info.size, MAX_FILE_BYTES)) throw LIMIT_REACHED
  return { target, key, pathInfo, info }
}

async function readRuleFile(fs, cwd, cwdTarget, rulesTarget, relative, entry, aggregate, signal, knownFile) {
  const file = knownFile ?? await getFileTarget(fs, cwd, cwdTarget, rulesTarget, relative, entry, signal)
  if (!file) return undefined
  const remaining = MAX_TOTAL_BYTES - aggregate.bytes
  if (remaining <= 0 || (file.info.size !== undefined && file.info.size > remaining)) throw LIMIT_REACHED
  const readLimit = Math.min(MAX_FILE_BYTES, remaining)
  const bytes = await safeCall(() => fs.readBytes(file.target, signal, readLimit), signal)
  assertNotAborted(signal)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > readLimit
    || (file.info.size !== undefined && bytes.byteLength !== file.info.size)) throw LIMIT_REACHED
  // Charge every bounded read, including files that later fail identity or UTF-8 checks.
  aggregate.bytes += bytes.byteLength

  const afterPathInfo = await lstat(fs, relative, cwd, signal)
  assertNotAborted(signal)
  if (afterPathInfo?.type !== 'file') return undefined
  const afterTarget = await resolve(fs, relative, cwd, signal)
  assertNotAborted(signal)
  const afterKey = safeTargetKey(afterTarget)
  if (!afterKey || afterKey !== file.key || !contains(fs, cwdTarget, afterTarget)
    || !contains(fs, rulesTarget, afterTarget)) return undefined
  const afterInfo = await stat(fs, afterTarget, signal)
  assertNotAborted(signal)
  if (afterInfo?.type !== 'file' || !metadataMatches(file.info, afterInfo)
    || !metadataMatches(file.pathInfo, afterPathInfo) || !metadataMatches(file.info, afterPathInfo)
    || !validSize(afterInfo.size, MAX_FILE_BYTES)
    || (afterInfo.size !== undefined && bytes.byteLength !== afterInfo.size)) return undefined

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  return { text, key: file.key }
}

function stripComment(value) {
  let quote
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      if (char === "'" && value[index + 1] === "'") index++
      else if (char === "'") quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (index === 0 || /\s/u.test(value[index - 1]))) return value.slice(0, index).trimEnd()
  }
  if (quote) throw INVALID_RULE
  return value.trimEnd()
}

function parseQuoted(value) {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") throw INVALID_RULE
  let result = ''
  let index = 1
  while (index < value.length) {
    const char = value[index]
    if (quote === "'" && char === "'" && value[index + 1] === "'") {
      result += "'"
      index += 2
      continue
    }
    if (char === quote) {
      const tail = stripComment(value.slice(index + 1)).trim()
      if (tail !== '') throw INVALID_RULE
      return result
    }
    if (quote === '"' && char === '\\') {
      const next = value[index + 1]
      if (next === undefined) throw INVALID_RULE
      const escaped = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }[next]
      if (escaped === undefined) throw INVALID_RULE
      result += escaped
      index += 2
      continue
    }
    result += char
    index++
  }
  throw INVALID_RULE
}

function parseScalar(value, { allowEmpty = false, allowGlobSyntax = false } = {}) {
  const clean = stripComment(value).trim()
  if (clean === '') {
    if (allowEmpty) return ''
    throw INVALID_RULE
  }
  if (clean[0] === '"' || clean[0] === "'") return parseQuoted(clean)
  if (!allowGlobSyntax && (clean.includes('[') || clean.includes(']') || clean.includes('{') || clean.includes('}'))) throw INVALID_RULE
  return clean
}

function splitOutsideQuotes(value, delimiter) {
  const pieces = []
  let start = 0
  let quote
  let escaped = false
  let squareDepth = 0
  let braceDepth = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      if (char === "'" && value[index + 1] === "'") index++
      else if (char === "'") quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[') squareDepth++
    else if (char === ']' && squareDepth > 0) squareDepth--
    else if (char === '{') braceDepth++
    else if (char === '}' && braceDepth > 0) braceDepth--
    else if (char === delimiter && squareDepth === 0 && braceDepth === 0) {
      pieces.push(value.slice(start, index))
      start = index + 1
    }
  }
  if (quote || escaped) throw INVALID_RULE
  pieces.push(value.slice(start))
  return pieces
}

function parseInlineArray(value) {
  const clean = stripComment(value).trim()
  const closing = clean.lastIndexOf(']')
  if (!clean.startsWith('[') || closing < 0) return []
  const content = clean.slice(1, closing)
  if (content.trim() === '') return []
  return splitOutsideQuotes(content, ',')
    .map(item => parseScalar(item, { allowEmpty: true, allowGlobSyntax: true }))
    .filter(Boolean)
}

function parseFrontmatter(text) {
  const source = text.startsWith('\ufeff') ? text.slice(1) : text
  const openingLength = source.startsWith('---\r\n') ? 5 : source.startsWith('---\n') ? 4 : 0
  if (openingLength === 0) return undefined

  let lineStart = openingLength
  let closingStart
  let bodyStart = source.length
  while (lineStart <= source.length) {
    const nextNewline = source.indexOf('\n', lineStart)
    const lineEnd = nextNewline === -1 ? source.length : nextNewline
    if (source.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      closingStart = lineStart
      bodyStart = nextNewline === -1 ? source.length : nextNewline + 1
      break
    }
    if (nextNewline === -1) break
    lineStart = nextNewline + 1
  }
  if (closingStart === undefined) return undefined

  const lines = source.slice(openingLength, closingStart).replace(/\r\n/gu, '\n').split('\n')
  const fields = { description: undefined, alwaysApply: false, patterns: [] }
  const appendPatterns = values => {
    for (const pattern of values) {
      if (typeof pattern !== 'string') throw INVALID_RULE
      const normalized = pattern.replaceAll('\\', '/')
      if (normalized.length === 0) continue
      if (normalized.length > MAX_PATH_CHARS || PATH_CONTROL_OR_BIDI.test(normalized)) throw INVALID_RULE
      if (!fields.patterns.includes(normalized)) fields.patterns.push(normalized)
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = stripComment(lines[index] ?? '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()

    if (name === 'globs' || name === 'paths' || name === 'applyTo') {
      if (raw.startsWith('[')) {
        appendPatterns(parseInlineArray(raw))
        continue
      }
      if (raw !== '') {
        const value = parseScalar(raw, { allowEmpty: true, allowGlobSyntax: true })
        const values = splitOutsideQuotes(value, ',').map(item => item.trim()).filter(Boolean)
        appendPatterns(values)
        continue
      }
      const values = []
      let cursor = index + 1
      while (cursor < lines.length) {
        const child = lines[cursor] ?? ''
        if (child.trim() === '' || /^\s*#/u.test(child)) {
          cursor++
          continue
        }
        const item = /^\s+-\s*(.*)$/u.exec(child)
        if (!item) break
        const parsed = parseScalar(item[1], { allowEmpty: true, allowGlobSyntax: true })
        if (parsed) values.push(parsed)
        cursor++
      }
      appendPatterns(values)
      index = cursor - 1
      continue
    }

    if (name === 'alwaysApply') fields.alwaysApply = raw === 'true'
    else if (name === 'description') {
      fields.description = parseScalar(raw, { allowEmpty: true, allowGlobSyntax: true })
    }
    // Unknown metadata (including mode) is ignored, as in upstream rule mode.
  }

  return { ...fields, body: source.slice(bodyStart) }
}

function compilePattern(pattern) {
  try {
    return picomatch(pattern, { dot: true, bash: true })
  } catch {
    throw INVALID_RULE
  }
}

function ruleMatch(rule, targetPath) {
  if (rule.alwaysApply) return 'alwaysApply'
  const patterns = rule.patterns.map(raw => {
    const negative = raw.startsWith('!')
    const pattern = negative ? raw.slice(1) : raw
    if (pattern.length === 0 || pattern.startsWith('!')) throw INVALID_RULE
    return { raw, negative, matcher: compilePattern(pattern) }
  })
  const matches = ({ matcher }) => matcher(targetPath.relativePath) || matcher(targetPath.basename)
  if (patterns.some(pattern => pattern.negative && matches(pattern))) return undefined
  const positive = patterns.find(pattern => !pattern.negative && matches(pattern))
  return positive ? `glob: ${positive.raw}` : undefined
}

function escapeRuleMetadata(value) {
  return escapePromptVariableSyntax(value.replace(CONTROL_OR_BIDI_GLOBAL, '?')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
    .replaceAll('[', '\uff3b')
    .replaceAll(']', '\uff3d'))
}

function ruleContext(relativePath, reason, rawBody) {
  const safePath = escapeRuleMetadata(relativePath)
  const safeReason = escapeRuleMetadata(reason)
  const content = escapePromptVariableSyntax(rawBody.replace(CONTROL_OR_BIDI_GLOBAL, '?'))
  return createUserMessage({
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: `[Rule: ${safePath}]\n[Match: ${safeReason}]\n[Untrusted repository rule text]\n${content}\n[End rule]`,
    }],
  })
}

function getAgentState(states, agent) {
  let state = states.get(agent)
  if (!state) {
    state = { generation: 0, injected: new Map(), pending: new Set() }
    states.set(agent, state)
  }
  return state
}

function resetAgentState(state) {
  state.generation++
  state.injected.clear()
  state.pending.clear()
}

function contentHash(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

function releaseReservations(state, keys) {
  for (const key of keys) state.pending.delete(key)
}

function commitReservations(state, keys) {
  for (const key of keys) {
    state.pending.delete(key)
    state.injected.set(key, true)
    while (state.injected.size > MAX_AGENT_CACHE_ENTRIES) {
      state.injected.delete(state.injected.keys().next().value)
    }
  }
}

async function getConfiguredUserRulesRoot(fs, rootPath, signal) {
  assertNotAborted(signal)
  const pathInfo = await lstat(fs, rootPath, undefined, signal)
  assertNotAborted(signal)
  if (pathInfo?.type !== 'directory') return undefined
  const target = await resolve(fs, rootPath, undefined, signal)
  assertNotAborted(signal)
  const key = safeTargetKey(target)
  if (!key) return undefined
  const info = await stat(fs, target, signal)
  assertNotAborted(signal)
  if (info?.type !== 'directory' || !metadataMatches(pathInfo, info)) return undefined
  return { target, key, pathInfo, info }
}

async function prepareRulesContext({
  fs,
  cwd,
  filePath,
  cwdTarget,
  agentState,
  generation,
  signal,
  includeProjectOmoRoot = false,
  includeProjectClaudeRoot = true,
  includeProjectCursorRoot = false,
  includeProjectGitHubInstructionsRoot = false,
  userClaudeRulesRoots = [],
  userOpenCodeRulesRoots = [],
}) {
  assertNotAborted(signal)
  const roots = []
  if (includeProjectOmoRoot) {
    const omo = await getDirectoryTarget(fs, cwd, cwdTarget, '.omo', undefined, undefined, signal)
    if (omo) {
      const rules = await getDirectoryTarget(fs, cwd, cwdTarget, OMO_PROJECT_RULES_DIRECTORY, undefined, undefined, signal)
      if (rules && contains(fs, omo.target, rules.target)) {
        const rootBefore = await getDirectoryTarget(fs, cwd, cwdTarget, OMO_PROJECT_RULES_DIRECTORY, rules.key, undefined, signal)
        if (rootBefore) {
          roots.push({
            cwd,
            cwdTarget,
            rulesTarget: rootBefore.target,
            relative: OMO_PROJECT_RULES_DIRECTORY,
            rootKey: rootBefore.key,
            pathInfo: rootBefore.pathInfo,
            labelPrefix: '',
          })
        }
      }
    }
  }
  if (includeProjectClaudeRoot) {
    const claude = await getDirectoryTarget(fs, cwd, cwdTarget, '.claude', undefined, undefined, signal)
    if (claude) {
      const rules = await getDirectoryTarget(fs, cwd, cwdTarget, RULES_DIRECTORY, undefined, undefined, signal)
      if (rules && contains(fs, claude.target, rules.target)) {
        const rootBefore = await getDirectoryTarget(fs, cwd, cwdTarget, RULES_DIRECTORY, rules.key, undefined, signal)
        if (rootBefore) {
          roots.push({
            cwd,
            cwdTarget,
            rulesTarget: rootBefore.target,
            relative: RULES_DIRECTORY,
            rootKey: rootBefore.key,
            pathInfo: rootBefore.pathInfo,
            labelPrefix: '',
          })
        }
      }
    }
  }
  if (includeProjectCursorRoot) {
    const cursor = await getDirectoryTarget(fs, cwd, cwdTarget, '.cursor', undefined, undefined, signal)
    if (cursor) {
      const rules = await getDirectoryTarget(fs, cwd, cwdTarget, CURSOR_PROJECT_RULES_DIRECTORY, undefined, undefined, signal)
      if (rules && contains(fs, cursor.target, rules.target)) {
        const rootBefore = await getDirectoryTarget(fs, cwd, cwdTarget, CURSOR_PROJECT_RULES_DIRECTORY, rules.key, undefined, signal)
        if (rootBefore) {
          roots.push({
            cwd,
            cwdTarget,
            rulesTarget: rootBefore.target,
            relative: CURSOR_PROJECT_RULES_DIRECTORY,
            rootKey: rootBefore.key,
            pathInfo: rootBefore.pathInfo,
            labelPrefix: '',
          })
        }
      }
    }
  }
  if (includeProjectGitHubInstructionsRoot) {
    const github = await getDirectoryTarget(fs, cwd, cwdTarget, '.github', undefined, undefined, signal)
    if (github) {
      const instructions = await getDirectoryTarget(fs, cwd, cwdTarget, GITHUB_PROJECT_INSTRUCTIONS_DIRECTORY, undefined, undefined, signal)
      if (instructions && contains(fs, github.target, instructions.target)) {
        const rootBefore = await getDirectoryTarget(fs, cwd, cwdTarget, GITHUB_PROJECT_INSTRUCTIONS_DIRECTORY, instructions.key, undefined, signal)
        if (rootBefore) {
          roots.push({
            cwd,
            cwdTarget,
            rulesTarget: rootBefore.target,
            relative: GITHUB_PROJECT_INSTRUCTIONS_DIRECTORY,
            rootKey: rootBefore.key,
            pathInfo: rootBefore.pathInfo,
            labelPrefix: '',
            ruleFilePattern: GITHUB_INSTRUCTION_FILE_PATTERN,
          })
        }
      }
    }
  }
  // Pinned upstream orders these user sources: ~/.omo, ~/.opencode, then ~/.claude.
  for (const rootPath of userOpenCodeRulesRoots) {
    const root = await getConfiguredUserRulesRoot(fs, rootPath, signal)
    if (!root) continue
    const source = OPENCODE_USER_RULE_SOURCES.find(candidate => rootPath.endsWith(`/${candidate.suffix}`))
    if (!source) continue
    roots.push({
      cwd: rootPath,
      cwdTarget: root.target,
      rulesTarget: root.target,
      relative: '.',
      rootKey: root.key,
      pathInfo: root.pathInfo,
      labelPrefix: source.labelPrefix,
    })
  }
  for (const rootPath of userClaudeRulesRoots) {
    const root = await getConfiguredUserRulesRoot(fs, rootPath, signal)
    if (!root) continue
    roots.push({
      cwd: rootPath,
      cwdTarget: root.target,
      rulesTarget: root.target,
      relative: '.',
      rootKey: root.key,
      pathInfo: root.pathInfo,
      labelPrefix: 'user/.claude/rules',
    })
  }
  if (roots.length === 0) return []

  const scan = { directories: 0, entries: 0, bytes: 0, files: [], visited: new Set() }
  const walk = async (root, directoryRelative, directoryKey, depth) => {
    assertNotAborted(signal)
    if (depth > MAX_RULE_DEPTH) throw LIMIT_REACHED
    if (scan.visited.has(directoryKey)) return
    if (++scan.directories > MAX_RULE_DIRECTORIES) throw LIMIT_REACHED
    scan.visited.add(directoryKey)

    const before = await getDirectoryTarget(
      fs, root.cwd, root.cwdTarget, directoryRelative, directoryKey, undefined, signal,
      depth === 0 ? root.pathInfo : undefined,
    )
    if (!before) throw LIMIT_REACHED
    const listing = await safeCall(() => fs.listDir(before.target, signal), signal)
    assertNotAborted(signal)
    if (!Array.isArray(listing)) throw LIMIT_REACHED
    // The provider may already have materialized this full direct listing before this cap is checked.
    if (scan.entries + listing.length > MAX_PROCESSED_ENTRIES) throw LIMIT_REACHED

    const entries = [...listing].sort((left, right) => compareName(left?.name, right?.name))
    const seenNames = new Set()
    const children = []
    for (const entry of entries) {
      assertNotAborted(signal)
      if (++scan.entries > MAX_PROCESSED_ENTRIES) throw LIMIT_REACHED
      if (!isObject(entry) || !validEntryName(entry.name)) continue
      if (seenNames.has(entry.name)) throw LIMIT_REACHED
      seenNames.add(entry.name)
      if (entry.type !== 'file' && entry.type !== 'directory') continue
      if (entry.type === 'directory' && SKIP_RULE_DIRECTORIES.has(entry.name)) continue
      const childRelative = directoryRelative === '.' || directoryRelative === ''
        ? entry.name
        : `${directoryRelative}/${entry.name}`
      const pathInfo = await lstat(fs, childRelative, root.cwd, signal)
      assertNotAborted(signal)
      if (pathInfo?.type !== entry.type) continue
      if (entry.type === 'directory') {
        const child = await getDirectoryTarget(fs, root.cwd, root.cwdTarget, childRelative, undefined, entry, signal, pathInfo)
        if (!child || !contains(fs, before.target, child.target)) continue
        children.push({ relative: childRelative, target: child.target, key: child.key, depth: depth + 1 })
        continue
      }
      const isRuleFile = root.ruleFilePattern
        ? root.ruleFilePattern.test(entry.name)
        : /\.(?:md|mdc)$/u.test(entry.name)
      if (!isRuleFile) {
        // Even non-rule files are identity/type checked before being ignored.
        const child = await getFileTarget(fs, root.cwd, root.cwdTarget, root.rulesTarget, childRelative, entry, signal, pathInfo)
        if (!child) continue
        continue
      }
      const file = await getFileTarget(fs, root.cwd, root.cwdTarget, root.rulesTarget, childRelative, entry, signal, pathInfo)
      if (!file) continue
      const read = await readRuleFile(fs, root.cwd, root.cwdTarget, root.rulesTarget, childRelative, entry, scan, signal, file)
      if (!read) continue
      let parsed
      try {
        parsed = parseFrontmatter(read.text)
      } catch (error) {
        if (error === LIMIT_REACHED) throw error
        continue
      }
      if (!parsed) continue
      let reason
      try {
        reason = ruleMatch(parsed, filePath)
      } catch {
        // A malformed pattern invalidates this rule without blocking the native read.
        continue
      }
      if (!reason) continue
      const body = parsed.body
      if (body.trim() === '') continue
      const relativePath = root.labelPrefix ? `${root.labelPrefix}/${childRelative}` : childRelative
      scan.files.push({
        key: contentHash(body),
        relativePath,
        reason,
        body,
      })
    }

    const after = await getDirectoryTarget(fs, root.cwd, root.cwdTarget, directoryRelative, directoryKey, undefined, signal)
    if (!after || after.key !== before.key || !metadataMatches(before.pathInfo, after.pathInfo)
      || !metadataMatches(before.info, after.info)) throw LIMIT_REACHED
    for (const child of children) {
      if (child.depth > MAX_RULE_DEPTH) throw LIMIT_REACHED
      await walk(root, child.relative, child.key, child.depth)
    }
  }

  for (const root of roots) await walk(root, root.relative, root.rootKey, 0)
  assertNotAborted(signal)
  if (agentState.generation !== generation) return []
  const unique = []
  const localKeys = new Set()
  for (const candidate of scan.files) {
    if (localKeys.has(candidate.key) || agentState.injected.has(candidate.key) || agentState.pending.has(candidate.key)) continue
    localKeys.add(candidate.key)
    unique.push(candidate)
  }
  if (unique.length > MAX_INJECTED_RULES || agentState.pending.size + unique.length > MAX_AGENT_CACHE_ENTRIES) throw LIMIT_REACHED
  return unique.map(candidate => ({
    key: candidate.key,
    message: ruleContext(candidate.relativePath, candidate.reason, candidate.body),
  }))
}

/** Append bounded, matched rule UserMessages to accepted DSH `read`, `write`, and `edit` results. */
export function createClaudeRulesOnReadContextListener(agents, sessions, fs, userClaudeRulesRoots = [], options = {}) {
  if (!agents || typeof agents.get !== 'function') throw new TypeError('Rules context requires DSH agents.get')
  if (!sessions || typeof sessions.get !== 'function') throw new TypeError('Rules context requires DSH sessions.get')
  assertFileSystem(fs)
  const includeProjectOmoRoot = options?.includeProjectOmoRoot === true
  const includeProjectClaudeRoot = options?.includeProjectClaudeRoot !== false
  const includeProjectCursorRoot = options?.includeProjectCursorRoot === true
  const includeProjectGitHubInstructionsRoot = options?.includeProjectGitHubInstructionsRoot === true
  const normalizedUserClaudeRulesRoots = normalizeUserClaudeRulesRoots(userClaudeRulesRoots)
  const normalizedUserOpenCodeRulesRoots = normalizeUserOpenCodeRulesRoots(options?.userOpenCodeRulesRoots)

  const states = new WeakMap()
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
    try {
      const liveAgent = agents.get(id)
      if (!isObject(liveAgent) || liveAgent.id !== id) return
      const state = states.get(liveAgent)
      if (state) resetAgentState(state)
    } catch {}
  }

  const listener = async (exec, result, next) => {
    const decision = await next()
    const toolName = typeof exec?.name === 'string' ? exec.name.toLowerCase() : ''
    if (disposed || !FILE_OPERATION_TOOL_NAMES.has(toolName) || !hasFilePathSchema(exec)
      || result?.isError !== false || decision?.kind !== 'accept') return decision
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
    if (session?.header?.id !== liveAgent.id || !validCwd(cwd)) return decision
    const filePath = validateFileOperationPath(exec.arguments, cwd)
    if (!filePath) return decision

    const state = getAgentState(states, liveAgent)
    const generation = state.generation
    let deadline
    let linked
    try {
      deadline = createDeadline(READ_PIPELINE_TIMEOUT_MS)
      linked = linkSignals([exec.signal, lifecycle.signal, deadline.signal])
    } catch {
      deadline?.dispose()
      return decision
    }

    let messages = []
    let reservations = []
    try {
      const cwdTarget = await resolve(fs, cwd, cwd, linked.signal)
      assertNotAborted(linked.signal)
      const cwdKey = safeTargetKey(cwdTarget)
      if (!cwdKey) return decision
      const cwdInfo = await stat(fs, cwdTarget, linked.signal)
      assertNotAborted(linked.signal)
      if (cwdInfo?.type !== 'directory') return decision
      const operationTarget = await resolve(fs, filePath.filePath, cwd, linked.signal)
      assertNotAborted(linked.signal)
      if (!safeTargetKey(operationTarget) || !contains(fs, cwdTarget, operationTarget)) return decision
      const operationInfo = await stat(fs, operationTarget, linked.signal)
      assertNotAborted(linked.signal)
      if (operationInfo?.type !== 'file') return decision

      messages = await prepareRulesContext({
        fs,
        cwd,
        filePath,
        cwdTarget,
        agentState: state,
        generation,
        signal: linked.signal,
        includeProjectOmoRoot,
        includeProjectClaudeRoot,
        includeProjectCursorRoot,
        includeProjectGitHubInstructionsRoot,
        userClaudeRulesRoots: normalizedUserClaudeRulesRoots,
        userOpenCodeRulesRoots: normalizedUserOpenCodeRulesRoots,
      })
      assertNotAborted(linked.signal)
      if (messages.length === 0) return decision
      if (state.generation !== generation || states.get(liveAgent) !== state || disposed) return decision
      if (exec.signal.aborted || !agents || agents.get(projection.id) !== liveAgent) return decision

      for (const item of messages) {
        if (state.injected.has(item.key) || state.pending.has(item.key)) continue
        state.pending.add(item.key)
        reservations.push(item.key)
      }
      if (reservations.length === 0) return decision
      if (reservations.length > MAX_INJECTED_RULES || state.pending.size > MAX_AGENT_CACHE_ENTRIES) {
        releaseReservations(state, reservations)
        reservations = []
        return decision
      }
      const byKey = new Map(messages.map(item => [item.key, item.message]))
      const contexts = reservations.map(key => byKey.get(key)).filter(Boolean)
      if (contexts.length === 0) {
        releaseReservations(state, reservations)
        reservations = []
        return decision
      }
      const previous = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
      const enriched = { ...decision, additionalContexts: [...previous, ...contexts] }
      commitReservations(state, reservations)
      reservations = []
      return enriched
    } catch {
      releaseReservations(state, reservations)
      return decision
    } finally {
      linked.dispose()
      deadline.dispose()
    }
  }

  listener.onAgentCreated = onAgentCreated
  listener.dispose = () => {
    if (disposed) return
    disposed = true
    lifecycle.abort()
  }
  return listener
}

/** Register the bounded rules file-operation adapter and clear dedupe on clear/compact. */
export function registerClaudeRulesOnReadContext(ctx, agents, sessions, fs, userClaudeRulesRoots = [], options = {}) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') {
    throw new TypeError('registerClaudeRulesOnReadContext requires Cordis ctx.on and ctx.effect')
  }
  const listener = createClaudeRulesOnReadContextListener(agents, sessions, fs, userClaudeRulesRoots, options)
  try {
    ctx.on('tools/post-execute', listener)
    ctx.on('agent/created', listener.onAgentCreated)
    ctx.effect(() => listener.dispose, 'dsh-omo rules on read context')
  } catch (error) {
    listener.dispose()
    throw error
  }
  return listener.dispose
}
