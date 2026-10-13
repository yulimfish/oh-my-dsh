import { defineTool } from '@deepseek-ai/dsh-tools'

const MAX_NAME = 128
const MAX_PROVIDER = 128
const MAX_DESCRIPTION = 8_000
const MAX_SUBJECT = 240
const MAX_TASK_ID = 128
const MAX_WRITE_SCOPE = 512
const MAX_CONTENT_BLOCKS = 32
const MAX_CONTENT_TEXT = 16_000
const MAX_CONTENT_JSON_CHARS = 64_000
const MAX_MEMBERS = 100
const MAX_TASKS = 100
const MAX_DIAGNOSTICS = 8
const MAX_DIAGNOSTIC_CHARS = 400
const MAX_MEMBER_DESCRIPTION_CHARS = 1_000
const MAX_TASK_SUBJECT_CHARS = 160
const MAX_TASK_DESCRIPTION_CHARS = 1_200
const MAX_BLOCKED_BY = 12
const MAX_WRITE_SCOPES = 12
const MAX_WRITE_SCOPE_WARNINGS = 8
const MAX_WRITE_SCOPE_WARNING_CHARS = 500
const MAX_OUTPUT_CHARS = 48_000
const MAX_WAIT_MS = 3_600_000
const WAIT_TOOL_TIMEOUT_MS = MAX_WAIT_MS + 30_000
const ACTIONS = ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']
const ROLES = ['lead', 'teammate']
const MEMBER_STATUSES = ['running', 'inactive', 'provisioning', 'failed']
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted']

const str = { type: 'string' }
const stringArray = { type: 'array', items: str }

function objectSchema(properties) {
  return { type: 'object', additionalProperties: false, properties }
}

function memberSchema() {
  return objectSchema({
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    role: { type: 'string', enum: ROLES, required: true },
    status: { type: 'string', enum: MEMBER_STATUSES, required: true },
    diagnostics: { type: 'array', items: str, required: true },
    diagnosticsTruncated: { type: 'boolean', required: true },
    description: str,
    provider: str,
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: str,
  })
}

function taskSchema() {
  return objectSchema({
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', enum: TASK_STATUSES, required: true },
    blockedBy: { type: 'array', items: str, required: true },
    blockedByTruncated: { type: 'boolean', required: true },
    writeScopes: { type: 'array', items: str, required: true },
    writeScopesTruncated: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', items: str, required: true },
    writeScopeWarningsTruncated: { type: 'boolean', required: true },
    ownerName: str,
    ready: { type: 'boolean', required: true },
  })
}

const member = memberSchema()
const task = taskSchema()
const textContentBlocks = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: { type: { type: 'string', required: true } },
  },
}

function boundedString(value, label, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || value.length > max) {
    throw new TypeError(`${label} must be a ${allowEmpty ? '' : 'non-empty '}string of at most ${max} characters`)
  }
  return value
}

function outputString(value, label, max) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function outputStringArray(value, label, maxItems, maxChars) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  const count = Math.min(value.length, maxItems)
  const values = []
  for (let index = 0; index < count; index += 1) {
    values.push(outputString(value[index], `${label}[${index}]`, maxChars))
  }
  return { values, truncated: value.length > count }
}

function boundedIdentifier(value, label = 'id') {
  return boundedString(value, label, MAX_TASK_ID)
}

function boundedStringArray(value, label, maxItems, maxChars) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${label} must be an array of at most ${maxItems} strings`)
  }
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, maxChars))
}

function optionalStringArray(value, label, maxItems, maxChars) {
  return value === undefined ? undefined : boundedStringArray(value, label, maxItems, maxChars)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function validateContent(content, label) {
  if (!Array.isArray(content) || content.length < 1 || content.length > MAX_CONTENT_BLOCKS) {
    throw new TypeError(`${label} must contain 1 to ${MAX_CONTENT_BLOCKS} content blocks`)
  }
  let serialized
  try {
    serialized = JSON.stringify(content)
  } catch {
    throw new TypeError(`${label} must contain JSON-serializable content blocks`)
  }
  if (typeof serialized !== 'string' || serialized.length > MAX_CONTENT_JSON_CHARS) {
    throw new TypeError(`${label} must be at most ${MAX_CONTENT_JSON_CHARS} serialized characters`)
  }

  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]
    if (!isRecord(block) || typeof block.type !== 'string' || block.type.trim().length === 0) {
      throw new TypeError(`${label}[${index}] must be a content-block object with a type`)
    }
    if (block.type === 'text' || block.type === 'reasoning') {
      boundedString(block.text, `${label}[${index}].text`, MAX_CONTENT_TEXT, { allowEmpty: true })
    } else if (block.type === 'image') {
      const ref = block.attachment
      if (!isRecord(ref) || typeof ref.attachmentId !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || !Number.isSafeInteger(ref.width) || ref.width < 1
        || !Number.isSafeInteger(ref.height) || ref.height < 1 || (block.offloaded !== undefined && block.offloaded !== true)) {
        throw new TypeError(`${label}[${index}] must contain a valid durable image attachment reference`)
      }
    } else if (block.type === 'file') {
      const ref = block.attachment
      if (!isRecord(ref) || typeof ref.attachmentId !== 'string' || typeof ref.name !== 'string'
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
        throw new TypeError(`${label}[${index}] must contain a valid durable file attachment reference`)
      }
    } else if (block.type === 'tool-call') {
      boundedString(block.id, `${label}[${index}].id`, MAX_TASK_ID)
      boundedString(block.name, `${label}[${index}].name`, MAX_NAME)
      boundedString(block.arguments, `${label}[${index}].arguments`, MAX_CONTENT_TEXT, { allowEmpty: true })
    } else if (block.type === 'tool-addition' || block.type === 'tool-removal') {
      boundedString(block.toolName, `${label}[${index}].toolName`, MAX_NAME)
    } else {
      throw new TypeError(`${label}[${index}] has unsupported content block type "${block.type.slice(0, 80)}"`)
    }
  }
  return content
}

function requireAgent(exec) {
  if (!exec || !exec.agent) throw new Error('Team tools require an active agent.')
  return exec.agent
}

function requireSignal(exec) {
  const signal = exec?.signal
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
    throw new Error('Team operation requires the DSH execution AbortSignal.')
  }
  return signal
}

function readString(source, key, label, max = MAX_NAME, options) {
  return boundedString(source?.[key], label, max, options)
}

function safeJson(value, label = 'Team tool output') {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new TypeError(`${label} is not JSON-serializable`)
  }
  if (typeof serialized !== 'string' || serialized.length > MAX_OUTPUT_CHARS) {
    throw new RangeError(`${label} exceeds the ${MAX_OUTPUT_CHARS}-character output bound`)
  }
  return value
}

function projectMember(source) {
  if (!isRecord(source)) throw new TypeError('Team service returned an invalid member view')
  const result = {
    id: boundedIdentifier(source.id, 'member id'),
    name: boundedString(source.name, 'member name', MAX_NAME),
    role: source.role,
    status: source.status,
    diagnostics: [],
    diagnosticsTruncated: false,
  }
  if (!ROLES.includes(result.role) || !MEMBER_STATUSES.includes(result.status)) {
    throw new TypeError('Team service returned an invalid member role or status')
  }
  if (source.description !== undefined) result.description = outputString(source.description, 'member description', MAX_MEMBER_DESCRIPTION_CHARS)
  if (source.provider !== undefined) result.provider = outputString(source.provider, 'member provider', MAX_PROVIDER)
  if (source.context !== undefined) {
    if (!['fresh', 'fork'].includes(source.context)) throw new TypeError('Team service returned an invalid member context')
    result.context = source.context
  }
  if (source.model !== undefined) result.model = outputString(source.model, 'member model', MAX_PROVIDER)
  const diagnostics = outputStringArray(source.diagnostics, 'member diagnostics', MAX_DIAGNOSTICS, MAX_DIAGNOSTIC_CHARS)
  result.diagnostics = diagnostics.values
  result.diagnosticsTruncated = diagnostics.truncated
  return result
}

function projectTask(source) {
  if (!isRecord(source)) throw new TypeError('Team service returned an invalid task view')
  if (!Number.isSafeInteger(source.revision) || source.revision < 1) throw new TypeError('Team service returned an invalid task revision')
  if (!TASK_STATUSES.includes(source.status)) throw new TypeError('Team service returned an invalid task status')
  if (typeof source.ready !== 'boolean') throw new TypeError('Team service returned an invalid task readiness value')
  const blockedBy = outputStringArray(source.blockedBy, 'task blockedBy', MAX_BLOCKED_BY, MAX_TASK_ID)
  const writeScopes = outputStringArray(source.writeScopes, 'task writeScopes', MAX_WRITE_SCOPES, MAX_WRITE_SCOPE)
  const warnings = outputStringArray(source.writeScopeWarnings, 'task writeScopeWarnings', MAX_WRITE_SCOPE_WARNINGS, MAX_WRITE_SCOPE_WARNING_CHARS)
  const result = {
    id: boundedIdentifier(source.id, 'task id'),
    revision: source.revision,
    subject: outputString(source.subject, 'task subject', MAX_TASK_SUBJECT_CHARS),
    description: outputString(source.description, 'task description', MAX_TASK_DESCRIPTION_CHARS),
    status: source.status,
    blockedBy: blockedBy.values,
    blockedByTruncated: blockedBy.truncated,
    writeScopes: writeScopes.values,
    writeScopesTruncated: writeScopes.truncated,
    writeScopeWarnings: warnings.values,
    writeScopeWarningsTruncated: warnings.truncated,
    ready: source.ready,
  }
  if (source.ownerName !== undefined) result.ownerName = outputString(source.ownerName, 'task ownerName', MAX_NAME)
  return result
}

function projectList(value, property, projector, maxItems) {
  if (!Array.isArray(value)) throw new TypeError(`Team service returned an invalid ${property} list`)
  const scanLimit = Math.min(value.length, maxItems)
  const items = []
  let truncated = value.length > scanLimit

  for (let index = 0; index < scanLimit; index += 1) {
    const item = projector(value[index])
    const nextItems = [...items, item]
    const hasMore = truncated || index + 1 < value.length
    const candidate = { [property]: nextItems, truncated: hasMore }
    if (JSON.stringify(candidate).length > MAX_OUTPUT_CHARS) {
      truncated = true
      break
    }
    items.push(item)
  }

  if (items.length < value.length) truncated = true
  return { [property]: items, truncated }
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function teamTool({ name, description, parameters, outputSchema, timeoutMs = 30_000, execute }) {
  return defineTool({
    name,
    description,
    parameters,
    output: { schema: outputSchema, render: renderJson },
    timeoutMs,
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const result = await execute(args, exec, caller)
      return safeJson(result)
    },
  })
}

const tools = [
  service => teamTool({
    name: 'team_membership',
    description: 'Return the Host agentTeams membership for the exact active agent. The Host service is authoritative for Team identity and role.',
    parameters: {},
    outputSchema: objectSchema({
      teamId: { type: 'string', required: true },
      rootAgentId: { type: 'string', required: true },
      role: { type: 'string', enum: ROLES, required: true },
      name: { type: 'string', required: true },
    }),
    execute: (_args, _exec, caller) => {
      const value = service.membership(caller)
      if (!isRecord(value) || !isRecord(value.root) || !ROLES.includes(value.role)) {
        throw new TypeError('Team service returned an invalid membership')
      }
      return {
        teamId: boundedIdentifier(value.id, 'team id'),
        rootAgentId: boundedIdentifier(value.root.id, 'root agent id'),
        role: value.role,
        name: boundedString(value.name, 'team member name', MAX_NAME),
      }
    },
  }),
  service => teamTool({
    name: 'team_members',
    description: 'List Host agentTeams roster rows visible to the exact active agent. The Host service is authoritative; results are capped at 100 rows and explicitly flag truncation.',
    parameters: {},
    outputSchema: objectSchema({
      members: { type: 'array', items: member, required: true },
      truncated: { type: 'boolean', required: true },
    }),
    execute: (_args, _exec, caller) => projectList(service.listMembers(caller), 'members', projectMember, MAX_MEMBERS),
  }),
  service => teamTool({
    name: 'team_spawn',
    description: 'Ask the Host agentTeams service to create a named direct teammate. The service owns authorization and creation. Interrupting a teammate only signals its current turn and does not guarantee termination.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique, non-empty teammate name.' },
      description: { type: 'string', required: true, description: 'Short teammate role description.' },
      prompt: { ...textContentBlocks, required: true, description: 'Prompt ContentBlock array.' },
      context: { type: 'string', enum: ['fresh', 'fork'], required: true, description: 'Whether to start fresh or fork context.' },
      provider: { type: 'string', required: true, description: 'DSH provider name.' },
    },
    outputSchema: objectSchema({ member: { ...member, required: true } }),
    execute: async (args, exec, caller) => {
      const request = {
        name: readString(args, 'name', 'name', MAX_NAME),
        description: boundedString(args.description, 'description', MAX_DESCRIPTION, { allowEmpty: true }),
        prompt: validateContent(args.prompt, 'prompt'),
        context: args.context,
        provider: boundedString(args.provider, 'provider', MAX_PROVIDER),
        signal: requireSignal(exec),
      }
      if (!['fresh', 'fork'].includes(request.context)) throw new TypeError('context must be fresh or fork')
      const value = await service.spawnTeammate(caller, request)
      if (!isRecord(value) || !('member' in value)) throw new TypeError('Team service returned an invalid spawn result')
      return { member: projectMember(value.member) }
    },
  }),
  service => teamTool({
    name: 'team_send_message',
    description: 'Queue a durable Host agentTeams peer message and surface the Host status exactly as reported (`accepted` or `queued`); neither status is reinterpreted as guaranteed delivery.',
    parameters: {
      target: { type: 'string', required: true, description: 'Durable teammate name.' },
      content: { ...textContentBlocks, required: true, description: 'Message ContentBlock array.' },
    },
    outputSchema: objectSchema({
      messageId: { type: 'string', required: true },
      status: { type: 'string', enum: ['accepted', 'queued'], required: true },
    }),
    execute: async (args, exec, caller) => {
      const request = {
        target: readString(args, 'target', 'target', MAX_NAME),
        content: validateContent(args.content, 'content'),
        signal: requireSignal(exec),
      }
      const value = await service.sendMessage(caller, request)
      if (!isRecord(value) || !['accepted', 'queued'].includes(value.status)) {
        throw new TypeError('Team service returned an invalid message result')
      }
      return { messageId: boundedIdentifier(value.messageId, 'message id'), status: value.status }
    },
  }),
  service => teamTool({
    name: 'team_create_task',
    description: 'Create a Host agentTeams task. writeScopes are advisory metadata only, not file locks or security boundaries; the Host service remains authoritative for permissions and task state.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Short task subject.' },
      description: { type: 'string', required: true, description: 'Task details.' },
      blockedBy: stringArray,
      writeScopes: { type: 'array', items: { type: 'string' }, description: 'Advisory path hints only; not file locks or security boundaries.' },
    },
    outputSchema: objectSchema({ task: { ...task, required: true } }),
    execute: async (args, _exec, caller) => {
      const request = {
        subject: boundedString(args.subject, 'subject', MAX_SUBJECT),
        description: boundedString(args.description, 'description', MAX_DESCRIPTION, { allowEmpty: true }),
      }
      const blockedBy = optionalStringArray(args.blockedBy, 'blockedBy', 100, MAX_TASK_ID)
      const writeScopes = optionalStringArray(args.writeScopes, 'writeScopes', MAX_WRITE_SCOPES, MAX_WRITE_SCOPE)
      if (blockedBy !== undefined) request.blockedBy = blockedBy
      if (writeScopes !== undefined) request.writeScopes = writeScopes
      return { task: projectTask(await service.createTask(caller, request)) }
    },
  }),
  service => teamTool({
    name: 'team_list_tasks',
    description: 'List current Host agentTeams tasks. writeScopes are advisory metadata only, not file locks or security boundaries. Results are capped at 100 tasks and explicitly flag truncation.',
    parameters: {},
    outputSchema: objectSchema({
      tasks: { type: 'array', items: task, required: true },
      truncated: { type: 'boolean', required: true },
    }),
    execute: (_args, _exec, caller) => projectList(service.listTasks(caller), 'tasks', projectTask, MAX_TASKS),
  }),
  service => teamTool({
    name: 'team_get_task',
    description: 'Read one Host agentTeams task by its Team-local id, including the Host service’s tombstone when applicable. writeScopes are advisory metadata, not file locks or security boundaries.',
    parameters: { id: { type: 'string', required: true, description: 'Team-local task id.' } },
    outputSchema: objectSchema({ task: { ...task, required: true } }),
    execute: (_args, _exec, caller) => ({ task: projectTask(service.getTask(caller, boundedIdentifier(_args.id, 'id'))) }),
  }),
  service => teamTool({
    name: 'team_update_task',
    description: 'Request one compare-and-set task action through Host agentTeams using expectedRevision. The Host service owns authorization and conflict behavior. writeScopes are advisory metadata only, not file locks or security boundaries.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Team-local task id.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact revision to compare-and-set.' },
      action: { type: 'string', enum: ACTIONS, required: true, description: 'Host-supported task transition.' },
      subject: { type: 'string', description: 'New subject for an edit action.' },
      description: { type: 'string', description: 'New description for an edit action.' },
      blockedBy: stringArray,
      writeScopes: { type: 'array', items: { type: 'string' }, description: 'Advisory path hints only; not file locks or security boundaries.' },
      owner: { type: 'string', description: 'Owner name for a reassign action.' },
    },
    outputSchema: objectSchema({ task: { ...task, required: true } }),
    execute: async (args, _exec, caller) => {
      if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) {
        throw new TypeError('expectedRevision must be a positive safe integer')
      }
      if (!ACTIONS.includes(args.action)) throw new TypeError('action is not supported')
      const request = {
        taskId: boundedIdentifier(args.taskId, 'taskId'),
        expectedRevision: args.expectedRevision,
        action: args.action,
      }
      if (args.subject !== undefined) request.subject = boundedString(args.subject, 'subject', MAX_SUBJECT, { allowEmpty: true })
      if (args.description !== undefined) request.description = boundedString(args.description, 'description', MAX_DESCRIPTION, { allowEmpty: true })
      const blockedBy = optionalStringArray(args.blockedBy, 'blockedBy', 100, MAX_TASK_ID)
      const writeScopes = optionalStringArray(args.writeScopes, 'writeScopes', MAX_WRITE_SCOPES, MAX_WRITE_SCOPE)
      if (blockedBy !== undefined) request.blockedBy = blockedBy
      if (writeScopes !== undefined) request.writeScopes = writeScopes
      if (args.owner !== undefined) request.owner = boundedString(args.owner, 'owner', MAX_NAME)
      return { task: projectTask(await service.updateTask(caller, request)) }
    },
  }),
  service => teamTool({
    name: 'team_wait_for_change',
    description: 'Wait for a Host agentTeams change. timeoutMs must be between 10 seconds and one hour; cancellation is passed to the Host wait service.',
    parameters: {
      timeoutMs: { type: 'integer', required: true, description: 'Bounded wait duration in milliseconds: 10000 through 3600000.' },
    },
    outputSchema: objectSchema({ timedOut: { type: 'boolean', required: true } }),
    timeoutMs: WAIT_TOOL_TIMEOUT_MS,
    execute: async (args, exec, caller) => {
      if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 10_000 || args.timeoutMs > MAX_WAIT_MS) {
        throw new TypeError('timeoutMs must be an integer from 10000 through 3600000')
      }
      const value = await service.waitForChange(caller, args.timeoutMs, requireSignal(exec))
      if (!isRecord(value) || typeof value.timedOut !== 'boolean') throw new TypeError('Team service returned an invalid wait result')
      return { timedOut: value.timedOut }
    },
  }),
  service => teamTool({
    name: 'team_interrupt',
    description: 'Ask Host agentTeams to interrupt a named teammate. This only signals a turn and does not guarantee termination; the reported value is only the target status sampled before the signal.',
    parameters: { targetName: { type: 'string', required: true, description: 'Durable teammate name.' } },
    outputSchema: objectSchema({ previousStatus: { type: 'string', enum: ['running', 'inactive'], required: true } }),
    execute: (_args, _exec, caller) => {
      const value = service.interrupt(caller, readString(_args, 'targetName', 'targetName', MAX_NAME))
      if (!isRecord(value) || !['running', 'inactive'].includes(value.previousStatus)) {
        throw new TypeError('Team service returned an invalid interrupt result')
      }
      return { previousStatus: value.previousStatus }
    },
  }),
]

const SERVICE_METHODS = [
  'membership', 'listMembers', 'spawnTeammate', 'sendMessage', 'createTask',
  'getTask', 'listTasks', 'updateTask', 'waitForChange', 'interrupt',
]

/**
 * Register the standalone DSH Agent Teams adapter. No service means the optional
 * integration is unavailable and installs no tools. The Host service remains
 * the authority for membership, authorization, persistence, and state changes.
 */
export function registerTeamTools(ctx, teamService) {
  const service = teamService === undefined
    ? (typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined)
    : teamService
  if (service === undefined || service === null) return () => {}
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    throw new TypeError('registerTeamTools requires ctx.tools.register')
  }
  for (const method of SERVICE_METHODS) {
    if (typeof service[method] !== 'function') throw new TypeError(`agentTeams service is missing ${method}()`)
  }

  const disposers = []
  try {
    for (const create of tools) {
      const dispose = ctx.tools.register(create(service))
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Preserve the original registration failure after best-effort rollback.
      }
    }
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const failures = []
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'one or more Agent Teams tools could not be disposed')
  }
}
