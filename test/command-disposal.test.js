import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/index.js'

function makeContext(failOnCommand) {
  const commands = new Map()
  const effects = []
  const ctx = {
    tools: { register: () => () => {} },
    commands: {
      register(definition) {
        if (definition.name === failOnCommand) throw new Error('command registration sentinel')
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    skills: { register: () => () => {}, registerProvider: create => { create({ signal: new AbortController().signal, invalidate() {} }); return () => {} } },
    systemPrompt: { section: () => () => {} },
    subagents: {},
    fs: {},
    logger: { warn() {} },
    effect(execute, label) {
      effects.push({ label, dispose: execute() })
      return () => {}
    },
  }
  return { ctx, commands, effects }
}

const config = {
  provider: 'spawn', maxConcurrent: 4, maxDepth: 1, maxTaskChars: 12_000, maxResultChars: 8_000,
  enableContinuableTasks: false, enableTeamTools: false, enableSessionSearch: false, enableSessionRead: false,
  enableSessionList: false, enableSessionInfo: false, enableJobTools: false,
  projectSkillDirs: ['.opencode/skills', '.claude/skills'], disabledSkills: [], disabledOmoCommands: [],
  disabledOmoRoles: [], categoryRoutes: [], roleRoutes: [],
}

test('attaches command unregister disposers to Cordis effects and rolls back partial registration', () => {
  const fixture = makeContext('refactor')
  assert.throws(() => apply(fixture.ctx, config), /command registration sentinel/u)
  assert.equal(fixture.commands.size, 0, 'commands registered before the failure are rolled back')

  const commandEffects = fixture.effects.filter(effect => effect.label.startsWith('dsh-omo command '))
  assert.ok(commandEffects.length > 0)
  for (const effect of commandEffects) effect.dispose()
  assert.equal(fixture.commands.size, 0, 'the captured context cleanup remains safe after rollback')
})
