const MAX_JOB_ID_CHARS = 256

function safeErrorName(error) {
  const name = error && typeof error === 'object' ? error.name : undefined
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : 'Error'
}

/** Create the human-command adapter for the optional Host job cancellation service. */
export function createJobKillCommand(jobController) {
  if (!jobController || typeof jobController.kill !== 'function') {
    throw new TypeError('omo-job-kill requires DSH jobController.kill')
  }

  return {
    name: 'omo-job-kill',
    description: 'Human-only request to kill one DSH background job visible to the current Agent. DSH visibility includes owned and unowned jobs. This is not a model tool, OMO background_cancel, or continuable-child interrupt.',
    input: { hint: '<jobId>' },
    handler(invocation) {
      const rawInput = invocation?.rawInput
      if (typeof rawInput !== 'string') {
        return { kind: 'error', text: 'Usage: /omo-job-kill <jobId>' }
      }
      if (rawInput.length > MAX_JOB_ID_CHARS) {
        return { kind: 'error', text: `Job ID must not exceed ${MAX_JOB_ID_CHARS} characters.` }
      }
      const jobId = rawInput.trim()
      if (jobId.length === 0 || /\s/u.test(jobId)) {
        return { kind: 'error', text: 'Provide exactly one non-empty DSH job ID.' }
      }
      const sessionId = invocation?.agent?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { kind: 'error', text: 'A current Agent is required to fence the DSH job kill request.' }
      }

      let result
      try {
        result = jobController.kill({ sessionId, jobId })
      } catch (error) {
        return { kind: 'error', text: `Could not request DSH job cancellation (${safeErrorName(error)}).` }
      }
      if (!result || (result.outcome !== 'requested' && result.outcome !== 'already-finished')) {
        return { kind: 'error', text: 'The DSH job controller returned an invalid cancellation result; no success is claimed.' }
      }
      if (result.outcome === 'requested') {
        return { kind: 'success', text: 'DSH accepted the kill request. This does not confirm termination; DSH sends any completion notice to the owning Agent.' }
      }
      return { kind: 'success', text: 'DSH reports that this job had already finished; no kill request was needed.' }
    },
  }
}
