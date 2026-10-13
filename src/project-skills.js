import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parseDocument } from 'yaml'

export const PROJECT_SKILL_PROVIDER = 'dsh-omo-project-skills'
export const DEFAULT_PROJECT_SKILL_DIRS = Object.freeze(['.opencode/skills', '.claude/skills'])

const MAX_SKILL_BYTES = 256 * 1024
const MAX_SKILLS = 256
const MAX_SCAN_ENTRIES = 512
const MAX_SCAN_BYTES = 8 * 1024 * 1024
const MAX_PROJECT_SKILL_DIRS = 16
const MAX_WATCHERS = 1_024
// Keep every configured root (230–245) ahead of DSH runtime rank 250.
const PROJECT_SKILL_RANK = 230
const FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'whenToUse',
  'disable-model-invocation',
  'user-invocable',
])

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

function normalizeDisabledSkills(value = []) {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw new TypeError(`disabledSkills must contain at most ${MAX_SKILLS} skill names`)
  const result = new Set()
  for (const name of value) {
    if (typeof name !== 'string' || !isSkillName(name)) {
      throw new TypeError(`disabledSkills contains an invalid skill name: ${String(name)}`)
    }
    result.add(name)
  }
  return result
}

export function normalizeEnabledProjectSkills(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > MAX_SKILLS) {
    throw new TypeError(`enabledProjectSkills must be an array with at most ${MAX_SKILLS} skill names`)
  }
  const result = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const name = value[index]
    if (typeof name !== 'string' || !isSkillName(name)) {
      throw new TypeError(`enabledProjectSkills[${index}] must be a valid skill name`)
    }
    if (seen.has(name)) throw new TypeError('enabledProjectSkills must not contain duplicate names')
    seen.add(name)
    result.push(name)
  }
  return Object.freeze(result)
}

function parseYamlBoolean(value, field, defaultValue) {
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
  throw new SkillFormatError(`frontmatter field ${field} must be boolean`)
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

function parseSkillDocument(source) {
  if (typeof source !== 'string') throw new SkillFormatError('skill file is not text')
  const normalized = source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') throw new SkillFormatError('skill file must begin with YAML frontmatter')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new SkillFormatError('skill YAML frontmatter has no closing delimiter')

  let document
  try {
    document = parseDocument(lines.slice(1, end).join('\n'), {
      schema: 'core',
      uniqueKeys: true,
    })
  } catch {
    throw new SkillFormatError('skill YAML frontmatter is invalid')
  }
  if (document.errors.length > 0) throw new SkillFormatError('skill YAML frontmatter is invalid')
  let frontmatter
  try {
    frontmatter = document.toJS({ maxAliasCount: 0 })
  } catch {
    throw new SkillFormatError('skill YAML frontmatter cannot be represented safely')
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter) || (Object.getPrototypeOf(frontmatter) !== Object.prototype && Object.getPrototypeOf(frontmatter) !== null)) {
    throw new SkillFormatError('skill YAML frontmatter must be a mapping')
  }

  const name = frontmatter.name
  const description = frontmatter.description
  const whenToUse = frontmatter.whenToUse
  if (typeof name !== 'string' || !isSkillName(name)) throw new SkillFormatError('skill frontmatter name must be a valid kebab-case name')
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > 2_000) {
    throw new SkillFormatError('skill frontmatter description must be a non-empty string no longer than 2000 characters')
  }
  if (whenToUse !== undefined && (typeof whenToUse !== 'string' || whenToUse.length > 2_000)) {
    throw new SkillFormatError('skill frontmatter whenToUse must be a string no longer than 2000 characters')
  }

  const metadata = Object.create(null)
  for (const [key, value] of Object.entries(frontmatter)) {
    if (FRONTMATTER_FIELDS.has(key)) continue
    assertJsonValue(value)
    metadata[key] = value
  }
  const hasMetadata = Object.keys(metadata).length > 0
  const invocation = {
    modelInvocable: !parseYamlBoolean(frontmatter['disable-model-invocation'], 'disable-model-invocation', false),
    userInvocable: parseYamlBoolean(frontmatter['user-invocable'], 'user-invocable', true),
  }

  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(hasMetadata ? { metadata } : {}),
    invocation,
    content: lines.slice(end + 1).join('\n').replace(/^\n/u, ''),
  }
}

async function readSkillFile(ctx, target, signal, byteLimit = MAX_SKILL_BYTES) {
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
    return { ...parseSkillDocument(source), byteLength: bytes.byteLength }
  } catch (error) {
    if (error instanceof SkillFormatError) {
      error.bytesRead = bytes.byteLength
      throw error
    }
    throw new SkillFormatError('skill instruction frontmatter could not be parsed safely', bytes.byteLength)
  }
}

function sourceForDirectory(directory) {
  if (directory === '.opencode/skills') return 'project-opencode'
  if (directory === '.claude/skills') return 'project-claude'
  return 'project-local'
}

async function isContainedSkillPath(ctx, { cwd, cwdTarget, rootPath, rootTarget, fileTarget, resolverPath, signal }) {
  const fs = ctx.fs
  if (typeof fs.lstat !== 'function') return false
  const lexicalInfo = await fs.lstat(resolverPath, { cwd }, signal)
  if (!lexicalInfo || lexicalInfo.type !== 'file') return false
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
    && JSON.stringify(skill.metadata ?? null) === JSON.stringify(candidate.metadata ?? null)
}

export function createProjectSkillProvider(ctx, control, options = {}) {
  const fs = ctx.fs
  const directories = normalizeProjectSkillDirs(options.projectSkillDirs)
  const disabledSkills = normalizeDisabledSkills(options.disabledSkills)
  const enabledProjectSkills = normalizeEnabledProjectSkills(options.enabledProjectSkills)
  const enabledProjectSkillSet = enabledProjectSkills === undefined ? undefined : new Set(enabledProjectSkills)
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
    pendingWatches.clear()
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

  const ensureWatch = async (target, signal) => {
    if (closed || control.signal.aborted || signal?.aborted) return false
    const key = target.targetKey
    if (watchers.has(key) && !failedWatchKeys.has(key)) return true
    const pending = pendingWatches.get(key)
    if (pending) {
      if (pending.controller.signal.aborted && !pending.settled) {
        const result = await waitForPending(pending, signal)
        if (result || signal?.aborted || closed) return result
        return ensureWatch(target, signal)
      }
      return waitForPending(pending, signal)
    }

    const previous = watchers.get(key)
    watchers.delete(key)
    failedWatchKeys.delete(key)
    if (previous) await closeWatcher(previous, 'dsh-omo could not replace a project skill watcher')
    if (liveWatcherCount() >= watcherLimit) {
      if (!watchCapacityWarned) {
        watchCapacityWarned = true
        warn(ctx, 'dsh-omo project skill watcher capacity reached; catalog will remain uncached', new Error('Watcher capacity'))
      }
      return false
    }

    const controller = new AbortController()
    const attempt = { controller, promise: undefined, waiters: 0, settled: false, acquired: false }
    pendingWatches.set(key, attempt)
    // Assign the shared promise before invoking a backend that may throw synchronously.
    attempt.promise = Promise.resolve().then(async () => {
      try {
        if (closed || control.signal.aborted || controller.signal.aborted) return false
        const dispose = await fs.watch(target, error => {
          if (control.signal.aborted || controller.signal.aborted) return
          if (error) {
            markWatchFailed(key)
            const active = watchers.get(key)
            watchers.delete(key)
            if (active) void closeWatcher(active, 'dsh-omo could not close a failed project skill watcher')
            warn(ctx, 'dsh-omo project skill watcher reported an error', error)
          }
          control.invalidate()
        }, controller.signal)
        attempt.acquired = true
        if (closed || control.signal.aborted || controller.signal.aborted || failedWatchKeys.has(key)) {
          await closeWatcher({ controller, dispose }, 'dsh-omo could not close an uninstalled project skill watcher')
          return false
        }
        watchers.set(key, { controller, dispose })
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

  const watchNearestExistingAncestor = async (rootPath, cwd, cwdTarget, signal) => {
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
        return ensureWatch(currentTarget, signal)
      }
      if (!fs.contains(cwdTarget, target)) return false
      let info
      try {
        info = await fs.stat(target, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        return false
      }
      if (!info || info.type !== 'directory') return ensureWatch(currentTarget, signal)
      currentTarget = target
    }
    return ensureWatch(currentTarget, signal)
  }

  const watchSymlinkParents = async (rootPath, cwd, cwdTarget, signal) => {
    let prefix = ''
    let parentTarget = cwdTarget
    const segments = rootPath.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]
      let pathInfo
      try {
        pathInfo = await fs.lstat(prefix, { cwd }, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code === 'FS_NOT_FOUND') return true
        warn(ctx, 'dsh-omo could not inspect a project skill path component', error)
        return false
      }
      if (!pathInfo) return true
      if (pathInfo.type === 'symlink' && !await ensureWatch(parentTarget, signal)) return false
      if (index === segments.length - 1) continue

      let target
      try {
        target = await fs.resolve(prefix, { cwd, signal })
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code === 'FS_NOT_FOUND') return true
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
      if (!info || info.type !== 'directory') return true
      parentTarget = target
    }
    return true
  }

  const makeCandidate = (skill, rootPath, rootTarget, skillDirectoryTarget, fileTarget, rootIndex, resolverPath) => {
    const invocation = {
      modelInvocable: skill.invocation.modelInvocable && !disabledSkills.has(skill.name),
      userInvocable: skill.invocation.userInvocable && !disabledSkills.has(skill.name),
    }
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      path: fileTarget.displayPath,
      provider: PROJECT_SKILL_PROVIDER,
      source: sourceForDirectory(rootPath),
      resourceBase: { kind: 'directory', path: skillDirectoryTarget.displayPath },
      invocation,
      rank: PROJECT_SKILL_RANK + rootIndex,
      locator: { rootTarget, skillDirectoryTarget, fileTarget, rootPath, resolverPath },
      ...(skill.metadata ? { metadata: skill.metadata } : {}),
    }
  }

  const provider = {
    name: PROJECT_SKILL_PROVIDER,
    async list(lookup = {}) {
      const cwd = typeof lookup.cwd === 'string' ? lookup.cwd : ''
      if (!cwd) return { candidates: [], complete: true }
      const signal = lifecycleSignal(lookup.signal, control.signal)
      const candidates = []
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
      try {
        throwIfAborted(signal)
        cwdTarget = await fs.resolve('.', { cwd, signal })
      } catch (error) {
        if (signal?.aborted) throw error
        warn(ctx, 'dsh-omo could not resolve the skill lookup cwd', error)
        return { candidates, complete: false }
      }

      for (let rootIndex = 0; rootIndex < directories.length; rootIndex += 1) {
        if (scanExhausted) break
        throwIfAborted(signal)
        const rootPath = directories[rootIndex]
        if (!await watchSymlinkParents(rootPath, cwd, cwdTarget, signal)) complete = false
        let rootTarget
        try {
          rootTarget = await fs.resolve(rootPath, { cwd, signal })
        } catch (error) {
          if (signal?.aborted) throw error
          warn(ctx, 'dsh-omo could not resolve a project skill root', error)
          if (error?.code === 'FS_NOT_FOUND') {
            if (!await watchNearestExistingAncestor(rootPath, cwd, cwdTarget, signal)) complete = false
          } else {
            complete = false
          }
          continue
        }
        try {
          if (!fs.contains(cwdTarget, rootTarget)) {
            complete = false
            warn(ctx, 'dsh-omo skipped a project skill root outside its lookup cwd', new Error('Path containment rejected'))
            continue
          }
          if (!await ensureWatch(rootTarget, signal)) complete = false
          const rootInfo = await fs.stat(rootTarget, signal)
          if (!rootInfo) continue
          if (rootInfo.type !== 'directory') {
            warn(ctx, 'dsh-omo skipped a project skill root that is not a directory', new Error('Not a directory'))
            continue
          }
          const entries = limitEntries(await fs.listDir(rootTarget, signal))
          for (const entry of entries) {
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
            if (!fs.contains(rootTarget, entry.target)) continue
            const entryInfo = await fs.stat(entry.target, signal)
            if (!entryInfo) {
              complete = false
              continue
            }

            let skillDirectoryTarget = rootTarget
            let fileTarget
            let resolverPath
            if (entryInfo.type === 'directory') {
              skillDirectoryTarget = entry.target
              if (!await ensureWatch(skillDirectoryTarget, signal)) complete = false
              const children = limitEntries(await fs.listDir(skillDirectoryTarget, signal))
              const skillFile = children.find(child => child.name === 'SKILL.md' && fs.contains(rootTarget, child.target))
              if (!skillFile) continue
              const skillFileInfo = await fs.stat(skillFile.target, signal)
              if (!skillFileInfo) {
                complete = false
                continue
              }
              if (skillFileInfo.type !== 'file' || !fs.contains(rootTarget, skillFile.target)) continue
              fileTarget = skillFile.target
              resolverPath = `${rootPath}/${entry.name}/SKILL.md`
            } else if (entryInfo.type === 'file' && entry.name.toLowerCase().endsWith('.md')) {
              fileTarget = entry.target
              resolverPath = `${rootPath}/${entry.name}`
            } else {
              continue
            }

            if (!await ensureWatch(fileTarget, signal)) complete = false
            const remainingBytes = MAX_SCAN_BYTES - scannedBytes
            if (remainingBytes <= 0) {
              complete = false
              scanExhausted = true
              break
            }
            let skill
            try {
              skill = await readSkillFile(ctx, fileTarget, signal, Math.min(MAX_SKILL_BYTES, remainingBytes))
              scannedBytes += skill.byteLength
              if (!await isContainedSkillPath(ctx, { cwd, cwdTarget, rootPath, rootTarget, fileTarget, resolverPath, signal })) {
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
            if (enabledProjectSkillSet && !enabledProjectSkillSet.has(skill.name)) continue
            candidates.push(makeCandidate(skill, rootPath, rootTarget, skillDirectoryTarget, fileTarget, rootIndex, resolverPath))
          }
        } catch (error) {
          if (signal?.aborted) throw error
          complete = false
          warn(ctx, 'dsh-omo could not list a project skill root', error)
        }
      }
      throwIfAborted(signal)
      return { candidates, complete }
    },
    async get(candidate, lookup = {}) {
      if (enabledProjectSkillSet && !enabledProjectSkillSet.has(candidate?.name)) return undefined
      const locator = candidate?.locator
      if (!locator?.rootTarget || !locator?.fileTarget || !locator?.skillDirectoryTarget || typeof locator.resolverPath !== 'string' || typeof lookup.cwd !== 'string' || !lookup.cwd) return undefined
      const signal = lifecycleSignal(lookup.signal, control.signal)
      throwIfAborted(signal)
      try {
        const cwdTarget = await fs.resolve('.', { cwd: lookup.cwd, signal })
        const rootTarget = await fs.resolve(locator.rootPath, { cwd: lookup.cwd, signal })
        const fileTarget = await fs.resolve(locator.resolverPath, { cwd: lookup.cwd, signal })
        if (!fs.contains(cwdTarget, rootTarget) || !fs.contains(rootTarget, fileTarget)) {
          control.invalidate()
          return undefined
        }
        const skill = await readSkillFile(ctx, fileTarget, signal)
        if (!await isContainedSkillPath(ctx, {
          cwd: lookup.cwd,
          cwdTarget,
          rootPath: locator.rootPath,
          rootTarget,
          fileTarget,
          resolverPath: locator.resolverPath,
          signal,
        })) {
          control.invalidate()
          return undefined
        }
        const candidateMatches = matchesCandidate(skill, candidate, disabledSkills)
        if (!candidateMatches) {
          control.invalidate()
          return undefined
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
          content: skill.content,
          ...(skill.metadata ? { metadata: skill.metadata } : {}),
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (!(error instanceof SkillFormatError)) warn(ctx, 'dsh-omo could not reload a project skill file', error)
        control.invalidate()
        return undefined
      }
    },
  }

  return provider
}

export function registerProjectSkillProvider(ctx, options = {}) {
  let control
  const dispose = ctx.skills.registerProvider(registeredControl => {
    control = registeredControl
    return createProjectSkillProvider(ctx, registeredControl, options)
  })
  return Object.freeze({
    refresh() {
      control?.invalidate()
    },
    dispose,
  })
}
