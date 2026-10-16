import assert from 'node:assert/strict'
import test from 'node:test'
import { join, sep } from 'node:path'
import {
  createNotepadWriteGuard,
  NOTEPAD_WRITE_GUARD_REASON,
  registerNotepadWriteGuard,
} from '../src/notepad-write-guard.js'

function execution(name, arguments_) {
  return { name, arguments: arguments_ }
}

test('blocks Write calls targeting normalized .omo and .sisyphus notepad path segments', () => {
  const guard = createNotepadWriteGuard()
  const blockedArguments = [
    { filePath: join('.omo', 'notepads') },
    { path: join('workspace', '.sisyphus', 'notepads', 'run.md') },
    { file_path: join(sep, 'home', 'agent', '.omo', 'notepads', 'state.md') },
    { filePath: join('workspace', 'draft', '..', '.sisyphus', 'notepads', 'archive.md') },
  ]

  for (const arguments_ of blockedArguments) {
    assert.equal(guard(execution('write', arguments_)), NOTEPAD_WRITE_GUARD_REASON)
  }
  assert.equal(guard(execution('WRITE', { path: join('.omo', 'notepads', 'state.md') })), NOTEPAD_WRITE_GUARD_REASON)
})

test('allows Edit, unrelated Tools, and path segments that are not notepads', () => {
  const guard = createNotepadWriteGuard()
  const planPath = join('.sisyphus', 'plans', 'active.md')
  const nearMisses = [
    execution('edit', { file_path: join('.omo', 'notepads', 'state.md') }),
    execution('bash', { command: 'write .omo/notepads/state.md' }),
    execution('write', { filePath: join('src', 'notepads', 'state.md') }),
    execution('write', { path: join('.omo', 'notepads-archive', 'state.md') }),
    execution('write', { file_path: planPath }),
    execution('write', { file_path: 42 }),
    execution('write', []),
    null,
  ]

  for (const input of nearMisses) assert.equal(guard(input), undefined)
})

test('caps lexical path inspection by JavaScript UTF-16 string length', () => {
  const guard = createNotepadWriteGuard()
  const prefix = join('.omo', 'notepads')
  const exactlyAtCap = `${prefix}${sep}${'x'.repeat(4_096 - prefix.length - 1)}`
  assert.equal(exactlyAtCap.length, 4_096)
  assert.equal(guard(execution('write', { path: exactlyAtCap })), NOTEPAD_WRITE_GUARD_REASON)
  assert.equal(guard(execution('write', { path: `${exactlyAtCap}x` })), undefined)

  const astralPath = `${prefix}${sep}${'🧪'.repeat(2_050)}`
  assert.ok([...astralPath].length < 4_096)
  assert.ok(astralPath.length > 4_096)
  assert.equal(guard(execution('write', { path: astralPath })), undefined)
})

test('honors upstream nullish path fallback and field precedence', () => {
  const guard = createNotepadWriteGuard()
  const notepadPath = join('.omo', 'notepads', 'state.md')
  assert.equal(guard(execution('write', { filePath: null, path: notepadPath })), NOTEPAD_WRITE_GUARD_REASON)
  assert.equal(guard(execution('write', { filePath: 'src/new.md', path: notepadPath })), undefined)
  assert.equal(guard(execution('write', { filePath: 42, path: notepadPath })), undefined)
})

test('registers a global monotonic Tool guard and disposes it idempotently', () => {
  const guards = new Set()
  const ctx = {
    tools: {
      guard: guard => {
        guards.add(guard)
        return () => guards.delete(guard)
      },
    },
  }
  const dispose = registerNotepadWriteGuard(ctx)
  assert.equal(guards.size, 1)
  const [guard] = guards
  assert.equal(guard(execution('write', { path: join('.omo', 'notepads', 'state.md') })), NOTEPAD_WRITE_GUARD_REASON)
  dispose()
  dispose()
  assert.equal(guards.size, 0)
  assert.throws(() => registerNotepadWriteGuard({ tools: {} }), /requires DSH tools\.guard/u)
  assert.throws(() => registerNotepadWriteGuard({ tools: { guard: () => undefined } }), /must return a disposer/u)
})
