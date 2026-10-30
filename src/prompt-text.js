/** Return one valid JSON string whose serialized representation fits the prompt budget. */
export function quoteBoundedText(value, maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 3) throw new RangeError('JSON text budget must be at least 3 characters')
  const encoded = []
  let length = 2
  let truncated = false
  for (const character of value) {
    const part = JSON.stringify(character).slice(1, -1)
    if (length + part.length > maxChars) {
      truncated = true
      break
    }
    encoded.push(part)
    length += part.length
  }
  if (!truncated) return `"${encoded.join('')}"`
  while (length + 1 > maxChars) length -= encoded.pop().length
  return `"${encoded.join('')}…"`
}
