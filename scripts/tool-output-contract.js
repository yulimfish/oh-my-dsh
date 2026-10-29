/** Test-only verification of successful Tool values and rendered content. */
export function checkToolOutput(definition, args, value, validate) {
  const errors = validate(definition.output.schema, value)
  if (errors.length > 0) {
    throw new TypeError(`${definition.name}: output schema mismatch: ${errors.join('; ')}`)
  }
  const content = definition.output.render(args, value)
  if (!Array.isArray(content) || content.some(block => !block || typeof block.type !== 'string'
    || (block.type === 'text' && typeof block.text !== 'string'))) {
    throw new TypeError(`${definition.name}: renderer returned invalid content blocks`)
  }
}
