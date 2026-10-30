import { isAbsolute } from 'node:path'

const MAX_CWD_CHARS = 4_096
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_SCRIPTS = 32
const MAX_SCRIPT_CHARS = 512
const MAX_EVENTS = 128
const MAX_COMPLETED_CALL_IDS = 2_048
const MAX_EVICTED_CALL_IDS = MAX_COMPLETED_CALL_IDS * 16
const MAX_EVIDENCE_CHARS = 2_800
const MAX_OUTPUT_CHARS = 4_000
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const CONTROL_OR_BIDI_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

function result(kind, text) {
  return { kind, text: text.slice(0, MAX_OUTPUT_CHARS) }
}

function validAgent(agent) {
  return agent !== null && typeof agent === 'object' && typeof agent.id === 'string'
    && agent.id.length > 0 && agent.id.length <= 256 && !CONTROL_OR_BIDI.test(agent.id)
}

function safeSignal(signal) {
  return signal === undefined || (signal !== null && typeof signal === 'object' && signal.aborted === false)
}

function assertActive(signal) {
  if (!safeSignal(signal)) throw new Error('Verification inspection was cancelled or has an invalid signal.')
}

function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_OR_BIDI_GLOBAL, ' ').replace(/\s+/gu, ' ').trim().slice(0, max)
}

function parseManifest(bytes) {
  let manifest
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch {
    throw new Error('package.json is not valid UTF-8 JSON; no verification commands were inferred.')
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('package.json is not a JSON object; no verification commands were inferred.')
  }
  if (manifest.scripts === undefined) return []
  if (manifest.scripts === null || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) {
    throw new Error('package.json has no valid scripts object; no verification commands were inferred.')
  }
  const scripts = []
  for (const name of Object.keys(manifest.scripts).sort()) {
    if (scripts.length >= MAX_SCRIPTS) break
    if (!/^(?:test|check|build|lint|typecheck|test:[a-z0-9:_-]+)$/iu.test(name)) continue
    const command = manifest.scripts[name]
    if (typeof command !== 'string' || command.length > MAX_SCRIPT_CHARS || CONTROL_OR_BIDI.test(command)) continue
    scripts.push({ name, command })
  }
  return scripts
}

async function readScripts(fs, cwd, signal) {
  const root = await fs.resolve('.', { cwd, signal })
  assertActive(signal)
  const rootInfo = await fs.stat(root, signal)
  if (rootInfo?.type !== 'directory') throw new Error('The current session cwd is not a real directory.')
  const manifest = await fs.lstat('package.json', { cwd }, signal)
  if (!manifest) return []
  if (manifest.type !== 'file' || (manifest.size !== undefined && manifest.size > MAX_MANIFEST_BYTES)) {
    throw new Error('package.json is not a regular bounded file; no verification commands were inferred.')
  }
  const target = await fs.resolve('package.json', { cwd, signal })
  if (fs.contains(root, target) !== true) throw new Error('package.json resolves outside the current workspace.')
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file' || (info.size !== undefined && info.size > MAX_MANIFEST_BYTES)) {
    throw new Error('package.json is not a regular bounded file; no verification commands were inferred.')
  }
  const bytes = await fs.readBytes(target, signal, MAX_MANIFEST_BYTES)
  assertActive(signal)
  const after = await fs.stat(target, signal)
  if (after?.type !== 'file' || (info.version !== undefined && after?.version !== info.version)
    || (info.size !== undefined && after?.size !== info.size)) {
    throw new Error('package.json changed during verification inspection; retry the command.')
  }
  return parseManifest(bytes)
}

function contentText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.slice(0, 32).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').slice(0, 2_000)
}

function hasNonTextContent(message) {
  return Array.isArray(message?.content) && message.content.slice(0, 32)
    .some(block => block?.type !== 'text')
}

/** Collect only bash Tool results with their matching call metadata; other tools are ignored. */
export function collectBashResults(events) {
  if (!Array.isArray(events)) throw new TypeError('Session events are not an array.')
  const calls = new Map()
  const completedCallIds = new Set()
  const otherCallIds = new Set()
  const malformedCallIds = new Set()
  const ambiguousCallIds = new Set()
  const evictedCallIds = new Set()
  let correlationComplete = true
  let correlationSaturated = false
  const results = []
  for (const event of events) {
    if (evictedCallIds.size >= MAX_EVICTED_CALL_IDS) correlationSaturated = true
    if (correlationSaturated) {
      calls.clear()
      results.length = 0
      correlationComplete = false
      continue
    }
    if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.seq)) throw new TypeError('Invalid session event metadata.')
    if (event.type === 'tool/call') {
      const callId = event.data.callId
      if (typeof callId !== 'string' || !callId) continue
      if (malformedCallIds.has(callId) || completedCallIds.has(callId) || calls.has(callId) || otherCallIds.has(callId)) {
        calls.delete(callId)
        otherCallIds.delete(callId)
        ambiguousCallIds.delete(callId)
        ambiguousCallIds.add(callId)
        if (ambiguousCallIds.size > MAX_COMPLETED_CALL_IDS) {
          const evicted = ambiguousCallIds.keys().next().value
          ambiguousCallIds.delete(evicted)
          evictedCallIds.add(evicted)
          correlationComplete = false
        }
        for (let index = results.length - 1; index >= 0; index -= 1) {
          if (results[index].callId === callId) results.splice(index, 1)
        }
        continue
      }
      if (event.data?.name !== 'bash') {
        otherCallIds.add(callId)
        if (otherCallIds.size > MAX_COMPLETED_CALL_IDS) {
          const evicted = otherCallIds.keys().next().value
          otherCallIds.delete(evicted)
          evictedCallIds.add(evicted)
          correlationComplete = false
        }
        continue
      }
      if (ambiguousCallIds.has(callId) || evictedCallIds.has(callId)) continue
      let args
      try { args = JSON.parse(event.data.arguments) } catch { args = undefined }
      if (!args || typeof args.command !== 'string' || args.command.length > 4_096) {
        malformedCallIds.delete(callId)
        malformedCallIds.add(callId)
        if (malformedCallIds.size > MAX_COMPLETED_CALL_IDS) {
          const evicted = malformedCallIds.keys().next().value
          malformedCallIds.delete(evicted)
          evictedCallIds.add(evicted)
          correlationComplete = false
        }
        continue
      }
      if (calls.size >= MAX_EVENTS) {
        const evicted = calls.keys().next().value
        calls.delete(evicted)
        evictedCallIds.add(evicted)
        correlationComplete = false
      }
      calls.set(callId, { command: clean(args.command, 4_096), description: clean(args.description, 160) })
    } else if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.toolCallId ?? message?.source?.toolCallId
      if (ambiguousCallIds.has(callId) || evictedCallIds.has(callId)) {
        calls.delete(callId)
        for (let index = results.length - 1; index >= 0; index -= 1) {
          if (results[index].callId === callId) results.splice(index, 1)
        }
        continue
      }
      if (completedCallIds.has(callId) && !calls.has(callId)) {
        ambiguousCallIds.add(callId)
        if (ambiguousCallIds.size > MAX_COMPLETED_CALL_IDS) {
          const evicted = ambiguousCallIds.keys().next().value
          ambiguousCallIds.delete(evicted)
          evictedCallIds.add(evicted)
          correlationComplete = false
        }
        for (let index = results.length - 1; index >= 0; index -= 1) {
          if (results[index].callId === callId) results.splice(index, 1)
        }
        continue
      }
      const call = calls.get(callId)
      if (!call) continue
      calls.delete(callId)
      completedCallIds.delete(callId)
      completedCallIds.add(callId)
      if (completedCallIds.size > MAX_COMPLETED_CALL_IDS) {
        const evicted = completedCallIds.keys().next().value
        completedCallIds.delete(evicted)
        evictedCallIds.add(evicted)
        ambiguousCallIds.add(evicted)
        if (evictedCallIds.size >= MAX_EVICTED_CALL_IDS) {
          // Once correlation tombstones reach their bound, no later result can
          // be attributed safely; return no evidence rather than guessing.
          results.length = 0
          correlationComplete = false
          continue
        }
      }
      if (results.length >= 16) results.shift()
      results.push({
        seq: event.seq,
        callId,
        command: call.command,
        description: call.description,
        isError: message?.isError === true || event.data?.error !== undefined,
        text: contentText(message),
        hasNonText: hasNonTextContent(message),
      })
    }
  }
  return evictedCallIds.size >= MAX_EVICTED_CALL_IDS ? [] : results
}

function render(scripts, checks, sessionId) {
  const evidenceLines = [`Latest bash results observed in this session (${checks.length}):`]
  if (checks.length === 0) evidenceLines.push('- (no completed bash Tool results observed; this is not proof that checks were never run elsewhere)')
  for (const check of checks) {
    evidenceLines.push(`- #${check.seq} ${check.isError ? 'FAIL/ERROR' : 'completed without Tool error'}: ${check.command.slice(0, 256)}`)
    if (check.text) evidenceLines.push(`  Output excerpt (untrusted): ${clean(check.text, 300)}`)
    else if (!check.hasNonText) evidenceLines.push('  (no text output; a passing exit status is not implied)')
    if (check.hasNonText) evidenceLines.push('  (non-text result blocks present; inspect the original Tool result for details)')
  }
  const disclaimer = 'Interpretation: a completed bash Tool result is not by itself a passing test. Check its exit code/output. Missing evidence means unverified, not failed. Run an explicitly chosen script through normal DSH tools/approvals, then rerun /omo verify.'
  const header = `Read-only verification evidence for session ${sessionId}. No tests were run and no Goal or workspace state was changed.`
  let evidenceText = evidenceLines.join('\n')
  if (evidenceText.length > MAX_EVIDENCE_CHARS) {
    const marker = '- … older evidence omitted to retain the latest result and interpretation …'
    const records = checks.map(check => [
      `- #${check.seq} ${check.isError ? 'FAIL/ERROR' : 'completed without Tool error'}: ${check.command.slice(0, 256)}`,
      ...(check.text ? [`  Output excerpt (untrusted): ${clean(check.text, 300)}`] : []),
      ...(!check.text && !check.hasNonText ? ['  (no text output; a passing exit status is not implied)'] : []),
      ...(check.hasNonText ? ['  (non-text result blocks present; inspect the original Tool result for details)'] : []),
    ].join('\n'))
    const retained = [records.at(-1)]
    let used = marker.length + 1 + retained[0].length
    for (let index = records.length - 2; index >= 0; index -= 1) {
      if (used + records[index].length + 1 > MAX_EVIDENCE_CHARS) break
      retained.unshift(records[index])
      used += records[index].length + 1
    }
    evidenceText = [marker, ...retained].join('\n')
  }
  const suffix = ['', evidenceText, '', disclaimer].join('\n')
  const scriptLines = ['', 'Suggested project scripts (inspect before running):']
  if (scripts.length === 0) scriptLines.push('- (no bounded test/check/build/lint scripts found)')
  for (const script of scripts) scriptLines.push(`- ${script.name}: ${script.command}`)
  const scriptText = scriptLines.join('\n')
  const scriptBudget = Math.max(0, MAX_OUTPUT_CHARS - header.length - suffix.length - 80)
  const scriptsOmitted = scriptText.length > scriptBudget
  const visibleScripts = scriptsOmitted ? `${scriptText.slice(0, scriptBudget)}\n- … additional scripts omitted to preserve verification evidence …` : scriptText
  return result('success', `${header}${visibleScripts}${suffix}`)
}

/** Register a read-only, current-session verification evidence command. */
export function createVerifyCommand(sessionQuery, fs, workingDirectory, sessions) {
  return {
    name: 'omo-verify',
    description: 'Inspect current-project verification scripts and latest bash evidence without executing anything.',
    input: { hint: '(no arguments)' },
    async handler(args = {}) {
      const agent = args?.agent
      const signal = args?.signal
      const rawInput = args?.rawInput
      if (!validAgent(agent)) return result('error', 'An active agent is required for /omo verify.')
      if (typeof rawInput !== 'string' || rawInput.length > 128 || rawInput.trim()) {
        return result('error', 'Usage: /omo verify (no arguments)')
      }
      if (!safeSignal(signal)) return result('error', 'Verification inspection was cancelled or has an invalid signal.')
      if (!sessionQuery || typeof sessionQuery.observeSession !== 'function') {
        return result('error', 'The DSH session observation service is unavailable; verification evidence was not inferred.')
      }
      if (!fs || ['resolve', 'contains', 'lstat', 'stat', 'readBytes'].some(method => typeof fs[method] !== 'function')) {
        return result('error', 'The DSH filesystem contract is unavailable; project scripts were not read.')
      }
      if (typeof workingDirectory?.get !== 'function' || typeof sessions?.get !== 'function') {
        return result('error', 'The DSH effective-working-directory contract is unavailable; project scripts were not read.')
      }

      let observation
      let response
      let cleanupFailure = false
      try {
        observation = await sessionQuery.observeSession(agent.id, { signal, projectionMode: 'none' })
        assertActive(signal)
        if (!observation?.header || observation.header.id !== agent.id) {
          throw new Error('The current DSH session observation has a mismatched identity.')
        }
        const session = sessions.get(agent.id)
        if (!session || session.header?.id !== agent.id) {
          throw new Error('The current DSH Session could not be verified for working-directory inspection.')
        }
        const cwd = workingDirectory.get(session)
        if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > MAX_CWD_CHARS || CONTROL_OR_BIDI.test(cwd)) {
          throw new Error('The current DSH session has no safe absolute working directory.')
        }
        const scripts = await readScripts(fs, cwd, signal)
        if (!Array.isArray(observation.events)) throw new Error('The current DSH session has no raw event history.')
        // observation.events contains raw calls/results. filterEvents returns
        // semantic-only documents without call arguments and cannot pair bash evidence.
        const events = observation.events.filter(event => event?.type === 'tool/call' || event?.type === 'tool/result')
        assertActive(signal)
        response = render(scripts, collectBashResults(events), agent.id)
      } catch (error) {
        response = result('error', clean(error?.message, 500) || 'Could not inspect verification evidence safely.')
      } finally {
        try {
          if (typeof observation?.[Symbol.dispose] === 'function') await observation[Symbol.dispose]()
        } catch {
          cleanupFailure = true
        }
      }
      if (cleanupFailure) return result('error', 'The verification observation could not be released safely; no verification result was claimed.')
      return response
    },
  }
}
