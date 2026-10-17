import { createUserMessage } from '@deepseek-ai/dsh-llm'

const MAX_ERROR_MESSAGE_BYTES = 256
const MAX_BLANK_TASK_INSPECTION_CHARS = 256
const ERROR_MESSAGE_ENCODER = new TextEncoder()
const EMPTY_TASK_ERROR = 'Task must not be empty.'
const TASK_TOO_LONG_ERROR = /^Task is (\d+) characters; dsh-omo limit is (\d+)\.$/
const TASK_TOOL_NAMES = new Set(['dsh_omo_task', 'dsh_omo_task_continuable'])

export const DELEGATE_TASK_ERROR_GUIDANCE = `[DSH task input error — correct the arguments before retrying]

The dsh-omo delegation was rejected before a child started because task text was blank or exceeded the configured maxTaskChars limit. Provide non-whitespace task text within that limit. Do not blindly repeat unchanged arguments; this notice does not retry or launch a one-shot or continuable child.
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

/**
 * Adds fixed advice only when exact task-text errors agree with parsed arguments and config.
 * Never retries or rewrites a call.
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
      || ERROR_MESSAGE_ENCODER.encode(errorMessage).byteLength > MAX_ERROR_MESSAGE_BYTES
      || !isTaskInputError(errorMessage, exec.arguments?.task, maxTaskChars)) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const guidanceContext = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: DELEGATE_TASK_ERROR_GUIDANCE }],
    })
    return { ...decision, additionalContexts: [...previousContexts, guidanceContext] }
  }
}
