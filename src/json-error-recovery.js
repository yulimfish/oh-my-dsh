import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const JSON_ERROR_TOOL_EXCLUDE_LIST = Object.freeze([
  'bash',
  'read',
  'glob',
  'grep',
  'webfetch',
  'look_at',
  'grep_app_searchgithub',
  'websearch_web_search_exa',
  'todowrite',
  'todoread',
  'task',
  'call_omo_agent',
  'background_output',
  'session_read',
  'session_search',
  'session_info',
  'session_list',
  'skill',
  'skill_mcp',
  // DSH-specific content, session, orchestration, and provider tools.
  'web.search',
  'web.fetch',
  'web_search',
  'web_fetch',
  'todo_write',
  'todo_read',
  'dsh_omo_project_agents',
  'dsh_omo_call_agent',
  'dsh_omo_task',
  'dsh_omo_task_continuable',
  'dsh_omo_job_list',
  'dsh_omo_job_follow',
  'dsh_omo_terminal_list',
  'dsh_omo_terminal_spawn',
  'dsh_omo_terminal_read',
  'dsh_omo_terminal_send',
  'dsh_omo_terminal_interrupt',
  'dsh_omo_terminal_close',
  'dsh_omo_plan_checklist',
  'lsp_goto_definition',
  'lsp_find_references',
  'team_membership',
  'team_status',
  'team_members',
  'team_spawn',
  'team_send_message',
  'team_create_task',
  'team_list_tasks',
  'team_get_task',
  'team_update_task',
  'team_wait_for_change',
  'team_interrupt',
])

export const JSON_ERROR_PATTERNS = Object.freeze([
  /json parse error/i,
  /failed to parse json/i,
  /invalid json/i,
  /malformed json/i,
  /unexpected end of json input/i,
  /syntaxerror:\s*unexpected token.*json/i,
  /json[^\n]*expected '\}'/i,
  /json[^\n]*unexpected eof/i,
])

const JSON_ERROR_EXCLUDED_TOOLS = new Set(JSON_ERROR_TOOL_EXCLUDE_LIST)
const JSON_ERROR_REMINDER_MARKER = '[JSON PARSE ERROR - RECOVERY GUIDANCE]'
const MAX_ERROR_MESSAGE_CHARS = 4_096
const MAX_TOOL_NAME_CHARS = 128

export const JSON_ERROR_REMINDER = `${JSON_ERROR_REMINDER_MARKER}

The failed tool execution reported a JSON parse error. Inspect the error message above to determine whether the tool arguments or another JSON payload failed to parse.

1. Identify what the error says was expected versus what was provided.
2. Correct the JSON syntax at the source (for example, braces, quoting, or trailing commas).
3. Retry only after checking the corrected input; do not blindly repeat the same call.
`

function hasJsonParseError(message) {
  if (message.includes(JSON_ERROR_REMINDER_MARKER)) return false
  return JSON_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

/** Adds advisory JSON recovery context for matched DSH Tool failures; never retries or rewrites calls. */
export function createJsonErrorRecoveryListener() {
  return async (exec, result, next) => {
    const decision = await next()
    const toolName = exec?.name
    const errorMessage = result?.error?.message
    if (decision?.kind !== 'accept' || !exec?.signal || exec.signal.aborted
      || typeof toolName !== 'string' || toolName.length > MAX_TOOL_NAME_CHARS
      || JSON_ERROR_EXCLUDED_TOOLS.has(toolName.toLowerCase())
      || result?.isError !== true || typeof errorMessage !== 'string'
      || errorMessage.length > MAX_ERROR_MESSAGE_CHARS || !hasJsonParseError(errorMessage)) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const recoveryContext = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: JSON_ERROR_REMINDER }],
    })
    return { ...decision, additionalContexts: [...previousContexts, recoveryContext] }
  }
}
