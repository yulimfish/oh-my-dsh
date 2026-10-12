import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config, inject, name } from '../src/index.js'
import { buildWorkerPrompt, getRole, ROLE_NAMES } from '../src/roles.js'

function makeContext(options = {}) {
  const tools = new Map()
  const sections = []
  const commands = new Map()
  const skills = new Map()
  const starts = []
  const continuableStarts = []
  const listCalls = []
  const interrupts = []
  const continuableChildren = []
  const followups = []
  const disposals = []
  const effects = []
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    subagents: {
      start: async (provider, request) => {
        starts.push({ provider, request })
        const id = `child-${starts.length}`
        return {
          id,
          result: Promise.resolve({
            stopReason: options.stopReason ?? 'completed',
            output: [{ type: 'text', text: options.outputText ?? 'Specialist finding.' }],
            ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
          }),
          dispose: async () => { disposals.push(id) },
        }
      },
      getProvider: options.getProvider ?? (provider => provider === 'spawn' ? { name: 'spawn', prepareContinuable: async () => ({}) } : undefined),
      startContinuable: async spec => {
        continuableStarts.push(spec)
        return { childId: `continuable-child-${continuableStarts.length}`, messageId: `accepted-${continuableStarts.length}` }
      },
      listChildren: async (parentId, signal) => {
        listCalls.push({ parentId, signal })
        return continuableChildren
      },
      interrupt: (childId, authority) => interrupts.push({ childId, authority }),
    },
    systemPrompt: { section: section => { sections.push(section); return () => {} } },
    commands: { register: command => { commands.set(command.name, command); return () => commands.delete(command.name) } },
    skills: { register: skill => { skills.set(skill.name, skill); return () => skills.delete(skill.name) } },
    effect: (execute, label) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return async () => dispose()
    },
    logger: { warn: () => {} },
  }
  return { ctx, tools, sections, commands, skills, starts, continuableStarts, continuableChildren, listCalls, interrupts, followups, disposals, effects }
}

const baseConfig = {
  provider: 'spawn',
  maxConcurrent: 4,
  maxDepth: 1,
  maxTaskChars: 12_000,
  maxResultChars: 8_000,
  enableContinuableTasks: false,
  roleRoutes: [],
}

test('exports Cordis function-plugin metadata and config defaults', () => {
  assert.equal(name, 'dsh-omo')
  assert.deepEqual(inject, ['tools', 'subagents', 'systemPrompt', 'commands', 'skills'])
  assert.ok(Config)
})

test('role directory and worker prompts are bounded to known roles', () => {
  assert.ok(ROLE_NAMES.includes('explore'))
  assert.equal(getRole('missing'), undefined)
  assert.match(buildWorkerPrompt('reviewer', 'Review changes'), /finding/i)
  assert.throws(() => buildWorkerPrompt('missing', 'task'), /Unknown specialist role/)
  assert.throws(() => buildWorkerPrompt('explore', '  '), /must not be empty/)
})

test('mounts specialist controls and caps the untrusted worker body', async () => {
  const fixture = makeContext({ outputText: 'worker-output-'.repeat(30) })
  apply(fixture.ctx, { ...baseConfig, maxResultChars: 64 })
  assert.ok(fixture.tools.has('dsh_omo_task'))
  assert.equal(fixture.sections.length, 1)
  assert.match(fixture.sections[0].text, /ULTRAWORK/i)
  assert.deepEqual([...fixture.commands.keys()], ['ulw', 'ultrawork', 'architect', 'review', 'omo-tasks', 'omo-interrupt', 'omo'])
  assert.deepEqual([...fixture.skills.keys()], ['omo-ultrawork', 'omo-code-review', 'omo-security-review', 'omo-research'])
  assert.ok([...fixture.skills.values()].every(skill => skill.source === 'bundled' && skill.invocation.modelInvocable && skill.invocation.userInvocable))

  const tool = fixture.tools.get('dsh_omo_task')
  const parent = { id: 'parent-agent', followup: message => fixture.followups.push(message) }
  const result = await tool.execute(
    { role: 'explore', task: 'Trace the routing logic' },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.deepEqual(result, { childId: 'child-1', role: 'explore', status: 'started' })
  assert.equal(fixture.starts.length, 1)
  assert.equal(fixture.starts[0].provider, 'spawn')
  assert.equal(fixture.starts[0].request.parent, parent)
  assert.deepEqual(Object.keys(fixture.starts[0].request).sort(), ['label', 'maxDepth', 'parent', 'prompt', 'signal'])
  assert.match(fixture.starts[0].request.prompt[0].text, /Trace the routing logic/)
  await new Promise(resolve => setImmediate(resolve))
  const workerMessage = fixture.followups[0]
  const workerText = workerMessage.content[0].text
  assert.match(workerText, /specialist result/)
  assert.match(workerText, /Stop reason: completed/)
  assert.match(workerText, /untrusted evidence/)
  assert.match(workerText, /Output truncated by dsh-omo at 64 characters/)
  const trustNoteEnd = workerText.indexOf('\n\n', workerText.indexOf('untrusted evidence')) + 2
  assert.ok(workerText.slice(trustNoteEnd).length <= 64)
  assert.equal(workerMessage.role, 'user')
  assert.ok(workerMessage.id)
  assert.deepEqual(workerMessage.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'child-1' })
  assert.deepEqual(fixture.disposals, ['child-1'])
})

test('applies configured model route and explicit tool restriction', async () => {
  const fixture = makeContext()
  apply(fixture.ctx, {
    ...baseConfig,
    roleRoutes: [{
      role: 'test', provider: 'deepseek-official', model: 'deepseek-flash',
      reasoningEffort: 'high', maxTokens: 1024, allowTools: ['read', 'grep'],
    }],
  })
  await fixture.tools.get('dsh_omo_task').execute(
    { role: 'test', task: 'Run the focused suite' },
    { agent: { id: 'parent-agent', followup: message => fixture.followups.push(message) }, signal: new AbortController().signal },
  )
  assert.deepEqual(fixture.starts[0].request.agentOptions, {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 1024,
  })
  assert.deepEqual(fixture.starts[0].request.toolFilter, { allow: ['read', 'grep'] })
})

test('applies per-role token and reasoning overrides without replacing the parent model route', async () => {
  const fixture = makeContext()
  apply(fixture.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'quick', maxTokens: 384, reasoningEffort: 'medium' }],
  })
  await fixture.tools.get('dsh_omo_task').execute(
    { role: 'quick', task: 'Summarize the changed files' },
    { agent: { id: 'parent-agent', followup: message => fixture.followups.push(message) }, signal: new AbortController().signal },
  )
  assert.deepEqual(fixture.starts[0].request.agentOptions, { reasoningEffort: 'medium', maxTokens: 384 })
})

test('preserves an empty inherited-global tool allowlist without claiming a hard deny-all', async () => {
  const fixture = makeContext()
  apply(fixture.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'security', allowTools: [] }],
  })
  await fixture.tools.get('dsh_omo_task').execute(
    { role: 'security', task: 'Review the configuration' },
    { agent: { id: 'parent-agent', followup: message => fixture.followups.push(message) }, signal: new AbortController().signal },
  )
  assert.deepEqual(fixture.starts[0].request.toolFilter, { allow: [] })
})

test('rejects unknown role routes and incomplete model routes', async () => {
  const fixture = makeContext()
  assert.throws(() => apply(fixture.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'unknown' }],
  }), /unknown role route/)

  const second = makeContext()
  assert.throws(() => apply(second.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'explore', provider: 'deepseek-official' }],
  }), /provider and model together/)

  const third = makeContext()
  assert.throws(() => apply(third.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'explore' }, { role: 'explore', provider: 'x', model: 'y' }],
  }), /duplicate role route/)

  const blankBoth = makeContext()
  assert.throws(() => apply(blankBoth.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'explore', provider: '   ', model: '   ' }],
  }), /provider and model must not be blank/)

  const blankModel = makeContext()
  assert.throws(() => apply(blankModel.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'explore', provider: 'deepseek-official', model: '   ' }],
  }), /provider and model must not be blank/)

  const trimmed = makeContext()
  apply(trimmed.ctx, {
    ...baseConfig,
    roleRoutes: [{ role: 'explore', provider: ' deepseek-official ', model: ' deepseek-flash ', reasoningEffort: ' high ' }],
  })
  await trimmed.tools.get('dsh_omo_task').execute(
    { role: 'explore', task: 'Trace the normalized model route' },
    { agent: { id: 'parent-agent', followup: message => trimmed.followups.push(message) }, signal: new AbortController().signal },
  )
  assert.deepEqual(trimmed.starts[0].request.agentOptions, {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
})

test('uses the DSH continuation seam only when enabled and rejects unpersisted token ceilings', async () => {
  const disabled = makeContext()
  apply(disabled.ctx, baseConfig)
  assert.equal(disabled.tools.has('dsh_omo_task_continuable'), false)
  assert.equal(disabled.continuableStarts.length, 0)

  const unsupported = makeContext({ getProvider: () => ({ name: 'spawn' }) })
  apply(unsupported.ctx, { ...baseConfig, enableContinuableTasks: true })
  await assert.rejects(unsupported.tools.get('dsh_omo_task_continuable').execute(
    { role: 'explore', task: 'Persist this task' },
    { agent: { id: 'parent-agent' }, signal: new AbortController().signal },
  ), /does not support continuable tasks/)
  assert.equal(unsupported.continuableStarts.length, 0)

  const noManager = makeContext()
  noManager.ctx.subagents.startContinuable = undefined
  apply(noManager.ctx, { ...baseConfig, enableContinuableTasks: true })
  await assert.rejects(noManager.tools.get('dsh_omo_task_continuable').execute(
    { role: 'explore', task: 'Persist this task' },
    { agent: { id: 'parent-agent' }, signal: new AbortController().signal },
  ), /continuation services are unavailable/)
  assert.equal(noManager.starts.length, 0)

  const tokenBound = makeContext()
  apply(tokenBound.ctx, {
    ...baseConfig,
    enableContinuableTasks: true,
    roleRoutes: [{ role: 'explore', provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 2048 }],
  })
  await assert.rejects(tokenBound.tools.get('dsh_omo_task_continuable').execute(
    { role: 'explore', task: 'Persist this task' },
    { agent: { id: 'parent-agent' }, signal: new AbortController().signal },
  ), /does not preserve this ceiling/)
  assert.equal(tokenBound.continuableStarts.length, 0)
})

test('starts a DSH continuable child with persisted route restrictions and no local one-shot quota', async () => {
  const fixture = makeContext()
  let resolveOneShot
  fixture.ctx.subagents.start = async (provider, request) => {
    fixture.starts.push({ provider, request })
    return { id: 'one-shot-active', result: new Promise(resolve => { resolveOneShot = resolve }), dispose: async () => {} }
  }
  apply(fixture.ctx, {
    ...baseConfig,
    maxConcurrent: 1,
    enableContinuableTasks: true,
    roleRoutes: [{
      role: 'explore', provider: 'deepseek-official', model: 'deepseek-flash',
      reasoningEffort: 'high', allowTools: ['read', 'grep'],
    }],
  })
  const tool = fixture.tools.get('dsh_omo_task')
  const continuableTool = fixture.tools.get('dsh_omo_task_continuable')
  assert.ok(continuableTool)
  const parent = { id: 'parent-agent', followup: message => fixture.followups.push(message) }
  const signal = new AbortController().signal
  await tool.execute({ role: 'explore', task: 'Bounded one-shot task' }, { agent: parent, signal })

  const result = await continuableTool.execute(
    { role: 'explore', task: 'Durable exploration' },
    { agent: parent, signal },
  )
  assert.deepEqual(result, {
    childId: 'continuable-child-1', role: 'explore', status: 'accepted', messageId: 'accepted-1',
  })
  assert.equal(fixture.starts.length, 1)
  const start = fixture.continuableStarts[0]
  assert.equal(start.provider, 'spawn')
  assert.equal(start.label, 'dsh-omo:explore')
  assert.equal(start.signal, signal)
  assert.equal(start.request.parent, parent)
  assert.match(start.request.prompt[0].text, /Durable exploration/)
  assert.deepEqual(start.request.agentOptions, {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
  assert.deepEqual(start.request.toolFilter, { allow: ['read', 'grep'] })
  assert.equal(start.request.maxDepth, 1)
  assert.equal(fixture.followups.length, 0)
  resolveOneShot({ stopReason: 'completed', output: [] })
  await new Promise(resolve => setImmediate(resolve))
})

test('labels every resolved non-completed subagent outcome as partial and keeps host diagnostics separate', async () => {
  for (const stopReason of ['error', 'aborted', 'refusal', 'max-tokens']) {
    const fixture = makeContext({ stopReason, outputText: 'partial evidence', diagnostic: 'provider-specific failure' })
    apply(fixture.ctx, baseConfig)
    await fixture.tools.get('dsh_omo_task').execute(
      { role: 'explore', task: 'Inspect one bounded path' },
      { agent: { id: 'parent-agent', followup: message => fixture.followups.push(message) }, signal: new AbortController().signal },
    )
    await new Promise(resolve => setImmediate(resolve))
    const text = fixture.followups[0].content[0].text
    assert.match(text, /specialist incomplete; output may be partial/)
    assert.match(text, new RegExp(`Stop reason: ${stopReason}`))
    assert.match(text, /Diagnostic \(DSH\): provider-specific failure/)
    assert.match(text, /untrusted evidence/)
  }
})

test('enforces per-instance worker and task-size bounds', async () => {
  let resolveResult
  let startCount = 0
  const fixture = makeContext()
  fixture.ctx.subagents.start = async (provider, request) => {
    fixture.starts.push({ provider, request })
    startCount += 1
    if (startCount === 1) return { id: 'child-active', result: new Promise(resolve => { resolveResult = resolve }), dispose: async () => {} }
    return { id: 'child-next', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
  }
  apply(fixture.ctx, { ...baseConfig, maxConcurrent: 1, maxTaskChars: 4 })
  const tool = fixture.tools.get('dsh_omo_task')
  const input = { role: 'quick', task: '1234' }
  const exec = { agent: { id: 'parent-agent', followup: message => fixture.followups.push(message) }, signal: new AbortController().signal }
  await tool.execute(input, exec)
  await assert.rejects(tool.execute(input, exec), /worker limit reached/)
  await assert.rejects(tool.execute({ ...input, task: '12345' }, exec), /character.*limit/i)
  resolveResult({ stopReason: 'completed' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await tool.execute(input, exec), {
    childId: 'child-next', role: 'quick', status: 'started',
  })
})

test('reserves worker capacity before asynchronous child startup', async () => {
  const fixture = makeContext()
  let acceptStart
  fixture.ctx.subagents.start = () => new Promise(resolve => { acceptStart = resolve })
  apply(fixture.ctx, { ...baseConfig, maxConcurrent: 1 })
  const tool = fixture.tools.get('dsh_omo_task')
  const exec = { agent: { id: 'parent-agent', followup: message => fixture.followups.push(message) }, signal: new AbortController().signal }
  const first = tool.execute({ role: 'explore', task: 'first' }, exec)
  const second = tool.execute({ role: 'explore', task: 'second' }, exec)
  await assert.rejects(second, /worker limit reached/)
  acceptStart({ id: 'child-one', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} })
  assert.deepEqual(await first, { childId: 'child-one', role: 'explore', status: 'started' })
})

test('plugin disposal cancels active workers without queuing stale results', async () => {
  let resolveResult
  let disposeCalls = 0
  const fixture = makeContext()
  fixture.ctx.subagents.start = async () => ({
    id: 'child-shutdown',
    result: new Promise(resolve => { resolveResult = resolve }),
    dispose: async () => {
      disposeCalls += 1
      resolveResult({ stopReason: 'aborted', output: [] })
    },
  })
  apply(fixture.ctx, baseConfig)
  await fixture.tools.get('dsh_omo_task').execute(
    { role: 'explore', task: 'Inspect one path' },
    { agent: { id: 'parent-agent', followup: message => fixture.followups.push(message) }, signal: new AbortController().signal },
  )
  await fixture.effects[0].dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(disposeCalls >= 1)
  assert.equal(fixture.followups.length, 0)
})

test('slash commands steer the current agent with explicit work modes', async () => {
  const fixture = makeContext()
  const messages = []
  apply(fixture.ctx, baseConfig)
  const result = await fixture.commands.get('ulw').handler({
    agent: { followup: message => messages.push(message) },
    rawInput: '  ship the feature  ',
  })
  assert.equal(result.kind, 'success')
  assert.match(messages[0].content[0].text, /ULTRAWORK mode/)
  assert.match(messages[0].content[0].text, /ship the feature/)
  assert.equal(messages[0].role, 'user')
  assert.ok(messages[0].id)
  assert.equal(messages[0].source.kind, 'user')
  assert.equal((await fixture.commands.get('ulw').handler({ agent: { followup() {} }, rawInput: '  ' })).kind, 'error')
})

test('lists only direct dsh-omo continuable children without inventing status', async () => {
  const fixture = makeContext()
  apply(fixture.ctx, baseConfig)
  fixture.continuableChildren.push(
    { id: 'omo-durable-1', mode: 'continuable', label: 'dsh-omo:explore', createdAt: 123 },
    { id: 'omo-one-shot', mode: 'one-shot', label: 'dsh-omo:reviewer', createdAt: 124 },
    { id: 'native-child', mode: 'continuable', label: 'native:research', createdAt: 125 },
  )
  const agent = { id: 'parent-agent' }
  const signal = new AbortController().signal
  const result = await fixture.commands.get('omo-tasks').handler({ agent, signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /omo-durable-1/)
  assert.match(result.text, /dsh-omo:explore/)
  assert.match(result.text, /does not report whether a child is running or completed/)
  assert.doesNotMatch(result.text, /omo-one-shot|native-child/)
  assert.deepEqual(fixture.listCalls, [{ parentId: agent.id, signal }])
})

test('interrupts only a listed direct dsh-omo continuable child and reports a request', async () => {
  const fixture = makeContext()
  apply(fixture.ctx, baseConfig)
  fixture.continuableChildren.push(
    { id: 'omo-durable-1', mode: 'continuable', label: 'dsh-omo:explore', createdAt: 123 },
    { id: 'omo-one-shot', mode: 'one-shot', label: 'dsh-omo:reviewer', createdAt: 124 },
    { id: 'native-child', mode: 'continuable', label: 'native:research', createdAt: 125 },
  )
  const agent = { id: 'parent-agent' }
  const signal = new AbortController().signal
  const result = await fixture.commands.get('omo-interrupt').handler({
    agent, rawInput: ' omo-durable-1 ', signal,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Interruption requested/)
  assert.match(result.text, /may take time/)
  assert.deepEqual(fixture.interrupts, [{ childId: 'omo-durable-1', authority: { kind: 'ancestor', agent } }])

  assert.equal((await fixture.commands.get('omo-interrupt').handler({
    agent, rawInput: 'native-child', signal,
  })).kind, 'error')
  assert.equal((await fixture.commands.get('omo-interrupt').handler({
    agent, rawInput: 'omo-one-shot', signal,
  })).kind, 'error')
  assert.equal((await fixture.commands.get('omo-interrupt').handler({
    agent, rawInput: '  ', signal,
  })).kind, 'error')
  assert.equal(fixture.interrupts.length, 1)
})
