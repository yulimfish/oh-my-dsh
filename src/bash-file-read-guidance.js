import { createUserMessage } from '@deepseek-ai/dsh-llm'

const MAX_COMMAND_CHARS = 1_024
const FILE_READ_PATTERNS = Object.freeze([
  /^\s*cat\s+(?!-)[^\s|&;]+\s*$/u,
  /^\s*head\s+(-n\s+\d+\s+)?(?!-)[^\s|&;]+\s*$/u,
  /^\s*tail\s+(-n\s+\d+\s+)?(?!-)[^\s|&;]+\s*$/u,
])

export const BASH_FILE_READ_GUIDANCE = `[BASH FILE-READ GUIDANCE]

This simple cat/head/tail file read has completed. Prefer the DSH read Tool for line-numbered file content, and use grep/glob for targeted searches. This guidance is advisory; the Bash call and its native result were not changed.`

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasBashSchema(exec) {
  const schema = exec?.schema
  const parameters = schema?.parameters
  const properties = parameters?.properties
  const required = parameters?.required
  return typeof schema?.name === 'string'
    && schema.name.toLowerCase() === 'bash'
    && parameters?.type === 'object'
    && isRecord(properties)
    && properties.command?.type === 'string'
    && Array.isArray(required)
    && required.includes('command')
}

export function isSimpleBashFileRead(exec) {
  const args = exec?.arguments
  if (typeof exec?.name !== 'string' || exec.name.toLowerCase() !== 'bash'
    || !hasBashSchema(exec) || !isRecord(args)
    || typeof args.command !== 'string' || args.command.length > MAX_COMMAND_CHARS) return false

  return FILE_READ_PATTERNS.some(pattern => pattern.test(args.command))
}

/** Adds fixed advisory context after a simple successful Bash file read; never blocks, retries, or rewrites it. */
export function createBashFileReadGuidanceListener() {
  return async (exec, result, next) => {
    const decision = await next()
    if (decision?.kind !== 'accept' || !exec?.signal || exec.signal.aborted
      || result?.isError !== false || !isSimpleBashFileRead(exec)) return decision

    const previousContexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    const guidanceContext = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: BASH_FILE_READ_GUIDANCE }],
    })
    return { ...decision, additionalContexts: [...previousContexts, guidanceContext] }
  }
}
