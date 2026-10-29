const MAX_TEXT_CHARS = 65_536
const MAX_COMMAND_NAME_CHARS = 64
const MAX_MESSAGE_BLOCKS = 4_096
const MAX_MESSAGE_IDS = 10_000
const PROCESSED_TTL_MS = 30_000
const CLOSED_FENCE = /```[\s\S]*?```/gu
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

function parseInvocation(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS || !text.trimStart().startsWith('/')) return undefined
  const trimmed = text.trimStart()
  if (trimmed.replace(CLOSED_FENCE, '').trimStart()[0] !== '/') return undefined
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(trimmed)
  const name = match?.[1]
  if (!name || name.length > MAX_COMMAND_NAME_CHARS || !COMMAND_NAME.test(name)) return undefined
  return { name, rawInput: trimmed.slice(match[0].length) }
}

function userText(message) {
  if (!message || typeof message !== 'object' || message.role !== 'user'
    || message.source?.kind !== 'user' || !Array.isArray(message.content)
    || message.content.length === 0 || message.content.length > MAX_MESSAGE_BLOCKS) return undefined
  let text = ''
  for (const block of message.content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return undefined
    if (text.length + block.text.length > MAX_TEXT_CHARS) return undefined
    text += block.text
  }
  return text
}

/**
 * Rewrite only explicitly marked project-command definitions. Unknown commands
 * stay untouched and no command handler/child/shell operation is started.
 */
export function createAutomaticSlashCommandListener({
  commands, resolveProjectCommand, expandCommand, agents, now = Date.now,
}) {
  if (!commands || typeof commands.find !== 'function') throw new TypeError('Automatic slash commands require commands.find')
  if (typeof resolveProjectCommand !== 'function') throw new TypeError('Automatic slash commands require project-command resolution')
  if (typeof now !== 'function') throw new TypeError('Automatic slash commands require a monotonic clock')
  const processed = new Map()
  const pending = new Map()
  const disposedAgents = new WeakSet()
  let disposed = false

  function live(agent) {
    if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string' || disposedAgents.has(agent)) return false
    if (typeof agents?.get !== 'function') return true
    try { return agents.get(agent.id) === agent } catch { return false }
  }
  function alreadyProcessed(agent, id) {
    const timestamp = now()
    for (const [key, record] of processed) {
      if (record.expiresAt <= timestamp) processed.delete(key)
    }
    const record = processed.get(`${agent.id}\0${id}`)
    return record?.agent === agent && record.expiresAt > timestamp
  }
  function markProcessed(agent, id) {
    const timestamp = now()
    processed.set(`${agent.id}\0${id}`, { agent, expiresAt: timestamp + PROCESSED_TTL_MS })
    while (processed.size > MAX_MESSAGE_IDS) processed.delete(processed.keys().next().value)
  }

  async function onPreStep(payload, next) {
    if (typeof next !== 'function') throw new TypeError('agent/pre-step requires next()')
    const inputMessages = payload?.messages
    const inputLatest = Array.isArray(inputMessages) ? inputMessages.at(-1) : undefined
    const inputInvocation = parseInvocation(userText(inputLatest))
    if (inputInvocation === undefined) return next()
    const decision = await next()
    const messages = decision?.kind === 'enter' && Array.isArray(decision.messages) ? decision.messages : undefined
    const latest = messages?.at(-1)
    const invocation = parseInvocation(userText(latest))
    const agent = payload?.agent
    if (!invocation || disposed || !live(agent) || payload.signal?.aborted || typeof latest.id !== 'string') return decision
    const pendingKey = `${agent.id}\0${latest.id}`
    if (alreadyProcessed(agent, latest.id) || pending.get(pendingKey)?.agent === agent) return decision
    let definition
    try { definition = commands.find(agent, invocation.name) } catch { return decision }
    if (!definition || definition.automatic === false) return decision
    let projectCommand
    try {
      projectCommand = resolveProjectCommand(agent, definition)
    } catch { return decision }
    if (!projectCommand) return decision
    const state = { agent, id: latest.id, definition, projectCommand }
    pending.set(pendingKey, state)
    try {
      let rendered
      if (expandCommand) {
        const expanded = await expandCommand(projectCommand, { agent, signal: payload.signal })
        const { renderExpandedProjectCommand } = await import('./project-commands.js')
        rendered = renderExpandedProjectCommand(projectCommand, expanded.body, invocation.rawInput)
      } else {
        const { renderProjectCommand } = await import('./project-commands.js')
        rendered = renderProjectCommand(projectCommand, invocation.rawInput)
      }
      if (disposed || !live(agent) || payload.signal?.aborted || pending.get(pendingKey) !== state) return decision
      let currentDefinition
      try { currentDefinition = commands.find(agent, invocation.name) } catch { return decision }
      if (currentDefinition !== definition && currentDefinition?.handler !== definition.handler) return decision
      try {
        if (!resolveProjectCommand(agent, currentDefinition)) return decision
      } catch { return decision }
      markProcessed(agent, latest.id)
      return { ...decision, messages: [...messages.slice(0, -1), { ...latest, content: [{ type: 'text', text: rendered }] }] }
    } catch {
      return decision
    } finally {
      if (pending.get(pendingKey) === state) pending.delete(pendingKey)
    }
  }

  onPreStep.clearAgent = agent => { if (agent && typeof agent === 'object') disposedAgents.add(agent) }
  onPreStep.dispose = () => {
    disposed = true
    processed.clear()
  }
  return onPreStep
}
