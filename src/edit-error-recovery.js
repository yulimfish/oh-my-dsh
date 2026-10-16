import { createUserMessage } from '@deepseek-ai/dsh-llm'

const EDIT_ERROR_PATTERNS = Object.freeze([
  'oldString and newString must be different',
  'oldString not found',
  'oldString found multiple times',
])
const MAX_ERROR_MESSAGE_CHARS = 4_096

export const EDIT_ERROR_RECOVERY_REMINDER = `[EDIT ERROR - IMMEDIATE ACTION REQUIRED]

You made an Edit mistake. STOP and do this NOW:

1. READ the file immediately to see its ACTUAL current state
2. VERIFY what the content really looks like (your assumption was wrong)
3. APOLOGIZE briefly to the user for the error
4. CONTINUE with corrected action based on the real file content

DO NOT attempt another edit until you've read and verified the file state.`

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasEditSchema(exec) {
  const schema = exec?.schema
  const parameters = schema?.parameters
  const properties = parameters?.properties
  const required = parameters?.required
  if (typeof schema?.name !== 'string' || schema.name.toLowerCase() !== 'edit'
    || parameters?.type !== 'object' || !isRecord(properties) || !Array.isArray(required)) return false

  return ['file_path', 'old_string', 'new_string'].every(name => (
    properties[name]?.type === 'string' && required.includes(name)
  ))
}

function hasEditArguments(argumentsValue) {
  if (!isRecord(argumentsValue)) return false
  if (typeof argumentsValue.file_path !== 'string'
    || typeof argumentsValue.old_string !== 'string'
    || typeof argumentsValue.new_string !== 'string') return false
  return !Object.hasOwn(argumentsValue, 'replace_all') || typeof argumentsValue.replace_all === 'boolean'
}

function isRecoverableEditFailure(exec, result) {
  if (typeof exec?.name !== 'string' || exec.name.toLowerCase() !== 'edit'
    || !hasEditSchema(exec) || !hasEditArguments(exec.arguments)) return false
  if (result?.isError !== true || typeof result.error?.message !== 'string'
    || result.error.message.length > MAX_ERROR_MESSAGE_CHARS) return false
  const errorMessage = result.error.message.toLowerCase()
  return EDIT_ERROR_PATTERNS.some(pattern => errorMessage.includes(pattern.toLowerCase()))
}

/** Adds advisory recovery context for a verified DSH Edit failure; never retries or rewrites the call. */
export function createEditErrorRecoveryListener() {
  return async (exec, result, next) => {
    const decision = await next()
    if (decision?.kind !== 'accept' || !exec?.signal || exec.signal.aborted
      || !isRecoverableEditFailure(exec, result)) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const recoveryContext = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: EDIT_ERROR_RECOVERY_REMINDER }],
    })
    return { ...decision, additionalContexts: [...previousContexts, recoveryContext] }
  }
}
