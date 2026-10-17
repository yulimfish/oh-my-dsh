import { isAbsolute } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PLAN_FORMAT_WARNING_MESSAGES, readPlanFormatWarnings, validatePlanName } from './plan-checklist.js'

const MAX_FILE_PATH_CHARS = 4_096
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
const FORMAT_WARNINGS = new Set(Object.values(PLAN_FORMAT_WARNING_MESSAGES))

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasVerifiedFilePathSchema(exec) {
  const schema = exec?.schema
  const parameters = schema?.parameters
  const properties = parameters?.properties
  const filePath = properties?.file_path
  return isRecord(schema) && schema.name === exec.name
    && isRecord(parameters) && parameters.type === 'object'
    && isRecord(properties) && isRecord(filePath) && filePath.type === 'string'
    && Array.isArray(parameters.required) && parameters.required.includes('file_path')
}

function looksLikePlanPathCandidate(filePath, fileName) {
  const parts = filePath.split(/[\\/]+/u).filter(part => part !== '' && part !== '.')
  if (parts.length < 3 || parts.at(-3) !== '.omo' || parts.at(-2) !== 'plans' || parts.at(-1) !== fileName) return false
  const absolute = isAbsolute(filePath) || /^[A-Za-z]:[\\/]/u.test(filePath) || /^\\\\/u.test(filePath)
  return absolute || parts.length === 3
}

function safePlanFromExecution(exec) {
  if (!isRecord(exec?.arguments)) return undefined
  const filePath = exec.arguments.file_path
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_FILE_PATH_CHARS
    || CONTROL_OR_BIDI.test(filePath)) return undefined
  const fileName = filePath.split(/[\\/]/u).at(-1)
  if (!fileName || !looksLikePlanPathCandidate(filePath, fileName)) return undefined
  try {
    return { filePath, planName: validatePlanName(fileName) }
  } catch {
    return undefined
  }
}

function formatWarningMessage(warnings) {
  const safeWarnings = warnings.filter(warning => FORMAT_WARNINGS.has(warning)).slice(0, 3)
  if (safeWarnings.length === 0) return undefined
  return `The current OMO plan checklist has formatting warnings:\n${safeWarnings.map(warning => `- ${warning}`).join('\n')}\nThis is advisory only; do not rewrite the plan without an explicit instruction.`
}

/** Adds fixed, read-only format advice only after a verified successful plan write/edit. */
export function createPlanFormatAdvisoryListener(sessionQuery, fs, lifecycleSignal) {
  return async (exec, result, next) => {
    const decision = await next()
    if (decision?.kind !== 'accept' || result?.isError !== false || exec?.signal?.aborted
      || lifecycleSignal?.aborted || !['write', 'edit'].includes(exec?.name)
      || !hasVerifiedFilePathSchema(exec)) return decision

    const plan = safePlanFromExecution(exec)
    if (!plan || !exec.agent?.id) return decision

    try {
      const warnings = await readPlanFormatWarnings(
        sessionQuery, fs, exec.agent, plan.planName, plan.filePath, exec.signal, lifecycleSignal,
      )
      if (exec.signal?.aborted || lifecycleSignal?.aborted) return decision
      const text = formatWarningMessage(warnings)
      if (!text) return decision
      const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
      const context = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      })
      return { ...decision, additionalContexts: [...previousContexts, context] }
    } catch {
      // Advisory-only inspection is fail-open: preserve the accepted Tool outcome.
      return decision
    }
  }
}
