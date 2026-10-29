import { isAbsolute } from 'node:path'

const MAX_CWD_CHARS = 4_096
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_SCRIPTS = 32
const MAX_SCRIPT_CHARS = 512
const MAX_EVENTS = 128
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
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.scripts === null || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) {
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
  const manifest = await fs.lstat('package.json', { cwd, signal })
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
  if (info.version !== undefined && after?.version !== info.version) {
    throw new Error('package.json changed during verification inspection; retry the command.')
  }
  return parseManifest(bytes)
}

function contentText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.slice(0, 32).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').slice(0, 2_000)
}

/** Collect only bash Tool results with their matching call metadata; other tools are ignored. */
export function collectBashResults(events) {
  if (!Array.isArray(events)) throw new TypeError('Session events are not an array.')
  const calls = new Map()
  const results = []
  for (const event of events) {
    if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.seq)) throw new TypeError('Invalid session event metadata.')
    if (event.type === 'tool/call' && event.data?.name === 'bash') {
      const callId = event.data.callId
      if (typeof callId !== 'string' || !callId) continue
      let args
      try { args = JSON.parse(event.data.arguments) } catch { continue }
      if (args && typeof args.command === 'string' && args.command.length <= 4_096) {
        if (calls.has(callId)) calls.delete(callId)
        if (calls.size >= MAX_EVENTS) calls.delete(calls.keys().next().value)
        calls.set(callId, { command: clean(args.command, 4_096), description: clean(args.description, 160) })
      }
    } else if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.toolCallId ?? message?.source?.toolCallId
      const call = calls.get(callId)
      if (!call) continue
      calls.delete(callId)
      results.push({
        seq: event.seq,
        command: call.command,
        description: call.description,
        isError: message?.isError === true || event.data?.error !== undefined,
        text: contentText(message),
      })
    }
  }
  return results.slice(-16)
}

function render(scripts, checks, sessionId) {
  const lines = [`Read-only verification evidence for session ${sessionId}. No tests were run and no Goal or workspace state was changed.`]
  lines.push('', 'Suggested project scripts (inspect before running):')
  if (scripts.length === 0) lines.push('- (no bounded test/check/build/lint scripts found)')
  for (const script of scripts) lines.push(`- ${script.name}: ${script.command}`)
  lines.push('', `Latest bash results observed in this session (${checks.length}):`)
  if (checks.length === 0) lines.push('- (no completed bash Tool results observed; this is not proof that checks were never run elsewhere)')
  for (const check of checks) {
    lines.push(`- #${check.seq} ${check.isError ? 'FAIL/ERROR' : 'completed without Tool error'}: ${check.command}`)
    if (check.text) lines.push(`  Output excerpt (untrusted): ${clean(check.text, 300)}`)
  }
  lines.push('', 'Interpretation: a completed bash Tool result is not by itself a passing test. Check its exit code/output. Missing evidence means unverified, not failed. Run an explicitly chosen script through normal DSH tools/approvals, then rerun /omo verify.')
  return result('success', lines.join('\n'))
}

/** Register a read-only, current-session verification evidence command. */
export function createVerifyCommand(sessionQuery, fs) {
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

      let observation
      try {
        observation = await sessionQuery.observeSession(agent.id, { signal, projectionMode: 'none' })
        assertActive(signal)
        if (!observation?.header || observation.header.id !== agent.id || !isAbsolute(observation.header.cwd)
          || observation.header.cwd.length > MAX_CWD_CHARS || CONTROL_OR_BIDI.test(observation.header.cwd)) {
          throw new Error('The current DSH session has no safe absolute working directory.')
        }
        const scripts = await readScripts(fs, observation.header.cwd, signal)
        if (!Array.isArray(observation.events)) throw new Error('The current DSH session has no raw event history.')
        // observation.events contains raw calls/results. filterEvents returns
        // semantic-only documents without call arguments and cannot pair bash evidence.
        const events = observation.events.filter(event => event?.type === 'tool/call' || event?.type === 'tool/result')
        assertActive(signal)
        return render(scripts, collectBashResults(events), agent.id)
      } catch (error) {
        return result('error', clean(error?.message, 500) || 'Could not inspect verification evidence safely.')
      } finally {
        try {
          if (typeof observation?.[Symbol.dispose] === 'function') await observation[Symbol.dispose]()
        } catch {
          // Observation cleanup failure is deliberately not converted into a verification claim.
        }
      }
    },
  }
}
