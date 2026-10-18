import assert from 'node:assert/strict'
import test from 'node:test'
import { posix as path } from 'node:path'
import { createPromptFileExpander, parsePromptFileReference } from '../src/prompt-file-expansion.js'

function makePromptFs({ files = {}, onRead, onStat, readBytes: customReadBytes, resolveTarget } = {}) {
  const cwd = '/workspace'
  const entries = new Map()
  const putDirectory = absolutePath => {
    if (!entries.has(absolutePath)) entries.set(absolutePath, { type: 'directory', version: `v-${absolutePath}` })
  }
  putDirectory(cwd)
  const putFile = (relativePath, content, options = {}) => {
    const absolutePath = path.resolve(cwd, relativePath)
    const parents = []
    let parent = path.dirname(absolutePath)
    while (parent !== cwd && parent.startsWith(`${cwd}/`)) {
      parents.unshift(parent)
      parent = path.dirname(parent)
    }
    for (const directory of parents) putDirectory(directory)
    const bytes = content instanceof Uint8Array ? new Uint8Array(content) : new TextEncoder().encode(content)
    entries.set(absolutePath, { type: options.type ?? 'file', bytes, size: bytes.byteLength, version: options.version ?? 'v1' })
    return entries.get(absolutePath)
  }
  for (const [relativePath, content] of Object.entries(files)) putFile(relativePath, content)
  const pathsByTargetKey = new Map()
  const targetKeysByPath = new Map()
  const target = absolutePath => {
    let key = targetKeysByPath.get(absolutePath)
    if (!key) {
      key = `opaque-target-${targetKeysByPath.size + 1}`
      targetKeysByPath.set(absolutePath, key)
      pathsByTargetKey.set(key, absolutePath)
    }
    return Object.freeze({ targetKey: key, displayPath: absolutePath })
  }
  const targetPath = value => pathsByTargetKey.get(value?.targetKey)
  const throwIfAborted = signal => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  const fs = {
    resolve: async (value, options = {}) => {
      throwIfAborted(options.signal)
      const absolutePath = path.resolve(options.cwd ?? cwd, value)
      if (resolveTarget) {
        const remapped = resolveTarget(value, options, absolutePath)
        if (remapped) return target(remapped)
      }
      if (!entries.has(absolutePath)) throw new Error('missing')
      return target(absolutePath)
    },
    contains: (parentTarget, childTarget) => {
      const parentPath = targetPath(parentTarget)
      const childPath = targetPath(childTarget)
      return typeof parentPath === 'string' && typeof childPath === 'string'
        && (childPath === parentPath || childPath.startsWith(`${parentPath.replace(/\/$/u, '')}/`))
    },
    lstat: async (value, options = {}, signal) => {
      throwIfAborted(signal)
      const absolutePath = path.resolve(options.cwd ?? cwd, value)
      const entry = entries.get(absolutePath)
      return entry ? { type: entry.type, version: entry.version, ...(entry.size !== undefined ? { size: entry.size } : {}) } : undefined
    },
    stat: async (fileTarget, signal) => {
      throwIfAborted(signal)
      const absolutePath = targetPath(fileTarget)
      const entry = entries.get(absolutePath)
      onStat?.(absolutePath, entry)
      return entry ? { type: entry.type, ...(entry.size !== undefined ? { size: entry.size } : {}), version: entry.version } : undefined
    },
    readBytes: async (fileTarget, signal, maxBytes) => {
      throwIfAborted(signal)
      if (customReadBytes) return customReadBytes(fileTarget, signal, maxBytes, entries)
      const absolutePath = targetPath(fileTarget)
      const entry = entries.get(absolutePath)
      if (!entry || entry.type !== 'file') throw new Error('not a file')
      if (entry.bytes.byteLength > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      onRead?.(absolutePath, entry)
      return new Uint8Array(entry.bytes)
    },
  }
  return { fs, cwd, entries, putDirectory, putFile }
}

function makeExpander(options = {}) {
  const { fs, cwd } = options.fs ?? makePromptFs()
  const agent = options.agent ?? { id: 'agent-1' }
  let currentCwd = cwd
  const agents = { get: id => id === agent.id ? agent : undefined }
  const sessions = { get: id => id === agent.id ? { header: { id, cwd: currentCwd } } : undefined }
  const expander = createPromptFileExpander({
    fs,
    agents,
    sessions,
    lifecycleSignal: options.lifecycleSignal,
    timeoutMs: options.timeoutMs,
  })
  return {
    agent,
    expander,
    setCwd(value) { currentCwd = value },
    getCwd() { return currentCwd },
  }
}

const signal = () => new AbortController().signal

test('parses only bounded relative file references and rejects ambiguous escapes', () => {
  assert.equal(parsePromptFileReference('ordinary guidance'), undefined)
  assert.equal(parsePromptFileReference('mention file://prompts/a.md in this note'), undefined)
  assert.equal(parsePromptFileReference('file://prompts/a.md'), 'prompts/a.md')
  assert.equal(parsePromptFileReference('file://./prompts/a.md'), 'prompts/a.md')
  for (const value of [
    'file://',
    'file:///etc/passwd',
    'file://~/secret.md',
    'file://../secret.md',
    'file://prompts/../../secret.md',
    'file://prompts//empty.md',
    'file://C:/secret.md',
    'file://prompts/a.md?query=1',
    'file://prompts/%2e%2e/secret.md',
    'file://prompts\\secret.md',
    'file://prompts/line\nfeed.md',
    'file://**/*.md',
    'file://[agent].md',
    'file://{agent}.md',
  ]) {
    assert.throws(() => parsePromptFileReference(value), /relative path|traverse/u, value)
  }
})

test('leaves inline appends untouched without resolving a session or reading files', async () => {
  let serviceCalls = 0
  let fileCalls = 0
  const fs = {
    resolve: async () => { fileCalls += 1 },
    contains: () => true,
    lstat: async () => { fileCalls += 1 },
    stat: async () => { fileCalls += 1 },
    readBytes: async () => { fileCalls += 1 },
  }
  const expander = createPromptFileExpander({
    fs,
    agents: { get: () => { serviceCalls += 1 } },
    sessions: { get: () => { serviceCalls += 1 } },
  })
  const result = await expander.expand({
    categoryPromptAppend: 'category inline guidance',
    rolePromptAppend: 'role inline guidance',
    agent: { id: 'agent-1' },
    signal: signal(),
  })
  assert.deepEqual(result, {
    categoryPromptAppend: 'category inline guidance',
    rolePromptAppend: 'role inline guidance',
    expanded: false,
  })
  assert.equal(serviceCalls, 0)
  assert.equal(fileCalls, 0)
})

test('expands selected category and role file appends through bounded DSH filesystem reads', async () => {
  const readPaths = []
  const fsFixture = makePromptFs({
    files: {
      'prompts/category.md': 'Category file guidance',
      'prompts/role.md': 'Role file guidance',
      'prompts/unused.md': 'Unselected route guidance',
    },
    onRead: filePath => readPaths.push(filePath),
  })
  const { agent, expander } = makeExpander({ fs: fsFixture })
  const result = await expander.expand({
    categoryPromptAppend: 'file://prompts/category.md',
    rolePromptAppend: 'file://./prompts/role.md',
    agent,
    signal: signal(),
  })
  assert.deepEqual(result, {
    categoryPromptAppend: 'Category file guidance',
    rolePromptAppend: 'Role file guidance',
    expanded: true,
  })
  assert.deepEqual(readPaths, ['/workspace/prompts/category.md', '/workspace/prompts/role.md'])
})

test('does not recursively expand file references found inside loaded content', async () => {
  const readPaths = []
  const fsFixture = makePromptFs({
    files: {
      'prompts/first.md': 'file://prompts/second.md',
      'prompts/second.md': 'must not be loaded',
    },
    onRead: filePath => readPaths.push(filePath),
  })
  const { agent, expander } = makeExpander({ fs: fsFixture })
  const result = await expander.expand({ rolePromptAppend: 'file://prompts/first.md', agent, signal: signal() })
  assert.equal(result.rolePromptAppend, 'file://prompts/second.md')
  assert.deepEqual(readPaths, ['/workspace/prompts/first.md'])
})

test('rejects symlinks, directories, unresolved targets, and files outside the session CWD', async () => {
  const symlinkFs = makePromptFs()
  symlinkFs.putFile('prompts/link.md', 'not read', { type: 'symlink' })
  const symlink = makeExpander({ fs: symlinkFs })
  await assert.rejects(symlink.expander.expand({ rolePromptAppend: 'file://prompts/link.md', agent: symlink.agent }), /symlink|regular/u)

  const parentSymlinkFs = makePromptFs({ files: { 'prompts/sub/file.md': 'not read' } })
  parentSymlinkFs.entries.set('/workspace/prompts', { type: 'symlink', version: 'link-v1' })
  const parentSymlink = makeExpander({ fs: parentSymlinkFs })
  await assert.rejects(parentSymlink.expander.expand({ rolePromptAppend: 'file://prompts/sub/file.md', agent: parentSymlink.agent }), /symlink|regular/u)

  const directoryFs = makePromptFs()
  directoryFs.putDirectory('/workspace/prompts/folder')
  const directory = makeExpander({ fs: directoryFs })
  await assert.rejects(directory.expander.expand({ rolePromptAppend: 'file://prompts/folder', agent: directory.agent }), /symlink|regular/u)

  const missingFs = makePromptFs()
  const missing = makeExpander({ fs: missingFs })
  await assert.rejects(missing.expander.expand({ rolePromptAppend: 'file://prompts/missing.md', agent: missing.agent }), /failed safely|missing|regular/u)

  const outsideFs = makePromptFs({
    files: { 'prompts/inside.md': 'safe' },
    resolveTarget: (value, options, absolutePath) => value === 'prompts/inside.md' ? '/outside/secret.md' : undefined,
  })
  const outside = makeExpander({ fs: outsideFs })
  await assert.rejects(outside.expander.expand({ rolePromptAppend: 'file://prompts/inside.md', agent: outside.agent }), /outside/u)
})

test('rejects oversized, invalid UTF-8, or changed prompt files', async () => {
  const oversizedFs = makePromptFs({ files: { 'prompts/large.md': 'x'.repeat(4097) } })
  const oversized = makeExpander({ fs: oversizedFs })
  await assert.rejects(oversized.expander.expand({ rolePromptAppend: 'file://prompts/large.md', agent: oversized.agent }), /size limit/u)

  const invalidUtf8Fs = makePromptFs({ files: { 'prompts/invalid.md': new Uint8Array([0xff, 0xfe]) } })
  const invalidUtf8 = makeExpander({ fs: invalidUtf8Fs })
  await assert.rejects(invalidUtf8.expander.expand({ rolePromptAppend: 'file://prompts/invalid.md', agent: invalidUtf8.agent }), /UTF-8/u)

  const unsafeTextFs = makePromptFs({ files: { 'prompts/unsafe.md': 'unsafe\u0001text' } })
  const unsafeText = makeExpander({ fs: unsafeTextFs })
  await assert.rejects(unsafeText.expander.expand({ rolePromptAppend: 'file://prompts/unsafe.md', agent: unsafeText.agent }), /unsafe text/u)

  const staleFs = makePromptFs({
    files: { 'prompts/stale.md': 'before' },
    onRead: (_filePath, entry) => { entry.version = 'v2' },
  })
  const stale = makeExpander({ fs: staleFs })
  await assert.rejects(stale.expander.expand({ rolePromptAppend: 'file://prompts/stale.md', agent: stale.agent }), /changed/u)

  let changedParentFs
  const changedParent = makeExpander({ fs: (changedParentFs = makePromptFs({
    files: { 'prompts/sub/file.md': 'contents' },
    onRead: () => { changedParentFs.entries.get('/workspace/prompts').type = 'symlink' },
  })) })
  await assert.rejects(changedParent.expander.expand({ rolePromptAppend: 'file://prompts/sub/file.md', agent: changedParent.agent }), /path changed/u)

  const readsBeforeCwdChange = []
  const changedBeforeReadFs = makePromptFs({
    files: { 'prompts/pre-read-cwd.md': 'contents' },
    onStat: filePath => {
      if (filePath === '/workspace/prompts/pre-read-cwd.md') changedBeforeRead.setCwd('/other')
    },
    onRead: filePath => readsBeforeCwdChange.push(filePath),
  })
  const changedBeforeRead = makeExpander({ fs: changedBeforeReadFs })
  await assert.rejects(changedBeforeRead.expander.expand({ rolePromptAppend: 'file://prompts/pre-read-cwd.md', agent: changedBeforeRead.agent }), /changed before/u)
  assert.deepEqual(readsBeforeCwdChange, [])

  const changedCwdFs = makePromptFs({
    files: { 'prompts/cwd.md': 'contents' },
    onRead: () => { changedCwd.setCwd('/other') },
  })
  const changedCwd = makeExpander({ fs: changedCwdFs })
  await assert.rejects(changedCwd.expander.expand({ rolePromptAppend: 'file://prompts/cwd.md', agent: changedCwd.agent }), /working directory changed/u)

  let rootRemapped = false
  const changedRootFs = makePromptFs({
    files: { 'prompts/root.md': 'contents' },
    onRead: () => { rootRemapped = true },
    resolveTarget: (value) => value === '/workspace' && rootRemapped ? '/other-root' : undefined,
  })
  const changedRoot = makeExpander({ fs: changedRootFs })
  await assert.rejects(changedRoot.expander.expand({ rolePromptAppend: 'file://prompts/root.md', agent: changedRoot.agent }), /working directory identity changed/u)
})

test('cancels and times out pending filesystem reads', async () => {
  let resolveStarted
  const started = new Promise(resolve => { resolveStarted = resolve })
  const cancelFs = makePromptFs({
    files: { 'prompts/pending.md': 'contents' },
    readBytes: (_target, _signal, _maxBytes) => {
      resolveStarted()
      return new Promise(() => {})
    },
  })
  const cancel = makeExpander({ fs: cancelFs })
  const controller = new AbortController()
  const pending = cancel.expander.expand({ rolePromptAppend: 'file://prompts/pending.md', agent: cancel.agent, signal: controller.signal })
  await started
  controller.abort()
  await assert.rejects(pending, /cancelled/u)

  const timeoutFs = makePromptFs({
    files: { 'prompts/pending.md': 'contents' },
    readBytes: () => new Promise(() => {}),
  })
  const timeout = makeExpander({ fs: timeoutFs, timeoutMs: 5 })
  await assert.rejects(
    timeout.expander.expand({ rolePromptAppend: 'file://prompts/pending.md', agent: timeout.agent, signal: signal() }),
    /timed out/u,
  )
})
