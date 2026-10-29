import { createUserMessage } from '@deepseek-ai/dsh-llm'

const MAX_ERROR_MESSAGE_BYTES = 256
const MAX_BLANK_TASK_INSPECTION_CHARS = 256
const MAX_ROLE_ERROR_NAME_CHARS = 256
const MAX_CATEGORY_ERROR_NAME_CHARS = 64
// Role names are identifiers; reject controls, format chars (including bidi controls), and line separators.
const UNSAFE_ROLE_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const ERROR_MESSAGE_ENCODER = new TextEncoder()
const EMPTY_TASK_ERROR = 'Task must not be empty.'
const TASK_TOO_LONG_ERROR = /^Task is (\d+) characters; dsh-omo limit is (\d+)\.$/
const ROLE_UNAVAILABLE_SUFFIX = '" is not available in dsh-omo.'
const TASK_TOOL_NAMES = new Set(['dsh_omo_call_agent', 'dsh_omo_task', 'dsh_omo_task_continuable'])

export const DELEGATE_TASK_ERROR_GUIDANCE = `[DSH task input error — correct the arguments before retrying]

The dsh-omo delegation was rejected before a child started because task text was blank or exceeded the configured maxTaskChars limit. Provide non-whitespace task text within that limit. Do not blindly repeat unchanged arguments; this notice does not retry or launch a one-shot or continuable child.
`

export const DELEGATE_ROLE_ERROR_GUIDANCE = `[DSH task selection error — correct the role before retrying]

The requested specialist role is not available in this configuration. Choose a role currently listed in the Tool's role options. Do not repeat unchanged arguments; this notice does not retry or launch a one-shot or continuable child.
`

export const DELEGATE_CATEGORY_ERROR_GUIDANCE = `[DSH task selection error — correct the explicit category before retrying]

The explicit category is not a configured, enabled option for this task. Choose a category from the Tool's current options; if none are offered, omit the optional category. If omission still errors, the role-default configuration is outside this notice. Do not repeat unchanged arguments; this notice does not retry or launch a one-shot or continuable child.
`

function isTaskInputError(message, task, maxTaskChars) {
  if (typeof task !== 'string') return false
  if (message === EMPTY_TASK_ERROR) {
    return task.length <= MAX_BLANK_TASK_INSPECTION_CHARS && task.trim().length === 0
  }

  const match = TASK_TOO_LONG_ERROR.exec(message)
  return match !== null
    && task.length > maxTaskChars
    && match[1] === String(task.length)
    && match[2] === String(maxTaskChars)
}

function selectionErrorGuidance(message, args) {
  const role = args?.role
  if (typeof role === 'string' && role.length > 0 && role.length <= MAX_ROLE_ERROR_NAME_CHARS
    && !UNSAFE_ROLE_CHARACTERS.test(role)
    && ERROR_MESSAGE_ENCODER.encode(role).byteLength <= MAX_ERROR_MESSAGE_BYTES
    && message === `Specialist role "${role}${ROLE_UNAVAILABLE_SUFFIX}`) {
    return DELEGATE_ROLE_ERROR_GUIDANCE
  }

  const category = args?.category
  if (typeof category !== 'string' || category.length > MAX_CATEGORY_ERROR_NAME_CHARS) return undefined
  const normalized = category.trim()
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  if (message === `unknown explicit category "${normalized}"`
    || message === `disabled explicit category "${normalized}" cannot be used for task delegation`) {
    return DELEGATE_CATEGORY_ERROR_GUIDANCE
  }
  return undefined
}

/**
 * Adds fixed advice only when bounded task-text or selection errors match parsed arguments.
 * Never echoes rejected values, retries, or rewrites a call.
 */
export function createDelegateTaskErrorGuidanceListener(maxTaskChars) {
  if (!Number.isSafeInteger(maxTaskChars) || maxTaskChars < 1) {
    throw new TypeError('maxTaskChars must be a positive safe integer')
  }
  return async (exec, result, next) => {
    const decision = await next()
    const errorMessage = result?.error?.message
    if (decision?.kind !== 'accept' || !exec?.signal || exec.signal.aborted
      || !TASK_TOOL_NAMES.has(exec?.name) || result?.isError !== true
      || typeof errorMessage !== 'string' || errorMessage.length > MAX_ERROR_MESSAGE_BYTES
      || ERROR_MESSAGE_ENCODER.encode(errorMessage).byteLength > MAX_ERROR_MESSAGE_BYTES) return decision

    const args = exec.arguments
    const guidance = isTaskInputError(errorMessage, args?.task, maxTaskChars)
      ? DELEGATE_TASK_ERROR_GUIDANCE
      : selectionErrorGuidance(errorMessage, args)
    if (!guidance) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const guidanceContext = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: guidance }],
    })
    return { ...decision, additionalContexts: [...previousContexts, guidanceContext] }
  }
}
