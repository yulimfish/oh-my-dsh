import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildUlwExecuteDirective,
  formatUlwWorktreeMetadata,
  normalizeUlwWorktreeMetadata,
  parseUlwExecuteInput,
  ULW_EXECUTE_COMMAND_HINT,
} from '../src/ulw-execute-command.js'

const parse = (input, limit) => parseUlwExecuteInput(input, limit)

test('requires one bounded existing-plan selector and applies both configured and hard limits', () => {
  assert.deepEqual(parse('  Migration plan  '), { ok: true, planName: 'Migration plan' })
  assert.equal(parse(undefined).ok, false)
  assert.equal(parse('   ').ok, false)
  for (const separator of ['\u0000', '\n', '\r', '\t', '\u000b', '\u000c', '\u001f', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029']) {
    assert.equal(parse(`Plan${separator}Name`).ok, false, `plan selectors must reject line/control separator ${separator.codePointAt(0).toString(16)}`)
  }
  assert.equal(parse('Plan name', 4).ok, false)
  assert.equal(parse('x'.repeat(12_001), 20_000).ok, false, 'the adapter hard cap applies even if config is larger')
  assert.equal(ULW_EXECUTE_COMMAND_HINT, '<existing plan name> [--worktree]')
})

test('accepts only a standalone trailing --worktree and rejects custom worktree paths', () => {
  assert.deepEqual(parse('Migration plan --worktree'), { ok: true, planName: 'Migration plan', worktree: true })
  for (const input of ['Plan --worktree /tmp/worktree', 'Plan --worktree=/tmp/worktree', 'Plan --WORKTREE']) {
    const result = parse(input)
    assert.equal(result.ok, false, `expected worktree syntax rejection for ${input}`)
  }
})

test('rejects PR and shipping flags before queuing', () => {
  for (const input of [
    'Plan --make-pr',
    'Plan --MAKE-PR',
    'Plan --make-pr=true',
    'Plan --ship',
    'Plan --SHIP',
    'Plan --ship=now',
    'Plan "--ship"',
    'Plan --ship-commit',
  ]) {
    const result = parse(input)
    assert.equal(result.ok, false, `expected rejection for ${input}`)
    assert.match(result.error, /rejects --make-pr and --ship/u)
  }
})

test('normalizes and JSON-quotes bounded Host worktree metadata', () => {
  const metadata = { path: '/workspace/.worktrees/plan-a', branch: 'plan-a', baseCommit: 'abc123' }
  assert.deepEqual(normalizeUlwWorktreeMetadata(metadata), metadata)
  assert.equal(formatUlwWorktreeMetadata(metadata), 'path="/workspace/.worktrees/plan-a"; branch="plan-a"; baseCommit="abc123"')
  assert.equal(formatUlwWorktreeMetadata({
    path: '/workspace/line\nbreak\u202e', branch: 'plan-a', baseCommit: 'abc123',
  }), 'path="/workspace/line\\nbreak\\u202e"; branch="plan-a"; baseCommit="abc123"')
  assert.equal(normalizeUlwWorktreeMetadata({ path: 'x'.repeat(4_097), branch: 'b', baseCommit: 'c' }), undefined)
  assert.equal(normalizeUlwWorktreeMetadata({ path: '\u202e'.repeat(2_000), branch: 'b', baseCommit: 'c' }), undefined, 'escaped metadata also has a serialized-output cap')
  assert.equal(normalizeUlwWorktreeMetadata({ path: '/repo', branch: 'b'.repeat(257), baseCommit: 'c' }), undefined)
  assert.equal(normalizeUlwWorktreeMetadata({ path: '/repo', branch: 'b', baseCommit: 'c'.repeat(257) }), undefined)
})

test('directive is explicit prompt-only guidance with no OMO lifecycle or external operations', () => {
  const directive = buildUlwExecuteDirective()
  const worktreeDetails = { path: '/workspace/.worktrees/plan-a', branch: 'plan-a', baseCommit: 'abc123' }
  const worktreeDirective = buildUlwExecuteDirective({ worktree: true, worktreeDetails })
  assert.match(directive, /Prompt-only DSH adapter/u)
  assert.match(directive, /existing project plan/u)
  assert.match(directive, /untrusted data/u)
  assert.match(directive, /If no matching plan exists, multiple plans match/u)
  assert.match(directive, /DSH permissions and approvals remain authoritative/u)
  assert.match(directive, /does not invoke the upstream OMO hook/u)
  assert.match(directive, /does not .*resume plans/u)
  assert.match(directive, /boulder state or notepads/u)
  assert.match(directive, /Do not create a worktree/u)
  assert.doesNotMatch(directive, /Host-returned metadata/u)
  assert.match(worktreeDirective, /explicitly requested --worktree/u)
  assert.match(worktreeDirective, /created and selected this retained DSH worktree as this Agent’s current working directory/u)
  assert.match(worktreeDirective, /path="\/workspace\/\.worktrees\/plan-a"; branch="plan-a"; baseCommit="abc123"/u)
  assert.match(worktreeDirective, /no worktree-removal service/u)
  assert.match(worktreeDirective, /do not run git worktree remove or manually delete this checkout/u)
  assert.match(worktreeDirective, /do not commit, push, open a PR, ship, or merge automatically/u)
  assert.throws(() => buildUlwExecuteDirective({ worktree: true }), /bounded Host worktree metadata/u)
})
