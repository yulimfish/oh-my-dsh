const MAX_REFACTOR_INPUT_CHARS = 12_000
const SCOPES = new Set(['file', 'module', 'project'])
const STRATEGIES = new Set(['safe', 'aggressive'])

export const REFACTOR_COMMAND_HINT = '<target> [--scope=<file|module|project>] [--strategy=<safe|aggressive>]'

function usageError() {
  return { ok: false, error: `Usage: /refactor ${REFACTOR_COMMAND_HINT}` }
}

function tokensWithOffsets(input) {
  const tokens = []
  const matcher = /\S+/gu
  let match
  while ((match = matcher.exec(input)) !== null) {
    tokens.push({ value: match[0], start: match.index })
  }
  return tokens
}

/** Parse a bounded free-form target followed only by strict trailing options. */
export function parseRefactorInput(rawInput, maxTaskChars = MAX_REFACTOR_INPUT_CHARS) {
  const configuredLimit = Number.isSafeInteger(maxTaskChars) && maxTaskChars > 0
    ? Math.min(maxTaskChars, MAX_REFACTOR_INPUT_CHARS)
    : MAX_REFACTOR_INPUT_CHARS
  if (typeof rawInput !== 'string') return usageError()
  if (rawInput.length > configuredLimit) {
    return { ok: false, error: `Refactor input is ${rawInput.length} characters; dsh-omo limit is ${configuredLimit}.` }
  }

  const input = rawInput.trim()
  if (!input) return usageError()
  const tokens = tokensWithOffsets(input)
  let remaining = tokens.length
  let targetEnd = input.length
  let scope = 'target'
  let strategy = 'safe'
  let scopeExplicit = false
  let strategyExplicit = false

  while (remaining > 0) {
    const { value, start } = tokens[remaining - 1]
    if (!value.startsWith('--')) break
    const separator = value.indexOf('=')
    if (separator < 0) {
      return { ok: false, error: `Refactor options must use --scope=value or --strategy=value. ${REFACTOR_COMMAND_HINT}` }
    }
    const flag = value.slice(0, separator)
    const setting = value.slice(separator + 1)
    if (flag === '--scope') {
      if (scopeExplicit) return { ok: false, error: 'Refactor --scope may be specified only once.' }
      if (!SCOPES.has(setting)) return { ok: false, error: 'Refactor --scope must be file, module, or project.' }
      scope = setting
      scopeExplicit = true
    } else if (flag === '--strategy') {
      if (strategyExplicit) return { ok: false, error: 'Refactor --strategy may be specified only once.' }
      if (!STRATEGIES.has(setting)) return { ok: false, error: 'Refactor --strategy must be safe or aggressive.' }
      strategy = setting
      strategyExplicit = true
    } else {
      return { ok: false, error: 'Unsupported refactor option. Use only --scope and --strategy.' }
    }
    targetEnd = start
    remaining -= 1
  }

  if (tokens.slice(0, remaining).some(token => token.value.startsWith('--'))) {
    return { ok: false, error: 'Refactor options must appear after the target.' }
  }
  const target = input.slice(0, targetEnd).trim()
  if (!target) return usageError()
  return Object.freeze({ ok: true, target, scope, strategy, scopeExplicit, strategyExplicit })
}

/** Build a prompt-only refactor workflow; DSH remains the enforcement boundary. */
export function buildRefactorDirective({ scope, strategy }) {
  const scopeGuidance = scope === 'target'
    ? 'the named target only (dsh-omo local default; do not broaden beyond it)'
    : `the user-requested ${scope} scope`
  const strategyGuidance = strategy === 'aggressive'
    ? 'aggressive (explicitly opted into by the user; broader changes are still limited by the requested target and DSH policy)'
    : 'safe (dsh-omo local default; prefer minimal, behavior-preserving edits)'
  return [
    'Refactor the user-requested target.',
    `Scope guidance: ${scopeGuidance}. This is prompt guidance only, not a filesystem, cwd, tool, or permission boundary.`,
    `Strategy: ${strategyGuidance}.`,
    'Inspect the target, relevant callers, architecture, and existing tests before editing. Use only tools actually available in this DSH profile.',
    'LSP rename/navigation, AST-grep, and codemap tools are unverified: use them only if present, otherwise state the limitation and use available DSH tools. Architecture analysis, test-first/TDD work, and codemap generation are requested workflow guidance, not guaranteed or automatically enforced phases.',
    'Make focused changes, preserve behavior and project invariants, add and run relevant focused tests, and review the final diff. Do not commit automatically. DSH permissions and approvals remain authoritative.',
  ].join('\n')
}
