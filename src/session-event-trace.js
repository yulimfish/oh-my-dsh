import { defineTool } from '@deepseek-ai/dsh-tools'

const MAX_SESSION_ID_CHARS = 256
const MAX_EVENT_TYPE_CHARS = 96
const MAX_RELATION_SEQS = 64
const SURFACES = Object.freeze(['current', 'shadowed', 'log-only'])
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const RELATIONS = Object.freeze([
  'replacementChain',
  'replacedEventSeqs',
  'sourceEventSeqs',
  'derivedEventSeqs',
])

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        seq: { type: 'integer', required: true },
        surface: { type: 'string', enum: [...SURFACES], required: true },
      },
    },
    replacedBy: { type: 'integer' },
    replacementChain: { type: 'array', required: true, items: { type: 'integer' } },
    replacedEventSeqs: { type: 'array', required: true, items: { type: 'integer' } },
    sourceEventSeqs: { type: 'array', required: true, items: { type: 'integer' } },
    derivedEventSeqs: { type: 'array', required: true, items: { type: 'integer' } },
    truncated: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        replacementChain: { type: 'boolean', required: true },
        replacedEventSeqs: { type: 'boolean', required: true },
        sourceEventSeqs: { type: 'boolean', required: true },
        derivedEventSeqs: { type: 'boolean', required: true },
      },
    },
  },
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_CHARS
    && !CONTROL_OR_BIDI.test(value)
}

function validSeq(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validateSignal(exec) {
  const signal = exec?.signal
  if (signal === undefined) return undefined
  if (!signal || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw new TypeError('dsh_omo_session_trace_event requires the DSH execution AbortSignal when provided')
  }
  return signal
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error('dsh_omo_session_trace_event was cancelled.')
}

function projectSeqList(value, label) {
  if (!Array.isArray(value)) throw new Error(`DSH returned an invalid ${label}`)
  const count = Math.min(value.length, MAX_RELATION_SEQS)
  const sequences = []
  for (let index = 0; index < count; index += 1) {
    const seq = value[index]
    if (!validSeq(seq)) throw new Error(`DSH returned an invalid ${label}`)
    sequences.push(seq)
  }
  return { sequences, truncated: value.length > MAX_RELATION_SEQS }
}

function projectTrace(observation, sessionId, requestedSeq) {
  if (!isRecord(observation) || !isRecord(observation.session) || !isRecord(observation.target)) {
    throw new Error('DSH returned an invalid current-session event trace.')
  }
  if (!validSessionId(observation.session.id) || observation.session.id !== sessionId
    || !validSessionId(observation.target.sessionId) || observation.target.sessionId !== sessionId) {
    throw new Error('DSH returned an event trace for the wrong session.')
  }
  const target = observation.target
  // Validate Host target type/time metadata, but deliberately exclude both from model-facing output.
  if (!validSeq(target.seq) || target.seq !== requestedSeq
    || typeof target.type !== 'string' || target.type.length === 0 || target.type.length > MAX_EVENT_TYPE_CHARS
    || CONTROL_OR_BIDI.test(target.type) || !Number.isFinite(target.time) || !SURFACES.includes(target.surface)) {
    throw new Error('DSH returned invalid event trace metadata.')
  }

  const projected = { target: { seq: target.seq, surface: target.surface } }
  if (observation.replacedBy !== undefined) {
    if (!validSeq(observation.replacedBy)) throw new Error('DSH returned an invalid replacement sequence.')
    projected.replacedBy = observation.replacedBy
  }
  projected.truncated = {}
  for (const relation of RELATIONS) {
    const bounded = projectSeqList(observation[relation], relation)
    projected[relation] = bounded.sequences
    projected.truncated[relation] = bounded.truncated
  }
  return projected
}

/** Trace bounded positional event provenance for only the executing Agent's session. */
export function createSessionEventTraceTool(sessionQuery) {
  if (!sessionQuery || typeof sessionQuery.traceEvent !== 'function') {
    throw new TypeError('dsh_omo_session_trace_event requires DSH sessionQuery.traceEvent')
  }

  return defineTool({
    name: 'dsh_omo_session_trace_event',
    description: 'Trace replacement and cited-source sequence links for one event in only the executing Agent’s current DSH session. No session ID is accepted. Returns bounded sequence/surface metadata only—never event type, text, or the Session header; Host-side trace work may be larger than the returned lists. This is provenance metadata, not a task DAG or session-recovery mechanism.',
    parameters: {
      seq: { type: 'integer', required: true, description: 'Nonnegative event sequence from this session’s event search or read result.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const rows = [
          'Read-only DSH event provenance for the current Agent session; this reports sequence links, not event content.',
          `Target: #${value.target.seq} (${value.target.surface})`,
          `Replaced by: ${value.replacedBy === undefined ? '(none)' : `#${value.replacedBy}`}`,
        ]
        for (const relation of RELATIONS) {
          const sequences = value[relation]
          const suffix = value.truncated[relation] ? ` (first ${MAX_RELATION_SEQS}; truncated)` : ''
          rows.push(`${relation}: ${sequences.length ? sequences.map(seq => `#${seq}`).join(', ') : '(none)'}${suffix}`)
        }
        return [{ type: 'text', text: rows.join('\n') }]
      },
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      if (args?.sessionId !== undefined) {
        throw new TypeError('dsh_omo_session_trace_event accepts no sessionId; it traces only the current Agent session')
      }
      if (!validSeq(args?.seq)) throw new TypeError('seq must be a nonnegative safe integer event sequence')
      const agent = exec?.agent
      if (!agent || !validSessionId(agent.id)) throw new TypeError('dsh_omo_session_trace_event requires a valid current Agent')
      const sessionId = agent.id
      const signal = validateSignal(exec)
      assertNotAborted(signal)

      let observation
      try {
        assertNotAborted(signal)
        observation = await sessionQuery.traceEvent({ sessionId, seq: args.seq }, signal)
        assertNotAborted(signal)
      } catch {
        if (signal?.aborted) throw new Error('dsh_omo_session_trace_event was cancelled.')
        throw new Error('Could not trace event provenance for the current DSH session.')
      }
      try {
        return projectTrace(observation, sessionId, args.seq)
      } catch {
        throw new Error('DSH returned invalid event trace metadata for the current session.')
      }
    },
  })
}

/** Register only when configured; return the Host Tool disposer to the caller. */
export function registerSessionEventTraceTool(ctx, sessionQuery) {
  if (sessionQuery === undefined || sessionQuery === null) return () => {}
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    throw new TypeError('registerSessionEventTraceTool requires ctx.tools.register')
  }
  const dispose = ctx.tools.register(createSessionEventTraceTool(sessionQuery))
  if (typeof dispose !== 'function') throw new TypeError('dsh_omo_session_trace_event registration did not return a disposer')
  return dispose
}
