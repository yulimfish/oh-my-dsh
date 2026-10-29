import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { posix as path, sep } from 'node:path'
import { parseCommand as parseDshCommand } from '@deepseek-ai/dsh-commands'
import { apply, Config } from '../src/index.js'
import { expandProjectCommandFileReferences } from '../src/project-command-file-expansion.js'
import {
  createProjectCommandAdapter,
  makeProjectCommandDefinition,
  normalizeProjectCommandsRoot,
  normalizeUserAgentsCommandRoots,
  normalizeUserClaudeCommandRoots,
  normalizeUserOpenCodeCommandRoots,
  parseProjectCommandDocument,
  registerProjectCommandDefinitions,
  PROJECT_COMMAND_DIRECTORIES,
  PROJECT_COMMAND_DIRECTORY,
  PROJECT_COMMAND_NAME,
  renderProjectCommand,
  renderExpandedProjectCommand,
} from '../src/project-commands.js'

const encoder = new TextEncoder()
const CWD = '/workspace/project'
const VALID = '---\ndescription: Inspect a requested area\n---\nReview the selected files.\n'

test('installed DSH command parser cannot invoke upstream slash-separated namespaces', () => {
  assert.deepEqual(parseDshCommand('/review-front-end src/changed.ts'), {
    name: 'review-front-end', rawInput: ' src/changed.ts',
  })
  assert.equal(parseDshCommand('/review/front-end src/changed.ts'), undefined)
  assert.equal(parseDshCommand('/review/front-end'), undefined)
  assert.throws(() => parseProjectCommandDocument('review/front-end', VALID), /safe flat lowercase ASCII stem/u)
})

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
    userClaudeCommandRoots: options.userClaudeCommandRoots,
    userAgentsCommandRoots: options.userAgentsCommandRoots,
    projectCommandsRoot: options.projectCommandsRoot,
    allowEmptyDescription: options.allowEmptyDescription,
    allowBlankDisplayMetadata: options.allowBlankDisplayMetadata,
    allowUnterminatedFrontmatter: options.allowUnterminatedFrontmatter,
    allowMalformedFrontmatter: options.allowMalformedFrontmatter,
    allowEmptyBody: options.allowEmptyBody,
    preserveBodyLineEndings: options.preserveBodyLineEndings,
  })
  return { ...memory, agent, session, sessions, adapter }
}

function applyCommandFixture() {
  const state = fixture()
  const globalCommands = new Map()
  const scopedCommands = new Map()
  const listeners = new Map()
  const effects = []
  const queued = []
  const starts = []
  const agent = state.agent
  agent.followup = message => queued.push(message)
  agent.ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['commands'])
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
      const fiber = Promise.resolve().then(() => callback(injected))
      fiber.dispose = async () => {
        await fiber
        for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
      }
      return fiber
    },
  }
  const services = {
    agents: { get: id => id === agent.id ? agent : undefined },
    sessions: state.sessions,
  }
  const ctx = {
    get: name => services[name],
    tools: { register: () => () => {} },
    commands: {
      find: (_agent, name) => globalCommands.get(name),
      register(definition) {
        globalCommands.set(definition.name, definition)
        return () => globalCommands.delete(definition.name)
      },
    },
    skills: {
      register: () => () => {},
      registerProvider: create => {
        create({ signal: new AbortController().signal, invalidate() {} })
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    subagents: {
      async startActivation(spec) {
        starts.push(spec)
        return {
          childId: `command-child-${starts.length}`,
          result: new Promise(() => {}),
          dispose: async () => {},
        }
      },
      getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true } }),
    },
    fs: state.fs,
    logger: { warn() {} },
    on(event, listener) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return ctx
    },
    effect(execute, label) {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => {}
    },
  }
  return {
    ...state,
    agent,
    globalCommands,
    scopedCommands,
    listeners,
    effects,
    queued,
    starts,
    setup(config = {}) {
      apply(ctx, Config({ enableProjectCommands: true, ...config }))
    },
    async createAgent() {
      for (const listener of listeners.get('agent/created') ?? []) {
        await listener({ agent, signal: new AbortController().signal })
      }
    },
    async dispose() {
      for (const listener of listeners.get('agent/disposed') ?? []) await listener({ agent })
      for (let index = effects.length - 1; index >= 0; index -= 1) await effects[index].dispose?.()
    },
  }
}

const listedNames = state => state.calls.filter(call => call.method === 'listDir').map(call => call.target?.path)
const readCalls = state => state.calls.filter(call => call.method === 'readBytes')

test('accepts Host-supported flat lowercase ASCII command stems', () => {
  for (const name of ['go', 'review', 'release-notes', 'v2-check', 'code_review', 'go--now', 'go-', 'a__b']) {
    assert.deepEqual(parseDshCommand(`/${name} files`), { name, rawInput: ' files' })
    assert.equal(PROJECT_COMMAND_NAME.test(name), true, name)
    assert.equal(parseProjectCommandDocument(name, VALID).name, name)
  }
  for (const name of ['', '-go', '_go', 'Go', 'a/b', 'a.b', '../review', 'a\\b', 'a b', 'a\u202eb']) {
    assert.equal(PROJECT_COMMAND_NAME.test(name), false, name)
  }
  assert.throws(() => parseProjectCommandDocument('a'.repeat(65), VALID), /command name/u)
})

test('validates explicit user OpenCode roots and keeps the option default-off', () => {
  const roots = ['/Users/alice/.config/opencode/commands', '/Users/alice/.config/opencode/command']
  assert.deepEqual(normalizeUserOpenCodeCommandRoots(undefined), [])
  assert.deepEqual(normalizeUserOpenCodeCommandRoots(roots), roots)
  assert.deepEqual(normalizeUserOpenCodeCommandRoots([`${roots[0]}/`]), [roots[0]], 'trailing separators are stripped before FS checks')
  if (sep === '/') {
    assert.throws(() => normalizeUserOpenCodeCommandRoots([`${roots[0]}\\`]), /named command or commands/u)
  }
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
  assert.deepEqual(Config({}).userClaudeCommandRoots, [])
})

test('validates only one explicit user Claude command root and keeps it default-off', () => {
  const root = '/Users/alice/.claude/commands'
  assert.deepEqual(normalizeUserClaudeCommandRoots(undefined), [])
  assert.deepEqual(normalizeUserClaudeCommandRoots([root]), [root])
  assert.deepEqual(normalizeUserClaudeCommandRoots([`${root}/`]), [root], 'trailing separators are stripped before filesystem checks')
  if (sep === '/') {
    assert.throws(() => normalizeUserClaudeCommandRoots([`${root}\\`]), /named commands/u)
  }
  assert.ok(Object.isFrozen(normalizeUserClaudeCommandRoots([root])))
  assert.throws(() => normalizeUserClaudeCommandRoots('/Users/alice/.claude/commands'), /must be an array/u)
  assert.throws(() => normalizeUserClaudeCommandRoots(['.claude/commands']), /normalized absolute/u)
  assert.throws(() => normalizeUserClaudeCommandRoots(['~/.claude/commands']), /normalized absolute/u)
  assert.throws(() => normalizeUserClaudeCommandRoots(['/Users/alice/.claude/command']), /named commands/u)
  assert.throws(() => normalizeUserClaudeCommandRoots(['/Users/alice/.claude/../commands']), /normalized absolute/u)
  assert.throws(() => normalizeUserClaudeCommandRoots([`${root}\u202e`]), /normalized absolute/u)
  assert.throws(() => normalizeUserClaudeCommandRoots([root, '/Users/alice/other/commands']), /at most 1 roots/u)
  assert.throws(() => apply({}, Config({ userClaudeCommandRoots: [root] })), /requires enableProjectCommands/u)
})

test('validates explicit user Agents command roots and keeps them default-off', () => {
  const roots = ['/Users/alice/.agents/skills', '/Users/alice/shared/skills']
  assert.deepEqual(normalizeUserAgentsCommandRoots(undefined), [])
  assert.deepEqual(normalizeUserAgentsCommandRoots(roots), roots)
  assert.ok(Object.isFrozen(normalizeUserAgentsCommandRoots(roots)))
  assert.deepEqual(Config({}).userAgentsCommandRoots, [])
  assert.throws(() => normalizeUserAgentsCommandRoots(['relative/skills']), /normalized absolute/u)
  assert.throws(() => normalizeUserAgentsCommandRoots(['/Users/alice/.agents/commands']), /named skills/u)
  assert.throws(() => normalizeUserAgentsCommandRoots([...roots, '/Users/alice/other/skills']), /at most 2 roots/u)
  assert.throws(() => normalizeUserAgentsCommandRoots([roots[0], `${roots[0]}/`]), /must not contain duplicates/u)
  assert.throws(() => apply({}, Config({ userAgentsCommandRoots: [roots[0]] })), /requires enableProjectCommands/u)
})

test('validates one explicit project-command root and keeps it opt-in', () => {
  assert.equal(normalizeProjectCommandsRoot(undefined), undefined)
  assert.equal(normalizeProjectCommandsRoot(''), undefined)
  assert.equal(normalizeProjectCommandsRoot('/workspace/project'), '/workspace/project')
  assert.equal(normalizeProjectCommandsRoot('/workspace/project/'), '/workspace/project')
  assert.throws(() => normalizeProjectCommandsRoot('workspace/project'), /normalized absolute/u)
  assert.throws(() => normalizeProjectCommandsRoot('/workspace/../project'), /normalized absolute/u)
  assert.throws(() => normalizeProjectCommandsRoot('/'), /non-filesystem-root/u)
  assert.throws(() => normalizeProjectCommandsRoot('/workspace/project\u202e'), /non-filesystem-root/u)
  assert.equal(Config({}).enableProjectRootCommands, false)
  assert.equal(Config({}).projectCommandsRoot, '')
  assert.throws(() => apply({}, Config({ projectCommandsRoot: '/workspace/project' })), /projectCommandsRoot requires enableProjectRootCommands/u)
  assert.throws(() => apply({}, Config({ enableProjectRootCommands: true })), /enableProjectRootCommands requires enableProjectCommands/u)
  assert.throws(() => apply({}, Config({ enableProjectCommands: true, enableProjectRootCommands: true })), /enableProjectRootCommands requires projectCommandsRoot/u)
})

test('parses bounded argument hints from Claude and OpenCode command sources', () => {
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
  const openCodeHint = parseProjectCommandDocument('review', '---\ndescription: Inspect files\nargument-hint: files\n---\nReview.\n')
  assert.equal(openCodeHint.argumentHint, 'files')
  assert.equal(makeProjectCommandDefinition(openCodeHint, () => ({ kind: 'success' })).input.hint, 'files')
  assert.throws(() => parseProjectCommandDocument('review', '---\nother: x\ndescription: ok\n---\nBody'), /only description and argument-hint keys/u)
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

test('empty descriptions remain strict unless the explicit compatibility option is enabled', () => {
  for (const source of ['opencode', 'claude']) {
    const sourceText = '---\ndescription: ""\n---\nReview $ARGUMENTS.\n'
    assert.throws(() => parseProjectCommandDocument('review', sourceText, source), /description/u)
    const parsed = parseProjectCommandDocument('review', sourceText, source, { allowEmptyDescription: true })
    assert.equal(parsed.description, 'Project command /review')
    const queued = []
    const definition = makeProjectCommandDefinition(parsed, (_agent, prompt) => {
      queued.push(prompt)
      return { kind: 'success' }
    })
    assert.equal(definition.handler({ agent: { id: 'agent-1' }, rawInput: 'src/changed.ts' }).kind, 'success')
    assert.match(queued[0], /Review src\/changed\.ts\./u)
    for (const value of ['null', '', 'false']) {
      const input = `---\ndescription: ${value}\n---\nBody`
      assert.throws(() => parseProjectCommandDocument('review', input, source), /description/u)
      assert.throws(() => parseProjectCommandDocument('review', input, source, { allowEmptyDescription: true }), /description/u)
    }
    assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: " "\n---\nBody', source, { allowEmptyDescription: true }), /description/u)
  }
  assert.throws(() => parseProjectCommandDocument('review', VALID, 'opencode', { allowEmptyDescription: 'true' }), /boolean/u)
})

test('blank display metadata compatibility is separately opt-in and Host-safe', () => {
  for (const source of ['opencode', 'claude']) {
    const descriptionSource = '---\ndescription: "   "\n---\nBody.\n'
    assert.throws(() => parseProjectCommandDocument('review', descriptionSource, source), /description/u)
    assert.throws(() => parseProjectCommandDocument('review', descriptionSource, source, { allowEmptyDescription: true }), /description/u)
    const parsed = parseProjectCommandDocument('review', descriptionSource, source, { allowBlankDisplayMetadata: true })
    assert.equal(parsed.description, 'Project command /review')
    for (const value of ['""', '"   "']) {
      const input = `---\ndescription: Review\nargument-hint: ${value}\n---\nBody.\n`
      assert.throws(() => parseProjectCommandDocument('review', input, source), /argument-hint/u)
      const compatible = parseProjectCommandDocument('review', input, source, { allowBlankDisplayMetadata: true })
      assert.equal(Object.hasOwn(compatible, 'argumentHint'), false)
      assert.equal(makeProjectCommandDefinition(compatible, () => ({ kind: 'success' })).input.hint, '[arguments]')
    }
    assert.equal(parseProjectCommandDocument('review', `---\ndescription: "${' '.repeat(1000)}"\n---\nBody`, source, { allowBlankDisplayMetadata: true }).description, 'Project command /review')
    assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: "${' '.repeat(1001)}"\n---\nBody`, source, { allowBlankDisplayMetadata: true }), /1000/u)
    assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: null\n---\nBody', source, { allowBlankDisplayMetadata: true }), /description/u)
  }
  assert.throws(() => parseProjectCommandDocument('review', VALID, 'opencode', { allowBlankDisplayMetadata: 'true' }), /boolean/u)
})

test('loads plain Markdown and missing-description commands from both source types', () => {
  for (const source of ['opencode', 'claude']) {
    const plain = parseProjectCommandDocument('review', '\uFEFF# Review\r\nInspect $ARGUMENTS.\r\n', source)
    assert.equal(plain.description, 'Project command /review')
    assert.equal(plain.body, '# Review\nInspect $ARGUMENTS.\n')
    assert.equal(makeProjectCommandDefinition(plain, () => ({ kind: 'success' })).description, 'Project command /review')
    const hintOnly = parseProjectCommandDocument('review', '---\nargument-hint: files\n---\nInspect the files.\n', source)
    assert.equal(hintOnly.description, 'Project command /review')
    assert.equal(hintOnly.argumentHint, 'files')
    const emptyMetadata = parseProjectCommandDocument('review', '---\n---\nInspect the files.\n', source)
    assert.equal(emptyMetadata.body, 'Inspect the files.\n')
    assert.equal(emptyMetadata.description, 'Project command /review')
    assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: broken\n', source), /closing delimiter/u)
    assert.throws(() => parseProjectCommandDocument('review', '  \n', source), /body/u)
  }
})

test('unterminated and EOF-closed frontmatter are plain text only in the pinned compatibility mode', () => {
  for (const source of ['opencode', 'claude']) {
    for (const input of [
      '---\ndescription: Review\n',
      '---\r\ndescription: Review\r\n',
      '---\ndescription: Review\n---',
    ]) {
      assert.throws(() => parseProjectCommandDocument('review', input, source), /closing delimiter|body/u)
      const parsed = parseProjectCommandDocument('review', input, source, { allowUnterminatedFrontmatter: true })
      assert.equal(parsed.description, 'Project command /review')
      assert.equal(parsed.body, input.replace(/\r\n?/gu, '\n'))
      const rendered = renderProjectCommand(parsed, '  src/changed.ts  ')
      assert.match(rendered, /<command-instruction>\n---\ndescription: Review/u)
      assert.match(rendered, /<user-request>\n  src\/changed\.ts  \n<\/user-request>/u)
    }
    for (const input of [
      '---\rdescription: Review\ragent: reviewer\r---\rBody',
      '---\r\ndescription: Review\ragent: reviewer\r---\rBody',
    ]) {
      const parsed = parseProjectCommandDocument('review', input, source, { allowUnterminatedFrontmatter: true })
      assert.equal(parsed.body, input.replace(/\r\n?/gu, '\n'))
      assert.equal(Object.hasOwn(parsed, 'agent'), false)
    }
    assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: [broken\n---\nBody.\n', source, { allowUnterminatedFrontmatter: true }), /frontmatter/u)
    const literalMetadata = parseProjectCommandDocument('review', '---\ndescription: Review\nagent: reviewer\n', source, { allowUnterminatedFrontmatter: true })
    assert.equal(literalMetadata.body, '---\ndescription: Review\nagent: reviewer\n')
    assert.equal(Object.hasOwn(literalMetadata, 'agent'), false)
  }
  assert.throws(() => parseProjectCommandDocument('review', VALID, 'opencode', { allowUnterminatedFrontmatter: 'true' }), /boolean/u)
})

test('malformed closed YAML can discard all metadata only through an explicit compatibility option', () => {
  for (const source of ['opencode', 'claude']) {
    const input = '---\ndescription: [broken\nagent: reviewer\n---\nBody.\n'
    assert.throws(() => parseProjectCommandDocument('review', input, source), /frontmatter/u)
    assert.throws(() => parseProjectCommandDocument('review', input, source, { allowUnterminatedFrontmatter: true }), /frontmatter/u)
    const parsed = parseProjectCommandDocument('review', input, source, { allowMalformedFrontmatter: true })
    assert.equal(parsed.description, 'Project command /review')
    assert.equal(parsed.body, 'Body.\n')
    assert.equal(Object.hasOwn(parsed, 'agent'), false)
    assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: one\ndescription: two\n---\nBody', source, { allowMalformedFrontmatter: true }), /frontmatter/u)
    assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: Review\nagent: reviewer\n---\nBody', source, { allowMalformedFrontmatter: true }), /only description and argument-hint/u)
    assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: [broken\n', source, { allowMalformedFrontmatter: true }), /closing delimiter/u)
    for (const options of [{ allowMalformedFrontmatter: true }, { allowMalformedFrontmatter: true, allowUnterminatedFrontmatter: true }]) {
      const adjacent = parseProjectCommandDocument('review', '---\ndescription: [broken---\nBody', source, options)
      assert.equal(adjacent.description, 'Project command /review')
      assert.equal(adjacent.body, 'Body')
    }
  }
  assert.throws(() => parseProjectCommandDocument('review', VALID, 'opencode', { allowMalformedFrontmatter: 'true' }), /boolean/u)
})

test('both command sources reject unsafe hints and execution-affecting frontmatter', () => {
  for (const source of ['opencode', 'claude']) {
    for (const hint of ['[files]', '""', '"one\\ntwo"', `"${'x'.repeat(161)}"`, '"hidden\\u202Etext"']) {
      assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: Review\nargument-hint: ${hint}\n---\nBody`, source), /argument-hint/u)
    }
    for (const field of ['agent', 'model', 'subtask', 'handoffs', 'tools', 'allowed-tools']) {
      assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: Review\n${field}: value\n---\nBody`, source), /only description and argument-hint/u)
    }
  }
})

test('requires a nonempty bounded body, rejects prompt controls, and enforces strict UTF-8', () => {
  assert.throws(() => parseProjectCommandDocument('review', '---\ndescription: valid\n---\n  \n'), /body/u)
  assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: valid\n---\n${'x'.repeat(64 * 1024 + 1)}`), /file|body/u)
  for (const unsafe of ['visible\u202e hidden', 'visible\u0001 hidden', 'visible\u0085 hidden']) {
    assert.throws(() => parseProjectCommandDocument('review', `---\ndescription: valid\n---\n${unsafe}`), /control or bidi/u)
  }
  assert.throws(() => parseProjectCommandDocument('review', new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff])), /UTF-8/u)
  assert.throws(() => parseProjectCommandDocument('../review', VALID), /safe flat lowercase ASCII stem/u)
})

test('empty command bodies are accepted only in the explicit upstream compatibility mode', () => {
  for (const source of ['opencode', 'claude']) {
    for (const body of ['', '   \n\t']) {
      const input = `---\ndescription: Review\n---\n${body}`
      assert.throws(() => parseProjectCommandDocument('review', input, source), /body/u)
      const parsed = parseProjectCommandDocument('review', input, source, { allowEmptyBody: true })
      assert.equal(parsed.body, body)
      const rendered = renderProjectCommand(parsed, '  actual request  ')
      assert.equal(rendered, '<command-instruction>\n\n</command-instruction>\n\n<user-request>\n  actual request  \n</user-request>')
      const expanded = renderExpandedProjectCommand(parsed, ' \n', '  actual request  ')
      assert.equal(expanded, rendered)
    }
  }
  assert.throws(() => parseProjectCommandDocument('review', VALID, 'opencode', { allowEmptyBody: 'true' }), /boolean/u)
})

test('body line-ending compatibility preserves internal CR and CRLF without changing argument framing', () => {
  for (const source of ['opencode', 'claude']) {
    for (const input of [
      'First\r\nSecond $ARGUMENTS\r\n',
      '---\r\ndescription: Review\r\n---\r\nFirst\r\nSecond $ARGUMENTS\r\n',
      '---\ndescription: Review\n---\nFirst\rSecond $ARGUMENTS\r',
      '---\rdescription: Review\r---\rFirst\rSecond $ARGUMENTS\r',
    ]) {
      const parsed = parseProjectCommandDocument('review', input, source, { preserveBodyLineEndings: true })
      const body = input.startsWith('---')
        ? input.slice(input.lastIndexOf('---') + 4).replace(/^(?:\r\n|\r|\n)/u, '')
        : input
      assert.equal(parsed.body, body)
      const rendered = renderProjectCommand(parsed, ' raw request ')
      const lineEnding = body.includes('\r\n') ? '\r\n' : body.includes('\r') ? '\r' : '\n'
      assert.ok(rendered.includes(`First${lineEnding}Second  raw request `))
      assert.ok(rendered.endsWith('<user-request>\n raw request \n</user-request>'))
    }
    assert.equal(parseProjectCommandDocument('review', 'First\r\nSecond\r\n', source).body, 'First\nSecond\n')
    assert.equal(parseProjectCommandDocument('review', '---\r\ndescription: Review\r\n---\r\n\r\nBody\r\n', source).body, 'Body\n')
  }
  assert.throws(() => parseProjectCommandDocument('review', VALID, 'opencode', { preserveBodyLineEndings: 'true' }), /boolean/u)
})

test('blank higher-priority commands shadow fallback only in empty-body compatibility mode', async () => {
  const root = `${CWD}/${PROJECT_COMMAND_DIRECTORY}`
  const claudeCommands = `${CWD}/.claude/commands`
  for (const allowEmptyBody of [false, true]) {
    const state = fixture({ allowEmptyBody })
    state.addDirectory(`${CWD}/.claude`)
    state.addDirectory(claudeCommands)
    state.addFile(`${root}/shared.md`, '---\ndescription: OpenCode\n---\n')
    state.addFile(`${claudeCommands}/shared.md`, '---\ndescription: Claude fallback\n---\nClaude body.\n')
    const result = await state.adapter.list(state.agent)
    assert.equal(result.commands[0].description, allowEmptyBody ? 'OpenCode' : 'Claude fallback')
  }
})

test('returns bounded exact watch targets for existing command roots', async () => {
  const userRoot = '/Users/alice/.config/opencode/commands'
  const userClaudeRoot = '/Users/alice/.claude/commands'
  const state = fixture({ userOpenCodeCommandRoots: [userRoot], userClaudeCommandRoots: [userClaudeRoot] })
  state.addDirectory(`${CWD}/.claude`)
  state.addDirectory(`${CWD}/.claude/commands`)
  state.addDirectory(userRoot)
  state.addDirectory(userClaudeRoot)
  const targets = await state.adapter.watchTargets(state.agent)
  assert.deepEqual(targets.map(target => target.path), [
    `${CWD}/.opencode`, `${CWD}/${PROJECT_COMMAND_DIRECTORY}`,
    `${CWD}/.claude`, `${CWD}/.claude/commands`, userRoot, userClaudeRoot,
  ])
})

test('watches contained missing project parents and explicit user command roots', async () => {
  const userRoot = '/Users/alice/.config/opencode/commands'
  const state = fixture({ userOpenCodeCommandRoots: [userRoot] })
  state.nodes.delete(`${CWD}/${PROJECT_COMMAND_DIRECTORY}`)
  state.nodes.delete(`${CWD}/.opencode`)
  const outsideParent = '/outside/.claude'
  state.fs.resolve = async (value, options = {}) => {
    const requested = path.resolve(options.cwd ?? CWD, value)
    state.calls.push({ method: 'resolve', value, options })
    return state.targetFor(requested === `${CWD}/.claude` ? outsideParent : requested)
  }

  const targets = await state.adapter.watchTargets(state.agent)
  assert.deepEqual(targets.map(target => target.path), [`${CWD}/.opencode`, userRoot])
  assert.equal(targets.some(target => target.path === outsideParent), false)
  assert.equal(listedNames(state).length, 0, 'watch target discovery does not enumerate absent roots')
})

test('does not watch a configured root replaced by a symlink during target resolution', async () => {
  const userRoot = '/Users/alice/.config/opencode/late-root/commands'
  const state = fixture({ userOpenCodeCommandRoots: [userRoot] })
  const originalResolve = state.fs.resolve
  state.fs.resolve = async (value, options = {}) => {
    const requested = path.resolve(options.cwd ?? CWD, value)
    if (requested === userRoot && !state.nodes.has(userRoot)) state.addSymlink(userRoot)
    return originalResolve(value, options)
  }

  const targets = await state.adapter.watchTargets(state.agent)
  assert.equal(targets.some(target => target.path === userRoot), false)
  assert.equal(readCalls(state).some(call => call.target?.path === userRoot), false)
})

test('falls back for absent configured user roots when the provider cannot resolve them', async () => {
  const userRoot = '/Users/alice/.config/opencode/late-root/commands'
  const state = fixture({ userOpenCodeCommandRoots: [userRoot] })
  const originalResolve = state.fs.resolve
  state.fs.resolve = async (value, options = {}) => {
    if (path.resolve(options.cwd ?? CWD, value) === userRoot) throw new Error('provider cannot resolve absent targets')
    return originalResolve(value, options)
  }

  const targets = await state.adapter.watchTargets(state.agent)
  assert.ok(targets.some(target => target.path === `${CWD}/${PROJECT_COMMAND_DIRECTORY}`), 'other safe project targets remain watchable')
  assert.equal(targets.some(target => target.path === userRoot), false, 'the unresolvable explicit root remains a manual-refresh case')
})

test('lists only direct .md commands from the exact project cwd', async () => {
  const state = fixture()
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/Release.md`, VALID)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/bad.name.md`, VALID)
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

test('discovers and queues plain Markdown commands without frontmatter', async () => {
  const state = fixture()
  state.addDirectory(`${CWD}/.claude`)
  state.addDirectory(`${CWD}/.claude/commands`)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/plain_open.md`, 'Inspect $ARGUMENTS.\n')
  state.addFile(`${CWD}/.claude/commands/plain-claude.md`, 'Review the requested files.\n')
  const scan = await state.adapter.list(state.agent)
  assert.deepEqual(scan.commands.map(command => command.name), ['plain_open', 'plain-claude'])
  const queued = []
  for (const command of scan.commands) {
    const definition = makeProjectCommandDefinition(command, (_agent, prompt) => {
      queued.push(prompt)
      return { kind: 'success' }
    })
    assert.equal(definition.description, `Project command /${command.name}`)
    assert.equal(definition.handler({ agent: state.agent, rawInput: 'src/changed.ts' }).kind, 'success')
  }
  assert.match(queued[0], /Inspect src\/changed\.ts\./u)
  assert.ok(queued.every(prompt => prompt.includes('<user-request>\nsrc/changed.ts\n</user-request>')))
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
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/fallback.md`, '---\ndescription: [unfinished\n---\nMalformed plural OpenCode source.')
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

test('reads explicit Agents command roots between OpenCode and Claude user roots', async () => {
  const openCodeRoot = '/Users/alice/.config/opencode/commands'
  const agentsRoot = '/Users/alice/.agents/skills'
  const claudeRoot = '/Users/alice/.claude/commands'
  const state = fixture({ userOpenCodeCommandRoots: [openCodeRoot], userAgentsCommandRoots: [agentsRoot], userClaudeCommandRoots: [claudeRoot] })
  for (const root of [openCodeRoot, agentsRoot, claudeRoot]) state.addDirectory(root)
  state.addFile(`${openCodeRoot}/shared.md`, '---\ndescription: OpenCode\n---\nOpenCode body.\n')
  state.addFile(`${agentsRoot}/shared.md`, '---\ndescription: Agents\n---\nAgents body.\n')
  state.addFile(`${claudeRoot}/shared.md`, '---\ndescription: Claude\n---\nClaude body.\n')
  state.addFile(`${agentsRoot}/agents.md`, '---\ndescription: Agents\n---\nAgents body.\n')
  state.addFile(`${claudeRoot}/agents.md`, '---\ndescription: Claude shadowed\n---\nClaude body.\n')
  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands.map(command => [command.name, command.description]), [
    ['shared', 'OpenCode'], ['agents', 'Agents'],
  ])
  const disabled = fixture()
  disabled.addDirectory(agentsRoot)
  disabled.addFile(`${agentsRoot}/must-not-load.md`, VALID)
  assert.deepEqual((await disabled.adapter.list(disabled.agent)).commands, [])
})

test('opt-in empty descriptions change same-name fallback only through discovery compatibility', async () => {
  const state = fixture({ allowEmptyDescription: true })
  const claudeCommands = `${CWD}/.claude/commands`
  state.addDirectory(`${CWD}/.claude`)
  state.addDirectory(claudeCommands)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, '---\ndescription: ""\n---\nOpenCode body.\n')
  state.addFile(`${claudeCommands}/review.md`, '---\ndescription: Claude fallback\n---\nClaude body.\n')
  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands.map(command => [command.description, command.body]), [
    ['Project command /review', 'OpenCode body.\n'],
  ])
  const strict = fixture()
  strict.addDirectory(`${CWD}/.claude`)
  strict.addDirectory(claudeCommands)
  strict.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, '---\ndescription: ""\n---\nOpenCode body.\n')
  strict.addFile(`${claudeCommands}/review.md`, '---\ndescription: Claude fallback\n---\nClaude body.\n')
  assert.equal((await strict.adapter.list(strict.agent)).commands[0].description, 'Claude fallback')
  for (const allowEmptyDescription of [false, true]) {
    const invalid = fixture({ allowEmptyDescription })
    invalid.addDirectory(`${CWD}/.claude`)
    invalid.addDirectory(claudeCommands)
    invalid.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, '---\ndescription: null\n---\nMust not win.\n')
    invalid.addFile(`${claudeCommands}/review.md`, '---\ndescription: Claude fallback\n---\nClaude body.\n')
    assert.equal((await invalid.adapter.list(invalid.agent)).commands[0].description, 'Claude fallback')
  }
})

test('unsupported agent metadata skips the higher-priority command and permits valid fallback', async () => {
  const state = fixture()
  const claudeCommands = `${CWD}/.claude/commands`
  state.addDirectory(`${CWD}/.claude`)
  state.addDirectory(claudeCommands)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review.md`, '---\ndescription: Routed upstream\nagent: reviewer\n---\nHigher priority body.\n')
  state.addFile(`${claudeCommands}/review.md`, '---\ndescription: Local fallback\n---\nLower priority body.\n')
  const result = await state.adapter.list(state.agent)
  assert.equal(result.skipped, 1)
  assert.equal(result.commands.length, 1)
  assert.equal(result.commands[0].description, 'Local fallback')
  assert.equal(result.commands[0].body, 'Lower priority body.\n')
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

test('reads an explicit user Claude root after project and OpenCode roots', async () => {
  const openCodeRoot = '/Users/alice/.config/opencode/commands'
  const claudeRoot = '/Users/alice/.claude/commands'
  const state = fixture({ userOpenCodeCommandRoots: [openCodeRoot], userClaudeCommandRoots: [claudeRoot] })
  state.addDirectory(openCodeRoot)
  state.addDirectory(claudeRoot)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/priority.md`, '---\ndescription: Project wins\n---\nProject body.\n')
  state.addFile(`${openCodeRoot}/priority.md`, '---\ndescription: OpenCode wins over user Claude\n---\nOpenCode body.\n')
  state.addFile(`${claudeRoot}/priority.md`, '---\ndescription: Claude is lower priority\n---\nClaude body.\n')
  state.addFile(`${claudeRoot}/claude-only.md`, '---\ndescription: User Claude command\nargument-hint: "file paths"\n---\nRead: $ARGUMENTS\n')

  const result = await state.adapter.list(state.agent)
  assert.deepEqual(Object.fromEntries(result.commands.map(command => [command.name, command.description])), {
    priority: 'Project wins',
    'claude-only': 'User Claude command',
  })
  assert.equal(result.commands.find(command => command.name === 'claude-only').argumentHint, 'file paths')
  assert.deepEqual(listedNames(state), [`${CWD}/${PROJECT_COMMAND_DIRECTORY}`, openCodeRoot, claudeRoot])

  const defaultOff = fixture()
  defaultOff.addDirectory(claudeRoot)
  defaultOff.addFile(`${claudeRoot}/must-not-load.md`, VALID)
  assert.deepEqual((await defaultOff.adapter.list(defaultOff.agent)).commands, [])
  assert.ok(!listedNames(defaultOff).includes(claudeRoot), 'no user Claude path is inferred or scanned by default')

  const missing = fixture({ userClaudeCommandRoots: [claudeRoot] })
  missing.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/project-only.md`, VALID)
  assert.deepEqual((await missing.adapter.list(missing.agent)).commands.map(command => command.name), ['project-only'])
  assert.ok(!listedNames(missing).includes(claudeRoot), 'a missing user Claude root leaves project commands available')
})

test('loads explicit project-root commands before exact-CWD sources', async () => {
  const root = '/workspace'
  const cwd = `${root}/project/apps/web`
  const state = fixture({ cwd, projectCommandsRoot: root })
  for (const directory of [
    root,
    `${root}/.opencode`, `${root}/.opencode/commands`, `${root}/.opencode/command`,
    `${root}/.claude`, `${root}/.claude/commands`,
    cwd, `${cwd}/.opencode`, `${cwd}/.opencode/commands`,
  ]) state.addDirectory(directory)
  state.addFile(`${root}/.opencode/commands/shared.md`, '---\ndescription: Explicit project root wins\n---\nRoot body @README.md.\n')
  state.addFile(`${root}/.opencode/commands/root-only.md`, '---\ndescription: Root-only command\n---\nRoot-only body.\n')
  state.addFile(`${root}/.claude/commands/claude-only.md`, '---\ndescription: Root Claude command\nargument-hint: "file paths"\n---\nRead: $ARGUMENTS\n', 'v1')
  state.addFile(`${cwd}/.opencode/commands/shared.md`, '---\ndescription: Nested CWD duplicate\n---\nNested body.\n')
  state.addFile(`${cwd}/.opencode/commands/cwd-only.md`, '---\ndescription: Nested CWD command\n---\nNested body.\n')

  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands.map(command => command.name), ['root-only', 'shared', 'claude-only', 'cwd-only'])
  assert.deepEqual(Object.fromEntries(result.commands.map(command => [command.name, command.description])), {
    'root-only': 'Root-only command',
    shared: 'Explicit project root wins',
    'claude-only': 'Root Claude command',
    'cwd-only': 'Nested CWD command',
  })
  assert.equal(result.commands.find(command => command.name === 'shared').body, 'Root body @README.md.\n')
  assert.equal(result.commands.find(command => command.name === 'claude-only').argumentHint, 'file paths')
  assert.deepEqual(listedNames(state), [
    `${root}/.opencode/commands`, `${root}/.opencode/command`, `${root}/.claude/commands`,
    `${cwd}/.opencode/commands`,
  ])
  assert.ok(state.calls.some(call => call.method === 'lstat' && call.value === root), 'the DSH FS validates the configured absolute project root')
})

test('ignores explicit project-root commands outside the live Agent CWD boundary', async () => {
  const root = '/workspace'
  const cwd = '/outside/project'
  const state = fixture({ cwd, projectCommandsRoot: root })
  state.addDirectory(root)
  state.addDirectory(`${root}/.opencode`)
  state.addDirectory(`${root}/.opencode/commands`)
  state.addDirectory(cwd)
  state.addDirectory(`${cwd}/.opencode`)
  state.addDirectory(`${cwd}/.opencode/commands`)
  state.addFile(`${root}/.opencode/commands/outside-only.md`, VALID)
  state.addFile(`${cwd}/.opencode/commands/local-only.md`, VALID)

  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands.map(command => command.name), ['local-only'])
  assert.ok(!listedNames(state).includes(`${root}/.opencode/commands`), 'an out-of-scope root is never enumerated')
})

test('skips symlinked explicit-root components without disabling safe CWD commands', async () => {
  const root = '/workspace'
  const cwd = `${root}/project/apps/web`
  const state = fixture({ cwd, projectCommandsRoot: root })
  state.addDirectory(root)
  state.addSymlink(`${root}/.opencode`)
  state.addDirectory(cwd)
  state.addDirectory(`${cwd}/.opencode`)
  state.addDirectory(`${cwd}/.opencode/commands`)
  state.addFile(`${cwd}/.opencode/commands/local-only.md`, VALID)
  state.addFile(`${root}/.opencode/commands/unsafe.md`, VALID)

  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands.map(command => command.name), ['local-only'])
  assert.ok(!listedNames(state).includes(`${root}/.opencode/commands`), 'symlinked project command parents are not followed')
})

test('rejects symlinked explicit roots and command-directory leaves without disabling CWD commands', async () => {
  const root = '/workspace'
  const cwd = `${root}/project/apps/web`
  const cases = [
    { symlink: root, parents: [] },
    { symlink: `${root}/.opencode/commands`, parents: [root, `${root}/.opencode`] },
    { symlink: `${root}/.claude/commands`, parents: [root, `${root}/.claude`] },
  ]
  for (const { symlink, parents } of cases) {
    const state = fixture({ cwd, projectCommandsRoot: root })
    for (const directory of [...parents, cwd, `${cwd}/.opencode`, `${cwd}/.opencode/commands`]) {
      state.addDirectory(directory)
    }
    state.addSymlink(symlink)
    state.addFile(`${cwd}/.opencode/commands/local-only.md`, VALID)

    const result = await state.adapter.list(state.agent)
    assert.deepEqual(result.commands.map(command => command.name), ['local-only'])
    assert.ok(!listedNames(state).some(name => name.startsWith(`${root}/.opencode/`) || name.startsWith(`${root}/.claude/`)))
  }
})

test('revalidates explicit project-root identity after scanning', async () => {
  const root = '/workspace'
  const cwd = `${root}/project/apps/web`
  const aliases = {}
  const file = `${root}/.opencode/commands/root-only.md`
  const state = fixture({
    cwd,
    projectCommandsRoot: root,
    fsOptions: {
      aliases,
      onRead(target) { if (target === file) aliases[root] = '/outside/replaced-root' },
    },
  })
  for (const directory of [root, `${root}/.opencode`, `${root}/.opencode/commands`, cwd, `${cwd}/.opencode`, `${cwd}/.opencode/commands`]) {
    state.addDirectory(directory)
  }
  state.addFile(file, VALID)

  const result = await state.adapter.list(state.agent)
  assert.deepEqual(result.commands, [], 'a root identity changed during read invalidates the entire scan snapshot')
})

test('includes the explicit project root and its command parents in bounded watch targets', async () => {
  const root = '/workspace'
  const cwd = `${root}/project/apps/web`
  const state = fixture({ cwd, projectCommandsRoot: root })
  for (const directory of [
    root, `${root}/.opencode`, `${root}/.opencode/commands`,
    cwd, `${cwd}/.opencode`, `${cwd}/.opencode/commands`,
  ]) state.addDirectory(directory)

  const targets = await state.adapter.watchTargets(state.agent)
  const targetPaths = targets.map(target => target.path)
  assert.ok(targetPaths.includes(root), 'the configured project boundary itself is watched')
  assert.ok(targetPaths.includes(`${root}/.opencode`), 'the project parent can observe command-directory creation')
  assert.ok(targetPaths.includes(`${root}/.opencode/commands`), 'existing project commands are watched')
  assert.ok(targetPaths.includes(`${cwd}/.opencode/commands`), 'exact-CWD commands remain watched')
  assert.equal(new Set(targets.map(target => target.targetKey)).size, targets.length)
})

test('wires the explicit project root through Agent setup and manual refresh', async () => {
  const root = '/workspace'
  const cwd = `${root}/project/apps/web`
  const state = fixture({ cwd })
  for (const directory of [
    root, `${root}/.opencode`, `${root}/.opencode/commands`,
    cwd, `${cwd}/.opencode`, `${cwd}/.opencode/commands`,
  ]) state.addDirectory(directory)
  state.addFile(`${root}/.opencode/commands/root-only.md`, VALID)
  state.addFile(`${root}/.opencode/commands/global-wins.md`, VALID)
  state.addFile(`${cwd}/.opencode/commands/cwd-only.md`, VALID)

  const globalCommands = new Map([['global-wins', { name: 'global-wins' }]])
  const scopedCommands = new Map()
  const listeners = new Map()
  const effects = []
  const warnings = []
  const watchSubscriptions = []
  state.fs.watch = async (target, changed, signal) => {
    const subscription = { target, changed, signal, closed: false }
    watchSubscriptions.push(subscription)
    return async () => { subscription.closed = true }
  }
  const agent = state.agent
  agent.followup = () => {}
  agent.ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['commands'])
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
      const fiber = Promise.resolve().then(() => callback(injected))
      fiber.dispose = async () => {
        await fiber
        for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
      }
      return fiber
    },
  }
  const services = {
    agents: { get: id => id === agent.id ? agent : undefined },
    sessions: state.sessions,
  }
  const ctx = {
    get: name => services[name],
    tools: { register: () => () => {} },
    commands: {
      find: (_agent, name) => globalCommands.get(name),
      register(definition) {
        globalCommands.set(definition.name, definition)
        return () => globalCommands.delete(definition.name)
      },
    },
    skills: {
      register: () => () => {},
      registerProvider: create => { create({ signal: new AbortController().signal, invalidate() {} }); return () => {} },
    },
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

  apply(ctx, Config({
    enableProjectCommands: true,
    enableProjectRootCommands: true,
    projectCommandsRoot: root,
    enableProjectCommandWatch: true,
  }))
  for (const listener of listeners.get('agent/created') ?? []) {
    await listener({ agent, signal: new AbortController().signal })
  }
  assert.deepEqual([...scopedCommands.keys()].sort(), ['cwd-only', 'root-only'])
  assert.ok(!scopedCommands.has('global-wins'), 'the global command registry continues to shadow project-root commands')
  const rootWatcher = watchSubscriptions.find(subscription => subscription.target.path === root)
  assert.ok(rootWatcher, 'watch mode subscribes to the explicit project boundary')
  assert.ok(watchSubscriptions.some(subscription => subscription.target.path === `${root}/.opencode/commands`), 'existing project-root commands are watched')
  state.addFile(`${root}/.opencode/commands/watched-root.md`, VALID)
  rootWatcher.changed()
  for (let attempt = 0; attempt < 200 && !scopedCommands.has('watched-root'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(scopedCommands.has('watched-root'), 'a project-root watcher automatically refreshes root-sourced commands')
  await new Promise(resolve => setTimeout(resolve, 180)) // Let the debounced refresh settle before manual refresh.

  state.addFile(`${root}/.opencode/commands/root-only.md`, '---\ndescription: Updated root command\n---\nUpdated root body.\n', 'v2')
  state.addFile(`${root}/.opencode/commands/after-refresh.md`, VALID)
  const refresh = globalCommands.get('omo-project-commands-refresh')
  assert.ok(refresh, 'the normal manual refresh entry point remains registered')
  const refreshed = await refresh.handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(refreshed.kind, 'success')
  assert.equal(scopedCommands.get('root-only').description, 'Updated root command')
  assert.ok(scopedCommands.has('after-refresh'), 'manual refresh scans the explicit project root')

  for (const listener of listeners.get('agent/disposed') ?? []) await listener({ agent })
  const cleanup = effects.find(effect => effect.label === 'dsh-omo project command source')?.dispose
  assert.equal(typeof cleanup, 'function')
  await cleanup()
  assert.equal(scopedCommands.size, 0)
  assert.ok(watchSubscriptions.every(subscription => subscription.closed), 'Agent/plugin disposal closes every explicit-root watcher')
  assert.equal(warnings.length, 0)
})

test('keeps project and user-root command precedence deterministic', async () => {
  const first = '/Users/alice/.config/opencode/commands'
  const second = '/Users/alice/.config/opencode/command'
  const state = fixture({ userOpenCodeCommandRoots: [first, second] })
  state.addDirectory(first)
  state.addDirectory(second)
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/shared.md`, '---\ndescription: Project wins\n---\nProject body.\n')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/fallback.md`, '---\ndescription: [unfinished\n---\nMalformed project file.')
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

  const claudeRoot = '/Users/alice/.claude/commands'
  const claudeTrailingSlash = fixture({ userClaudeCommandRoots: [`${claudeRoot}/`] })
  claudeTrailingSlash.addSymlink(claudeRoot)
  await assert.rejects(claudeTrailingSlash.adapter.list(claudeTrailingSlash.agent), /not a real directory/u)
  assert.equal(listedNames(claudeTrailingSlash).length, 0)
  assert.equal(readCalls(claudeTrailingSlash).length, 0)

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

  const claudeFile = `${claudeRoot}/steal.md`
  const claudeEscaped = fixture({
    userClaudeCommandRoots: [claudeRoot],
    fsOptions: { aliases: { [claudeFile]: outside } },
  })
  claudeEscaped.addDirectory(claudeRoot)
  claudeEscaped.addFile(claudeFile, VALID)
  claudeEscaped.addFile(outside, VALID)
  assert.deepEqual((await claudeEscaped.adapter.list(claudeEscaped.agent)).commands, [])
  assert.equal(readCalls(claudeEscaped).length, 0, 'user Claude roots enforce the same canonical containment boundary')
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
  const claudeRoot = '/Users/alice/.claude/commands'
  const sharedEntryLimit = fixture({ userOpenCodeCommandRoots: [userRoot], userClaudeCommandRoots: [claudeRoot] })
  sharedEntryLimit.addDirectory(userRoot)
  sharedEntryLimit.addDirectory(claudeRoot)
  for (let index = 0; index < 42; index += 1) {
    sharedEntryLimit.addFile(`${directory}/local-${String(index).padStart(3, '0')}.md`, VALID)
  }
  for (let index = 0; index < 42; index += 1) {
    sharedEntryLimit.addFile(`${userRoot}/user-${String(index).padStart(3, '0')}.md`, VALID)
  }
  for (let index = 0; index < 45; index += 1) {
    sharedEntryLimit.addFile(`${claudeRoot}/claude-${String(index).padStart(3, '0')}.md`, VALID)
  }
  const sharedEntryList = await sharedEntryLimit.adapter.list(sharedEntryLimit.agent)
  assert.equal(sharedEntryList.truncated, true)
  assert.ok(readCalls(sharedEntryLimit).length <= 128, 'the entry cap is shared across project, OpenCode user, and Claude user roots')

  const perFile = fixture()
  const tooLarge = `---\ndescription: large\n---\n${'x'.repeat(64 * 1024)}`
  perFile.addFile(`${directory}/large.md`, tooLarge)
  const perFileList = await perFile.adapter.list(perFile.agent)
  assert.equal(perFileList.commands.length, 0)
  assert.equal(readCalls(perFile).length, 0, 'known oversized files are rejected before readBytes')

  const totalRoot = '/Users/alice/.config/opencode/commands'
  const claudeTotalRoot = '/Users/alice/.claude/commands'
  const total = fixture({ userOpenCodeCommandRoots: [totalRoot], userClaudeCommandRoots: [claudeTotalRoot] })
  total.addDirectory(totalRoot)
  total.addDirectory(claudeTotalRoot)
  const fixedSizeSource = (() => {
    const prefix = '---\ndescription: bounded\n---\n'
    return prefix + 'x'.repeat(64 * 1024 - encoder.encode(prefix).byteLength)
  })()
  for (let index = 0; index < 2; index += 1) total.addFile(`${directory}/local-${index}.md`, fixedSizeSource)
  total.addFile(`${totalRoot}/user-0.md`, fixedSizeSource)
  for (let index = 0; index < 3; index += 1) total.addFile(`${claudeTotalRoot}/claude-${index}.md`, fixedSizeSource)
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

test('enableProjectCommands bounds abandoned Host lstat and resolve calls until late settlement', { timeout: 3000 }, async t => {
  for (const method of ['lstat', 'resolve']) {
    await t.test(method, async t => {
      const state = fixture()
      state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/omo-unused-review.md`, VALID)
      const originalHost = state.fs[method]
      const deferred = []
      state.fs[method] = (value, options = {}) => {
        state.calls.push({ method, value, options })
        return new Promise((resolve, reject) => {
          deferred.push({ resolve, reject, settled: false })
        })
      }
      const globalCommands = new Map()
      const scopedCommands = new Map()
      const listeners = new Map()
      const effects = []
      const warnings = []
      const queued = []
      const agent = state.agent
      agent.followup = message => queued.push(message)
      agent.ctx = {
        inject(dependencies, callback) {
          assert.deepEqual(dependencies, ['commands'])
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
          const fiber = Promise.resolve().then(() => callback(injected))
          fiber.dispose = async () => {
            await fiber
            for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
          }
          return fiber
        },
      }
      const services = {
        agents: { get: id => id === agent.id ? agent : undefined },
        sessions: state.sessions,
      }
      const ctx = {
        get: name => services[name],
        tools: { register: () => () => {} },
        commands: {
          find: (_agent, name) => globalCommands.get(name),
          register(definition) {
            globalCommands.set(definition.name, definition)
            return () => globalCommands.delete(definition.name)
          },
        },
        skills: {
          register: () => () => {},
          registerProvider: create => { create({ signal: new AbortController().signal, invalidate() {} }); return () => {} },
        },
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
      apply(ctx, Config({ enableProjectCommands: true }))
      const refresh = globalCommands.get('omo-project-commands-refresh')
      assert.ok(refresh)
      t.after(async () => {
        for (const listener of listeners.get('agent/disposed') ?? []) await listener({ agent })
        await effects.find(effect => effect.label === 'dsh-omo project command source')?.dispose?.()
        for (const host of deferred) {
          if (!host.settled) {
            host.settled = true
            host.reject(new Error('test cleanup'))
          }
        }
        await new Promise(resolve => setImmediate(resolve))
      })

      const immediateOutcome = promise => Promise.race([
        Promise.resolve(promise).then(value => ({ value }), error => ({ error })),
        new Promise(resolve => setImmediate(() => resolve({ pending: true }))),
      ])
      const cancelRefresh = async index => {
        const controller = new AbortController()
        const before = deferred.length
        const pending = refresh.handler({ agent, rawInput: '', signal: controller.signal })
        for (let attempt = 0; deferred.length === before && attempt < 4; attempt += 1) {
          const early = await immediateOutcome(pending)
          assert.equal(early.pending, true, `refresh ${index} settled before starting Host ${method}`)
        }
        assert.equal(deferred.length, before + 1, `refresh ${index} starts exactly one Host ${method}`)
        controller.abort()
        const outcome = await immediateOutcome(pending)
        assert.equal(outcome.pending, undefined, `caller abort ${index} must not wait for Host ${method} or the five-second scan timeout`)
        assert.equal(outcome.error, undefined)
        assert.equal(outcome.value?.kind, 'error')
        assert.match(outcome.value.text, /cancelled/iu)
        assert.equal(queued.length, 0, 'a cancelled refresh never executes a project command')
      }

      for (let index = 1; index <= 64; index += 1) await cancelRefresh(index)
      assert.ok(deferred.every(host => !host.settled), `every Host ${method} ignores cancellation and remains pending`)
      assert.equal(scopedCommands.size, 0)

      const busy = await immediateOutcome(refresh.handler({ agent, rawInput: '', signal: new AbortController().signal }))
      assert.equal(busy.pending, undefined, 'the 65th refresh must fail busy without waiting five seconds')
      assert.equal(busy.error, undefined)
      assert.equal(busy.value?.kind, 'error')
      assert.match(busy.value.text, /busy/iu)
      assert.equal(deferred.length, 64, `a busy refresh must not call Host ${method}`)
      assert.equal(queued.length, 0)
      assert.equal(scopedCommands.size, 0)

      state.addFile(
        `${CWD}/${PROJECT_COMMAND_DIRECTORY}/omo-unused-review.md`,
        '---\ndescription: Fresh after late rejection\n---\nFresh command body.\n',
        'v2',
      )
      deferred[0].settled = true
      deferred[0].reject(new Error('secret late Host failure /private/host'))
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(scopedCommands.size, 0, 'late rejection cannot commit an abandoned scan')
      assert.equal(queued.length, 0)
      state.fs[method] = originalHost

      const recovered = await immediateOutcome(refresh.handler({ agent, rawInput: '', signal: new AbortController().signal }))
      assert.equal(recovered.pending, undefined, 'one late Host settlement must release capacity')
      assert.equal(recovered.error, undefined)
      assert.equal(recovered.value?.kind, 'success')
      assert.equal(scopedCommands.get('omo-unused-review')?.description, 'Fresh after late rejection', 'abandoned failures are not cached')
      const executed = await scopedCommands.get('omo-unused-review').handler({ agent, rawInput: 'current', signal: new AbortController().signal })
      assert.equal(executed.kind, 'success')
      assert.equal(queued.length, 1)
      assert.match(queued[0].content[0].text, /Fresh command body\./u)
      assert.doesNotMatch(JSON.stringify({ warnings, recovered, executed, queued }), /secret late Host failure|private\/host/u)
    })
  }
})

test('project command lstat abort races consume leased rejections under strict unhandled rejection policy', { timeout: 5000 }, async () => {
  // A deliberately rejected native Host Promise must be isolated from the test
  // runner's own unhandled-rejection reporting.
  if (!process.env.OMO_PROJECT_COMMAND_STRICT_ABORT_CHILD) {
    const env = { ...process.env, OMO_PROJECT_COMMAND_STRICT_ABORT_CHILD: '1' }
    delete env.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, [
      '--unhandled-rejections=strict', '--test',
      '--test-name-pattern=^project command lstat abort races consume leased rejections under strict unhandled rejection policy$',
      import.meta.filename,
    ], { encoding: 'utf8', env, timeout: 10_000 })
    assert.equal(child.status, 0, `isolated strict rejection test failed: ${child.error ?? ''}\n${child.stdout}\n${child.stderr}`)
    assert.match(child.stdout, /project command lstat abort races consume leased rejections under strict unhandled rejection policy/u)
    return
  }

  const immediateOutcome = promise => Promise.race([
    Promise.resolve(promise).then(value => ({ value }), error => ({ error })),
    new Promise(resolve => setImmediate(() => resolve({ pending: true }))),
  ])
  for (const settlement of ['resolve', 'reject']) {
    for (const order of ['abort-first', 'settle-first']) {
      const state = fixture()
      const originalLstat = state.fs.lstat
      const controller = new AbortController()
      let calls = 0
      state.fs.lstat = () => {
        calls += 1
        const host = () => settlement === 'resolve'
          ? Promise.resolve({ type: 'directory' })
          : Promise.reject('late secret')
        if (order === 'abort-first') {
          controller.abort()
          return host()
        }
        const pending = host()
        controller.abort()
        return pending
      }

      const outcome = await immediateOutcome(state.adapter.list(state.agent, controller.signal))
      assert.equal(outcome.pending, undefined, `${settlement}/${order} must not wait for another turn`)
      assert.equal(typeof outcome.error, 'symbol', `${settlement}/${order} must reject with ABORTED`)
      assert.equal(outcome.error.description, 'project command operation cancelled')
      assert.equal(calls, 1, 'synchronous cancellation stops the scan after its first lstat')
      await new Promise(resolve => setImmediate(resolve))

      state.fs.lstat = originalLstat
      const recovered = await immediateOutcome(state.adapter.list(state.agent))
      assert.equal(recovered.pending, undefined, `${settlement}/${order} must release its lease after Host settlement`)
      assert.equal(recovered.error, undefined)
      assert.deepEqual(recovered.value.commands, [], 'a later normally settled scan still completes')
    }
  }
})

test('command refresh sanitizes Host error accessors and never trusts a forged busy message', async () => {
  for (const hostile of [
    { get message() { throw new Error('private accessor failure') } },
    { get message() { return 'Project command filesystem capacity is busy (64 unsettled Host calls); retry after one settles.' } },
  ]) {
    const state = fixture()
    state.fs.lstat = async () => { throw hostile }
    const agent = { id: 'agent-1', followup() {}, ctx: { inject() { throw new Error('must not inject') } } }
    const globalCommands = new Map()
    const ctx = {
      get: name => name === 'agents'
        ? { get: id => id === agent.id ? agent : undefined }
        : name === 'sessions' ? state.sessions : undefined,
      tools: { register: () => () => {} },
      commands: { find: () => undefined, register(definition) { globalCommands.set(definition.name, definition); return () => {} } },
      skills: { register: () => () => {}, registerProvider: () => () => {} },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
      subagents: { startActivation: async () => { throw new Error('unused') }, getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true } }) },
      fs: state.fs,
      logger: { warn() {} },
      on() { return ctx },
      effect: execute => { execute(); return () => {} },
    }
    apply(ctx, Config({ enableProjectCommands: true }))
    const refresh = globalCommands.get('omo-project-commands-refresh')
    const result = await refresh.handler({ agent, rawInput: '', signal: new AbortController().signal })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /refresh failed/u)
    assert.doesNotMatch(result.text, /private accessor failure|capacity is busy/iu)
  }
})

test('Config forwards explicit Agents command roots through real apply', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  const root = '/Users/alice/.agents/skills'
  state.addDirectory(root)
  state.addFile(`${root}/agents-review.md`, '---\ndescription: Agents review\n---\nReview $ARGUMENTS.\n')
  state.setup({ userAgentsCommandRoots: [root] })
  await state.createAgent()
  assert.equal(state.scopedCommands.get('agents-review')?.description, 'Agents review')
})

test('blank display metadata can change fallback only in its opt-in discovery mode', async () => {
  const root = `${CWD}/${PROJECT_COMMAND_DIRECTORY}`
  const claudeCommands = `${CWD}/.claude/commands`
  for (const allowBlankDisplayMetadata of [false, true]) {
    const state = fixture({ allowBlankDisplayMetadata })
    state.addDirectory(`${CWD}/.claude`)
    state.addDirectory(claudeCommands)
    state.addFile(`${root}/review.md`, '---\ndescription: "   "\n---\nOpenCode body.\n')
    state.addFile(`${claudeCommands}/review.md`, '---\ndescription: Claude fallback\n---\nClaude body.\n')
    const result = await state.adapter.list(state.agent)
    assert.equal(result.commands[0].description, allowBlankDisplayMetadata ? 'Project command /review' : 'Claude fallback')
    state.addFile(`${root}/review.md`, `---\ndescription: "${' '.repeat(1001)}"\n---\nOversized body.\n`, 'v2')
    assert.equal((await state.adapter.list(state.agent)).commands[0].description, 'Claude fallback')
  }
})

test('Config forwards opt-in empty-description compatibility through real apply', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review-empty.md`, '---\ndescription: ""\n---\nReview $ARGUMENTS.\n')
  state.setup({ enableProjectCommandEmptyDescription: true })
  await state.createAgent()
  assert.equal(state.scopedCommands.get('review-empty')?.description, 'Project command /review-empty')
  assert.throws(() => state.setup({ enableProjectCommandEmptyDescription: true, enableProjectCommands: false }), /requires enableProjectCommands/u)
})

test('malformed YAML compatibility changes same-name fallback only when enabled', async () => {
  const root = `${CWD}/${PROJECT_COMMAND_DIRECTORY}`
  const claudeCommands = `${CWD}/.claude/commands`
  for (const allowMalformedFrontmatter of [false, true]) {
    const state = fixture({ allowMalformedFrontmatter })
    state.addDirectory(`${CWD}/.claude`)
    state.addDirectory(claudeCommands)
    state.addFile(`${root}/review.md`, '---\ndescription: [broken\n---\nOpenCode body.\n')
    state.addFile(`${claudeCommands}/review.md`, '---\ndescription: Claude fallback\n---\nClaude body.\n')
    const result = await state.adapter.list(state.agent)
    assert.equal(result.commands[0].description, allowMalformedFrontmatter ? 'Project command /review' : 'Claude fallback')
  }
})

test('plain frontmatter fallback changes same-name selection only when enabled', async () => {
  const root = `${CWD}/${PROJECT_COMMAND_DIRECTORY}`
  const claudeCommands = `${CWD}/.claude/commands`
  for (const allowUnterminatedFrontmatter of [false, true]) {
    const state = fixture({ allowUnterminatedFrontmatter })
    state.addDirectory(`${CWD}/.claude`)
    state.addDirectory(claudeCommands)
    state.addFile(`${root}/review.md`, '---\ndescription: Review\n')
    state.addFile(`${claudeCommands}/review.md`, '---\ndescription: Claude fallback\n---\nClaude body.\n')
    const result = await state.adapter.list(state.agent)
    assert.equal(result.commands[0].description, allowUnterminatedFrontmatter ? 'Project command /review' : 'Claude fallback')
  }
})

test('Config forwards blank display metadata compatibility through real apply', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/blank-review.md`, '---\ndescription: "   "\nargument-hint: ""\n---\nReview $ARGUMENTS.\n')
  state.setup({ enableProjectCommandBlankDisplayMetadata: true })
  await state.createAgent()
  const command = state.scopedCommands.get('blank-review')
  assert.equal(command?.description, 'Project command /blank-review')
  assert.equal(command?.input.hint, '[arguments]')
  assert.throws(() => state.setup({ enableProjectCommandBlankDisplayMetadata: true, enableProjectCommands: false }), /requires enableProjectCommands/u)
})

test('Config forwards malformed frontmatter compatibility through real apply', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/malformed.md`, '---\ndescription: [broken\n---\nBody.\n')
  state.setup({ enableProjectCommandMalformedFrontmatter: true })
  await state.createAgent()
  assert.equal(state.scopedCommands.get('malformed')?.description, 'Project command /malformed')
  assert.throws(() => state.setup({ enableProjectCommandMalformedFrontmatter: true, enableProjectCommands: false }), /requires enableProjectCommands/u)
})

test('Config forwards plain frontmatter fallback through real apply', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/plain-frontmatter.md`, '---\ndescription: Review\n')
  state.setup({ enableProjectCommandUnterminatedFrontmatter: true })
  await state.createAgent()
  assert.equal(state.scopedCommands.get('plain-frontmatter')?.description, 'Project command /plain-frontmatter')
  assert.throws(() => state.setup({ enableProjectCommandUnterminatedFrontmatter: true, enableProjectCommands: false }), /requires enableProjectCommands/u)
})

test('Config forwards body line-ending compatibility through real apply', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/crlf-body.md`, '---\r\ndescription: CRLF\r\n---\r\nFirst\r\nSecond\r\n')
  state.setup({ enableProjectCommandPreserveBodyLineEndings: true })
  await state.createAgent()
  const command = state.scopedCommands.get('crlf-body')
  assert.equal(command?.description, 'CRLF')
  const result = await command.handler({ agent: state.agent, rawInput: 'request', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.ok(state.queued[0].content[0].text.includes('First\r\nSecond'))
  assert.throws(() => state.setup({ enableProjectCommandPreserveBodyLineEndings: true, enableProjectCommands: false }), /requires enableProjectCommands/u)
})

test('Config forwards empty-body compatibility through real apply', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/empty-body.md`, '---\ndescription: Empty\n---\n')
  state.setup({ enableProjectCommandEmptyBody: true })
  await state.createAgent()
  assert.equal(state.scopedCommands.get('empty-body')?.description, 'Empty')
  assert.throws(() => state.setup({ enableProjectCommandEmptyBody: true, enableProjectCommands: false }), /requires enableProjectCommands/u)
})

test('command routes default off and preserve the existing project prompt queue', async t => {
  const state = applyCommandFixture()
  t.after(() => state.dispose())
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/review-code.md`, '---\ndescription: Review code\n---\nReview $ARGUMENTS carefully.\n')
  state.setup()
  await state.createAgent()

  const command = state.scopedCommands.get('review-code')
  assert.ok(command, 'the real apply fixture scanned and registered the project command')
  const rawInput = '  src/changed.ts $ARGUMENTS  '
  const result = await command.handler({ agent: state.agent, rawInput, signal: new AbortController().signal })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Queued project command/u)
  assert.equal(state.starts.length, 0, 'default-off routing never starts a specialist')
  assert.equal(state.queued.length, 1)
  assert.deepEqual(state.queued[0].source, { kind: 'user' })
  assert.equal(state.queued[0].content[0].text, '<command-instruction>\nReview   src/changed.ts $ARGUMENTS   carefully.\n</command-instruction>\n\n<user-request>\n  src/changed.ts $ARGUMENTS  \n</user-request>')
})

test('command route setup rejects unknown, conflicting, and disabled configurations', async t => {
  const cases = [
    {
      name: 'unknown specialist role',
      config: { commandRoutes: [{ name: 'review-code', role: 'missing-role' }] },
      expected: /unknown.*role|enabled specialist role/iu,
    },
    {
      name: 'duplicate command route conflict',
      config: { commandRoutes: [{ name: 'review-code', role: 'reviewer' }, { name: 'review-code', role: 'security' }] },
      expected: /duplicate|conflict/iu,
    },
    {
      name: 'built-in command conflict',
      config: { commandRoutes: [{ name: 'review', role: 'reviewer' }] },
      expected: /conflict|command route/iu,
    },
    {
      name: 'disabled command route',
      config: { disabledOmoCommands: ['review'], commandRoutes: [{ name: 'review', role: 'reviewer' }] },
      expected: /disabled|conflict/iu,
    },
    {
      name: 'disabled specialist role',
      config: { disabledOmoRoles: ['reviewer'], commandRoutes: [{ name: 'review-code', role: 'reviewer' }] },
      expected: /disabled|enabled specialist role/iu,
    },
    {
      name: 'project commands remain an explicit prerequisite',
      config: { enableProjectCommands: false, commandRoutes: [{ name: 'review-code', role: 'reviewer' }] },
      expected: /requires enableProjectCommands/u,
    },
  ]
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const state = applyCommandFixture()
      assert.throws(() => state.setup(entry.config), entry.expected)
      assert.equal(state.starts.length, 0, `${entry.name} must fail before child startup`)
    })
  }
})

test('command routes do not start for an invalid role or a command that was not provided', async t => {
  const invalid = applyCommandFixture()
  assert.throws(
    () => invalid.setup({ commandRoutes: [{ name: 'review-code', role: '' }] }),
    /role/iu,
  )
  assert.equal(invalid.starts.length, 0)

  const missing = applyCommandFixture()
  t.after(() => missing.dispose())
  missing.setup({ commandRoutes: [{ name: 'review-code', role: 'reviewer' }] })
  await missing.createAgent()
  assert.equal(missing.scopedCommands.has('review-code'), false, 'a route alone does not synthesize a project command')
  assert.equal(missing.globalCommands.has('review-code'), false)
  assert.equal(missing.starts.length, 0)
  assert.equal(missing.queued.length, 0)
})

test('administrator command routes start a one-shot specialist instead of queueing prompt text', async () => {
  const state = fixture()
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/capacity-review.md`, '---\ndescription: Delegated review\n---\nReview $ARGUMENTS carefully.\n')
  const globalCommands = new Map()
  const scopedCommands = new Map()
  const listeners = new Map()
  const effects = []
  const activations = []
  const followups = []
  const agent = { ...state.agent, followup: message => followups.push(message) }
  agent.ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['commands'])
      const disposers = []
      const fiber = Promise.resolve().then(() => callback({
        commands: {
          find: (_agent, name) => globalCommands.get(name),
          register(definition) { scopedCommands.set(definition.name, definition); disposers.push(() => scopedCommands.delete(definition.name)); return disposers.at(-1) },
        },
        effect(execute) { const dispose = execute(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
      }))
      fiber.dispose = async () => { await fiber; for (const dispose of disposers.reverse()) dispose() }
      return fiber
    },
  }
  const services = { agents: { get: id => id === agent.id ? agent : undefined }, sessions: state.sessions }
  const ctx = {
    get: name => services[name],
    tools: { register: () => () => {} },
    commands: { find: (_agent, name) => globalCommands.get(name), register(definition) { globalCommands.set(definition.name, definition); return () => globalCommands.delete(definition.name) } },
    skills: { register: () => () => {}, registerProvider: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    subagents: {
      getProvider: () => ({ capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => {
        activations.push(spec)
        return { childId: 'delegated-command-child', result: new Promise(() => {}), dispose: async () => {} }
      },
    },
    fs: state.fs,
    logger: { warn() {} },
    on(event, listener) { const values = listeners.get(event) ?? []; values.push(listener); listeners.set(event, values); return ctx },
    effect(execute, label) { const dispose = execute(); effects.push({ label, dispose }); return () => {} },
  }
  apply(ctx, Config({
    enableProjectCommands: true,
    commandRoutes: [{ name: 'capacity-review', role: 'reviewer' }],
    roleRoutes: [{ role: 'reviewer', promptAppend: 'Use the current reviewer route.' }],
  }))
  for (const listener of listeners.get('agent/created') ?? []) await listener({ agent, signal: new AbortController().signal })
  const command = scopedCommands.get('capacity-review')
  assert.ok(command)
  const controller = new AbortController()
  const result = await command.handler({ agent, rawInput: ' current request ', signal: controller.signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /delegated-command-child/u)
  assert.equal(activations.length, 1)
  assert.equal(activations[0].request.parent, agent)
  assert.equal(activations[0].signal, controller.signal)
  const prompt = activations[0].request.prompt[0].text
  assert.match(prompt, /You are acting as the Independent reviewer/u)
  assert.ok(prompt.includes('## Additional role guidance\nUse the current reviewer route.'), 'the launch uses the current reviewer role route')
  assert.ok(prompt.includes('<command-instruction>\nReview  current request  carefully.\n</command-instruction>\n\n<user-request>\n current request \n</user-request>'), 'the specialist task preserves both command instruction framing and exact rawInput')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(followups.length, 0, 'one-shot startup does not call queueParentMessage; settlement remains pending')
  for (const effect of [...effects].reverse()) await effect.dispose?.()
})

test('rejects command attachments before expansion or queueing', async () => {
  const queued = []
  const expanded = []
  const command = parseProjectCommandDocument('review', VALID)
  const definition = makeProjectCommandDefinition(command, (...args) => { queued.push(args) }, async source => {
    expanded.push(source)
    return source
  })
  const result = await definition.handler({
    agent: { id: 'agent-1' }, rawInput: 'input', attachments: [{ type: 'image' }],
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /attachments/u)
  assert.deepEqual(expanded, [])
  assert.deepEqual(queued, [])
})

test('wraps command instructions, substitutes only literal placeholders, and always includes opaque invocation text', () => {
  const command = parseProjectCommandDocument('review', '---\ndescription: Review\n---\nLiteral $ARGUMENTS\nShell ! echo ignored\nFile @README.md\nTwice: $ARGUMENTS\n')
  const rawInput = '  user text ; ! touch /tmp/nope @other $ARGUMENTS  '
  assert.equal(renderProjectCommand(command, rawInput), `<command-instruction>\nLiteral ${rawInput}\nShell ! echo ignored\nFile @README.md\nTwice: ${rawInput}\n</command-instruction>\n\n<user-request>\n${rawInput}\n</user-request>`)

  const noPlaceholder = parseProjectCommandDocument('no-arg-command', '---\ndescription: Review\n---\nReview the requested files.\n')
  assert.equal(renderProjectCommand(noPlaceholder, 'src/changed.ts'), '<command-instruction>\nReview the requested files.\n</command-instruction>\n\n<user-request>\nsrc/changed.ts\n</user-request>')
  assert.throws(() => renderProjectCommand({ ...command, body: 'visible\u202e hidden' }, rawInput), /parsed project command/u)
  assert.throws(() => renderProjectCommand(command, 'é'.repeat(9_000)), /exceed 16384 bytes/u)
  assert.throws(() => renderProjectCommand({ ...command, body: '$ARGUMENTS '.repeat(5_000) }, 'x'.repeat(10_000)), /Rendered project command exceeds/u)
})

test('command definition delegates registration and queueing to the caller', () => {
  const command = parseProjectCommandDocument('review', '---\ndescription: Review\n---\nReview the requested files.\n')
  const queued = []
  const definition = makeProjectCommandDefinition(command, (...args) => {
    queued.push(args)
    return { kind: 'success', text: 'queued' }
  })
  assert.equal(definition.name, 'review')
  assert.equal(definition.description, 'Review')
  assert.equal(definition.handler({ agent: { id: 'agent-1' }, rawInput: 'argument text' }).kind, 'success')
  assert.deepEqual(queued, [[{ id: 'agent-1' }, '<command-instruction>\nReview the requested files.\n</command-instruction>\n\n<user-request>\nargument text\n</user-request>', command]])
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal(definition.handler({ agent: { id: 'agent-1' }, rawInput: 'do not queue', signal: cancelled.signal }).kind, 'error')
  assert.equal(queued.length, 1)
  assert.equal(definition.handler({ rawInput: 'x' }).kind, 'error')
  assert.throws(() => makeProjectCommandDefinition(command, undefined), /queue callback/u)
})

test('renders project command file references before opaque raw invocation text', async () => {
  const command = parseProjectCommandDocument('review', '---\ndescription: Review\n---\nRead @README.md for $ARGUMENTS\n')
  const queued = []
  const expanded = []
  const definition = makeProjectCommandDefinition(command, (...args) => {
    queued.push(args)
    return { kind: 'success', text: 'queued' }
  }, async (source, invocation) => {
    expanded.push({ source, invocation })
    return Object.freeze({ ...source, body: source.body.replace('@README.md', 'Referenced README (untrusted)') })
  })
  const agent = { id: 'agent-1' }
  const rawInput = '@private.md must remain opaque'
  assert.equal((await definition.handler({ agent, rawInput })).kind, 'success')
  assert.deepEqual(expanded, [{ source: command, invocation: { agent, signal: undefined } }])
  assert.deepEqual(queued, [[agent, `<command-instruction>\nRead Referenced README (untrusted) for ${rawInput}\n</command-instruction>\n\n<user-request>\n${rawInput}\n</user-request>`, command]])

  const failing = makeProjectCommandDefinition(command, (...args) => queued.push(args), async () => {
    throw new Error('do not disclose read details')
  })
  assert.deepEqual(await failing.handler({ agent, rawInput }), {
    kind: 'error',
    text: 'Project command file references could not be expanded safely; no prompt was queued.',
  })
  assert.equal(queued.length, 1, 'failed expansion never queues the original command')
})

test('allows bounded file expansion beyond the source-body limit under the rendered-output cap', async () => {
  const sourceText = `---\ndescription: Large review\n---\n${'a'.repeat(62_000)} @README.md\n`
  const command = parseProjectCommandDocument('large-review', sourceText)
  assert.ok(new TextEncoder().encode(command.body).byteLength <= 64 * 1024)
  const queued = []
  const agent = { id: 'agent-1' }
  const definition = makeProjectCommandDefinition(command, (_caller, prompt) => {
    queued.push(prompt)
    return { kind: 'success', text: 'queued' }
  }, (source, invocation) => expandProjectCommandFileReferences(source, {
    promptFileExpander: { async expand() { return { rolePromptAppend: 'x'.repeat(4_096) } } },
    ...invocation,
  }))

  const result = await definition.handler({ agent, rawInput: '', signal: new AbortController().signal })

  assert.equal(result.kind, 'success')
  assert.equal(queued.length, 1)
  const renderedBytes = new TextEncoder().encode(queued[0]).byteLength
  assert.ok(renderedBytes > 64 * 1024, `expected expanded output above source cap, got ${renderedBytes}`)
  assert.ok(renderedBytes <= 128 * 1024)
})

test('counts unconditional request text and framing at the exact expanded command byte limit', async () => {
  const command = parseProjectCommandDocument('boundary', VALID)
  const args = 'é'.repeat(8_192)
  const framing = '<command-instruction>\n\n</command-instruction>\n\n<user-request>\n\n</user-request>'
  const bodyBytes = 128 * 1024 - encoder.encode(framing).byteLength - encoder.encode(args).byteLength
  let expandedBody = 'x'.repeat(bodyBytes)
  const queued = []
  const definition = makeProjectCommandDefinition(command, (_agent, prompt) => {
    queued.push(prompt)
    return { kind: 'success' }
  }, source => ({ ...source, body: expandedBody }))
  const invocation = { agent: { id: 'boundary-agent' }, rawInput: args }
  assert.equal((await definition.handler(invocation)).kind, 'success')
  assert.equal(encoder.encode(queued[0]).byteLength, 128 * 1024)
  expandedBody += 'x'
  const rejected = await definition.handler(invocation)
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /Rendered project command exceeds/u)
  assert.equal(queued.length, 1, 'oversized prompt is never queued')
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
  const userClaudeRoot = '/Users/alice/.claude/commands'
  const missingUserRoot = '/Users/alice/.config/opencode/extra/commands'
  const state = fixture({ userOpenCodeCommandRoots: [userRoot, missingUserRoot], userClaudeCommandRoots: [userClaudeRoot] })
  state.addDirectory(userRoot)
  state.addDirectory(userClaudeRoot)
  state.addFile(`${userRoot}/user-level-only.md`, VALID)
  state.addFile(`${userClaudeRoot}/user-claude-only.md`, '---\ndescription: User Claude command\nargument-hint: "file paths"\n---\nDocument: $ARGUMENTS\n')
  state.addFile(`${CWD}/README.md`, 'Project overview. $ARGUMENTS.')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/local-check.md`, '---\ndescription: Inspect project docs\n---\nReview @README.md for $ARGUMENTS.\n')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/omo.md`, '---\ndescription: Shadow attempt\n---\nMust not replace global command.\n')
  state.addDirectory(`${CWD}/.claude`)
  state.addDirectory(`${CWD}/.claude/commands`)
  state.addFile(`${CWD}/.claude/commands/claude-source-only.md`, '---\ndescription: Document request\nargument-hint: "file paths"\n---\nDocument: $ARGUMENTS\n')
  assert.equal((await state.adapter.list(state.agent)).commands.length, 5)
  const globalCommands = new Map()
  const scopedCommands = new Map()
  const listeners = new Map()
  const effects = []
  const warnings = []
  const queued = []
  const watchSubscriptions = []
  let nextWatchGate
  let onNextWatch
  state.fs.watch = async (target, changed, signal) => {
    const subscription = { target, changed, signal, closed: false, closeGate: undefined, failCloseOnce: false }
    watchSubscriptions.push(subscription)
    const initializeNextWatch = onNextWatch
    onNextWatch = undefined
    initializeNextWatch?.(subscription)
    const watchGate = nextWatchGate
    nextWatchGate = undefined
    if (watchGate) await watchGate
    return async () => {
      if (subscription.closeGate) await subscription.closeGate
      if (subscription.failCloseOnce) {
        subscription.failCloseOnce = false
        throw new Error('injected watcher close failure')
      }
      subscription.closed = true
    }
  }
  const agent = state.agent
  agent.followup = message => queued.push(message)
  let nextFiberDisposeHook
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
          const beforeDispose = nextFiberDisposeHook
          nextFiberDisposeHook = undefined
          if (beforeDispose) await beforeDispose()
          for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
        },
      }
    },
  }

  apply(ctx, Config({ enableProjectCommands: true, enableProjectCommandWatch: true, enablePromptFileExpansion: true, userOpenCodeCommandRoots: [userRoot, missingUserRoot], userClaudeCommandRoots: [userClaudeRoot] }))
  assert.equal(Config({ enableProjectCommands: true }).enableProjectCommands, true)
  assert.deepEqual(Config({}).userOpenCodeCommandRoots, [])
  assert.deepEqual(Config({}).userClaudeCommandRoots, [])
  assert.equal((listeners.get('agent/created') ?? []).length, 1)
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent, signal: new AbortController().signal })))
  assert.ok(watchSubscriptions.some(subscription => subscription.target.path === `${CWD}/${PROJECT_COMMAND_DIRECTORY}`), 'existing project command roots are watched')
  assert.ok(scopedCommands.has('local-check'), JSON.stringify({ warnings, calls: state.calls.map(call => call.method) }))
  assert.ok(scopedCommands.has('user-level-only'), 'explicit user OpenCode roots register in the receiving Agent scope')
  assert.ok(scopedCommands.has('user-claude-only'), 'explicit user Claude roots register in the receiving Agent scope')
  assert.equal(scopedCommands.get('user-claude-only').input.hint, 'file paths')
  assert.ok(scopedCommands.has('claude-source-only'), 'project Claude Markdown command files use the same bounded subset')
  assert.equal(scopedCommands.get('claude-source-only').input.hint, 'file paths')
  assert.equal(scopedCommands.get('local-check').input.hint, '[arguments]')
  assert.equal(scopedCommands.has('omo'), false)
  assert.equal(globalCommands.has('local-check'), false, 'project command registration stays Agent-scoped')

  const result = await scopedCommands.get('local-check').handler({ agent, rawInput: 'focus', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Eligible relative file references, when present, were expanded/u)
  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0].source, { kind: 'user' })
  assert.equal(queued[0].content[0].text, '<command-instruction>\nReview Referenced project file "README.md" (untrusted contents): "Project overview. \\u0024ARGUMENTS." for focus.\n</command-instruction>\n\n<user-request>\nfocus\n</user-request>')
  await scopedCommands.get('user-level-only').handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(queued.length, 2)
  assert.equal(queued[1].content[0].text, '<command-instruction>\nReview the selected files.\n</command-instruction>\n\n<user-request>\n\n</user-request>')

  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/local-check.md`, '---\ndescription: Updated docs review\n---\nUpdated request: $ARGUMENTS.\n')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/new-after-refresh.md`, '---\ndescription: Added after startup\n---\nNew command loaded.\n')
  state.nodes.delete(`${userRoot}/user-level-only.md`)
  const refreshCommand = globalCommands.get('omo-project-commands-refresh')
  assert.ok(refreshCommand, 'the manual refresh command is enabled with project commands')
  const inactiveRefresh = await refreshCommand.handler({ agent: { id: 'inactive', ctx: agent.ctx }, rawInput: '', signal: new AbortController().signal })
  assert.equal(inactiveRefresh.kind, 'error', 'refresh is restricted to the exact live Agent')
  const canceledRefreshController = new AbortController()
  canceledRefreshController.abort()
  const canceledRefresh = await refreshCommand.handler({ agent, rawInput: '', signal: canceledRefreshController.signal })
  assert.equal(canceledRefresh.kind, 'error')
  assert.equal(scopedCommands.size, 4, 'an inactive or canceled refresh leaves current registrations unchanged')

  let signalDisposeStarted
  const disposeStarted = new Promise(resolve => { signalDisposeStarted = resolve })
  let releaseDispose
  const disposeGate = new Promise(resolve => { releaseDispose = resolve })
  nextFiberDisposeHook = async () => {
    signalDisposeStarted()
    await disposeGate
  }
  const cancelDuringDisposeController = new AbortController()
  const cancelDuringDisposePromise = refreshCommand.handler({ agent, rawInput: '', signal: cancelDuringDisposeController.signal })
  await disposeStarted
  cancelDuringDisposeController.abort()
  releaseDispose()
  const canceledDuringDispose = await cancelDuringDisposePromise
  assert.equal(canceledDuringDispose.kind, 'error')
  assert.match(canceledDuringDispose.text, /previous Agent command state was restored/u)
  assert.equal(scopedCommands.size, 4)
  assert.equal(scopedCommands.has('new-after-refresh'), false, 'cancel rollback removes the uncommitted new command')
  assert.equal(scopedCommands.has('user-level-only'), true, 'cancel rollback restores the prior command snapshot')
  await scopedCommands.get('local-check').handler({ agent, rawInput: 'restored', signal: new AbortController().signal })
  assert.equal(queued[2].content[0].text, '<command-instruction>\nReview Referenced project file "README.md" (untrusted contents): "Project overview. \\u0024ARGUMENTS." for restored.\n</command-instruction>\n\n<user-request>\nrestored\n</user-request>')

  const refreshed = await refreshCommand.handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(refreshed.kind, 'success')
  assert.match(refreshed.text, /4 registered from 5 discovered/u)
  assert.equal(scopedCommands.size, 4)
  await scopedCommands.get('local-check').handler({ agent, rawInput: 'new focus', signal: new AbortController().signal })
  assert.equal(queued[3].content[0].text, '<command-instruction>\nUpdated request: new focus.\n</command-instruction>\n\n<user-request>\nnew focus\n</user-request>')
  await scopedCommands.get('new-after-refresh').handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(queued[4].content[0].text, '<command-instruction>\nNew command loaded.\n</command-instruction>\n\n<user-request>\n\n</user-request>')

  const beforeFailedRefresh = scopedCommands.size
  const originalListDirForRefresh = state.fs.listDir
  state.fs.listDir = async (target, signal) => {
    if (target?.path === userClaudeRoot) throw new Error('injected refresh listing failure')
    return originalListDirForRefresh(target, signal)
  }
  const failedRefresh = await refreshCommand.handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(failedRefresh.kind, 'error')
  assert.match(failedRefresh.text, /existing commands were left unchanged/u)
  assert.equal(scopedCommands.size, beforeFailedRefresh, 'a failed refresh scan preserves active registrations')
  state.fs.listDir = originalListDirForRefresh

  const liveCommandWatch = watchSubscriptions.find(subscription => !subscription.closed
    && subscription.target.path === `${CWD}/${PROJECT_COMMAND_DIRECTORY}`)
  assert.ok(liveCommandWatch, 'the active project-command watcher survives a failed refresh scan')
  let releaseFiberDisposal
  let resolveFiberDisposalStarted
  const fiberDisposalStarted = new Promise(resolve => { resolveFiberDisposalStarted = resolve })
  nextFiberDisposeHook = () => new Promise(resolve => {
    releaseFiberDisposal = resolve
    resolveFiberDisposalStarted()
  })
  let releaseWatchClose
  liveCommandWatch.closeGate = new Promise(resolve => { releaseWatchClose = resolve })
  liveCommandWatch.failCloseOnce = true
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/auto-watched.md`, VALID)
  liveCommandWatch.changed()
  await fiberDisposalStarted
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/auto-watched.md`, VALID.replace('Inspect a requested area', 'Changed during scope swap'), 'v2')
  liveCommandWatch.changed()
  releaseFiberDisposal()
  releaseWatchClose()
  for (let attempt = 0; attempt < 200 && scopedCommands.get('auto-watched')?.description !== 'Changed during scope swap'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(scopedCommands.get('auto-watched')?.description, 'Changed during scope swap', 'an invalidation during scope replacement triggers a follow-up refresh')
  await scopedCommands.get('auto-watched').handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(queued[5].content[0].text, '<command-instruction>\nReview the selected files.\n</command-instruction>\n\n<user-request>\n\n</user-request>')

  const originalWatch = state.fs.watch
  state.fs.watch = async () => { throw new Error('watch backend unsupported') }
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/watch-fallback.md`, VALID)
  const watchFallback = await refreshCommand.handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(watchFallback.kind, 'success', 'unsupported watching falls back to a usable manual refresh')
  assert.ok(scopedCommands.has('watch-fallback'))
  state.fs.watch = originalWatch

  const secondAgent = { id: 'agent-2', followup() {}, ctx: agent.ctx }
  const claudeErrorAgent = { id: 'agent-3', followup() {}, ctx: agent.ctx }
  const emptyAgent = { id: 'agent-4', followup() {}, ctx: agent.ctx }
  const cancelAgent = { id: 'agent-5', followup() {}, ctx: agent.ctx }
  const capacityAgents = Array.from({ length: 11 }, (_, index) => ({ id: `capacity-agent-${index}`, followup() {}, ctx: agent.ctx }))
  const capacityAgentIds = new Set(capacityAgents.map(candidate => candidate.id))
  const liveAgents = new Map([[agent.id, agent], [secondAgent.id, secondAgent], [claudeErrorAgent.id, claudeErrorAgent], [emptyAgent.id, emptyAgent], [cancelAgent.id, cancelAgent], ...capacityAgents.map(candidate => [candidate.id, candidate])])
  services.agents.get = id => liveAgents.get(id)
  const additionalCwds = new Map()
  const originalSessionGet = state.sessions.get
  state.sessions.get = id => {
    const cwd = additionalCwds.get(id)
    if (cwd) return { header: { id, cwd } }
    return id === secondAgent.id || id === claudeErrorAgent.id || id === emptyAgent.id || id === cancelAgent.id || capacityAgentIds.has(id)
      ? { header: { id, cwd: CWD } }
      : originalSessionGet(id)
  }
  state.nodes.get(userRoot).type = 'symlink'
  const priorScopedCount = scopedCommands.size
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: secondAgent, signal: new AbortController().signal })))
  assert.equal(scopedCommands.size, priorScopedCount, 'an invalid OpenCode user root registers no Agent command')
  assert.ok(warnings.length > 0, 'invalid roots fail closed and report through the existing warning path')

  state.nodes.get(userRoot).type = 'directory'
  const originalListDir = state.fs.listDir
  state.fs.listDir = async (target, signal) => {
    if (target?.path === userClaudeRoot) {
      state.calls.push({ method: 'listDir', target, signal })
      throw new Error('injected user Claude command listing failure')
    }
    return originalListDir(target, signal)
  }
  const warningsBeforeClaudeFailure = warnings.length
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: claudeErrorAgent, signal: new AbortController().signal })))
  assert.equal(scopedCommands.size, priorScopedCount, 'a user Claude root listing failure prevents partial project/OpenCode registration')
  assert.ok(state.calls.some(call => call.method === 'listDir' && call.target?.path === userClaudeRoot), 'the configured user Claude root listing was attempted')
  assert.ok(warnings.length > warningsBeforeClaudeFailure, 'a user Claude root listing failure reaches the Agent warning path')
  state.fs.listDir = originalListDir
  const commandRoots = [`${CWD}/${PROJECT_COMMAND_DIRECTORY}`, `${CWD}/.claude/commands`, userRoot, missingUserRoot, userClaudeRoot]
  for (const [file, node] of state.nodes) {
    if (node.type === 'file' && commandRoots.some(root => file.startsWith(`${root}/`))) state.nodes.delete(file)
  }
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: emptyAgent, signal: new AbortController().signal })))
  assert.equal(scopedCommands.has('empty-auto'), false, 'an initially empty Agent scope retains no phantom command')
  const emptyAgentWatch = [...watchSubscriptions].reverse().find(subscription => !subscription.closed
    && subscription.target.path === `${CWD}/${PROJECT_COMMAND_DIRECTORY}`)
  assert.ok(emptyAgentWatch, 'an initially empty scope watches its existing command directory')
  state.addFile(`${CWD}/${PROJECT_COMMAND_DIRECTORY}/empty-auto.md`, VALID)
  emptyAgentWatch.changed()
  for (let attempt = 0; attempt < 100 && !scopedCommands.has('empty-auto'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(scopedCommands.has('empty-auto'), 'watching an initially empty scope discovers newly created commands')
  await Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent: emptyAgent })))
  assert.equal(scopedCommands.has('empty-auto'), false, 'empty-scope watcher cleanup unregisters its later command')

  const lateUserRootCwd = `${CWD}/late-user-root-project`
  state.addDirectory(lateUserRootCwd)
  const lateUserRootAgent = { id: 'agent-late-user-root', followup() {}, ctx: agent.ctx }
  liveAgents.set(lateUserRootAgent.id, lateUserRootAgent)
  additionalCwds.set(lateUserRootAgent.id, lateUserRootCwd)
  const userRootWatchStart = watchSubscriptions.length
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: lateUserRootAgent, signal: new AbortController().signal })))
  const missingUserRootWatcher = watchSubscriptions.slice(userRootWatchStart).find(subscription => !subscription.closed && subscription.target.path === missingUserRoot)
  assert.ok(missingUserRootWatcher, 'an explicitly configured absent user root receives a creation watcher')
  state.addDirectory(missingUserRoot)
  const lateUserRootFile = `${missingUserRoot}/late-user-root.md`
  state.addFile(lateUserRootFile, VALID)
  missingUserRootWatcher.changed()
  for (let attempt = 0; attempt < 200 && !scopedCommands.has('late-user-root'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(scopedCommands.has('late-user-root'), 'creating an explicit user root automatically discovers its command')
  const createdUserRootWatcher = [...watchSubscriptions].reverse().find(subscription => !subscription.closed && subscription.target.path === missingUserRoot)
  assert.ok(createdUserRootWatcher, 'the created root remains watched as an existing configured directory')
  state.nodes.delete(lateUserRootFile)
  createdUserRootWatcher.changed()
  for (let attempt = 0; attempt < 200 && scopedCommands.has('late-user-root'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(scopedCommands.has('late-user-root'), false, 'the configured user-root watcher removes a command after file deletion')
  await Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent: lateUserRootAgent })))
  assert.ok(watchSubscriptions.slice(userRootWatchStart).filter(subscription => subscription.target.path === missingUserRoot).every(subscription => subscription.closed))

  const lateRootCwd = `${CWD}/late-root-project`
  state.addDirectory(lateRootCwd)
  const lateRootAgent = { id: 'agent-late-root', followup() {}, ctx: agent.ctx }
  liveAgents.set(lateRootAgent.id, lateRootAgent)
  additionalCwds.set(lateRootAgent.id, lateRootCwd)
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: lateRootAgent, signal: new AbortController().signal })))
  const lateRootWatcher = watchSubscriptions.find(subscription => !subscription.closed && subscription.target.path === `${lateRootCwd}/.opencode`)
  assert.ok(lateRootWatcher, 'an absent conventional top-level parent receives a creation watcher')
  state.addDirectory(`${lateRootCwd}/.opencode`)
  state.addDirectory(`${lateRootCwd}/.opencode/commands`)
  state.addFile(`${lateRootCwd}/.opencode/commands/late-root.md`, VALID)
  lateRootWatcher.changed()
  for (let attempt = 0; attempt < 200 && !scopedCommands.has('late-root'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(scopedCommands.has('late-root'), 'creating a missing project root automatically registers its command')
  await Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent: lateRootAgent })))
  assert.equal(scopedCommands.has('late-root'), false, 'disposal removes the command discovered through the absent-root watcher')
  assert.ok(watchSubscriptions.filter(subscription => subscription.target.path.startsWith(`${lateRootCwd}/`)).every(subscription => subscription.closed))

  const raceCwd = `${CWD}/watch-race-project`
  state.addDirectory(raceCwd)
  const raceAgent = { id: 'agent-watch-race', followup() {}, ctx: agent.ctx }
  liveAgents.set(raceAgent.id, raceAgent)
  additionalCwds.set(raceAgent.id, raceCwd)
  onNextWatch = subscription => {
    if (subscription.target.path !== `${raceCwd}/.opencode`) return
    state.addDirectory(`${raceCwd}/.opencode`)
    state.addDirectory(`${raceCwd}/.opencode/commands`)
    state.addFile(`${raceCwd}/.opencode/commands/race-created.md`, VALID)
  }
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: raceAgent, signal: new AbortController().signal })))
  for (let attempt = 0; attempt < 200 && !scopedCommands.has('race-created'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(scopedCommands.has('race-created'), 'post-subscription reconciliation catches a root created before watcher activation settles')
  await Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent: raceAgent })))
  assert.equal(scopedCommands.has('race-created'), false)

  const symlinkCwd = `${CWD}/symlink-root-project`
  state.addDirectory(symlinkCwd)
  const symlinkAgent = { id: 'agent-symlink-root', followup() {}, ctx: agent.ctx }
  liveAgents.set(symlinkAgent.id, symlinkAgent)
  additionalCwds.set(symlinkAgent.id, symlinkCwd)
  await Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: symlinkAgent, signal: new AbortController().signal })))
  const symlinkRootWatcher = watchSubscriptions.find(subscription => !subscription.closed && subscription.target.path === `${symlinkCwd}/.opencode`)
  assert.ok(symlinkRootWatcher)
  const outsideCommand = '/outside/symlink-project/.opencode/commands/escape.md'
  state.addFile(outsideCommand, VALID)
  state.addSymlink(`${symlinkCwd}/.opencode`)
  const readsBeforeSymlink = readCalls(state).length
  const warningsBeforeSymlink = warnings.length
  symlinkRootWatcher.changed()
  for (let attempt = 0; attempt < 200 && warnings.length === warningsBeforeSymlink; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(warnings.length > warningsBeforeSymlink, 'a replaced project root symlink fails closed through the existing warning path')
  assert.equal(readCalls(state).slice(readsBeforeSymlink).some(call => call.target?.path === outsideCommand), false, 'symlink replacement never reads outside the Agent cwd')
  assert.equal(scopedCommands.has('escape'), false)
  await Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent: symlinkAgent })))
  assert.ok(watchSubscriptions.filter(subscription => subscription.target.path.startsWith(`${symlinkCwd}/`)).every(subscription => subscription.closed))

  const firstLateWatch = watchSubscriptions.length
  let releaseLateWatch
  nextWatchGate = new Promise(resolve => { releaseLateWatch = resolve })
  const cancellation = new AbortController()
  const canceledCreation = Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: cancelAgent, signal: cancellation.signal })))
  for (let attempt = 0; attempt < 100 && watchSubscriptions.length === firstLateWatch; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(watchSubscriptions.length > firstLateWatch, 'canceled Agent creation reaches delayed watcher initialization')
  const lateSubscription = watchSubscriptions[firstLateWatch]
  cancellation.abort()
  await canceledCreation
  assert.equal(scopedCommands.has('empty-auto'), false, 'canceled Agent creation rolls back command registration')
  releaseLateWatch()
  for (let attempt = 0; attempt < 100 && !lateSubscription.closed; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(lateSubscription.closed, true, 'a watcher initialized after cancellation is disposed immediately')

  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.all(capacityAgents.map(candidate => Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent: candidate, signal: new AbortController().signal })))))
  assert.equal(watchSubscriptions.filter(subscription => !subscription.closed).length, 64, 'concurrent Agent setups reserve pending capacity and never exceed the global 64-watcher cap')
  await Promise.all(capacityAgents.map(candidate => Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent: candidate })))))

  await Promise.all((listeners.get('agent/disposed') ?? []).map(listener => listener({ agent })))
  assert.equal(scopedCommands.size, 0, 'Agent disposal unregisters scoped commands')
  const cleanup = effects.find(effect => effect.label === 'dsh-omo project command source')?.dispose
  assert.equal(typeof cleanup, 'function')
  await cleanup()
  assert.ok(watchSubscriptions.every(subscription => subscription.closed), 'Agent disposal and plugin cleanup close every filesystem watcher')
})
