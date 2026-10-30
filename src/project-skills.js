import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parseDocument } from 'yaml'
import { basename, dirname, isAbsolute, normalize, parse as parsePath, posix, relative, win32 } from 'node:path'

export const PROJECT_SKILL_PROVIDER = 'dsh-omo-project-skills'
export const DEFAULT_PROJECT_SKILL_DIRS = Object.freeze(['.opencode/skills', '.opencode/skill', '.claude/skills', '.agents/skills'])

const MAX_SKILL_BYTES = 256 * 1024
const MAX_SKILLS = 256
const MAX_SCAN_ENTRIES = 512
const MAX_SCAN_BYTES = 8 * 1024 * 1024
const MAX_COMPAT_DIRECTORY_DEPTH = 3
const MAX_PROJECT_SKILL_DIRS = 16
const MAX_WATCHERS = 1_024
const MAX_COMPAT_REFERENCE_MATCHES = 64
// Keep every configured root (230–245) ahead of DSH runtime rank 250.
const PROJECT_SKILL_RANK = 230
const USER_SKILL_RANK = 246
const FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'whenToUse',
  'disable-model-invocation',
  'user-invocable',
])

const JSON_TAG_RESOLVERS = Object.freeze({
  'tag:yaml.org,2002:str': value => value,
  'tag:yaml.org,2002:null': (value, onError) => {
    if (value === 'null' || value === '') return null
    onError(`cannot resolve null scalar ${JSON.stringify(value)}`)
    return value
  },
  'tag:yaml.org,2002:bool': (value, onError) => {
    if (value === 'true') return true
    if (value === 'false') return false
    onError(`cannot resolve boolean scalar ${JSON.stringify(value)}`)
    return value
  },
  'tag:yaml.org,2002:int': (value, onError) => {
    if (!/^[+-]?(?:[0-9]+|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/u.test(value)) {
      onError(`cannot resolve integer scalar ${JSON.stringify(value)}`)
      return value
    }
    const normalized = value.replaceAll('_', '')
    const negative = normalized.startsWith('-')
    const unsigned = normalized.replace(/^[+-]/u, '')
    const sign = negative ? -1 : 1
    const result = unsigned.startsWith('0x')
      ? sign * Number.parseInt(unsigned.slice(2), 16)
      : unsigned.startsWith('0o')
        ? sign * Number.parseInt(unsigned.slice(2), 8)
        : unsigned.startsWith('0b')
          ? sign * Number.parseInt(unsigned.slice(2), 2)
          : sign * Number.parseInt(unsigned, 10)
    if (!Number.isFinite(result)) {
      onError(`cannot resolve integer scalar ${JSON.stringify(value)}`)
      return value
    }
    return result
  },
  'tag:yaml.org,2002:float': (value, onError) => {
    if (value === '.nan' || value === '.NaN' || value === '.NAN') return Number.NaN
    if (/^[+-]?\.(?:inf|Inf|INF)$/u.test(value)) return value.startsWith('-') ? -Infinity : Infinity
    if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(value)) {
      onError(`cannot resolve float scalar ${JSON.stringify(value)}`)
      return value
    }
    const result = Number.parseFloat(value)
    if (!Number.isFinite(result)) {
      onError(`cannot resolve float scalar ${JSON.stringify(value)}`)
      return value
    }
    return result
  },
})

class SkillFormatError extends Error {
  constructor(message, bytesRead = 0) {
    super(message)
    this.name = 'SkillFormatError'
    this.bytesRead = bytesRead
  }
}

class ScanBudgetError extends Error {
  constructor(message, bytesRead = 0) {
    super(message)
    this.name = 'ScanBudgetError'
    this.bytesRead = bytesRead
  }
}

function safeErrorName(error) {
  return error && typeof error.name === 'string' ? error.name.slice(0, 64) : 'Error'
}

function warn(ctx, message, error) {
  try {
    ctx.logger?.warn?.(`${message} (${safeErrorName(error)})`)
  } catch {
    // Diagnostics must not turn an unavailable optional source into a plugin failure.
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Skill lookup aborted')
}

function lifecycleSignal(signal, lifecycle) {
  return signal ? AbortSignal.any([signal, lifecycle]) : lifecycle
}

export function normalizeProjectSkillDirs(value = DEFAULT_PROJECT_SKILL_DIRS) {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_SKILL_DIRS) {
    throw new TypeError(`projectSkillDirs must be an array with at most ${MAX_PROJECT_SKILL_DIRS} relative directories`)
  }
  const normalized = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 512 || entry.includes('\0')) {
      throw new TypeError('projectSkillDirs entries must be non-empty relative paths no longer than 512 characters')
    }
    const dir = entry.trim().replace(/\\/gu, '/')
    const segments = dir.split('/')
    if (dir.startsWith('/') || dir.startsWith('~') || /^[a-z][a-z\d+.-]*:/iu.test(dir) || segments.includes('..') || dir === '.') {
      throw new TypeError(`projectSkillDirs entry must stay relative to the lookup cwd: ${entry}`)
    }
    const canonical = segments.filter(segment => segment && segment !== '.').join('/')
    if (!canonical) throw new TypeError(`projectSkillDirs entry must not be empty: ${entry}`)
    if (!seen.has(canonical)) {
      seen.add(canonical)
      normalized.push(canonical)
    }
  }
  return normalized
}

export function normalizeUserSkillRoots(value, field) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 2) throw new TypeError(`${field} must contain at most 2 normalized absolute skill roots`)
  const roots = []
  const seen = new Set()
  for (const entry of value) {
    const root = typeof entry === 'string' ? entry.replace(/[\\/]+$/u, '') || entry : entry
    if (typeof entry !== 'string' || !entry || entry.trim() !== entry || entry.length > 4_096
      || !isAbsolute(root) || normalize(root) !== root || basename(root) !== 'skills'
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u2066-\u2069]/u.test(entry)) {
      throw new TypeError(`${field} entries must be normalized absolute directories named skills`)
    }
    if (seen.has(root)) throw new TypeError(`${field} must not contain duplicates`)
    seen.add(root)
    roots.push(root)
  }
  return Object.freeze(roots)
}

export function normalizeDisabledSkills(value = []) {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw new TypeError(`disabledSkills must contain at most ${MAX_SKILLS} skill names`)
  const result = new Set()
  for (const name of value) {
    if (typeof name !== 'string' || !/^[\x00-\x7f]*$/u.test(name) || !isSkillName(name.toLowerCase())) {
      throw new TypeError(`disabledSkills contains an invalid skill name: ${String(name)}`)
    }
    result.add(name.toLowerCase())
  }
  return result
}

function normalizeProjectSkillNameList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) {
    throw new TypeError(`${field} must be an array with at most ${MAX_SKILLS} skill names`)
  }
  const result = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const name = value[index]
    if (typeof name !== 'string' || !isSkillName(name)) {
      throw new TypeError(`${field}[${index}] must be a valid skill name`)
    }
    if (seen.has(name)) throw new TypeError(`${field} must not contain duplicate names`)
    seen.add(name)
    result.push(name)
  }
  return Object.freeze(result)
}

export function normalizeEnabledProjectSkills(value) {
  if (value === undefined || value === null) return undefined
  return normalizeProjectSkillNameList(value, 'enabledProjectSkills')
}

export function normalizeDisabledProjectSkills(value = []) {
  return normalizeProjectSkillNameList(value, 'disabledProjectSkills')
}

function parseYamlBoolean(value, field, defaultValue, formatCompatibility = false) {
  if (value === undefined) return defaultValue
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
      case '1':
        return true
      case 'false':
      case 'no':
      case 'off':
      case '0':
        return false
      default:
        break
    }
  }
  if (formatCompatibility) return defaultValue
  throw new SkillFormatError(`frontmatter field ${field} must be boolean`)
}

function hasComplexMappingKey(node, seen = new WeakSet()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false
  seen.add(node)
  if (node.key && Array.isArray(node.key.items)) return true
  if (!Array.isArray(node.items)) return false
  return node.items.some(item => {
    if (!item || typeof item !== 'object') return false
    if (item.key && Array.isArray(item.key.items)) return true
    return hasComplexMappingKey(item.key, seen) || hasComplexMappingKey(item.value, seen) || hasComplexMappingKey(item, seen)
  })
}

function assertJsonValue(value, depth = 0) {
  if (depth > 12) throw new SkillFormatError('frontmatter metadata is too deeply nested')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1)
    return
  }
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const item of Object.values(value)) assertJsonValue(item, depth + 1)
    return
  }
  throw new SkillFormatError('frontmatter metadata must contain JSON-compatible values')
}

export function resolveCompatibleSkillReferences(content, basePath) {
  if (typeof basePath !== 'string' || basePath.length === 0 || basePath.length > 4_096 || basePath.includes('\0')) return content
  const base = basePath.replace(/[\\/]$/u, '')
  const windows = !base.startsWith('/') && win32.isAbsolute(base)
  const absolute = windows || posix.isAbsolute(base)
  if (!absolute) return content
  const pathApi = windows ? win32 : posix
  let matches = 0
  let result = ''
  let cursor = 0
  let rejected = false
  const pattern = /(?<![a-zA-Z0-9="\(])@([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.\-\/]*)/g
  for (const match of content.matchAll(pattern)) {
    matches += 1
    if (matches > MAX_COMPAT_REFERENCE_MATCHES) return content
    const reference = match[1]
    const lastSegment = reference.split('/').at(-1) ?? ''
    if (!reference.endsWith('/') && !/\.[a-zA-Z0-9]+$/u.test(lastSegment)) continue
    const nextIndex = match.index + match[0].length
    const nextCharacter = content[nextIndex]
    // The pinned pattern stops at '#', but downstream path consumers do not.
    // Refuse a replacement when the unconsumed suffix could retarget the path.
    if (nextCharacter === '#' || nextCharacter === '\\' || (windows && nextCharacter === ':')) continue
    const resolved = pathApi.resolve(base, reference)
    const relativePath = pathApi.relative(base, resolved)
    if (relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) continue
    const displayPath = windows ? resolved.replaceAll('\\', '/') : resolved
    const replacement = `${displayPath}${reference.endsWith('/') && !displayPath.endsWith('/') ? '/' : ''}`
    if (Buffer.byteLength(result) + Buffer.byteLength(content.slice(cursor, match.index)) + Buffer.byteLength(replacement) > MAX_SKILL_BYTES) {
      rejected = true
      break
    }
    result += content.slice(cursor, match.index) + replacement
    cursor = match.index + match[0].length
  }
  if (rejected || cursor === 0) return content
  result += content.slice(cursor)
  return Buffer.byteLength(result) <= MAX_SKILL_BYTES ? result : content
}

function parseSkillDocument(source, { formatCompatibility = false, defaultName, modelScope = 'opencode' } = {}) {
  if (typeof source !== 'string') throw new SkillFormatError('skill file is not text')
  const unprefixed = source.replace(/^\uFEFF/u, '')
  const pinnedFrontmatter = formatCompatibility
    ? /^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/u.exec(unprefixed)
    : undefined
  const normalized = unprefixed.replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  const standaloneFrontmatter = lines[0] === '---'
  const end = standaloneFrontmatter ? lines.indexOf('---', 1) : -1
  // The pinned parser requires a newline after the closing delimiter. At EOF
  // its no-match result treats the whole document as Markdown, not metadata.
  const hasFrontmatter = standaloneFrontmatter
    && !(formatCompatibility && !pinnedFrontmatter && (end < 0 || end === lines.length - 1))
  if (!hasFrontmatter && !formatCompatibility) throw new SkillFormatError('skill file must begin with YAML frontmatter')
  if (hasFrontmatter && end < 0 && !pinnedFrontmatter) throw new SkillFormatError('skill YAML frontmatter has no closing delimiter')
  let originalBody
  if (formatCompatibility && pinnedFrontmatter) {
    originalBody = pinnedFrontmatter[2]
  } else if (formatCompatibility && hasFrontmatter) {
    // Retain the local standalone-delimiter fallback for source shapes the
    // pinned parser does not accept, mapping it back to original line endings.
    let originalOffset = 0
    for (let lineIndex = 0; lineIndex <= end; lineIndex += 1) {
      const newline = unprefixed.indexOf('\n', originalOffset)
      const carriage = unprefixed.indexOf('\r', originalOffset)
      const candidates = [newline, carriage].filter(index => index >= 0)
      const breakIndex = candidates.length > 0 ? Math.min(...candidates) : -1
      if (lineIndex === end) {
        originalBody = breakIndex < 0 ? '' : unprefixed.slice(breakIndex + (unprefixed[breakIndex] === '\r' && unprefixed[breakIndex + 1] === '\n' ? 2 : 1))
        break
      }
      if (breakIndex < 0) break
      originalOffset = breakIndex + (unprefixed[breakIndex] === '\r' && unprefixed[breakIndex + 1] === '\n' ? 2 : 1)
    }
  }

  let frontmatter = {}
  if (hasFrontmatter) {
    let document
    try {
      document = parseDocument(pinnedFrontmatter ? pinnedFrontmatter[1] : lines.slice(1, end).join('\n'), {
        schema: formatCompatibility ? 'json' : 'core',
        uniqueKeys: true,
        ...(formatCompatibility ? {
          customTags: tags => tags.concat(Object.entries(JSON_TAG_RESOLVERS).map(([tag, resolve]) => ({ tag, default: false, resolve }))),
        } : {}),
      })
    } catch {
      throw new SkillFormatError('skill YAML frontmatter is invalid')
    }
    const parseErrors = formatCompatibility
      ? [
          ...document.errors.filter(error => error?.code !== 'TAG_RESOLVE_FAILED' || !String(error.message).startsWith('Unresolved plain scalar ')),
          ...document.warnings.filter(error => error?.code === 'TAG_RESOLVE_FAILED'),
          ...(hasComplexMappingKey(document.contents) ? [new Error('complex mapping key') ] : []),
        ]
      : document.errors
    if (parseErrors.length > 0 && !(formatCompatibility && pinnedFrontmatter)) {
      throw new SkillFormatError('skill YAML frontmatter is invalid')
    }
    try {
      if (parseErrors.length > 0 && formatCompatibility && pinnedFrontmatter) {
        // Pinned OpenCode discards malformed frontmatter and retains the body.
      } else {
        frontmatter = document.toJS({ maxAliasCount: 0 })
        if (formatCompatibility && (document.contents === null || frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter))) frontmatter = {}
      }
    } catch {
      throw new SkillFormatError('skill YAML frontmatter cannot be represented safely')
    }
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter) || (Object.getPrototypeOf(frontmatter) !== Object.prototype && Object.getPrototypeOf(frontmatter) !== null)) {
    throw new SkillFormatError('skill YAML frontmatter must be a mapping')
  }

  const name = formatCompatibility ? String(frontmatter.name || defaultName) : frontmatter.name
  const description = formatCompatibility
    ? String(frontmatter.description || '')
    : frontmatter.description
  const whenToUse = frontmatter.whenToUse
  if (typeof name !== 'string' || !isSkillName(name)) throw new SkillFormatError('skill frontmatter name must be a valid kebab-case name')
  if (typeof description !== 'string' || (!formatCompatibility && description.trim().length === 0) || description.length > 2_000) {
    throw new SkillFormatError('skill frontmatter description must be a non-empty string no longer than 2000 characters')
  }
  if (whenToUse !== undefined && (typeof whenToUse === 'string' ? whenToUse.length > 2_000 : !formatCompatibility)) {
    throw new SkillFormatError('skill frontmatter whenToUse must be a string no longer than 2000 characters')
  }
  const allowedTools = frontmatter['allowed-tools']
  if (formatCompatibility && allowedTools && typeof allowedTools !== 'string'
    && (!Array.isArray(allowedTools) || allowedTools.some(tool => typeof tool !== 'string'))) {
    throw new SkillFormatError('skill frontmatter allowed-tools must be a string or an array of strings')
  }

  const compatibleMetadataKeys = new Set([
    'model', 'agent', 'subtask', 'argument-hint', 'license', 'compatibility',
    'metadata', 'allowed-tools', 'mcp', 'disable-model-invocation', 'user-invocable',
  ])
  const reservedMetadata = formatCompatibility && Object.hasOwn(frontmatter, 'metadata')
  const metadata = reservedMetadata ? frontmatter.metadata : Object.create(null)
  if (reservedMetadata && frontmatter.metadata !== undefined) assertJsonValue(frontmatter.metadata)
  for (const [key, value] of Object.entries(frontmatter)) {
    if (FRONTMATTER_FIELDS.has(key) || (formatCompatibility && (key === 'metadata' || (key === 'allowed-tools' && !allowedTools)))) continue
    if (formatCompatibility && ['agent', 'subtask', 'argument-hint', 'license', 'compatibility'].includes(key)) continue
    if (formatCompatibility && key === 'model') {
      if (!reservedMetadata || (metadata && !Array.isArray(metadata) && typeof metadata === 'object'
        && (Object.getPrototypeOf(metadata) === Object.prototype || Object.getPrototypeOf(metadata) === null))) {
        if (modelScope === 'opencode' && typeof value === 'string' && value.trim().length > 0) metadata.model = value.trim()
        else if (!reservedMetadata) delete metadata.model
      }
      continue
    }
    if (formatCompatibility && !compatibleMetadataKeys.has(key)) continue
    assertJsonValue(value)
    if (!reservedMetadata) metadata[key] = value
  }
  const hasMetadata = reservedMetadata || Object.keys(metadata).length > 0
  const invocation = {
    modelInvocable: !parseYamlBoolean(frontmatter['disable-model-invocation'], 'disable-model-invocation', false, formatCompatibility),
    userInvocable: parseYamlBoolean(frontmatter['user-invocable'], 'user-invocable', true, formatCompatibility),
  }

  return {
    name,
    description,
    ...(whenToUse === undefined || (formatCompatibility && typeof whenToUse !== 'string') ? {} : { whenToUse }),
    ...(hasMetadata ? { metadata } : {}),
    ...(formatCompatibility ? {
      agent: frontmatter.agent,
      subtask: frontmatter.subtask,
      argumentHint: frontmatter['argument-hint'],
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
    } : {}),
    invocation,
    content: formatCompatibility
      ? (hasFrontmatter
        ? (originalBody ?? lines.slice(end + 1).join('\n').replace(/^\n/u, ''))
        : unprefixed).trim()
      : lines.slice(end + 1).join('\n').replace(/^\n/u, ''),
  }
}

async function readSkillFile(ctx, target, signal, byteLimit = MAX_SKILL_BYTES, formatOptions) {
  throwIfAborted(signal)
  const info = await ctx.fs.stat(target, signal)
  if (!info || info.type !== 'file') throw new SkillFormatError('skill instruction path is not a regular file')
  if (info.size !== undefined && (!Number.isSafeInteger(info.size) || info.size < 0)) {
    throw new SkillFormatError('skill instruction file has invalid size metadata')
  }
  if (info.size !== undefined && info.size > MAX_SKILL_BYTES) {
    throw new SkillFormatError(`skill instruction file exceeds the ${MAX_SKILL_BYTES}-byte limit`)
  }
  if (info.size !== undefined && info.size > byteLimit) throw new ScanBudgetError('project skill scan byte budget reached')
  let bytes
  try {
    bytes = await ctx.fs.readBytes(target, signal, byteLimit)
  } catch (error) {
    if (error?.code === 'FS_TOO_LARGE') {
      if (byteLimit < MAX_SKILL_BYTES) throw new ScanBudgetError('project skill scan byte budget reached', byteLimit)
      throw new SkillFormatError(`skill instruction file exceeds the ${MAX_SKILL_BYTES}-byte limit`, byteLimit)
    }
    throw error
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new SkillFormatError('filesystem backend returned non-byte skill content', byteLimit)
  }
  if (bytes.byteLength > byteLimit) throw new ScanBudgetError('filesystem backend exceeded the project skill read limit', byteLimit)
  let afterInfo
  try {
    afterInfo = await ctx.fs.stat(target, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    const readError = new Error('project skill file could not be revalidated after reading', { cause: error })
    readError.bytesRead = bytes.byteLength
    throw readError
  }
  if (!afterInfo || afterInfo.type !== 'file'
    || (info.version !== undefined && afterInfo.version !== info.version)
    || (info.size !== undefined && afterInfo.size !== info.size)) {
    const error = new Error('project skill file changed while it was being read')
    error.bytesRead = bytes.byteLength
    throw error
  }
  throwIfAborted(signal)
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SkillFormatError('skill instruction file is not valid UTF-8 text', bytes.byteLength)
  }
  try {
    return { ...parseSkillDocument(source, formatOptions), byteLength: bytes.byteLength }
  } catch (error) {
    if (error instanceof SkillFormatError) {
      error.bytesRead = bytes.byteLength
      throw error
    }
    throw new SkillFormatError('skill instruction frontmatter could not be parsed safely', bytes.byteLength)
  }
}

function sourceForDirectory(directory) {
  if (directory === '.opencode/skills' || directory === '.opencode/skill') return 'project-opencode'
  if (directory === '.claude/skills') return 'project-claude'
  if (directory === '.agents/skills') return 'project-agents'
  return 'project-local'
}

async function isContainedSkillPath(ctx, { cwd, cwdTarget, rootPath, rootTarget, fileTarget, resolverPath, signal, allowSymlink = true }) {
  const fs = ctx.fs
  if (typeof fs.lstat !== 'function') return false
  const lexicalInfo = await fs.lstat(resolverPath, { cwd }, signal)
  if (!lexicalInfo || (lexicalInfo.type !== 'file' && lexicalInfo.type !== 'symlink') || (!allowSymlink && lexicalInfo.type === 'symlink')) return false
  const currentRoot = await fs.resolve(rootPath, { cwd, signal })
  const currentFile = await fs.resolve(resolverPath, { cwd, signal })
  return fs.contains(cwdTarget, currentRoot)
    && fs.contains(rootTarget, currentFile)
    && currentFile.targetKey === fileTarget.targetKey
}

function isSafeEntryName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 512
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0')
}

function compatibleSkillDescription(description, scope) {
  const formatted = `(${scope} - Skill) ${description}`
  if (formatted.length > 2_000) throw new SkillFormatError('skill description exceeds the 2000-character limit after scope formatting')
  return formatted
}

function skillDescriptionScope(rootPath, userRoot) {
  if (userRoot?.source === 'user-opencode') return 'opencode'
  if (userRoot) return 'user'
  return rootPath === '.opencode/skills' || rootPath === '.opencode/skill' ? 'opencode-project' : 'project'
}

function sameSkillField(left, right) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((value, index) => sameSkillField(value, right[index]))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameSkillField(left[key], right[key]))
}

function matchesCandidate(skill, candidate, disabledSkills) {
  const disabled = disabledSkills.has(skill.name)
  const invocation = {
    modelInvocable: skill.invocation.modelInvocable && !disabled,
    userInvocable: skill.invocation.userInvocable && !disabled,
  }
  return skill.name === candidate.name
    && skill.description === candidate.description
    && skill.whenToUse === candidate.whenToUse
    && invocation.modelInvocable === candidate.invocation.modelInvocable
    && invocation.userInvocable === candidate.invocation.userInvocable
    && sameSkillField(skill.metadata, candidate.metadata)
    && sameSkillField(skill.agent, candidate.agent) && sameSkillField(skill.subtask, candidate.subtask)
    && sameSkillField(skill.argumentHint, candidate.argumentHint) && sameSkillField(skill.license, candidate.license)
    && sameSkillField(skill.compatibility, candidate.compatibility)
}

function skillFormatPaths(rootPath, resolverPath) {
  if (typeof rootPath !== 'string' || typeof resolverPath !== 'string' || !resolverPath.startsWith(`${rootPath}/`)) return undefined
  const parts = resolverPath.slice(rootPath.length + 1).split('/')
  if (!parts.every(isSafeEntryName) || parts.some(part => part.startsWith('.'))) return undefined
  if (parts.length === 1 && parts[0].endsWith('.md')) {
    return { defaultName: parts[0].slice(0, -3) }
  }
  const directories = parts.slice(0, -1)
  const fileName = parts.at(-1)
  if (directories.length >= 1 && directories.length <= MAX_COMPAT_DIRECTORY_DEPTH) {
    const directoryName = directories.at(-1)
    const isDirectorySkill = fileName === 'SKILL.md' || fileName === `${directoryName}.md`
    const ancestorDirectories = isDirectorySkill ? directories.slice(0, -1) : directories
    const ancestorPaths = ancestorDirectories.flatMap((name, index) => {
      const directoryPath = `${rootPath}/${directories.slice(0, index + 1).join('/')}`
      return [`${directoryPath}/SKILL.md`, `${directoryPath}/${name}.md`]
    })
    if (fileName === 'SKILL.md') return { defaultName: directoryName, ancestorPaths }
    if (fileName === `${directoryName}.md`) {
      return {
        defaultName: directoryName,
        ancestorPaths,
        primaryPath: `${rootPath}/${directories.join('/')}/SKILL.md`,
      }
    }
    if (directories.length < MAX_COMPAT_DIRECTORY_DEPTH && fileName.endsWith('.md')) {
      return { defaultName: fileName.slice(0, -3), ancestorPaths }
    }
  }
  return undefined
}

export function createProjectSkillProvider(ctx, control, options = {}) {
  const fs = ctx.fs
  const formatCompatibility = options.formatCompatibility === undefined ? false : options.formatCompatibility
  if (typeof formatCompatibility !== 'boolean') throw new TypeError('formatCompatibility must be boolean')
  const primaryIsAbsent = async (path, cwd, signal) => {
    const directory = await fs.resolve(dirname(path), { cwd, signal })
    const entries = await fs.listDir(directory, signal)
    // Directory entries preserve exact case even when lstat is case-insensitive.
    if (!Array.isArray(entries)) return false
    const primary = entries.find(entry => entry.name === basename(path))
    if (!primary) return true
    // fs.access in the pinned loader follows links: a dangling canonical is
    // absent, while an existing invalid or escaping canonical still wins.
    return !await fs.stat(primary.target, signal)
  }
  const formatPathsStillEligible = async (paths, cwd, signal) => {
    if (!paths) return false
    for (const path of [...(paths.ancestorPaths ?? []), ...(paths.primaryPath ? [paths.primaryPath] : [])]) {
      if (!await primaryIsAbsent(path, cwd, signal)) return false
    }
    return true
  }
  const userOpenCodeRoots = normalizeUserSkillRoots(options.userOpenCodeSkillRoots, 'userOpenCodeSkillRoots')
  const userClaudeRoots = normalizeUserSkillRoots(options.userClaudeSkillRoots, 'userClaudeSkillRoots')
  const userAgentsRoots = normalizeUserSkillRoots(options.userAgentsSkillRoots, 'userAgentsSkillRoots')
  const userRoots = [
    ...userOpenCodeRoots.map((rootPath, index) => ({ rootPath, source: 'user-opencode', rank: USER_SKILL_RANK + index })),
    ...userClaudeRoots.map((rootPath, index) => ({ rootPath, source: 'user-claude', rank: USER_SKILL_RANK + userOpenCodeRoots.length + index })),
    // Keep the existing roots' numeric ranks unchanged and all user roots below runtime rank 250.
    ...userAgentsRoots.map((rootPath, index) => ({ rootPath, source: 'user-agents', rank: USER_SKILL_RANK + userOpenCodeRoots.length + userClaudeRoots.length - 0.5 + index * 0.25 })),
  ]
  const configuredUserRoot = candidate => {
    const source = candidate?.locator?.userRoot
    const rootPath = candidate?.locator?.rootPath
    if (typeof source !== 'string' || typeof rootPath !== 'string' || candidate.source !== source) return undefined
    return userRoots.find(root => root.rootPath === rootPath && root.source === source)
  }
  const directories = normalizeProjectSkillDirs(options.projectSkillDirs)
  const discoveryRoots = formatCompatibility ? [
    ...directories.filter(rootPath => rootPath === '.opencode/skills' || rootPath === '.opencode/skill').map((rootPath, index) => ({ rootPath, rank: PROJECT_SKILL_RANK + index })),
    ...userRoots.filter(root => root.source === 'user-opencode').map((root, index) => ({ ...root, rank: USER_SKILL_RANK - 1 + index * 0.25 })),
    ...directories.filter(rootPath => rootPath === '.claude/skills').map((rootPath, index) => ({ rootPath, rank: USER_SKILL_RANK + index * 0.25 })),
    ...directories.filter(rootPath => rootPath === '.agents/skills').map((rootPath, index) => ({ rootPath, rank: USER_SKILL_RANK + userClaudeRoots.length * 0.25 + index * 0.25 })),
    ...userRoots.filter(root => root.source === 'user-claude').map((root, index) => ({ ...root, rank: USER_SKILL_RANK + 1 + index * 0.25 })),
    ...userRoots.filter(root => root.source === 'user-agents').map((root, index) => ({ ...root, rank: USER_SKILL_RANK + 1 + userClaudeRoots.length * 0.25 + index * 0.25 })),
  ] : [...directories.map((rootPath, index) => ({ rootPath, rank: PROJECT_SKILL_RANK + index })), ...userRoots]
  const disabledSkills = normalizeDisabledSkills(options.disabledSkills)
  const enabledProjectSkills = normalizeEnabledProjectSkills(options.enabledProjectSkills)
  const enabledProjectSkillSet = enabledProjectSkills === undefined ? undefined : new Set(enabledProjectSkills)
  const disabledProjectSkillSet = new Set(normalizeDisabledProjectSkills(options.disabledProjectSkills))
  const watcherLimit = options.watcherLimit === undefined ? MAX_WATCHERS : options.watcherLimit
  if (!Number.isSafeInteger(watcherLimit) || watcherLimit < 1 || watcherLimit > MAX_WATCHERS) {
    throw new TypeError(`watcherLimit must be an integer from 1 to ${MAX_WATCHERS}`)
  }
  const watchers = new Map()
  const pendingWatches = new Map()
  const closingWatchers = new Set()
  const failedWatchKeys = new Set()
  let closed = false
  let watchCapacityWarned = false
  let watchRevision = 0
  let observationRevision = 0

  const invalidateObservation = () => {
    observationRevision += 1
    control.invalidate()
  }

  const markWatchFailed = key => {
    failedWatchKeys.add(key)
    if (failedWatchKeys.size > MAX_WATCHERS) failedWatchKeys.delete(failedWatchKeys.values().next().value)
  }

  const closeWatcher = (watcher, message = 'dsh-omo could not close a project skill watcher') => {
    if (watcher.closePromise) return watcher.closePromise
    closingWatchers.add(watcher)
    watcher.controller.abort()
    watcher.closePromise = (async () => {
      try {
        await watcher.dispose()
        closingWatchers.delete(watcher)
      } catch (error) {
        // Keep failed disposals counted: the backend may still own a live handle.
        warn(ctx, message, error)
      }
    })()
    return watcher.closePromise
  }

  const waitForPending = (attempt, signal) => {
    if (signal?.aborted) return Promise.resolve(false)
    attempt.waiters += 1
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        attempt.waiters -= 1
        if (!attempt.settled && attempt.waiters === 0 && !closed && !control.signal.aborted) {
          attempt.controller.abort(new Error('Project skill watch has no active lookups'))
        }
        resolve(value)
      }
      const onAbort = () => finish(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      attempt.promise.then(finish, () => finish(false))
    })
  }

  const closeWatchers = () => {
    if (closed) return
    closed = true
    const close = [...watchers.values()]
    const pending = [...pendingWatches.values()]
    watchers.clear()
    for (const watcher of close) void closeWatcher(watcher)
    for (const attempt of pending) attempt.controller.abort()
  }
  control.signal.addEventListener('abort', closeWatchers, { once: true })

  const liveWatcherCount = () => {
    let count = watchers.size + closingWatchers.size
    // Acquired pending attempts already appear in watchers or closingWatchers; count only in-flight acquisitions here.
    for (const attempt of pendingWatches.values()) {
      if (!attempt.acquired) count += 1
    }
    return count
  }

  const ensureWatch = async (target, signal, revision, reclaimOnChange = false, symlinkParent = false) => {
    if (closed || control.signal.aborted || signal?.aborted || revision !== watchRevision) return false
    const key = target.targetKey
    const existing = watchers.get(key)
    if (existing && !failedWatchKeys.has(key)) {
      if (reclaimOnChange) existing.reclaimOnChange = true
      if (symlinkParent) existing.symlinkParent = true
      return true
    }
    const pending = pendingWatches.get(key)
    if (pending) {
      if (pending.retired) return false
      if (reclaimOnChange) pending.reclaimOnChange = true
      if (symlinkParent) pending.symlinkParent = true
      if (pending.controller.signal.aborted && !pending.settled) {
        const result = await waitForPending(pending, signal)
        if (result || signal?.aborted || closed || revision !== watchRevision) return result && revision === watchRevision
        return ensureWatch(target, signal, revision, reclaimOnChange, symlinkParent)
      }
      return waitForPending(pending, signal)
    }

    const previous = watchers.get(key)
    watchers.delete(key)
    failedWatchKeys.delete(key)
    if (previous) await closeWatcher(previous, 'dsh-omo could not replace a project skill watcher')
    if (closed || control.signal.aborted || signal?.aborted || revision !== watchRevision) return false
    if (liveWatcherCount() >= watcherLimit) {
      if (!watchCapacityWarned) {
        watchCapacityWarned = true
        warn(ctx, 'dsh-omo project skill watcher capacity reached; catalog will remain uncached', new Error('Watcher capacity'))
      }
      return false
    }

    const controller = new AbortController()
    const attempt = { controller, promise: undefined, waiters: 0, settled: false, acquired: false, reclaimOnChange, symlinkParent, retired: false }
    pendingWatches.set(key, attempt)
    // Assign the shared promise before invoking a backend that may throw synchronously.
    attempt.promise = Promise.resolve().then(async () => {
      try {
        if (closed || control.signal.aborted || controller.signal.aborted) return false
        const dispose = await fs.watch(target, error => {
          if (control.signal.aborted || controller.signal.aborted || attempt.retired) return
          const active = watchers.get(key)
          if (active && active.controller !== controller) return
          if (!active && pendingWatches.get(key) !== attempt) return
          observationRevision += 1
          if (active?.symlinkParent ?? attempt.symlinkParent) {
            watchRevision += 1
            const retiring = [...watchers.values()]
            watchers.clear()
            for (const watcher of retiring) closingWatchers.add(watcher)
            const pending = [...pendingWatches.values()]
            for (const item of pending) item.retired = true
            for (const item of pending) item.controller.abort()
            try {
              control.invalidate()
            } finally {
              for (const watcher of retiring) void closeWatcher(watcher, 'dsh-omo could not close a retired project skill watcher')
            }
            if (error) warn(ctx, 'dsh-omo project skill watcher reported an error', error)
            return
          }
          let retire
          if (error || (active?.reclaimOnChange ?? attempt.reclaimOnChange)) {
            // Any scan that used this handle must not publish a cacheable result.
            watchRevision += 1
            attempt.retired = true
            if (error) markWatchFailed(key)
            if (active?.controller === controller) {
              watchers.delete(key)
              retire = active
              // Reserve capacity before invalidation can re-enter discovery.
              closingWatchers.add(active)
            }
          }
          try {
            control.invalidate()
          } finally {
            if (retire) void closeWatcher(retire, 'dsh-omo could not close a retired project skill watcher')
          }
          if (error) warn(ctx, 'dsh-omo project skill watcher reported an error', error)
        }, controller.signal)
        attempt.acquired = true
        if (closed || control.signal.aborted || controller.signal.aborted || attempt.retired || failedWatchKeys.has(key)) {
          await closeWatcher({ controller, dispose }, 'dsh-omo could not close an uninstalled project skill watcher')
          return false
        }
        watchers.set(key, { controller, dispose, reclaimOnChange: attempt.reclaimOnChange, symlinkParent: attempt.symlinkParent })
        attempt.settled = true
        return true
      } catch (error) {
        if (!control.signal.aborted && !controller.signal.aborted) {
          markWatchFailed(key)
          warn(ctx, 'dsh-omo could not watch a project skill path; catalog will remain uncached', error)
        }
        return false
      } finally {
        attempt.settled = true
        if (pendingWatches.get(key) === attempt) pendingWatches.delete(key)
      }
    })
    return waitForPending(attempt, signal)
  }

  const watchAbsoluteSkillRoot = async (rootPath, cwd, signal, revision, missing) => {
    const anchor = parsePath(rootPath).root
    const lexicalPath = relative(anchor, rootPath)
    let anchorTarget
    try {
      anchorTarget = await fs.resolve(anchor, { cwd, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      return false
    }
    if (!await watchSymlinkParents(lexicalPath, anchor, anchorTarget, signal, revision)) return false
    let currentPath = rootPath
    while (true) {
      const parentPath = dirname(currentPath)
      try {
        const parentTarget = await fs.resolve(parentPath, { cwd, signal })
        if (!await ensureWatch(parentTarget, signal, revision, false, true)) return false
        const info = await fs.stat(parentTarget, signal)
        if (info?.type === 'directory') return ensureWatch(parentTarget, signal, revision, missing, true)
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code !== 'FS_NOT_FOUND') return false
      }
      if (parentPath === currentPath) return false
      currentPath = parentPath
    }
  }

  const watchNearestExistingAncestor = async (rootPath, cwd, cwdTarget, signal, revision) => {
    let currentTarget = cwdTarget
    let prefix = ''
    for (const segment of rootPath.split('/')) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      let target
      try {
        target = await fs.resolve(prefix, { cwd, signal })
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code !== 'FS_NOT_FOUND') return false
        return ensureWatch(currentTarget, signal, revision, true, true)
      }
      if (!fs.contains(cwdTarget, target)) return false
      let info
      try {
        info = await fs.stat(target, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        return false
      }
      if (!info || info.type !== 'directory') return ensureWatch(currentTarget, signal, revision, true, true)
      currentTarget = target
    }
    return ensureWatch(currentTarget, signal, revision, true, true)
  }

  const watchSymlinkParents = async (rootPath, cwd, cwdTarget, signal, revision) => {
    let prefix = ''
    let parentTarget = cwdTarget
    const segments = rootPath.split(/[\\/]/u)
    for (let index = 0; index < segments.length; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]
      // Observe each lexical parent before examining its child: a directory can
      // become a symlink between lstat and resolve, or after discovery.
      if (!await ensureWatch(parentTarget, signal, revision, false, true)) return false
      let pathInfo
      try {
        pathInfo = await fs.lstat(prefix, { cwd }, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code === 'FS_NOT_FOUND') return ensureWatch(parentTarget, signal, revision, true, true)
        warn(ctx, 'dsh-omo could not inspect a project skill path component', error)
        return false
      }
      if (!pathInfo) return ensureWatch(parentTarget, signal, revision, true, true)
      if (pathInfo.type === 'symlink' && !await ensureWatch(parentTarget, signal, revision, false, true)) return false
      if (index === segments.length - 1) continue

      let target
      try {
        target = await fs.resolve(prefix, { cwd, signal })
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code === 'FS_NOT_FOUND') return ensureWatch(parentTarget, signal, revision, true, true)
        warn(ctx, 'dsh-omo could not resolve a project skill path component', error)
        return false
      }
      if (!fs.contains(cwdTarget, target)) return false
      let info
      try {
        info = await fs.stat(target, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        return false
      }
      if (!info || info.type !== 'directory') return ensureWatch(parentTarget, signal, revision, true, true)
      parentTarget = target
    }
    return true
  }

  const makeCandidate = (skill, rootPath, rootTarget, skillDirectoryTarget, fileTarget, rootIndex, resolverPath, userRoot, revision, allowSymlink = true) => {
    const invocation = {
      modelInvocable: skill.invocation.modelInvocable && !disabledSkills.has(skill.name),
      userInvocable: skill.invocation.userInvocable && !disabledSkills.has(skill.name),
    }
    return {
      name: skill.name,
      description: formatCompatibility
        ? compatibleSkillDescription(skill.description, skillDescriptionScope(rootPath, userRoot))
        : skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      path: fileTarget.displayPath,
      provider: PROJECT_SKILL_PROVIDER,
      source: userRoot?.source ?? sourceForDirectory(rootPath),
      resourceBase: { kind: 'directory', path: skillDirectoryTarget.displayPath },
      invocation,
      rank: formatCompatibility ? discoveryRoots[rootIndex].rank : userRoot ? userRoot.rank : PROJECT_SKILL_RANK + rootIndex,
      userRoot: userRoot?.source,
      locator: { rootTarget, skillDirectoryTarget, fileTarget, rootPath, resolverPath, userRoot: userRoot?.source, observationRevision: revision, allowSymlink },
      ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
      ...(formatCompatibility ? {
        agent: skill.agent, subtask: skill.subtask, argumentHint: skill.argumentHint,
        license: skill.license, compatibility: skill.compatibility,
      } : {}),
    }
  }

  const refresh = () => {
    // Reserve retiring handles before aborts or invalidation can re-enter discovery.
    watchRevision += 1
    observationRevision += 1
    const retiring = [...watchers.values()]
    watchers.clear()
    for (const watcher of retiring) closingWatchers.add(watcher)
    const pending = [...pendingWatches.values()]
    for (const attempt of pending) attempt.retired = true
    try {
      for (const attempt of pending) attempt.controller.abort()
      control.invalidate()
    } finally {
      for (const watcher of retiring) void closeWatcher(watcher, 'dsh-omo could not close a retired project skill watcher')
    }
  }

  const provider = {
    name: PROJECT_SKILL_PROVIDER,
    refresh,
    async list(lookup = {}) {
      const cwd = typeof lookup.cwd === 'string' ? lookup.cwd : ''
      if (!cwd && userRoots.length === 0) return { candidates: [], complete: true }
      const signal = lifecycleSignal(lookup.signal, control.signal)
      const candidates = []
      const startingWatchRevision = watchRevision
      const startingObservationRevision = observationRevision
      let complete = true
      let scannedEntries = 0
      let scannedBytes = 0
      let scanExhausted = false
      const limitEntries = entries => {
        const remaining = Math.max(0, MAX_SCAN_ENTRIES - scannedEntries)
        const bounded = entries.slice(0, remaining)
        scannedEntries += bounded.length
        if (bounded.length < entries.length) {
          complete = false
          scanExhausted = true
        }
        return bounded
      }
      let cwdTarget
      if (cwd) {
        try {
          throwIfAborted(signal)
          cwdTarget = await fs.resolve('.', { cwd, signal })
        } catch (error) {
          if (signal?.aborted) throw error
          warn(ctx, 'dsh-omo could not resolve the skill lookup cwd', error)
          if (userRoots.length === 0) return { candidates, complete: false }
        }
      }

      for (let rootIndex = 0; rootIndex < discoveryRoots.length; rootIndex += 1) {
        if (scanExhausted) break
        throwIfAborted(signal)
        const discoveryRoot = discoveryRoots[rootIndex]
        const userRoot = 'source' in discoveryRoot ? discoveryRoot : undefined
        const rootPath = discoveryRoot.rootPath
        if (!userRoot && !cwdTarget) { complete = false; continue }
        if (!userRoot && !await watchSymlinkParents(rootPath, cwd, cwdTarget, signal, startingWatchRevision)) complete = false
        if (userRoot && !await watchAbsoluteSkillRoot(rootPath, cwd, signal, startingWatchRevision, false)) complete = false
        let rootTarget
        try {
          rootTarget = await fs.resolve(rootPath, { cwd, signal })
        } catch (error) {
          if (signal?.aborted) throw error
          warn(ctx, 'dsh-omo could not resolve a project skill root', error)
          if (error?.code === 'FS_NOT_FOUND') {
            if (userRoot) {
              if (!await watchAbsoluteSkillRoot(rootPath, cwd, signal, startingWatchRevision, true)) complete = false
            } else if (!await watchNearestExistingAncestor(rootPath, cwd, cwdTarget, signal, startingWatchRevision)) complete = false
          } else {
            complete = false
          }
          continue
        }
        try {
          if (!userRoot && !fs.contains(cwdTarget, rootTarget)) {
            complete = false
            warn(ctx, 'dsh-omo skipped a project skill root outside its lookup cwd', new Error('Path containment rejected'))
            continue
          }
          if (userRoot) {
            const rootInfo = await fs.lstat(rootPath, { cwd, signal })
            if (!rootInfo || rootInfo.type !== 'directory') {
              complete = false
              continue
            }
          }
          if (!await ensureWatch(rootTarget, signal, startingWatchRevision, false, true)) complete = false
          const rootInfo = await fs.stat(rootTarget, signal)
          if (!rootInfo) continue
          if (rootInfo.type !== 'directory') {
            warn(ctx, 'dsh-omo skipped a project skill root that is not a directory', new Error('Not a directory'))
            continue
          }
          const entries = limitEntries(await fs.listDir(rootTarget, signal))
          let orderedEntries
          if (formatCompatibility) {
            if (entries.length > 0 && candidates.length >= MAX_SKILLS) {
              complete = false
              scanExhausted = true
              continue
            }
            // Classify only the already-budgeted root entries. listDir's type
            // is a hint and may be stale or describe a symlink; stat the
            // contained target, then recheck its type when processing it.
            const directoriesFirst = []
            const remaining = []
            for (const entry of entries) {
              throwIfAborted(signal)
              let info
              try {
                if (!isSafeEntryName(entry?.name)) { complete = false; continue }
                if (entry.name.startsWith('.') || !fs.contains(rootTarget, entry.target)) continue
                info = await fs.stat(entry.target, signal)
              } catch (error) {
                if (signal?.aborted) throw error
                complete = false
                warn(ctx, 'dsh-omo could not classify a project skill entry')
                continue
              }
              if (!info) { complete = false; continue }
              const classified = { entry, classifiedType: info.type }
              if (info.type === 'directory') directoriesFirst.push(classified)
              else remaining.push(classified)
            }
            orderedEntries = [...directoriesFirst, ...remaining]
          } else {
            orderedEntries = entries.map(entry => ({ entry }))
          }
          for (let orderedIndex = 0; orderedIndex < orderedEntries.length; orderedIndex += 1) {
            const orderedEntry = orderedEntries[orderedIndex]
            const { entry, classifiedType } = orderedEntry
            const relativeDirectoryPath = orderedEntry.relativePath ?? entry.name
            const directoryDepth = orderedEntry.directoryDepth ?? 1
            try {
              throwIfAborted(signal)
              if (candidates.length >= MAX_SKILLS) {
                complete = false
                scanExhausted = true
                break
              }
              if (!isSafeEntryName(entry.name)) {
                complete = false
                continue
              }
              if (formatCompatibility && entry.name.startsWith('.')) continue
              if (!fs.contains(rootTarget, entry.target)) continue
              const entryInfo = await fs.stat(entry.target, signal)
              if (!entryInfo) {
                complete = false
                continue
              }
              if (formatCompatibility && entryInfo.type !== classifiedType) {
                // The ordering decision may have become stale since classification.
                complete = false
                continue
              }

              let skillDirectoryTarget = rootTarget
              let fileTarget
              let resolverPath
              if (entryInfo.type === 'directory') {
                skillDirectoryTarget = entry.target
                if (!await ensureWatch(skillDirectoryTarget, signal, startingWatchRevision, false, true)) complete = false
                const allChildren = await fs.listDir(skillDirectoryTarget, signal)
                const children = limitEntries(allChildren)
                let skillFile = children.find(child => child.name === 'SKILL.md')
                let skillFileInfo
                let danglingCanonical = false
                if (skillFile && formatCompatibility) {
                  if (!fs.contains(rootTarget, skillFile.target)) continue
                  skillFileInfo = await fs.stat(skillFile.target, signal)
                  if (!skillFileInfo) {
                    danglingCanonical = true
                    skillFile = undefined
                  }
                }
                const directoryName = relativeDirectoryPath.slice(relativeDirectoryPath.lastIndexOf('/') + 1)
                let canonicalConfirmedAbsent = false
                if (!skillFile && formatCompatibility && children.length === allChildren.length) {
                  canonicalConfirmedAbsent = danglingCanonical || children.every(child => child.name !== 'SKILL.md')
                  if (!canonicalConfirmedAbsent) {
                    complete = false
                    continue
                  }
                  skillFile = children.find(child => child.name === `${directoryName}.md`)
                }
                if (skillFile && formatCompatibility && !skillFileInfo) {
                  if (!fs.contains(rootTarget, skillFile.target)) continue
                  skillFileInfo = await fs.stat(skillFile.target, signal)
                  if (!skillFileInfo) skillFile = undefined
                }
                if (!skillFile) {
                  if (formatCompatibility && canonicalConfirmedAbsent && directoryDepth < MAX_COMPAT_DIRECTORY_DEPTH) {
                    const nestedDirectories = []
                    const nestedFiles = []
                    for (const child of children) {
                      try {
                        throwIfAborted(signal)
                        if (!isSafeEntryName(child.name) || child.name.startsWith('.') || !fs.contains(rootTarget, child.target)) continue
                        if (danglingCanonical && child.name === 'SKILL.md') continue
                        if (child.name === `${directoryName}.md` && !skillFile) {
                          const namedInfo = await fs.stat(child.target, signal)
                          if (!namedInfo) continue
                        }
                        const childInfo = await fs.stat(child.target, signal)
                        if (!childInfo) { complete = false; continue }
                        if (childInfo.type === 'directory') {
                          nestedDirectories.push({
                            entry: child,
                            classifiedType: 'directory',
                            relativePath: `${relativeDirectoryPath}/${child.name}`,
                            directoryDepth: directoryDepth + 1,
                          })
                        } else if (childInfo.type === 'file' && child.name.endsWith('.md')) {
                          nestedFiles.push({
                            entry: child,
                            classifiedType: 'file',
                            relativePath: `${relativeDirectoryPath}/${child.name}`,
                            parentTarget: skillDirectoryTarget,
                          })
                        }
                      } catch (error) {
                        if (signal?.aborted) throw error
                        complete = false
                        warn(ctx, 'dsh-omo could not classify a nested project skill directory')
                      }
                    }
                    // Finish this container's recursive directories and flat files
                    // before advancing to its next sibling, matching upstream's
                    // per-container first-name-wins merge order.
                    orderedEntries.splice(orderedIndex + 1, 0, ...nestedDirectories, ...nestedFiles)
                  }
                  continue
                }
                if (!fs.contains(rootTarget, skillFile.target)) continue
                skillFileInfo ??= await fs.stat(skillFile.target, signal)
                if (!skillFileInfo) {
                  complete = false
                  continue
                }
                if (skillFileInfo.type !== 'file' || !fs.contains(rootTarget, skillFile.target)) continue
                fileTarget = skillFile.target
                resolverPath = `${rootPath}/${relativeDirectoryPath}/${skillFile.name}`
              } else if (entryInfo.type === 'file' && entry.name.endsWith('.md')) {
                skillDirectoryTarget = orderedEntry.parentTarget ?? rootTarget
                fileTarget = entry.target
                resolverPath = `${rootPath}/${relativeDirectoryPath}`
              } else {
                continue
              }

              if (!await ensureWatch(fileTarget, signal, startingWatchRevision, true)) complete = false
              const remainingBytes = MAX_SCAN_BYTES - scannedBytes
              if (remainingBytes <= 0) {
                complete = false
                scanExhausted = true
                break
              }
              let skill
              try {
                const formatPaths = formatCompatibility ? skillFormatPaths(rootPath, resolverPath) : undefined
                if (formatCompatibility && !formatPaths) continue
                if (formatCompatibility && !await formatPathsStillEligible(formatPaths, cwd, signal)) {
                  complete = false
                  continue
                }
                if (!await isContainedSkillPath(ctx, { cwd, cwdTarget: userRoot ? rootTarget : cwdTarget, rootPath, rootTarget, fileTarget, resolverPath, signal, allowSymlink: !formatCompatibility || entryInfo.type !== 'file' })) {
                  complete = false
                  continue
                }
                skill = await readSkillFile(ctx, fileTarget, signal, Math.min(MAX_SKILL_BYTES, remainingBytes), { formatCompatibility, defaultName: formatPaths?.defaultName, modelScope: userRoot?.source === 'user-opencode' || rootPath === '.opencode/skills' || rootPath === '.opencode/skill' ? 'opencode' : 'claude-code' })
                scannedBytes += skill.byteLength
                if (formatCompatibility && !await formatPathsStillEligible(formatPaths, cwd, signal)) {
                  complete = false
                  continue
                }
                if (!await isContainedSkillPath(ctx, { cwd, cwdTarget: userRoot ? rootTarget : cwdTarget, rootPath, rootTarget, fileTarget, resolverPath, signal, allowSymlink: !formatCompatibility || entryInfo.type !== 'file' })) {
                  complete = false
                  continue
                }
              } catch (error) {
                if (signal?.aborted) throw error
                if (!skill && Number.isSafeInteger(error?.bytesRead) && error.bytesRead > 0) scannedBytes += error.bytesRead
                if (error instanceof ScanBudgetError) {
                  complete = false
                  scanExhausted = true
                  break
                }
                if (error instanceof SkillFormatError) {
                  warn(ctx, 'dsh-omo skipped an invalid project skill file', error)
                } else {
                  complete = false
                  warn(ctx, 'dsh-omo could not read a project skill file', error)
                }
                continue
              }
              if (!userRoot && disabledProjectSkillSet.has(skill.name)) continue
              if (!userRoot && enabledProjectSkillSet && !enabledProjectSkillSet.has(skill.name)) continue
              if (formatCompatibility && entryInfo.type !== 'directory' && orderedEntry.parentTarget
                && candidates.some(existing => existing.name === skill.name && existing.locator.rootTarget.targetKey === rootTarget.targetKey
                  && existing.locator.skillDirectoryTarget.targetKey !== skillDirectoryTarget.targetKey)) continue
              const candidate = makeCandidate(skill, rootPath, rootTarget, skillDirectoryTarget, fileTarget, rootIndex, resolverPath, userRoot, startingObservationRevision, !formatCompatibility || entryInfo.type !== 'file')
              candidates.push(candidate)
            } catch (error) {
              if (signal?.aborted || !formatCompatibility) throw error
              if (error instanceof SkillFormatError) {
                warn(ctx, 'dsh-omo skipped an invalid project skill file', error)
              } else {
                complete = false
                warn(ctx, 'dsh-omo could not process a project skill entry')
              }
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error
          complete = false
          warn(ctx, 'dsh-omo could not list a project skill root', error)
        }
      }
      throwIfAborted(signal)
      return { candidates, complete: complete && startingWatchRevision === watchRevision && startingObservationRevision === observationRevision }
    },
    async get(candidate, lookup = {}) {
      const locator = candidate?.locator
      const userRoot = configuredUserRoot(candidate)
      if (!userRoot && disabledProjectSkillSet.has(candidate?.name)) return undefined
      if (!userRoot && enabledProjectSkillSet && !enabledProjectSkillSet.has(candidate?.name)) return undefined
      if (!locator?.rootTarget || !locator?.fileTarget || !locator?.skillDirectoryTarget || typeof locator.resolverPath !== 'string'
        || (typeof lookup.cwd === 'string' && lookup.cwd.length === 0 && !userRoot)) return undefined
      const signal = lifecycleSignal(lookup.signal, control.signal)
      throwIfAborted(signal)
      // The registry may have selected this locator immediately before a
      // this provider invalidated the catalog. Never load it across that event.
      if (locator.observationRevision !== observationRevision) return undefined
      try {
        const cwdTarget = !userRoot && lookup.cwd ? await fs.resolve('.', { cwd: lookup.cwd, signal }) : undefined
        const rootTarget = await fs.resolve(locator.rootPath, { cwd: userRoot ? locator.rootPath : lookup.cwd, signal })
        const fileTarget = await fs.resolve(locator.resolverPath, { cwd: userRoot ? locator.rootPath : lookup.cwd, signal })
        const skillDirectoryTarget = await fs.resolve(dirname(locator.resolverPath), { cwd: userRoot ? locator.rootPath : lookup.cwd, signal })
        if ((!userRoot && !fs.contains(cwdTarget, rootTarget)) || !fs.contains(rootTarget, fileTarget)
          || !fs.contains(rootTarget, skillDirectoryTarget)
          || (locator.rootTarget.targetKey !== rootTarget.targetKey) || (locator.fileTarget.targetKey !== fileTarget.targetKey)
          || (locator.skillDirectoryTarget.targetKey !== skillDirectoryTarget.targetKey)) {
          invalidateObservation()
          return undefined
        }
        const formatPaths = formatCompatibility ? skillFormatPaths(locator.rootPath, locator.resolverPath) : undefined
        if (formatCompatibility && !await formatPathsStillEligible(formatPaths, userRoot ? locator.rootPath : lookup.cwd, signal)) {
          invalidateObservation()
          return undefined
        }
        if (!await isContainedSkillPath(ctx, {
          cwd: userRoot ? locator.rootPath : lookup.cwd, cwdTarget: userRoot ? rootTarget : cwdTarget, rootPath: locator.rootPath, rootTarget, fileTarget, resolverPath: locator.resolverPath, signal, allowSymlink: locator.allowSymlink ?? true,
        })) {
          invalidateObservation()
          return undefined
        }
        const skill = await readSkillFile(ctx, fileTarget, signal, MAX_SKILL_BYTES, { formatCompatibility, defaultName: formatPaths?.defaultName, modelScope: userRoot?.source === 'user-opencode' || locator.rootPath === '.opencode/skills' || locator.rootPath === '.opencode/skill' ? 'opencode' : 'claude-code' })
        if (formatCompatibility && !await formatPathsStillEligible(formatPaths, userRoot ? locator.rootPath : lookup.cwd, signal)) {
          invalidateObservation()
          return undefined
        }
        if (!await isContainedSkillPath(ctx, {
          cwd: userRoot ? locator.rootPath : lookup.cwd,
          cwdTarget: userRoot ? rootTarget : cwdTarget,
          rootPath: locator.rootPath,
          rootTarget,
          fileTarget,
          resolverPath: locator.resolverPath,
          signal,
          allowSymlink: locator.allowSymlink ?? true,
        })) {
          invalidateObservation()
          return undefined
        }
        const currentSkillDirectoryTarget = await fs.resolve(dirname(locator.resolverPath), { cwd: userRoot ? locator.rootPath : lookup.cwd, signal })
        if (!fs.contains(rootTarget, currentSkillDirectoryTarget)
          || currentSkillDirectoryTarget.targetKey !== locator.skillDirectoryTarget.targetKey) {
          invalidateObservation()
          return undefined
        }
        throwIfAborted(signal)
        if (locator.observationRevision !== observationRevision) return undefined
        const candidateMatches = matchesCandidate(formatCompatibility
          ? { ...skill, description: compatibleSkillDescription(skill.description, skillDescriptionScope(locator.rootPath, userRoot)) }
          : skill, candidate, disabledSkills)
        if (!candidateMatches) {
          invalidateObservation()
          return undefined
        }
        if (formatCompatibility) {
          const fresh = await provider.list({ cwd: lookup.cwd, signal })
          throwIfAborted(signal)
          const current = fresh.candidates.find(item => item.name === candidate.name)
          if (!fresh.complete || !current
            || current.locator.rootPath !== locator.rootPath || current.locator.resolverPath !== locator.resolverPath
            || current.locator.fileTarget.targetKey !== locator.fileTarget.targetKey) {
            invalidateObservation()
            return undefined
          }
          if (locator.observationRevision !== observationRevision) return undefined
        }
        return {
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
          path: candidate.path,
          provider: PROJECT_SKILL_PROVIDER,
          source: candidate.source,
          resourceBase: candidate.resourceBase,
          invocation: candidate.invocation,
          content: formatCompatibility
            ? resolveCompatibleSkillReferences(skill.content, locator.skillDirectoryTarget.displayPath)
            : skill.content,
          ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
          ...(formatCompatibility ? {
            agent: skill.agent, subtask: skill.subtask, argumentHint: skill.argumentHint,
            license: skill.license, compatibility: skill.compatibility,
          } : {}),
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (!(error instanceof SkillFormatError)) warn(ctx, 'dsh-omo could not reload a project skill file', error)
        invalidateObservation()
        return undefined
      }
    },
  }

  return provider
}

export function registerProjectSkillProvider(ctx, options = {}) {
  let provider
  const dispose = ctx.skills.registerProvider(registeredControl => {
    provider = createProjectSkillProvider(ctx, registeredControl, options)
    return provider
  })
  return Object.freeze({
    refresh() {
      provider?.refresh()
    },
    dispose,
  })
}
