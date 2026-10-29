import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const cli = fileURLToPath(new URL('../src/doctor.js', import.meta.url))
const expectedDsh = manifest.peerDependencies['@deepseek-ai/dsh-subagent']
const minimumNodeMajor = Number(/^>=(\d+)$/u.exec(manifest.engines.node)[1])
function doctor(args = [], nodeVersion = `${minimumNodeMajor}.0.0`) {
  const preload = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} })`)}`
  const result = spawnSync(process.execPath, ['--import', preload, cli, ...args], { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

test('doctor derives identity and target from manifest and labels runtime unverified', () => {
  const result = doctor(['--json'])
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.plugin, manifest.name)
  assert.equal(report.pluginVersion, manifest.version)
  assert.equal(report.expectedDsh, expectedDsh)
  assert.equal(report.dshVersion, null)
  assert.equal(report.dshVersionSource, 'unverified')
  assert.equal(report.compatibleDsh, null)
  assert.equal(report.compatibleNode, true)
  const text = doctor()
  assert.equal(text.status, 0)
  assert.ok(text.stdout.includes(`${manifest.name} ${manifest.version}`))
  assert.match(text.stdout, /Installed DSH runtime: unverified/u)
})

test('unsupported Node fails in JSON and text modes', () => {
  const unsupported = `${minimumNodeMajor - 1}.99.0`
  const json = doctor(['--json'], unsupported)
  assert.equal(json.status, 1)
  assert.equal(JSON.parse(json.stdout).compatibleNode, false)
  const text = doctor([], unsupported)
  assert.equal(text.status, 1)
  assert.ok(text.stdout.includes(`requires Node.js ${manifest.engines.node}`))
})

test('explicit DSH version checks are labeled caller-supplied, never runtime discovery', () => {
  const matching = doctor(['--json', '--dsh-version', expectedDsh])
  assert.equal(matching.status, 0)
  const report = JSON.parse(matching.stdout)
  assert.equal(report.dshVersion, expectedDsh)
  assert.equal(report.dshVersionSource, 'explicit-argument')
  assert.equal(report.compatibleDsh, true)
  assert.ok(report.notes.some(note => note.includes('runtime was not queried')))
  for (const mode of [[], ['--json']]) {
    const mismatching = doctor([...mode, '--dsh-version', '999.0.0'])
    assert.equal(mismatching.status, 1)
    if (mode.length) assert.equal(JSON.parse(mismatching.stdout).compatibleDsh, false)
    else assert.match(mismatching.stdout, /explicit argument, not runtime introspection/u)
  }
})

test('invalid, missing, unknown, and duplicate arguments fail safely', () => {
  for (const args of [
    ['--unknown'], ['--dsh-version'], ['--dsh-version', '--json'],
    ['--dsh-version', 'latest'], ['--dsh-version', '1.2.3\n'],
    ['--json', '--json'], ['--dsh-version', expectedDsh, '--dsh-version', expectedDsh],
  ]) {
    const result = doctor(args)
    assert.equal(result.status, 2, JSON.stringify(args))
    const output = args.includes('--json') ? JSON.parse(result.stdout).error : result.stderr
    assert.match(output, /argument|version/u)
  }
  const json = doctor(['--json', '--unknown'])
  assert.equal(json.status, 2)
  assert.equal(typeof JSON.parse(json.stdout).error, 'string')
})
