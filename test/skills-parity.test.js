import assert from 'node:assert/strict'
import test from 'node:test'
import { SKILLS } from '../src/skills.js'

const addedSkills = [
  'debugging',
  'frontend',
  'git-master',
  'init-deep',
  'remove-ai-slops',
  'review-work',
  'security-research',
  'visual-qa',
]

const topicChecks = new Map([
  ['debugging', /hypothesis|reproduc/u],
  ['frontend', /semantic|keyboard|responsive/u],
  ['git-master', /worktree|staged diff|history/u],
  ['init-deep', /repository|entry point|architecture/u],
  ['remove-ai-slops', /redundant|boilerplate|clutter/u],
  ['review-work', /finding|severity|evidence/u],
  ['security-research', /threat|authorized|advisory/u],
  ['visual-qa', /rendered.view|viewport|visual verification/u],
])

const criticalGuidance = new Map([
  ['debugging', [/falsifiable hypothesis/i, /re-run the reproducer/i]],
  ['frontend', [/keyboard access/i, /loading, empty, and error states/i]],
  ['git-master', [/preserve pre-existing user changes/i, /never reset, discard, or rewrite unrelated work/i]],
  ['init-deep', [/verified facts from hypotheses/i, /Do not create persistent notes/i]],
  ['remove-ai-slops', [/Preserve useful rationale/i, /diff small and behavior-preserving/i]],
  ['review-work', [/Lead with findings/i, /Do not report preferences/i]],
  ['security-research', [/Do not probe third-party or live systems without explicit authorization/i, /Avoid collecting, exposing, or reproducing secrets/i]],
  ['visual-qa', [/representative viewport sizes/i, /report visual verification as unavailable/i]],
])

test('bundled skills are immutable, well-shaped, bounded, and uniquely named', () => {
  assert.ok(Object.isFrozen(SKILLS), 'skill catalog should be immutable')
  assert.ok(SKILLS.length > 0)

  const names = SKILLS.map(skill => skill.name)
  assert.equal(new Set(names).size, names.length, 'skill names must not be duplicated')

  for (const skill of SKILLS) {
    assert.ok(Object.isFrozen(skill), `${skill.name} should be immutable`)
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `${skill.name} should be kebab-case`)
    for (const field of ['description', 'whenToUse', 'content']) {
      assert.equal(typeof skill[field], 'string', `${skill.name}.${field} should be a string`)
      assert.ok(skill[field].trim().length > 0, `${skill.name}.${field} should not be empty`)
    }
    assert.ok(skill.content.length <= 3000, `${skill.name} instructions should remain bounded`)
  }
})

test('selected upstream workflow skills are present with focused DSH-native guidance', () => {
  const byName = new Map(SKILLS.map(skill => [skill.name, skill]))
  const actualAdded = namesInCatalog(SKILLS).filter(name => addedSkills.includes(name))
  assert.deepEqual(actualAdded, addedSkills)

  for (const name of addedSkills) {
    const skill = byName.get(name)
    assert.ok(skill, `${name} should be registered`)
    assert.match(skill.content, topicChecks.get(name), `${name} should contain topic-specific workflow guidance`)
    assert.match(skill.content, /workflow guide, not an upstream lifecycle equivalent/u)
    assert.match(skill.content, /DSH host policies, permissions, approvals, sandbox, and available tools remain authoritative/u)
    assert.match(skill.content, /do not assume a particular tool or service exists/u)
    for (const requirement of criticalGuidance.get(name)) {
      assert.match(skill.content, requirement, `${name} should retain critical workflow/safety guidance`)
    }
  }
})

function namesInCatalog(skills) {
  return skills.map(skill => skill.name)
}
