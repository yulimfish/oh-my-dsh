import assert from 'node:assert/strict'
import test from 'node:test'
import { posix as path } from 'node:path'
import { createProjectAgentFilesAdapter } from '../src/project-agent-files.js'

const encoder = new TextEncoder()
const CWD = '/workspace'
const VALID_AGENT = '---\nname: reviewer\ndescription: Review implementation\n---\nRead the requested files and report concrete findings.'

function createMemoryFs({ resolveAliases = {}, onRead } = {}) {
  const nodes = new Map()
  const absolute = (value, cwd = CWD) => path.resolve(cwd, value)
  const addDirectory = directory => {
    const target = absolute(directory)
    nodes.set(target, { type: 'directory', version: `v-${target}` })
    return target
  }
  const addFile = (file, content, version = 'v1') => {
    const target = absolute(file)
    const bytes = content instanceof Uint8Array ? new Uint8Array(content) : encoder.encode(content)
    nodes.set(target, { type: 'file', bytes, size: bytes.byteLength, version })
    return target
  }
  const addSymlink = link => {
    const target = absolute(link)
    nodes.set(target, { type: 'symlink', version: `link-${target}` })
    return target
  }
  const targetFor = target => ({ targetKey: target, path: target })
  const fs = {
    resolve: async (input, options = {}) => {
      const requested = absolute(input, options.cwd ?? CWD)
      const resolved = resolveAliases[requested] ?? requested
      if (!nodes.has(resolved)) throw new Error('not found')
      return targetFor(resolved)
    },
    contains: (parent, child) => child.path === parent.path || child.path.startsWith(`${parent.path.replace(/\/$/u, '')}/`),
    lstat: async (input, options = {}) => {
      const target = absolute(input, options.cwd ?? CWD)
      const entry = nodes.get(target)
      return entry ? { type: entry.type, ...(entry.size !== undefined ? { size: entry.size } : {}) } : undefined
    },
    stat: async target => {
      const entry = nodes.get(target.path)
      return entry ? { type: entry.type, ...(entry.size !== undefined ? { size: entry.size } : {}), version: entry.version } : undefined
    },
    listDir: async target => [...nodes.entries()]
      .filter(([candidate]) => path.dirname(candidate) === target.path)
      .map(([candidate, entry]) => ({ name: path.basename(candidate), type: entry.type, target: targetFor(candidate) })),
    readBytes: async (target, _signal, maxBytes) => {
      const entry = nodes.get(target.path)
      if (!entry || entry.type !== 'file') throw new Error('not a file')
      if (entry.bytes.byteLength > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      onRead?.(target.path, entry)
      return new Uint8Array(entry.bytes)
    },
  }
  return { fs, addDirectory, addFile, addSymlink, nodes }
}

function fixture({ files = [['reviewer.md', VALID_AGENT]], cwd = CWD, sessionCwd = cwd, fsOptions } = {}) {
  const memory = createMemoryFs(fsOptions)
  memory.addDirectory(cwd)
  memory.addDirectory(`${cwd}/.claude`)
  memory.addDirectory(`${cwd}/.claude/agents`)
  for (const [name, source] of files) memory.addFile(`${cwd}/.claude/agents/${name}`, source)
  const agent = { id: 'agent-1' }
  const session = { header: { id: agent.id, cwd: sessionCwd } }
  const agents = { get: id => id === agent.id ? agent : undefined }
  const sessions = { get: id => id === agent.id ? session : undefined }
  const adapter = createProjectAgentFilesAdapter({ agents, sessions, fs: memory.fs })
  const exec = { agent, signal: new AbortController().signal }
  return { ...memory, adapter, agent, session, agents, sessions, exec }
}

test('lists safe project-agent metadata only and reloads the selected prompt on demand', async () => {
  const state = fixture()
  const roster = await state.adapter.list(state.exec)
  assert.deepEqual(roster, {
    agents: [{ agentFile: 'reviewer', name: 'reviewer', description: 'Review implementation' }],
    truncated: false,
  })
  assert.equal(JSON.stringify(roster).includes('Read the requested files'), false)
  assert.deepEqual(await state.adapter.load(state.exec, 'reviewer'), {
    agentFile: 'reviewer',
    name: 'reviewer',
    description: 'Review implementation',
    prompt: 'Read the requested files and report concrete findings.',
  })
})

test('parses bounded project-agent tool allowlists without exposing them in the roster', async t => {
  await t.test('comma-separated strings are lowercased and deduplicated', async () => {
    const state = fixture({ files: [['reviewer.md', '---\nname: reviewer\ntools: READ, read, Bash\n---\nBody.']] })
    assert.deepEqual(await state.adapter.load(state.exec, 'reviewer'), {
      agentFile: 'reviewer', name: 'reviewer', tools: ['read', 'bash'], prompt: 'Body.',
    })
    assert.deepEqual((await state.adapter.list(state.exec)).agents, [{ agentFile: 'reviewer', name: 'reviewer' }])
  })
  await t.test('YAML string arrays and empty values', async () => {
    const arrayState = fixture({ files: [['reviewer.md', '---\nname: reviewer\ntools:\n  - Bash\n  - read\n  - bash\n---\nBody.']] })
    assert.deepEqual((await arrayState.adapter.load(arrayState.exec, 'reviewer')).tools, ['bash', 'read'])
    for (const toolsField of ['tools: []', 'tools:']) {
      const emptyState = fixture({ files: [['reviewer.md', `---\nname: reviewer\n${toolsField}\n---\nBody.`]] })
      assert.equal(Object.hasOwn(await emptyState.adapter.load(emptyState.exec, 'reviewer'), 'tools'), false)
    }
  })
  const invalid = [
    ['too many tools', `tools: ${Array.from({ length: 65 }, (_value, index) => `tool-${index}`).join(',')}`],
    ['oversized tool name', `tools: ${'x'.repeat(129)}`],
    ['oversized UTF-8 name', `tools: ${'é'.repeat(65)}`],
    ['bidi tool name', `tools: safe\u202ename`],
    ['reserved DSH transport', 'tools: run_code'],
    ['nested map', 'tools: {read: true}'],
    ['non-string array item', 'tools: [read, 7]'],
    ['nested array item', 'tools: [read, [bash]]'],
  ]
  for (const [name, field] of invalid) {
    await t.test(name, async () => {
      const state = fixture({ files: [['reviewer.md', `---\nname: reviewer\n${field}\n---\nBody.`]] })
      await assert.rejects(state.adapter.load(state.exec, 'reviewer'), /tool|frontmatter/u)
    })
  }
})

test('scans only exact direct basenames under the live session cwd', async () => {
  const state = fixture({
    files: [['local.md', '---\nname: local\n---\nLocal prompt.']],
  })
  state.addDirectory('/parent')
  state.addDirectory('/parent/.claude')
  state.addDirectory('/parent/.claude/agents')
  state.addFile('/parent/.claude/agents/parent.md', '---\nname: parent\n---\nParent prompt.')
  const roster = await state.adapter.list(state.exec)
  assert.deepEqual(roster.agents.map(item => item.agentFile), ['local'])
  await assert.rejects(state.adapter.load(state.exec, 'parent'), /unavailable in the safe current-session roster/u)
  await assert.rejects(state.adapter.load(state.exec, '../parent'), /safe project agent filename stem/u)
})

test('rejects unsupported, duplicate, aliased, tagged, nested, and multiline frontmatter', async t => {
  const invalid = [
    ['mcp', '---\nname: reviewer\nmcp: [read]\n---\nBody.'],
    ['model', '---\nname: reviewer\nmodel: expensive\n---\nBody.'],
    ['permissions', '---\nname: reviewer\npermissionMode: bypass\n---\nBody.'],
    ['duplicate', '---\nname: reviewer\nname: reviewer\n---\nBody.'],
    ['alias', '---\nname: &n reviewer\ndescription: *n\n---\nBody.'],
    ['tag', '---\nname: !!str reviewer\n---\nBody.'],
    ['nested', '---\nname: reviewer\ndescription: {text: nested}\n---\nBody.'],
    ['multiline', '---\nname: reviewer\ndescription: |\n  Review code\n---\nBody.'],
  ]
  for (const [name, source] of invalid) {
    await t.test(name, async () => {
      const state = fixture({ files: [['reviewer.md', source]] })
      await assert.rejects(state.adapter.load(state.exec, 'reviewer'), /frontmatter|description|filename stem/u)
      assert.deepEqual((await state.adapter.list(state.exec)).agents, [])
    })
  }
})

test('rejects filename/name mismatch, invalid UTF-8, bidi text, and empty bodies', async t => {
  const cases = [
    ['mismatch', '---\nname: other\n---\nBody.'],
    ['invalid utf8', new Uint8Array([0xff, 0xfe])],
    ['bidi', '---\nname: reviewer\n---\nDo not \u202e trust.'],
    ['empty', '---\nname: reviewer\n---\n  \n'],
  ]
  for (const [name, source] of cases) {
    await t.test(name, async () => {
      const state = fixture({ files: [['reviewer.md', source]] })
      await assert.rejects(state.adapter.load(state.exec, 'reviewer'))
    })
  }
})

test('rejects symlinked project directories and selected files', async t => {
  await t.test('.claude symlink', async () => {
    const state = createMemoryFs()
    state.addDirectory(CWD)
    state.addSymlink(`${CWD}/.claude`)
    const agent = { id: 'agent-1' }
    const adapter = createProjectAgentFilesAdapter({
      agents: { get: () => agent },
      sessions: { get: () => ({ header: { id: agent.id, cwd: CWD } }) },
      fs: state.fs,
    })
    await assert.rejects(adapter.list({ agent, signal: new AbortController().signal }), /real directory/u)
  })
  await t.test('agents symlink', async () => {
    const state = createMemoryFs()
    state.addDirectory(CWD)
    state.addDirectory(`${CWD}/.claude`)
    state.addSymlink(`${CWD}/.claude/agents`)
    const agent = { id: 'agent-1' }
    const adapter = createProjectAgentFilesAdapter({
      agents: { get: () => agent },
      sessions: { get: () => ({ header: { id: agent.id, cwd: CWD } }) },
      fs: state.fs,
    })
    await assert.rejects(adapter.list({ agent, signal: new AbortController().signal }), /real directory/u)
  })
  await t.test('selected entry symlink', async () => {
    const state = fixture({ files: [] })
    state.addSymlink(`${CWD}/.claude/agents/reviewer.md`)
    await assert.rejects(state.adapter.load(state.exec, 'reviewer'), /unavailable in the safe current-session roster/u)
  })
})

test('rejects canonical targets outside the active cwd', async () => {
  const state = fixture({ fsOptions: { resolveAliases: { [`${CWD}/.claude/agents/reviewer.md`]: '/outside/reviewer.md' } } })
  state.addDirectory('/outside')
  state.addFile('/outside/reviewer.md', VALID_AGENT)
  await assert.rejects(state.adapter.load(state.exec, 'reviewer'), /outside the active session working directory/u)
})

test('bounds project-agent roster file count and total bytes', async t => {
  await t.test('maximum returned roster', async () => {
    const files = Array.from({ length: 300 }, (_value, index) => {
      const name = `agent-${index}`
      return [`${name}.md`, `---\nname: ${name}\n---\nPrompt ${index}.`]
    })
    const state = fixture({ files })
    const roster = await state.adapter.list(state.exec)
    assert.equal(roster.agents.length, 32)
    assert.equal(roster.truncated, true)
    const selected = await state.adapter.load(state.exec, roster.agents[0].agentFile)
    assert.match(selected.prompt, /^Prompt /u)
    await assert.rejects(state.adapter.load(state.exec, 'agent-9'), /unavailable in the safe current-session roster/u)
    await assert.rejects(state.adapter.load(state.exec, 'agent-299'), /unavailable in the safe current-session roster/u)
  })
  await t.test('aggregate source bytes', async () => {
    let bytesRead = 0
    const files = Array.from({ length: 10 }, (_value, index) => {
      const name = `large-${index}`
      return [`${name}.md`, `---\nname: ${name}\n---\n${'x'.repeat(16_000)}`]
    })
    const state = fixture({ files, fsOptions: { onRead: (_path, entry) => { bytesRead += entry.bytes.byteLength } } })
    const roster = await state.adapter.list(state.exec)
    assert.equal(roster.truncated, true)
    assert.ok(bytesRead <= 131_072)
  })
})

test('rechecks file and directory identity/version after bounded reads', async t => {
  await t.test('selected file version', async () => {
    const state = fixture({ fsOptions: { onRead: (_path, entry) => { entry.version = 'v2' } } })
    await assert.rejects(state.adapter.load(state.exec, 'reviewer'), /changed during inspection/u)
  })
  await t.test('agent directory version', async () => {
    let state
    state = fixture({ fsOptions: { onRead: () => { state.nodes.get(`${CWD}/.claude/agents`).version = 'changed' } } })
    await assert.rejects(state.adapter.load(state.exec, 'reviewer'), /directory changed during inspection/u)
  })
})

test('fails closed without the live session cwd and honors cancellation', async t => {
  const state = fixture()
  await t.test('missing live agent', async () => {
    const adapter = createProjectAgentFilesAdapter({
      agents: { get: () => undefined },
      sessions: state.sessions,
      fs: state.fs,
    })
    await assert.rejects(adapter.list(state.exec), /live Agent session/u)
  })
  await t.test('missing cwd', async () => {
    state.session.header.cwd = undefined
    await assert.rejects(state.adapter.list(state.exec), /absolute working directory/u)
  })
  await t.test('aborted call', async () => {
    state.session.header.cwd = CWD
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(state.adapter.list({ ...state.exec, signal: controller.signal }), /cancelled or exceeded/u)
  })
})
