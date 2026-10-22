import assert from 'node:assert/strict'
import test from 'node:test'
import { posix as path } from 'node:path'
import { apply, Config } from '../src/index.js'
import {
  createProjectCommandAdapter,
  makeProjectCommandDefinition,
  normalizeUserOpenCodeCommandRoots,
  parseProjectCommandDocument,
  registerProjectCommandDefinitions,
  PROJECT_COMMAND_DIRECTORIES,
  PROJECT_COMMAND_DIRECTORY,
  PROJECT_COMMAND_NAME,
  renderProjectCommand,
} from '../src/project-commands.js'

const encoder = new TextEncoder()
const CWD = '/workspace/project'
const VALID = '---\ndescription: Inspect a requested area\n---\nReview the selected files.\n'

function createMemoryFs({ aliases = {}, onRead, onList, listOverride } = {}) {
  const nodes = new Map()
  const calls = []
  const absolute = (value, cwd = CWD) => path.resolve(cwd, value)
  const targetFor = value => ({ targetKey: value, path: value })
  const addDirectory = value => {
    const absolutePath = absolute(value)
    nodes.set(absolutePath, { type: 'directory', version: `dir-${absolutePath}` })
    return absolutePath
  }
  const addFile = (value, source, version = 'v1') => {
    const absolutePath = absolute(value)
    const bytes = source instanceof Uint8Array ? new Uint8Array(source) : encoder.encode(source)
    nodes.set(absolutePath, { type: 'file', bytes, size: bytes.byteLength, version })
    return absolutePath
  }
  const addSymlink = value => {
    const absolutePath = absolute(value)
    nodes.set(absolutePath, { type: 'symlink', version: `link-${absolutePath}` })
    return absolutePath
  }
  addDirectory(CWD)
  addDirectory(`${CWD}/.opencode`)
  addDirectory(`${CWD}/${PROJECT_COMMAND_DIRECTORY}`)

  const fs = {
    async resolve(value, options = {}) {
      calls.push({ method: 'resolve', value, options })
      const requested = absolute(value, options.cwd ?? CWD)
      const resolved = aliases[requested] ?? requested
      if (!nodes.has(resolved)) throw new Error('not found')
      return targetFor(resolved)
    },
    contains(parent, child) {
      calls.push({ method: 'contains', parent, child })
      if (!parent?.path || !child?.path) return false
      return child.path === parent.path || child.path.startsWith(`${parent.path.replace(/\/$/u, '')}/`)
    },
    async lstat(value, options = {}) {
      calls.push({ method: 'lstat', value, options })
      const record = nodes.get(absolute(value, options.cwd ?? CWD))
      return record ? { type: record.type, ...(record.size === undefined ? {} : { size: record.size }) } : undefined
    },
    async stat(target) {
      calls.push({ method: 'stat', target })
      const record = nodes.get(target?.path)
      return record ? {
        type: record.type,
        ...(record.size === undefined ? {} : { size: record.size }),
        version: record.version,
      } : undefined
    },
    async listDir(target, signal) {
      calls.push({ method: 'listDir', target, signal })
      if (onList) return onList(target, signal, nodes)
      if (listOverride) return listOverride
      return [...nodes.entries()]
        .filter(([candidate]) => path.dirname(candidate) === target.path)
        .map(([candidate, record]) => ({ name: path.basename(candidate), type: record.type, target: targetFor(candidate) }))
    },
    async readBytes(target, signal, maxBytes) {
      calls.push({ method: 'readBytes', target, signal, maxBytes })
      const record = nodes.get(target?.path)
      if (!record || record.type !== 'file') throw new Error('not a regular file')
      if (record.bytes.byteLength > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      await onRead?.(target.path, record, signal, maxBytes, nodes)
      return new Uint8Array(record.bytes)
    },
  }
  return { fs, nodes, calls, addDirectory, addFile, addSymlink, targetFor }
}

function fixture(options = {}) {
  const memory = createMemoryFs(options.fsOptions)
  const agent = { id: 'agent-1' }
  const session = { header: { id: agent.id, cwd: options.cwd ?? CWD } }
  const sessions = { get: id => id === agent.id ? session : undefined }
  const adapter = createProjectCommandAdapter(memory.fs, {
    sessions,
    userOpenCodeCommandRoots: options.userOpenCodeCommandRoots,
  })
  return { ...memory, agent, session, sessions, adapter }
}

const listedNames = state => state.calls.filter(call => call.method === 'listDir').map(call => call.target?.path)
const readCalls = state => state.calls.filter(call => call.method === 'readBytes')

test('accepts only safe kebab-case flat command stems', () => {
  for (const name of ['go', 'review', 'release-notes', 'v2-check']) assert.equal(PROJECT_COMMAND_NAME.test(name), true)
  for (const name of ['', '-go', 'Go', 'go--now', 'go-', 'a/b', 'a_b', 'a.b']) assert.equal(PROJECT_COMMAND_NAME.test(name), false)
})

test('validates explicit user OpenCode roots and keeps the option default-off', () => {
  const roots = ['/Users/alice/.config/opencode/commands', '/Users/alice/.config/opencode/command']
  assert.deepEqual(normalizeUserOpenCodeCommandRoots(undefined), [])
  assert.deepEqual(normalizeUserOpenCodeCommandRoots(roots), roots)
  assert.deepEqual(normalizeUserOpenCodeCommandRoots([`${roots[0]}/`]), [roots[0]], 'trailing separators are stripped before FS checks')
  assert.ok(Object.isFrozen(normalizeUserOpenCodeCommandRoots(roots)))
  assert.deepEqual(Config({}).userOpenCodeCommandRoots, [])
  assert.throws(() => normalizeUserOpenCodeCommandRoots('/Users/alice/.config/opencode/commands'), /must be an array/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots(['relative/commands']), /normalized absolute/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots(['~/.config/opencode/commands']), /normalized absolute/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots(['/Users/alice/.config/opencode/custom']), /named command or commands/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots(['/Users/alice/.config/opencode/../commands']), /normalized absolute/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots(['/Users/alice/.config/opencode/commands\u202e']), /normalized absolute/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots([...roots, '/Users/alice/other/commands']), /at most 2 roots/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots([roots[0], roots[0]]), /must not contain duplicates/u)
  assert.throws(() => normalizeUserOpenCodeCommandRoots([roots[0], `${roots[0]}/`]), /must not contain duplicates/u)
  assert.throws(() => apply({}, Config({ userOpenCodeCommandRoots: [roots[0]] })), /requires enableProjectCommands/u)
})

test('parses bounded Claude argument hints while keeping OpenCode frontmatter exact', () => {
  const parsed = parseProjectCommandDocument('review', VALID)
  assert.deepEqual(parsed, {
    name: 'review',
    description: 'Inspect a requested area',
    body: 'Review the selected files.\n',
  })
  const claudeHint = parseProjectCommandDocument('review', '---\ndescription: Inspect files\nargument-hint: "file paths"\n---\nReview.\n', 'claude')
  assert.equal(claudeHint.argumentHint, 'file paths')
  assert.equal(makeProjectCommandDefinition(claudeHint, () => ({ kind: 'success' })).input.hint, 'file paths')
  assert.equal(makeProjectCommandDefinition(parsed, () => ({ kind: 'success' })).input.hint, '[arguments]')
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: Inspect files\nargument-hint: files\n---\nReview.\n'), /OpenCode project command frontmatter permits only the description key/u)
  assert.throws(() => parseProjectCommandDocument('review', '---\nother: x\ndescription: ok\n---\nBody'), /only the description key/u)
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: one\ndescription: two\n---\nBody'), /valid mapping|frontmatter/u)
  assert.throws(() => parseProjectCommandDocument('review', '---\n- description\n---\nBody'), /mapping/u)
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: ""\n---\nBody'), /description/u)
  assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: ${'x'.repeat(1_001)}\n---\nBody`), /1000/u)
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: [not, a, string]\n---\nBody'), /description/u)
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: valid\nargument-hint: [not, a, string]\n---\nBody', 'claude'), /argument-hint/u)
  assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: valid\nargument-hint: "${'x'.repeat(161)}"\n---\nBody`, 'claude'), /160/u)
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: valid\nargument-hint: "one\\ntwo"\n---\nBody', 'claude'), /one safe line/u)
  assert.throws(() => parseProjectCommandDocument('review', VALID, 'unsupported'), /source must be opencode or claude/u)
})

test('requires a nonempty bounded body, rejects prompt controls, and enforces strict UTF-8', () => {
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: valid\n---\n  \n'), /body/u)
  assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: valid\n---\n${'x'.repeat(64 * 1024 + 1)}`), /file|body/u)
  for (const unsafe of ['visible\u202e hidden', 'visible\u0001 hidden', 'visible\u0085 hidden']) {
    assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: valid\n---\n${unsafe}`), /control or bidi/u)
  }
  assert.throws(() => parseProjectCommandDocument('review', new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff])), /UTF-8/u)
  assert.throws(() => parseProjectCommandDocument('../review', VALID), /kebab-case/u)
})

test('lists only direct .md commands from the exact project cwd', async () => {
  const state = fixture()
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/Release.md`, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/bad_name.md`, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/nested/hidden.md`, VALID)
  state.addSymlink(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/link.md`)
  const commands = await state.adapter.list(state.agent)
  assert.deepEqual(commands.commands, [{
    name: 'review',
    description: 'Inspect a requested area',
    body: 'Review the selected files.\n',
  }])
  assert.deepEqual(commands, { commands: commands.commands, truncated: false, skipped: 0 })
  assert.deepEqual(listedNames(state), [`${CWD}/${PROJECT_COMMAND_DIRECTORY}`])
  assert.equal(readCalls(state).length, 1)
  assert.ok(state.calls.every(call => call.method !== 'listDir' || call.target.path === `${CWD}/${PROJECT_COMMAND_DIRECTORY}`))
})

test('merges plural and singular OpenCode roots before Claude commands with deterministic fallback', async () => {
  assert.deepEqual(PROJECT_COMMAND_DIRECTORIES, ['.opencode/commands', '.opencode/command', '.claude/commands'])
  const state = fixture()
  const opencodeSingular = `${CWD}/.opencode/command`
  const claudeCommands = `${CWD}/.claude/commands`
  state.addDirectory(opencodeSingular)
  state.addDirectory(`${CWD}/.claude`)
  state.addDirectory(claudeCommands)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/shared.md`, '---\ndescription: Plural OpenCode wins\n---\nPlural body.\n')
  state.addFile(`${opencodeSingular}/shared.md`, '---\ndescription: Singular OpenCode is shadowed\n---\nSingular body.\n')
  state.addFile(`${claudeCommands}/shared.md`, '---\ndescription: Claude is shadowed\n---\nClaude body.\n')
  state.addFile(`${claudeCommands}/claude-only.md`, '---\ndescription: Claude-only command\n---\nClaude body.\n')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/fallback.md`, 'malformed plural OpenCode source')
  state.addFile(`${opencodeSingular}/fallback.md`, '---\ndescription: Singular OpenCode fallback\n---\nOpenCode singular body.\n')
  state.addFile(`${claudeCommands}/fallback.md`, '---\ndescription: Claude fallback\n---\nClaude fallback body.\n')
  state.addFile(`${opencodeSingular}/singular-only.md`, '---\ndescription: Singular-only command\n---\nSingular body.\n')
  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands.map(command => [command.name, command.description]), [
    ['shared', 'Plural OpenCode wins'],
    ['fallback', 'Singular OpenCode fallback'],
    ['singular-only', 'Singular-only command'],
    ['claude-only', 'Claude-only command'],
  ])
  assert.deepEqual(listedNames(state), [`${CWD}/${PROJECT_COMMAND_DIRECTORY}`, opencodeSingular, claudeCommands])
  assert.equal(readCalls(state).length, 5, 'shadowed sources are skipped and malformed higher-priority files fall back')
})

test('reads only explicitly configured absolute user OpenCode roots after project roots', async () => {
  const root = '/Users/alice/.config/opencode/commands'
  const state = fixture({ userOpenCodeCommandRoots: [root] })
  state.addDirectory(root)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/project-only.md`, VALID)
  state.addFile(`${root}/user-only.md`, VALID)

  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands.map(command => command.name), ['project-only', 'user-only'])
  assert.deepEqual(listedNames(state), [`${CWD}/${PROJECT_COMMAND_DIRECTORY}`, root])
  assert.ok(state.calls.some(call => call.method === 'lstat' && call.value === root), 'the DSH FS receives the configured absolute path')

  const defaultOff = fixture()
  defaultOff.addDirectory(root)
  defaultOff.addFile(`${root}/must-not-load.md`, VALID)
  assert.deepEqual((await defaultOff.adapter.list(defaultOff.agent)).commands, [])
  assert.ok(!listedNames(defaultOff).includes(root), 'no user path is inferred or scanned by default')

  const missing = fixture({ userOpenCodeCommandRoots: [root] })
  missing.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/project-only.md`, VALID)
  assert.deepEqual((await missing.adapter.list(missing.agent)).commands.map(command => command.name), ['project-only'])
  assert.ok(!listedNames(missing).includes(root), 'a reported-missing user root does not disable valid project commands')
})

test('keeps project and user-root command precedence deterministic', async () => {
  const first = '/Users/alice/.config/opencode/commands'
  const second = '/Users/alice/.config/opencode/command'
  const state = fixture({ userOpenCodeCommandRoots: [first, second] })
  state.addDirectory(first)
  state.addDirectory(second)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/shared.md`, '---\ndescription: Project wins\n---\nProject body.\n')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/fallback.md`, 'malformed project file')
  state.addFile(`${first}/shared.md`, '---\ndescription: First user root is shadowed\n---\nFirst body.\n')
  state.addFile(`${first}/fallback.md`, '---\ndescription: First user root fallback\n---\nFirst body.\n')
  state.addFile(`${first}/first-only.md`, '---\ndescription: First root wins\n---\nFirst body.\n')
  state.addFile(`${second}/shared.md`, '---\ndescription: Second user root is shadowed\n---\nSecond body.\n')
  state.addFile(`${second}/fallback.md`, '---\ndescription: Second user root is shadowed\n---\nSecond body.\n')
  state.addFile(`${second}/first-only.md`, '---\ndescription: Second user root is shadowed\n---\nSecond body.\n')
  state.addFile(`${second}/second-only.md`, '---\ndescription: Second root command\n---\nSecond body.\n')

  const result = await state.adapter.list(state.agent)
  assert.deepEqual(Object.fromEntries(result.commands.map(command => [command.name, command.description])), {
    shared: 'Project wins',
    fallback: 'First user root fallback',
    'first-only': 'First root wins',
    'second-only': 'Second root command',
  })
})

test('rejects symlinked user roots and files resolving outside their configured boundary', async () => {
  const root = '/Users/alice/.config/opencode/commands'
  const symlinked = fixture({ userOpenCodeCommandRoots: [root] })
  symlinked.addSymlink(root)
  await assert.rejects(symlinked.adapter.list(symlinked.agent), /not a real directory/u)
  assert.equal(listedNames(symlinked).length, 0)
  assert.equal(readCalls(symlinked).length, 0)

  const trailingSlash = fixture({ userOpenCodeCommandRoots: [`${root}/`] })
  trailingSlash.addSymlink(root)
  await assert.rejects(trailingSlash.adapter.list(trailingSlash.agent), /not a real directory/u)
  assert.equal(listedNames(trailingSlash).length, 0, 'trailing slashes are removed before lstat')
  assert.equal(readCalls(trailingSlash).length, 0)

  const file = `${root}/steal.md`
  const outside = '/outside/steal.md'
  const escaped = fixture({
    userOpenCodeCommandRoots: [root],
    fsOptions: { aliases: { [file]: outside } },
  })
  escaped.addDirectory(root)
  escaped.addFile(file, VALID)
  escaped.addFile(outside, VALID)
  assert.deepEqual((await escaped.adapter.list(escaped.agent)).commands, [])
  assert.equal(readCalls(escaped).length, 0, 'canonical containment rejects an outside target before reading')
})

test('does not follow symlinked OpenCode or Claude command roots', async () => {
  const cases = [
    { target: `${CWD}/.opencode` },
    { target: `${CWD}/${PROJECT_COMMAND_DIRECTORY}` },
    { target: `${CWD}/.opencode/command` },
    { target: `${CWD}/.claude` },
    { target: `${CWD}/.claude/commands`, parents: [`${CWD}/.claude`] },
  ]
  for (const entry of cases) {
    const state = fixture()
    for (const parent of entry.parents ?? []) state.addDirectory(parent)
    state.addSymlink(entry.target)
    await assert.rejects(state.adapter.list(state.agent), /not a real directory/u)
    assert.equal(state.calls.some(call => call.method === 'listDir'), false)
    assert.equal(readCalls(state).length, 0)
  }
})

test('rejects missing, noncurrent, and unsafe session CWDs before scanning', async () => {
  const state = fixture()
  await assert.rejects(state.adapter.list({ id: 'other-agent' }), /absolute CWD/u)
  state.sessions.get = () => ({ header: { id: 'different', cwd: CWD } })
  await assert.rejects(state.adapter.list(state.agent), /session header/u)
  state.sessions.get = () => ({ header: { id: state.agent.id, cwd: '../outside' } })
  await assert.rejects(state.adapter.list(state.agent), /absolute CWD/u)
  state.sessions.get = () => ({ header: { id: state.agent.id, cwd: '/workspace/\u202eoutside' } })
  await assert.rejects(state.adapter.list(state.agent), /absolute CWD/u)
  state.addSymlink('/workspace/link')
  state.sessions.get = () => ({ header: { id: state.agent.id, cwd: '/workspace/link' } })
  await assert.rejects(state.adapter.list(state.agent), /real directory/u)
})

test('rejects listing entries that escape the directory or change identity during read', async () => {
  const outside = '/outside/steal.md'
  const state = fixture({ fsOptions: {
    aliases: { [`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`]: outside },
  } })
  state.addFile(outside, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, VALID)
  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands, [])
  assert.equal(readCalls(state).length, 0, 'canonical containment rejects before opening a path outside cwd')

  const changed = fixture({ fsOptions: {
    onRead(filePath, _record, _signal, _limit, nodes) {
      if (filePath.endsWith('/review.md')) nodes.get(filePath).version = 'changed'
    },
  } })
  changed.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, VALID)
  assert.deepEqual((await changed.adapter.list(changed.agent)).commands, [])
})

test('applies the 128-entry, 64 KiB per-file, and 256 KiB aggregate read caps', async () => {
  const directoryLimited = fixture()
  const directory = `${CWD}/${PROJECT_COMMAND_DIRECTORY}`
  const entries = Array.from({ length: 129 }, (_unused, index) => {
    const name = `item-${String(index).padStart(3, '0')}.md`
    const absolute = `${directory}/${name}`
    directoryLimited.addFile(absolute, VALID)
    return { name, type: 'file', target: directoryLimited.targetFor(absolute) }
  })
  directoryLimited.fs.listDir = async target => {
    directoryLimited.calls.push({ method: 'listDir', target })
    return entries
  }
  const cappedList = await directoryLimited.adapter.list(directoryLimited.agent)
  assert.equal(cappedList.truncated, true)
  assert.ok(readCalls(directoryLimited).length <= 128)

  const userRoot = '/Users/alice/.config/opencode/commands'
  const sharedEntryLimit = fixture({ userOpenCodeCommandRoots: [userRoot] })
  sharedEntryLimit.addDirectory(userRoot)
  for (let index = 0; index < 64; index += 1) {
    sharedEntryLimit.addFile(`${directory}/local-${String(index).padStart(3, '0')}.md`, VALID)
  }
  for (let index = 0; index < 65; index += 1) {
    sharedEntryLimit.addFile(`${userRoot}/user-${String(index).padStart(3, '0')}.md`, VALID)
  }
  const sharedEntryList = await sharedEntryLimit.adapter.list(sharedEntryLimit.agent)
  assert.equal(sharedEntryList.truncated, true)
  assert.ok(readCalls(sharedEntryLimit).length <= 128, 'the entry cap is shared across project and user roots')

  const perFile = fixture()
  const tooLarge = `---\ndescription: large\n---\n${'x'.repeat(64 * 1024)}`
  perFile.addFile(`${directory}/large.md`, tooLarge)
  const perFileList = await perFile.adapter.list(perFile.agent)
  assert.equal(perFileList.commands.length, 0)
  assert.equal(readCalls(perFile).length, 0, 'known oversized files are rejected before readBytes')

  const totalRoot = '/Users/alice/.config/opencode/commands'
  const total = fixture({ userOpenCodeCommandRoots: [totalRoot] })
  total.addDirectory(totalRoot)
  const fixedSizeSource = (() => {
    const prefix = '---\ndescription: bounded\n---\n'
    return prefix + 'x'.repeat(64 * 1024 - encoder.encode(prefix).byteLength)
  })()
  for (let index = 0; index < 2; index += 1) total.addFile(`${directory}/local-${index}.md`, fixedSizeSource)
  for (let index = 0; index < 3; index += 1) total.addFile(`${totalRoot}/user-${index}.md`, fixedSizeSource)
  const totalList = await total.adapter.list(total.agent)
  assert.equal(readCalls(total).reduce((sum, call) => sum + call.maxBytes, 0), 4 * 64 * 1024)
  assert.equal(totalList.commands.length, 4)
  assert.equal(totalList.truncated, true)
})

test('uses post-read path identity and directory containment checks', async () => {
  const outside = '/outside/replaced.md'
  const state = fixture({ fsOptions: {
    onRead(filePath, _record, _signal, _limit, _nodes) {
      if (filePath.endsWith('/review.md')) state.fsOptionsAlias = true
    },
  } })
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, VALID)
  const originalResolve = state.fs.resolve
  let replaced = false
  state.fs.resolve = async (value, options) => {
    if (value.endsWith('/review.md') && state.fsOptionsAlias && !replaced) {
      replaced = true
      state.addFile(outside, VALID)
      return state.targetFor(outside)
    }
    return originalResolve(value, options)
  }
  assert.deepEqual((await state.adapter.list(state.agent)).commands, [])

  const claudeCommands = `${CWD}/.claude/commands`
  const changedClaudeScope = fixture({ fsOptions: {
    onRead(filePath, _record, _signal, _limit, nodes) {
      if (filePath.endsWith('/only-claude.md')) nodes.get(claudeCommands).version = 'replaced-directory'
    },
  } })
  changedClaudeScope.addDirectory(`${CWD}/.claude`)
  changedClaudeScope.addDirectory(claudeCommands)
  changedClaudeScope.addFile(`${claudeCommands}/only-claude.md`, VALID)
  assert.deepEqual((await changedClaudeScope.adapter.list(changedClaudeScope.agent)).commands, [], 'Claude command roots are revalidated after reading')
})

test('honors cancellation before scanning and while listDir or readBytes is pending', async t => {
  const preAborted = fixture()
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(preAborted.adapter.list(preAborted.agent, aborted.signal), error => typeof error === 'symbol')
  assert.equal(preAborted.calls.length, 0)

  await t.test('listDir', async () => {
    const controller = new AbortController()
    const state = fixture({ fsOptions: {
      onList: (_target, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('backend aborted')), { once: true })
      }),
    } })
    const pending = state.adapter.list(state.agent, controller.signal)
    controller.abort()
    await assert.rejects(pending, error => typeof error === 'symbol')
  })

  await t.test('readBytes', async () => {
    const controller = new AbortController()
    const state = fixture({ fsOptions: {
      onRead: (_path, _record, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('backend aborted')), { once: true })
      }),
    } })
    state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, VALID)
    const pending = state.adapter.list(state.agent, controller.signal)
    while (readCalls(state).length === 0) await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await assert.rejects(pending, error => typeof error === 'symbol')
  })
})

test('replaces only literal $ARGUMENTS and treats invocation text as opaque prompt text', () => {
  const command = parseProjectCommandDocument('review', '---\ndescription: Review\n---\nLiteral $ARGUMENTS\nShell ! echo ignored\nFile @README.md\nTwice: $ARGUMENTS\n')
  const rawInput = '  user text ; ! touch /tmp/nope @other $ARGUMENTS  '
  assert.equal(renderProjectCommand(command, rawInput), `Literal ${rawInput}\nShell ! echo ignored\nFile @README.md\nTwice: ${rawInput}\n`)
  assert.throws(() => renderProjectCommand({ ...command, body: 'visible\u202e hidden' }, rawInput), /parsed project command/u)
  assert.throws(() => renderProjectCommand(command, 'é'.repeat(9_000)), /exceed 16384 bytes/u)
  assert.throws(() => renderProjectCommand({ ...command, body: '$ARGUMENTS '.repeat(5_000) }, 'x'.repeat(10_000)), /Rendered project command exceeds/u)
})

test('command definition delegates registration and queueing to the caller', () => {
  const command = parseProjectCommandDocument('review', '---\ndescription: Review\n---\nReview: $ARGUMENTS\n')
  const queued = []
  const definition = makeProjectCommandDefinition(command, (...args) => {
    queued.push(args)
    return { kind: 'success', text: 'queued' }
  })
  assert.equal(definition.name, 'review')
  assert.equal(definition.description, 'Review')
  assert.equal(definition.handler({ agent: { id: 'agent-1' }, rawInput: 'argument text' }).kind, 'success')
  assert.deepEqual(queued, [[{ id: 'agent-1' }, 'Review: argument text\n', command]])
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal(definition.handler({ agent: { id: 'agent-1' }, rawInput: 'do not queue', signal: cancelled.signal }).kind, 'error')
  assert.equal(queued.length, 1)
  assert.equal(definition.handler({ rawInput: 'x' }).kind, 'error')
  assert.throws(() => makeProjectCommandDefinition(command, undefined), /queue callback/u)
})

test('registers through an explicit callback and disposes in reverse order', async () => {
  const state = fixture()
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/one.md`, '---\ndescription: One\n---\nOne.\n')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/two.md`, '---\ndescription: Two\n---\nTwo.\n')
  const registered = []
  const disposed = []
  const result = await registerProjectCommandDefinitions(
    state.adapter,
    state.agent,
    definition => {
      registered.push(definition.name)
      return () => disposed.push(definition.name)
    },
    (_agent, prompt) => ({ kind: 'success', text: prompt }),
  )
  assert.deepEqual(registered, ['one', 'two'])
  assert.deepEqual(result.commands.map(command => command.name), ['one', 'two'])
  result.dispose()
  result.dispose()
  assert.deepEqual(disposed, ['two', 'one'])
})

test('rolls back partial explicit registrations if a later registration fails', async () => {
  const state = fixture()
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/one.md`, '---\ndescription: One\n---\nOne.\n')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/two.md`, '---\ndescription: Two\n---\nTwo.\n')
  const disposed = []
  await assert.rejects(registerProjectCommandDefinitions(
    state.adapter,
    state.agent,
    definition => {
      if (definition.name === 'two') throw new Error('registration failed')
      return () => disposed.push(definition.name)
    },
    () => ({}),
  ), /registration failed/u)
  assert.deepEqual(disposed, ['one'])
})

test('integrates project and user-root commands in only the exact live Agent command scope', async () => {
  const userRoot = '/Users/alice/.config/opencode/commands'
  const state = fixture({ userOpenCodeCommandRoots: [userRoot] })
  state.addDirectory(userRoot)
  state.addFile(`${userRoot}/user-level-only.md`, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/local-check.md`, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/omo.md`, '---\ndescription: Shadow attempt\n---\nMust not replace global command.\n')
  state.addDirectory(`${CWD}/.claude`)
  state.addDirectory(`${CWD}/.claude/commands`)
  state.addFile(`${CWD}/.claude/commands/claude-source-only.md`, '---\ndescription: Document request\nargument-hint: "file paths"\n---\nDocument: $ARGUMENTS\n')
  assert.equal((await state.adapter.list(state.agent)).commands.length, 4)
  const globalCommands = new Map()
  const scopedCommands = new Map()
  const listeners = new Map()
  const effects = []
  const warnings = []
  const queued = []
  const agent = state.agent
  agent.followup = message => queued.push(message)
  const services = {
    agents: { get: id => id === agent.id ? agent : undefined },
    sessions: state.sessions,
  }
  const ctx = {
    get: name => services[name],
    tools: { register: () => () => {} },
    commands: {
      find: (_agent, name) => globalCommands.get(name),
      register: definition => {
        globalCommands.set(definition.name, definition)
        return () => globalCommands.delete(definition.name)
      },
    },
    skills: { register: () => () => {}, registerProvider: create => { create({ signal: new AbortController().signal, invalidate() {} }); return () => {} } },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    subagents: {
      startActivation: async () => { throw new Error('unused test activation') },
      getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true } }),
    },
    fs: state.fs,
    logger: { warn(...args) { warnings.push(args) } },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return ctx
    },
    effect(execute, label) {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => {}
    },
  }
  agent.ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['commands'])
      let disposed = false
      const disposers = []
      const injected = {
        commands: {
          find: (_agent, name) => scopedCommands.get(name) ?? globalCommands.get(name),
          register(definition) {
            scopedCommands.set(definition.name, definition)
            return () => scopedCommands.delete(definition.name)
          },
        },
        effect(execute) {
          const dispose = execute()
          if (typeof dispose === 'function') disposers.push(dispose)
          return () => {}
        },
      }
      const ready = Promise.resolve().then(() => callback(injected))
      return {
        then(resolve, reject) { return ready.then(() => resolve?.(), reject) },
        async dispose() {
          if (disposed) return
          disposed = true
          await ready
          for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
        },
      }
    },
  }

  apply(ctx, Config({ enableProjectCommands: true, userOpenCodeCommandRoots: [userRoot] }))
  assert.equal(Config({ enableProjectCommands: true }).enableProjectCommands, true)
  assert.deepEqual(Config({}).userOpenCodeCommandRoots, [])
  assert.equal((listeners.get('agent/created') ?? []).length, 1)
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent, signal: new AbortController().signal })))
  assert.ok(scopedCommands.has('local-check'), JSON.stringify({ warnings, calls: state.calls.map(call => call.method) }))
  assert.ok(scopedCommands.has('user-level-only'), 'explicit user OpenCode roots register in the receiving Agent scope')
  assert.ok(scopedCommands.has('claude-source-only'), 'Claude-style Markdown command files use the same bounded subset')
  assert.equal(scopedCommands.get('claude-source-only').input.hint, 'file paths')
  assert.equal(scopedCommands.get('local-check').input.hint, '[arguments]')
  assert.equal(scopedCommands.has('omo'), false)
  assert.equal(globalCommands.has('local-check'), false, 'project command registration stays Agent-scoped')

  const result = scopedCommands.get('local-check').handler({ agent, rawInput: 'focus', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0].source, { kind: 'user' })
  assert.equal(queued[0].content[0].text, 'Review the selected files.\n')
  scopedCommands.get('user-level-only').handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(queued.length, 2)
  assert.equal(queued[1].content[0].text, 'Review the selected files.\n')

  const secondAgent = { id: 'agent-2', followup() {}, ctx: agent.ctx }
  services.agents.get = id => id === agent.id ? agent : id === secondAgent.id ? secondAgent : undefined
  const originalSessionGet = state.sessions.get
  state.sessions.get = id => id === secondAgent.id
    ? { header: { id, cwd: CWD } }
    : originalSessionGet(id)
  state.nodes.get(userRoot).type = 'symlink'
  const priorScopedCount = scopedCommands.size
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: secondAgent, signal: new AbortController().signal })))
  assert.equal(scopedCommands.size, priorScopedCount, 'an invalid user root registers no Agent command')
  assert.ok(warnings.length > 0, 'invalid roots fail closed and report through the existing warning path')

  await Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent })))
  assert.equal(scopedCommands.size, 0, 'Agent disposal unregisters scoped commands')
  const cleanup = effects.find(effect => effect.label === 'dsh-omo project command source')?.dispose
  assert.equal(typeof cleanup, 'function')
  await cleanup()
})
