import { ROLE_NAMES } from './roles.js'

const MAX_USER_AGENTS = 32
const MAX_USER_AGENT_NAME_CHARS = 64
const MAX_USER_AGENT_DESCRIPTION_BYTES = 512
const MAX_USER_AGENT_PROMPT_BYTES = 16_384
const MAX_TOTAL_USER_AGENT_PROMPT_BYTES = 65_536
const MAX_USER_AGENT_PRESET_BYTES = 256
const USER_AGENT_NAME = /^[a-z][a-z0-9-]{0,63}$/u
const DISALLOWED_PROMPT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const DISALLOWED_DESCRIPTION_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
const ALLOWED_FIELDS = new Set(['name', 'description', 'prompt', 'agentPreset', 'mode'])
const BUILTIN_ROLES = new Set(ROLE_NAMES)
const encoder = new TextEncoder()

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function ownDataValue(record, key) {
  if (!isPlainRecord(record)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function normalizeDescription(value, name) {
  if (value === undefined) return undefined
  const label = `userAgents[${name}].description`
  if (typeof value !== 'string' || value.length > MAX_USER_AGENT_DESCRIPTION_BYTES
    || encoder.encode(value).byteLength > MAX_USER_AGENT_DESCRIPTION_BYTES) {
    throw new TypeError(`${label} must be a single-line string of at most ${MAX_USER_AGENT_DESCRIPTION_BYTES} UTF-8 bytes`)
  }
  if (DISALLOWED_DESCRIPTION_CONTROLS.test(value)) {
    throw new TypeError(`${label} must be a single-line string without control or bidi characters`)
  }
  const description = value.trim()
  return description || undefined
}

function normalizePrompt(value, name) {
  const label = `userAgents[${name}].prompt`
  if (typeof value !== 'string') throw new TypeError(`${label} must be a non-empty string`)
  if (value.length > MAX_USER_AGENT_PROMPT_BYTES) {
    throw new TypeError(`${label} must be non-empty and at most ${MAX_USER_AGENT_PROMPT_BYTES} UTF-8 bytes`)
  }
  const rawBytes = encoder.encode(value).byteLength
  if (rawBytes > MAX_USER_AGENT_PROMPT_BYTES) {
    throw new TypeError(`${label} must be non-empty and at most ${MAX_USER_AGENT_PROMPT_BYTES} UTF-8 bytes`)
  }
  const prompt = value.trim()
  if (!prompt) throw new TypeError(`${label} must be a non-empty string`)
  if (DISALLOWED_PROMPT_CONTROLS.test(value)) {
    throw new TypeError(`${label} contains disallowed control or bidi characters`)
  }
  return { prompt, rawBytes }
}

export function normalizeAgentPreset(value, label = 'agentPreset') {
  if (typeof value !== 'string' || value.length > MAX_USER_AGENT_PRESET_BYTES
    || encoder.encode(value).byteLength > MAX_USER_AGENT_PRESET_BYTES) {
    throw new TypeError(`${label} must be a non-empty registered preset reference of at most ${MAX_USER_AGENT_PRESET_BYTES} UTF-8 bytes`)
  }
  if (DISALLOWED_DESCRIPTION_CONTROLS.test(value)) {
    throw new TypeError(`${label} must not contain control or bidi characters`)
  }
  const agentPreset = value.trim()
  if (!agentPreset) throw new TypeError(`${label} must be a non-empty registered preset reference`)
  return agentPreset
}

/** Normalize explicit config-defined subagent personas or registered presets; file-based discovery is intentionally separate. */
export function normalizeUserAgents(value = []) {
  if (!Array.isArray(value)) throw new TypeError('dsh-omo: userAgents must be an array')
  if (value.length > MAX_USER_AGENTS) {
    throw new TypeError(`dsh-omo: userAgents may contain at most ${MAX_USER_AGENTS} definitions`)
  }

  const agents = new Map()
  let totalRawPromptBytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!isPlainRecord(entry)) throw new TypeError(`dsh-omo: userAgents[${index}] must be a plain object`)
    let keys
    try {
      keys = Reflect.ownKeys(entry)
    } catch {
      throw new TypeError(`dsh-omo: userAgents[${index}] must be a plain object`)
    }
    for (const key of keys) {
      if (typeof key !== 'string' || !ALLOWED_FIELDS.has(key)) {
        throw new TypeError(`dsh-omo: userAgents[${index}] contains an unsupported field`)
      }
    }

    const name = ownDataValue(entry, 'name')
    if (typeof name !== 'string' || name.length > MAX_USER_AGENT_NAME_CHARS || !USER_AGENT_NAME.test(name)) {
      throw new TypeError(`dsh-omo: userAgents[${index}].name must match [a-z][a-z0-9-]{0,63}`)
    }
    if (BUILTIN_ROLES.has(name)) throw new TypeError(`dsh-omo: user agent name "${name}" conflicts with a built-in specialist role`)
    if (agents.has(name)) throw new TypeError(`dsh-omo: duplicate user agent "${name}"`)

    const mode = ownDataValue(entry, 'mode')
    if (mode !== undefined && mode !== 'subagent') {
      throw new TypeError(`dsh-omo: userAgents[${name}].mode only supports "subagent"`)
    }
    const description = normalizeDescription(ownDataValue(entry, 'description'), name)
    const promptValue = ownDataValue(entry, 'prompt')
    const agentPresetValue = ownDataValue(entry, 'agentPreset')
    if ((promptValue === undefined) === (agentPresetValue === undefined)) {
      throw new TypeError(`dsh-omo: userAgents[${name}] must define exactly one of prompt or agentPreset`)
    }
    let definition
    if (promptValue !== undefined) {
      const { prompt, rawBytes } = normalizePrompt(promptValue, name)
      totalRawPromptBytes += rawBytes
      if (totalRawPromptBytes > MAX_TOTAL_USER_AGENT_PROMPT_BYTES) {
        throw new TypeError(`dsh-omo: userAgents prompts may not exceed ${MAX_TOTAL_USER_AGENT_PROMPT_BYTES} UTF-8 bytes in total`)
      }
      definition = { prompt }
    } else {
      definition = { agentPreset: normalizeAgentPreset(agentPresetValue, `userAgents[${name}].agentPreset`) }
    }
    agents.set(name, Object.freeze({
      name,
      ...(description !== undefined ? { description } : {}),
      ...definition,
      mode: 'subagent',
    }))
  }
  return agents
}
