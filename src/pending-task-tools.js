import { defineTool } from '@deepseek-ai/dsh-tools'
import { PENDING_TASK_ID_PREFIX } from './pending-task-registry.js'

const MAX_AGENT_ID_CHARS = 256
const MAX_TASK_ID_CHARS = 256
const STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled', 'expired'])

function isAgent(agent) {
  return agent !== null && typeof agent === 'object'
    && typeof agent.id === 'string' && agent.id.length > 0 && agent.id.length <= MAX_AGENT_ID_CHARS
}

function isTaskId(taskId) {
  return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= MAX_TASK_ID_CHARS
    && taskId.startsWith(PENDING_TASK_ID_PREFIX)
}

function validateTaskId(args, toolName) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => key !== 'taskId') || !isTaskId(args.taskId)) {
    throw new Error(`${toolName} requires one bounded pending taskId returned by dsh_omo_task.`)
  }
  return args.taskId
}

function requireParent(exec, toolName) {
  if (!isAgent(exec?.agent)) throw new Error(`${toolName} requires the exact calling Agent.`)
  if (exec?.signal?.aborted) throw new Error(`${toolName} was cancelled before it ran.`)
  return exec.agent
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    status: { type: 'string', enum: [...STATUSES], required: true },
  },
}

/** Read one bounded pending task record for the exact calling Agent. */
export function createPendingTaskStatusTool(registry) {
  if (!registry || typeof registry.read !== 'function') throw new TypeError('pending task status Tool requires a pending registry')
  return defineTool({
    name: 'dsh_omo_task_pending_status',
    description: 'Read the lifecycle status of one pending task owned by this exact Agent. Pending IDs are separate from child IDs; this process-local Tool does not expose child IDs or child output.',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: 'The pending taskId returned by dsh_omo_task, not a childId.',
      },
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Pending task ${JSON.stringify(value.taskId)} status: ${value.status}. This is process-local lifecycle metadata, not a childId or child output.`,
      }],
    },
    execute(args, exec) {
      const parent = requireParent(exec, 'dsh_omo_task_pending_status')
      const taskId = validateTaskId(args, 'dsh_omo_task_pending_status')
      const record = registry.read(parent, taskId)
      if (!record || record.id !== taskId || !STATUSES.has(record.status)) {
        throw new Error('No unexpired pending task record is tracked for this exact Agent and ID.')
      }
      return { taskId: record.id, status: record.status }
    },
  })
}

/** Cancel queued work or request interruption of a bound pending child by pending ID. */
export function createPendingTaskCancelTool(scheduler) {
  if (!scheduler || typeof scheduler.cancel !== 'function') throw new TypeError('pending task cancel Tool requires a pending scheduler')
  return defineTool({
    name: 'dsh_omo_task_pending_cancel',
    description: 'Cancel queued/starting work or request fire-and-return interruption of a bound child for this exact Agent when DSH supports it. Requests do not prove the child stopped.',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: 'The pending taskId returned by dsh_omo_task, not a childId.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', enum: ['cancelled', 'interrupt-requested'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'interrupt-requested'
          ? `DSH interruption was requested for pending task ${JSON.stringify(value.taskId)}. The child may continue until it observes the request; check pending status or later settlement before relying on completion.`
          : `Pending task ${JSON.stringify(value.taskId)} was cancelled. If startup had begun, Host may already have accepted a child; cleanup was attempted where available, but this does not prove the child stopped.`,
      }],
    },
    execute(args, exec) {
      const parent = requireParent(exec, 'dsh_omo_task_pending_cancel')
      const taskId = validateTaskId(args, 'dsh_omo_task_pending_cancel')
      let record
      try { record = scheduler.cancel(parent, taskId) } catch {
        throw new Error('DSH did not accept pending-task cancellation/interruption; inspect its status before retrying.')
      }
      if (!record || record.id !== taskId || !['cancelled', 'interrupt-requested'].includes(record.status)) {
        throw new Error('No queued/starting task can be cancelled and no supported bound-child interruption was accepted for this exact Agent and ID; it may be terminal, expired, stale, already bound without DSH interruption support, or complete.')
      }
      return { taskId: record.id, status: record.status }
    },
  })
}
