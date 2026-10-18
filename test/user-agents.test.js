import assert from 'node:assert/strict'
import test from 'node:test'
import { ROLE_NAMES } from '../src/roles.js'
import { normalizeUserAgents } from '../src/user-agents.js'

const validAgent = {
  name: 'docs-auditor',
  description: 'Review documentation for concrete gaps.',
  prompt: 'Inspect the changed docs and report actionable inconsistencies.',
}

test('normalizes bounded user-agent personas and registered preset references', () => {
  const agents = normalizeUserAgents([
    validAgent,
    { name: 'plan-helper', prompt: 'Plan the next step.' },
    { name: 'preset-auditor', description: 'Use a trusted registered preset.', agentPreset: 'reviewer-v2' },
  ])

  assert.deepEqual([...agents.keys()], ['docs-auditor', 'plan-helper', 'preset-auditor'])
  assert.deepEqual(agents.get('docs-auditor'), {
    name: 'docs-auditor',
    description: 'Review documentation for concrete gaps.',
    prompt: 'Inspect the changed docs and report actionable inconsistencies.',
    mode: 'subagent',
  })
  assert.deepEqual(agents.get('plan-helper'), {
    name: 'plan-helper',
    prompt: 'Plan the next step.',
    mode: 'subagent',
  })
  assert.deepEqual(agents.get('preset-auditor'), {
    name: 'preset-auditor',
    description: 'Use a trusted registered preset.',
    agentPreset: 'reviewer-v2',
    mode: 'subagent',
  })
  assert.ok(Object.isFrozen(agents.get('docs-auditor')))
  assert.ok(Object.isFrozen(agents.get('preset-auditor')))
  assert.deepEqual([...normalizeUserAgents([])], [])
  assert.deepEqual([...normalizeUserAgents(undefined)], [])
})

test('rejects malformed names, built-in collisions, duplicates, and unknown fields', () => {
  for (const name of ['', 'Docs-auditor', '1auditor', 'docs_auditor', 'docs auditor', 'x'.repeat(65)]) {
    assert.throws(() => normalizeUserAgents([{ name, prompt: 'Review docs.' }]), /userAgents/u)
  }
  assert.throws(() => normalizeUserAgents([{ name: ROLE_NAMES[0], prompt: 'Override built-in.' }]), /conflicts with a built-in/u)
  assert.throws(() => normalizeUserAgents([
    { name: 'docs-auditor', prompt: 'First.' },
    { name: 'docs-auditor', prompt: 'Second.' },
  ]), /duplicate user agent/u)
  assert.throws(() => normalizeUserAgents([{ ...validAgent, provider: 'model-provider' }]), /unsupported field/u)
})

test('accepts only subagent mode and validates prompt content', () => {
  for (const mode of ['primary', 'all', 'subagent-plus', '', 1]) {
    assert.throws(() => normalizeUserAgents([{ name: 'mode-test', prompt: 'Follow instructions.', mode }]), /mode only supports/u)
  }
  for (const prompt of ['', ' \n\t ', 'x'.repeat(16_385), `${' '.repeat(16_385)}x`, `before${String.fromCodePoint(0)}after`, `before${String.fromCodePoint(0x202e)}after`]) {
    assert.throws(() => normalizeUserAgents([{ name: 'prompt-test', prompt }]), /userAgents\[prompt-test\]\.prompt/u)
  }
  for (const codePoint of [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
    assert.throws(() => normalizeUserAgents([{
      name: 'prompt-test', prompt: `before${String.fromCodePoint(codePoint)}after`,
    }]), /contains disallowed control or bidi characters/u)
  }
})

test('requires exactly one bounded prompt or registered preset reference', () => {
  assert.throws(() => normalizeUserAgents([{ name: 'missing-mode' }]), /exactly one of prompt or agentPreset/u)
  assert.throws(() => normalizeUserAgents([{
    name: 'ambiguous-mode', prompt: 'Review safely.', agentPreset: 'reviewer-v2',
  }]), /exactly one of prompt or agentPreset/u)
  for (const agentPreset of [null, '', ' \t ', 'x'.repeat(257), 'é'.repeat(129), `bad${String.fromCodePoint(0)}id`, `bad${String.fromCodePoint(0x202e)}id`]) {
    assert.throws(() => normalizeUserAgents([{ name: 'preset-test', agentPreset }]), /userAgents\[preset-test\]\.agentPreset/u)
  }
  for (const codePoint of [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
    assert.throws(() => normalizeUserAgents([{
      name: 'preset-test', agentPreset: `before${String.fromCodePoint(codePoint)}after`,
    }]), /control or bidi characters/u)
  }
  const exactUtf8Bound = 'é'.repeat(128)
  assert.equal(normalizeUserAgents([{ name: 'preset-test', agentPreset: exactUtf8Bound }]).get('preset-test').agentPreset, exactUtf8Bound)
})

test('bounds descriptions, definition count, and aggregate persona bytes', () => {
  assert.throws(() => normalizeUserAgents('not-an-array'), /userAgents must be an array/u)
  assert.throws(() => normalizeUserAgents(Array.from({ length: 33 }, (_, index) => ({ name: `agent-${index}`, prompt: 'Prompt.' }))), /at most 32/u)
  assert.throws(() => normalizeUserAgents([{ name: 'description-test', prompt: 'Prompt.', description: 'x'.repeat(513) }]), /description/u)
  assert.throws(() => normalizeUserAgents([{ name: 'description-test', prompt: 'Prompt.', description: `a${String.fromCodePoint(0x2028)}b` }]), /description/u)
  for (const codePoint of [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
    assert.throws(() => normalizeUserAgents([{
      name: 'description-test', prompt: 'Prompt.', description: `before${String.fromCodePoint(codePoint)}after`,
    }]), /description.*control or bidi characters/u)
  }
  assert.throws(() => normalizeUserAgents(Array.from({ length: 5 }, (_, index) => ({
    name: `agent-${index}`,
    prompt: 'x'.repeat(16_384),
  }))), /total/u)
  assert.throws(() => normalizeUserAgents(Array.from({ length: 5 }, (_, index) => ({
    name: `padded-agent-${index}`,
    prompt: `${' '.repeat(16_383)}x`,
  }))), /total/u)
})

test('measures per-agent and aggregate persona limits in UTF-8 bytes', () => {
  const maximumPersona = 'é'.repeat(8_192)
  const accepted = normalizeUserAgents([{ name: 'unicode-agent', prompt: maximumPersona }])
  assert.equal(new TextEncoder().encode(accepted.get('unicode-agent').prompt).byteLength, 16_384)
  assert.throws(() => normalizeUserAgents([{ name: 'unicode-agent', prompt: 'é'.repeat(8_193) }]), /16384 UTF-8 bytes/u)

  const exactAggregate = normalizeUserAgents(Array.from({ length: 4 }, (_, index) => ({
    name: `unicode-${index}`,
    prompt: maximumPersona,
  })))
  assert.equal(exactAggregate.size, 4)
  assert.throws(() => normalizeUserAgents(Array.from({ length: 5 }, (_, index) => ({
    name: `unicode-${index}`,
    prompt: maximumPersona,
  }))), /65536 UTF-8 bytes in total/u)
})
