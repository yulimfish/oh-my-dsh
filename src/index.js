import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildWorkerPrompt, ROLE_NAMES } from './roles.js'
import { SKILLS } from './skills.js'

export const name = 'dsh-omo'
export const inject = ['tools', 'subagents', 'systemPrompt', 'commands', 'skills']

const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_DEPTH = 1
const DEFAULT_MAX_TASK_CHARS = 12_000

export const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  maxConcurrent: z.number().default(DEFAULT_MAX_CONCURRENT),
  maxDepth: z.number().default(DEFAULT_MAX_DEPTH),
  maxTaskChars: z.number().default(DEFAULT_MAX_TASK_CHARS),
  maxResultChars: z.number().default(8_000),
  roleRoutes: z.array(z.object({
    role: z.string().required(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    maxTokens: z.number(),
    allowTools: z.array(z.string()),
  })).default([]),
})

const ULTRAWORK_GUIDANCE = `## Specialist orchestration

You can delegate focused work with the **dsh_omo_task** tool. Its roles are: ${ROLE_NAMES.join(', ')}. Use independent specialists for separable exploration, documentation research, architecture advice, implementation, testing, and review; do not delegate duplicate work. You own the parent task, merge decisions, and final verification.

When the user says **ultrawork**, **ulw**, or requests a substantial multi-step change:
1. Clarify only material ambiguity; form a short dependency-aware plan using the native DSH task/todo tools.
2. Delegate independent investigations or changes in parallel, each with a bounded deliverable. Keep one owner for integration.
3. Inspect every worker's evidence and diff; do not accept a worker's completion claim as verification.
4. Run the relevant project checks yourself (or have a test worker provide exact command output), fix failures, and report what was and was not verified.

Use the **reviewer** or **security** role for read-only reviews. A role is a work prompt, not a security boundary: all filesystem, shell, network, approval, and sandbox policy remains controlled by DeepSeek Harness. A role-specific route and tool allowlist apply only when explicitly configured.`

function assertPositiveInteger(field, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-omo: ${field} must be a positive safe integer`)
  }
}

function normalizeRoleRoutes(routes) {
  const result = new Map()
  for (const entry of routes) {
    if (!ROLE_NAMES.includes(entry.role)) {
      throw new Error(`dsh-omo: unknown role route "${entry.role}"`)
    }
    if (result.has(entry.role)) throw new Error(`dsh-omo: duplicate role route "${entry.role}"`)
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (Boolean(provider) !== Boolean(model)) {
      throw new Error(`dsh-omo: role route "${entry.role}" must set provider and model together`)
    }
    if (entry.maxTokens !== undefined && (!Number.isSafeInteger(entry.maxTokens) || entry.maxTokens < 1)) {
      throw new Error(`dsh-omo: role route "${entry.role}" maxTokens must be a positive safe integer`)
    }
    if (entry.allowTools !== undefined && (!Array.isArray(entry.allowTools) || entry.allowTools.some(tool => typeof tool !== 'string' || tool.trim().length === 0))) {
      throw new Error(`dsh-omo: role route "${entry.role}" allowTools must contain non-empty tool names`)
    }
    const allowTools = entry.allowTools === undefined
      ? undefined
      : Object.freeze([...new Set(entry.allowTools.map(tool => tool.trim()))])
    result.set(entry.role, Object.freeze({
      ...entry,
      ...(provider ? { provider, model } : {}),
      ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort.trim() } : {}),
      ...(allowTools ? { allowTools } : {}),
    }))
  }
  return result
}

function queueParentMessage(parent, text) {
  parent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function safeErrorName(error) {
  try {
    return error instanceof Error && typeof error.name === 'string' ? error.name.slice(0, 80) : 'UnknownError'
  } catch {
    return 'UnknownError'
  }
}

function childOutputText(result, maxChars) {
  const sections = []
  for (const block of result.output ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') sections.push(block.text)
    else sections.push(`[${String(block.type ?? 'non-text')} result block omitted]`)
  }
  const text = sections.join('\n\n').trim() || '(No assistant text was returned.)'
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[Output truncated by dsh-omo at ${maxChars} characters.]`
}

async function settleBackgroundChild({ run, role, task, parent, ctx, activeChildren, activeRuns, lifecycle, maxResultChars }) {
  const taskSummary = task.trim().replace(/\s+/gu, ' ').slice(0, 240)
  try {
    const result = await run.result
    if (!lifecycle.disposed) {
      const details = childOutputText(result, maxResultChars)
      const diagnostic = result.diagnostic ? `\nDiagnostic: ${result.diagnostic.slice(0, 1_000)}` : ''
      queueParentMessage(parent, `[dsh-omo ${role} specialist result]\nTask: ${taskSummary}\nStop reason: ${result.stopReason}${diagnostic}\n\n${details}`)
    }
  } catch (error) {
    if (!lifecycle.disposed) {
      try {
        queueParentMessage(parent, `[dsh-omo ${role} specialist failed]\nTask: ${taskSummary}\nHost error type: ${safeErrorName(error)}. See DSH diagnostics for details.`)
      } catch (deliveryError) {
        ctx.logger.warn(`dsh-omo could not deliver child ${run.id} failure (${safeErrorName(deliveryError)})`)
      }
    }
  } finally {
    try {
      await run.dispose()
    } catch (error) {
      ctx.logger.warn(`dsh-omo could not dispose child ${run.id} (${safeErrorName(error)})`)
    }
    activeRuns.delete(run.id)
    activeChildren.delete(run.id)
  }
}

function specialistTool(ctx, config, roleRoutes, activeChildren, activeRuns, lifecycle) {
  return defineTool({
    name: 'dsh_omo_task',
    description: `Start one bounded specialist task in the background. The parent receives the result when the child settles. Roles: ${ROLE_NAMES.join(', ')}.`,
    parameters: {
      role: {
        type: 'string', enum: ROLE_NAMES, required: true,
        description: 'Specialist role matched to this task.',
      },
      task: {
        type: 'string', required: true,
        description: 'One self-contained task with a concrete expected result.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true },
          role: { type: 'string', required: true },
          status: { type: 'string', enum: ['started'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Started ${value.role} specialist ${value.childId}. The parent will receive its result after the child settles.`,
      }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      if (typeof args.task !== 'string' || args.task.trim().length === 0) throw new Error('Task must not be empty.')
      if (args.task.length > config.maxTaskChars) {
        throw new Error(`Task is ${args.task.length} characters; dsh-omo limit is ${config.maxTaskChars}.`)
      }
      if (activeChildren.size >= config.maxConcurrent) {
        throw new Error(`dsh-omo worker limit reached (${config.maxConcurrent}); wait for a child to finish.`)
      }
      if (!exec.agent) throw new Error('dsh-omo_task requires an active parent agent.')

      // Reserve synchronously before the async provider start so parallel tool
      // calls cannot all pass the same capacity check.
      const reservation = Symbol('dsh-omo worker reservation')
      activeChildren.add(reservation)
      const route = roleRoutes.get(args.role)
      const agentOptions = route?.provider && route?.model
        ? {
            provider: route.provider,
            model: route.model,
            ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
            ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
          }
        : undefined
      const toolFilter = route?.allowTools ? { allow: route.allowTools } : undefined
      const label = `${args.role}: ${args.task.trim().replace(/\s+/gu, ' ').slice(0, 72)}`
      let run
      try {
        run = await ctx.subagents.start(config.provider || DEFAULT_PROVIDER, {
          label,
          parent: exec.agent,
          prompt: [{ type: 'text', text: buildWorkerPrompt(args.role, args.task) }],
          signal: exec.signal,
          ...(agentOptions ? { agentOptions } : {}),
          ...(toolFilter ? { toolFilter } : {}),
          maxDepth: config.maxDepth,
        })
      } catch (error) {
        activeChildren.delete(reservation)
        throw error
      }

      if (lifecycle.disposed) {
        activeChildren.delete(reservation)
        await run.dispose()
        throw new Error('dsh-omo was unloaded while starting the specialist.')
      }
      activeChildren.delete(reservation)
      activeChildren.add(run.id)
      activeRuns.set(run.id, run)
      void settleBackgroundChild({
        run, role: args.role, task: args.task, parent: exec.agent, ctx, activeChildren, activeRuns, lifecycle,
        maxResultChars: config.maxResultChars,
      })
      return { childId: run.id, role: args.role, status: 'started' }
    },
  })
}

function registerCommands(ctx) {
  const queueTask = (agent, rawInput, mode) => {
    const task = rawInput.trim()
    if (!task) return { kind: 'error', text: `Usage: /${mode.command} ${mode.hint}` }
    queueParentMessage(agent, `${mode.directive}\n\n${task}`)
    return { kind: 'success', text: `Queued ${mode.label} work for the current agent.` }
  }

  const registrations = [
    {
      name: 'ulw',
      description: 'Start an ultrawork-style multi-step task with specialist delegation and verification.',
      input: { hint: '<task>' },
      handler: ({ agent, rawInput }) => queueTask(agent, rawInput, {
        command: 'ulw', hint: '<task>', label: 'ultrawork',
        directive: 'Work in ULTRAWORK mode: make a dependency-aware plan, split independent work across dsh_omo_task specialists when useful, integrate results, and verify the final change before reporting.',
      }),
    },
    {
      name: 'ultrawork',
      description: 'Alias for /ulw: start a substantial task with parallel specialists and explicit verification.',
      input: { hint: '<task>' },
      handler: ({ agent, rawInput }) => queueTask(agent, rawInput, {
        command: 'ultrawork', hint: '<task>', label: 'ultrawork',
        directive: 'Work in ULTRAWORK mode: make a dependency-aware plan, split independent work across dsh_omo_task specialists when useful, integrate results, and verify the final change before reporting.',
      }),
    },
    {
      name: 'architect',
      description: 'Ask the current agent for a design-first architecture analysis.',
      input: { hint: '<design question>' },
      handler: ({ agent, rawInput }) => queueTask(agent, rawInput, {
        command: 'architect', hint: '<design question>', label: 'architecture analysis',
        directive: 'Act as an architecture consultant. Inspect before proposing changes; compare practical options, identify trade-offs and risks, and recommend a small, testable design.',
      }),
    },
    {
      name: 'review',
      description: 'Ask the current agent to perform a finding-first code or security review.',
      input: { hint: '<change or area to review>' },
      handler: ({ agent, rawInput }) => queueTask(agent, rawInput, {
        command: 'review', hint: '<change or area to review>', label: 'review',
        directive: 'Perform a finding-first review. Inspect the relevant diff and callers; report only actionable correctness, regression, security, and test-gap findings with file/line evidence. Do not edit files unless the user asks.',
      }),
    },
    {
      name: 'omo',
      description: 'Show the installed DSH OMO-inspired specialist roles and available commands.',
      handler: () => ({
        kind: 'success',
        text: `dsh-omo is active. Roles: ${ROLE_NAMES.join(', ')}. Commands: /ulw, /ultrawork, /architect, /review. Skills: ${SKILLS.map(skill => skill.name).join(', ')}. Set per-role provider/model overrides and allowTools in the dsh-omo profile row.`,
      }),
    },
  ]
  for (const registration of registrations) ctx.commands.register(registration)
}

export function apply(ctx, rawConfig) {
  const config = rawConfig
  assertPositiveInteger('maxConcurrent', config.maxConcurrent)
  assertPositiveInteger('maxDepth', config.maxDepth)
  assertPositiveInteger('maxTaskChars', config.maxTaskChars)
  assertPositiveInteger('maxResultChars', config.maxResultChars)
  const roleRoutes = normalizeRoleRoutes(config.roleRoutes)
  const activeChildren = new Set()
  const activeRuns = new Map()
  const lifecycle = { disposed: false }

  ctx.tools.register(specialistTool(ctx, config, roleRoutes, activeChildren, activeRuns, lifecycle))
  for (const skill of SKILLS) {
    ctx.skills.register({
      ...skill,
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  }
  ctx.systemPrompt.section({
    name: 'dsh-omo:specialist-orchestration',
    order: 5_200,
    interpolate: false,
    text: ULTRAWORK_GUIDANCE,
  })
  registerCommands(ctx)
  ctx.effect(() => async () => {
    lifecycle.disposed = true
    const settled = await Promise.allSettled([...activeRuns.values()].map(run => run.dispose()))
    for (const result of settled) {
      if (result.status === 'rejected') ctx.logger.warn(`dsh-omo shutdown could not dispose a worker (${safeErrorName(result.reason)})`)
    }
  }, 'dsh-omo background workers')
}
