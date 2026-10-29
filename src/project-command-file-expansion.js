import { MAX_PROMPT_APPEND_BYTES } from './roles.js'

const MAX_REFERENCES = 4
const MAX_TOTAL_REFERENCE_BYTES = MAX_PROMPT_APPEND_BYTES * MAX_REFERENCES
const MAX_EXPANSION_MS = 5_000

const FILE_REFERENCE = /(^|[\t ])@((?:\.\/)?(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*)(?=$|[\t ),.;!?])/gu
const SUPPORTED_FILE_EXTENSION = /\.(?:md|mdc|mdx|txt|text|json|jsonc|yaml|yml|toml|ini|js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|swift|rb|sh|bash|zsh|fish|css|scss|html|xml|sql|csv|env|config|conf|cfg|properties|vue|svelte|php|c|h|cpp|hpp|proto|graphql|gql|log|rst|adoc|gitignore)$/iu
const MAX_MARKDOWN_CODE_MARKERS = 256
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const TILDE_CODE_MARKER = /~{3,}/gu

function containerPrefix(line) {
  let index = 0
  let quoteDepth = 0
  while (true) {
    let probe = index
    let spaces = 0
    while (spaces < 3 && line[probe] === ' ') {
      probe += 1
      spaces += 1
    }
    if (line[probe] !== '>') break
    quoteDepth += 1
    index = probe + 1
    if (line[index] === ' ' || line[index] === '\t') index += 1
  }
  return { quoteDepth, content: line.slice(index) }
}

function fenceMarker(content) {
  const match = FENCE_MARKER.exec(content)
  return match
    ? { marker: match[1][0], length: match[1].length, tail: match[2] }
    : undefined
}

function nextBacktickRun(line, start) {
  const index = line.indexOf('`', start)
  if (index < 0) return undefined
  let end = index + 1
  while (line[end] === '`') end += 1
  return { start: index, end, length: end - index }
}

function inlineCodeRanges(line, markerCount) {
  const ranges = []
  let cursor = 0
  while (true) {
    const opening = nextBacktickRun(line, cursor)
    if (!opening) return ranges
    markerCount.count += 1
    if (markerCount.count > MAX_MARKDOWN_CODE_MARKERS) return undefined

    let search = opening.end
    let closing
    while (true) {
      const candidate = nextBacktickRun(line, search)
      if (!candidate) break
      markerCount.count += 1
      if (markerCount.count > MAX_MARKDOWN_CODE_MARKERS) return undefined
      if (candidate.length === opening.length) {
        closing = candidate
        break
      }
      search = candidate.end
    }
    if (!closing) return undefined
    ranges.push([opening.start, closing.end])
    cursor = closing.end
  }
}

function scanMarkdownCodeContexts(body) {
  const lines = body.split('\n')
  const codeRanges = []
  const markerCount = { count: 0 }
  let fence

  for (const line of lines) {
    const { quoteDepth, content } = containerPrefix(line)
    if (fence) {
      if (quoteDepth !== fence.quoteDepth) return undefined
      const candidate = fenceMarker(content)
      if (candidate && candidate.marker === fence.marker && candidate.length >= fence.length && /^[\t ]*$/u.test(candidate.tail)) {
        markerCount.count += 1
        if (markerCount.count > MAX_MARKDOWN_CODE_MARKERS) return undefined
        fence = undefined
      }
      codeRanges.push([[0, line.length]])
      continue
    }

    const opening = fenceMarker(content)
    if (opening) {
      markerCount.count += 1
      if (markerCount.count > MAX_MARKDOWN_CODE_MARKERS
        || (opening.marker === '`' && opening.tail.includes('`'))) return undefined
      fence = { marker: opening.marker, length: opening.length, quoteDepth }
      codeRanges.push([[0, line.length]])
      continue
    }

    const inlineRanges = inlineCodeRanges(line, markerCount)
    if (!inlineRanges) return undefined
    for (const match of line.matchAll(TILDE_CODE_MARKER)) {
      markerCount.count += 1
      if (markerCount.count > MAX_MARKDOWN_CODE_MARKERS) return undefined
      if (!inlineRanges.some(([start, end]) => match.index >= start && match.index < end)) return undefined
    }
    codeRanges.push(inlineRanges)
  }

  if (fence) return undefined
  return { lines, codeRanges }
}

function fileReferences(line, codeRanges) {
  return [...line.matchAll(FILE_REFERENCE)].flatMap(match => {
    const referenceStart = match.index + match[1].length
    if (codeRanges.some(([start, end]) => referenceStart >= start && referenceStart < end)) return []
    const relativePath = match[2].replace(/[.,!?;]+$/u, '')
    return SUPPORTED_FILE_EXTENSION.test(relativePath) ? [{ match, relativePath }] : []
  })
}

export async function expandProjectCommandFileReferences(projectCommand, { promptFileExpander, agent, signal } = {}) {
  if (!projectCommand || typeof projectCommand.body !== 'string') {
    throw new TypeError('A parsed project command is required for file expansion.')
  }
  if (!promptFileExpander || typeof promptFileExpander.expand !== 'function') {
    throw new TypeError('Project command file expansion requires the bounded DSH prompt-file expander.')
  }
  if (!agent || typeof agent !== 'object') throw new TypeError('Project command file expansion requires the current Agent.')
  // Pre-scan the whole bounded body so ambiguous Markdown never causes partial reads.
  const markdown = scanMarkdownCodeContexts(projectCommand.body)
  if (!markdown) return projectCommand
  const { lines, codeRanges } = markdown
  let referenceCount = 0
  const referencesByLine = lines.map((line, index) => {
    const references = fileReferences(line, codeRanges[index])
    referenceCount += references.length
    if (referenceCount > MAX_REFERENCES) {
      throw new RangeError(`Project commands may expand at most ${MAX_REFERENCES} file references.`)
    }
    return references
  })
  let totalReferenceBytes = 0
  let changed = false
  let boundedSignal

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const matches = referencesByLine[lineIndex]
    if (matches.length === 0) continue
    let cursor = 0
    let rendered = ''
    for (const { match, relativePath } of matches) {
      const leading = match[1]
      const referenceStart = match.index + leading.length
      const referenceEnd = referenceStart + 1 + relativePath.length
      rendered += line.slice(cursor, referenceStart)

      let expansion
      try {
        boundedSignal ??= signal === undefined
          ? AbortSignal.timeout(MAX_EXPANSION_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(MAX_EXPANSION_MS)])
        expansion = await promptFileExpander.expand({
          rolePromptAppend: `file://${relativePath}`,
          preserveWhitespace: true,
          agent,
          signal: boundedSignal,
        })
      } catch {
        throw new Error('A project command file reference could not be read safely; no prompt was queued.')
      }
      const contents = expansion?.rolePromptAppend
      if (typeof contents !== 'string') {
        throw new Error('A project command file reference could not be read safely; no prompt was queued.')
      }
      const bytes = new TextEncoder().encode(contents).byteLength
      totalReferenceBytes += bytes
      if (totalReferenceBytes > MAX_TOTAL_REFERENCE_BYTES) {
        throw new RangeError(`Project command file references exceed the ${MAX_TOTAL_REFERENCE_BYTES}-byte combined limit.`)
      }
      // The command renderer runs afterward; retain this token as JSON data, not template syntax.
      const encodedContents = JSON.stringify(contents).replaceAll('$ARGUMENTS', '\\u0024ARGUMENTS')
      rendered += `Referenced project file ${JSON.stringify(relativePath)} (untrusted contents): ${encodedContents}`
      cursor = referenceEnd
      changed = true
    }
    if (changed) {
      rendered += line.slice(cursor)
      lines[lineIndex] = rendered
    }
  }

  if (!changed) return projectCommand
  return Object.freeze({ ...projectCommand, body: lines.join('\n') })
}
