const MAX_LABEL_CHARS = 240
const MAX_DETAIL_CHARS = 80
const MAX_ERROR_NAME_CHARS = 64
const JOB_WAIT_TIMEOUT_MS = 2_147_483_647
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]*$/u

function cleanSingleLine(value, maxChars) {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_OR_BIDI, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxChars)
}

function safeErrorName(error) {
  try {
    if (!(error instanceof Error)) return 'UnknownError'
    const name = error.name
    return typeof name === 'string' && name.length <= MAX_ERROR_NAME_CHARS && SAFE_ERROR_NAME.test(name)
      ? name
      : 'Error'
  } catch {
    return 'UnknownError'
  }
}

function warn(logger, message, error) {
  try {
    logger?.warn?.(`[dsh-omo] ${message} (${safeErrorName(error)})`)
  } catch {
    // Monitoring and diagnostics must never affect the child.
  }
}

async function childOutcome(run) {
  try {
    const result = await run.result
    const stopReason = cleanSingleLine(result?.stopReason, MAX_DETAIL_CHARS)
    if (stopReason === 'completed') return { status: 'completed' }
    if (stopReason === 'aborted') return { status: 'killed', detail: stopReason }
    return { status: 'failed', ...(stopReason ? { detail: stopReason } : {}) }
  } catch (error) {
    return { status: 'failed', detail: safeErrorName(error) }
  }
}

/** Mirror an already-started one-shot child without relaying its output or settlement. */
export function createTaskJobMonitor({ jobs, subagents, logger } = {}) {
  function start({ run, parent, role, task }) {
    if (typeof jobs?.start !== 'function' || typeof jobs.wait !== 'function'
      || typeof subagents?.interrupt !== 'function') return undefined

    let jobId
    try {
      const cleanRole = cleanSingleLine(role, MAX_LABEL_CHARS)
      const cleanTask = cleanSingleLine(task, MAX_LABEL_CHARS)
      jobId = jobs.start({
        kind: 'omo-subagent',
        owner: parent.id,
        label: cleanSingleLine(`OMO ${cleanRole}: ${cleanTask}`, MAX_LABEL_CHARS),
        run() {
          return {
            done: childOutcome(run),
            cancel() {
              subagents.interrupt(run.id, { kind: 'ancestor', agent: parent })
            },
          }
        },
      })
    } catch (error) {
      warn(logger, 'could not start one-shot child job mirror', error)
      return undefined
    }

    try {
      const waiter = jobs.wait(jobId, JOB_WAIT_TIMEOUT_MS, parent.id)
      void Promise.resolve(waiter).catch(error => {
        warn(logger, 'one-shot child job mirror wait failed', error)
      })
    } catch (error) {
      warn(logger, 'one-shot child job mirror wait failed', error)
    }
    return jobId
  }

  return { start }
}
