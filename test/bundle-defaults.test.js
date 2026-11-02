import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import { Config } from '../src/index.js'
import { DEFAULT_PROJECT_SKILL_DIRS } from '../src/project-skills.js'

async function bundleConfig() {
  const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const row = patch.flatMap(operation => operation.insert ?? []).find(entry => entry.id === 'dsh-omo')
  assert.ok(row, 'bundle must insert its own plugin row')
  return row.config
}

test('shipped bundle retains all default project skill source roots', async () => {
  const config = await bundleConfig()
  assert.deepEqual(config.projectSkillDirs, [...DEFAULT_PROJECT_SKILL_DIRS])
  assert.deepEqual(Config(config).projectSkillDirs, Config({}).projectSkillDirs)
})

test('documented project skill roots mirror the shipped defaults', async () => {
  const roots = [...DEFAULT_PROJECT_SKILL_DIRS]
  for (const file of ['../docs/release-readiness.md', '../README.md']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8')
    const blocks = [...text.matchAll(/```yaml\n([\s\S]*?)```/gu)]
    assert.ok(blocks.length > 0, `${file} must contain a YAML example`)
    let checked = 0
    for (const block of blocks) {
      let rows
      try { rows = parse(block[1]) } catch { continue }
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (row?.id !== 'dsh-omo' || !row.config || !Array.isArray(row.config.projectSkillDirs)) continue
        assert.deepEqual(row.config.projectSkillDirs, roots, `${file} example must use the shipped skill roots`)
        checked += 1
      }
    }
    assert.ok(checked > 0, `${file} must document projectSkillDirs in a dsh-omo example`)
  }
})

test('release doctor reports the packaged version and compatible Node runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const report = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('../src/doctor.js', import.meta.url)), '--json',
  ], { encoding: 'utf8', timeout: 10_000 }))
  assert.equal(report.pluginVersion, manifest.version)
  assert.equal(report.expectedDsh, manifest.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.equal(report.compatibleNode, true)
})

test('release exports bilingual display metadata and a bounded self-contained icon', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  for (const locale of ['en', 'zh']) {
    const { meta } = JSON.parse(await readFile(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'))
    assert.ok(meta.title.trim())
    assert.ok(meta.description.trim())
  }
  const icon = await readFile(new URL('../icon.svg', import.meta.url), 'utf8')
  assert.ok(Buffer.byteLength(icon) <= 256 * 1024)
  assert.match(icon, /^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u)
  assert.doesNotMatch(icon, /<script|<foreignObject|\bhref=|<!DOCTYPE/iu)
  assert.match(icon, /<\/svg>\s*$/u)
})

test('shipped bundle stays on one-shot defaults without optional Host prerequisites', async () => {
  const config = Config(await bundleConfig())
  assert.equal(config.provider, 'spawn')
  assert.equal(config.enableContinuableTasks, false)
  assert.equal(config.enableGoalTools, false)
  assert.equal(config.enableTeamTools, false)
  assert.deepEqual(config.categoryRoutes, [])
  assert.deepEqual(config.roleRoutes, [])
})
