const MAX_CONTENT_BLOCKS = 256
const MAX_IMAGE_BLOCKS = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 12_000
const MAX_IMAGE_PIXELS = 32_000_000
const MAX_TOTAL_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_DERIVATIVE_BYTES = 8 * 1024 * 1024
const TARGET_DIMENSION = 1_568
const TARGET_MAX_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_ID_CHARS = 256
const MAX_IMAGE_NAME_CHARS = 256
const MAX_ADDITIONAL_CONTEXTS = 32
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasValidSignal(signal) {
  return signal !== null && typeof signal === 'object'
    && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function'
    && typeof signal.removeEventListener === 'function'
}

function isSafeImageReference(ref) {
  return isRecord(ref)
    && typeof ref.attachmentId === 'string'
    && ref.attachmentId.length > 0
    && ref.attachmentId.length <= MAX_ATTACHMENT_ID_CHARS
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(ref.attachmentId)
    && ALLOWED_MEDIA_TYPES.has(ref.mediaType)
    && Number.isSafeInteger(ref.bytes)
    && ref.bytes > 0
    && ref.bytes <= MAX_IMAGE_BYTES
    && Number.isSafeInteger(ref.width)
    && ref.width > 0
    && ref.width <= MAX_IMAGE_DIMENSION
    && Number.isSafeInteger(ref.height)
    && ref.height > 0
    && ref.height <= MAX_IMAGE_DIMENSION
    && ref.width * ref.height <= MAX_IMAGE_PIXELS
}

function preservesAspectRatio(source, variant) {
  const sourceRatio = source.width / source.height
  const resultRatio = variant.width / variant.height
  return Number.isFinite(sourceRatio) && Number.isFinite(resultRatio)
    && Math.abs(resultRatio - sourceRatio) / sourceRatio <= 0.02
}

function validRequestVariant(variant, source) {
  if (!isRecord(variant)
    || !(variant.data instanceof Uint8Array)
    || !Number.isSafeInteger(variant.bytes)
    || variant.bytes < 1
    || variant.bytes !== variant.data.byteLength
    || variant.bytes > TARGET_MAX_BYTES
    || !ALLOWED_MEDIA_TYPES.has(variant.mediaType)
    || !Number.isSafeInteger(variant.width)
    || variant.width < 1
    || variant.width > TARGET_DIMENSION
    || !Number.isSafeInteger(variant.height)
    || variant.height < 1
    || variant.height > TARGET_DIMENSION
    || variant.width > source.width
    || variant.height > source.height
    || variant.width * variant.height > MAX_IMAGE_PIXELS) return false

  // Some host implementations can choose a best-effort output. Preserve the source
  // if the result changes the aspect ratio instead of merely scaling it down.
  if (!preservesAspectRatio(source, variant)) return false

  // Do not create a persistent derivative unless its encoded bytes are strictly
  // smaller than the source attachment.
  return variant.bytes < source.bytes
}

function safeName(ref) {
  if (typeof ref?.name !== 'string' || ref.name.length === 0 || ref.name.length > MAX_IMAGE_NAME_CHARS
    || /[\u0000-\u001f\u007f-\u009f]/u.test(ref.name)) return undefined
  return ref.name
}

function toImageReference(ref) {
  const output = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
  const name = safeName(ref)
  if (name !== undefined) output.name = name
  if (isRecord(ref.originalDimensions)
    && Number.isSafeInteger(ref.originalDimensions.width) && ref.originalDimensions.width > 0
    && Number.isSafeInteger(ref.originalDimensions.height) && ref.originalDimensions.height > 0) {
    output.originalDimensions = {
      width: ref.originalDimensions.width,
      height: ref.originalDimensions.height,
    }
  }
  return output
}

function appendDimensionContext(decision, dimensions) {
  if (dimensions.length === 0) return decision
  const existing = decision.additionalContexts
  if (existing !== undefined && (!Array.isArray(existing) || existing.length >= MAX_ADDITIONAL_CONTEXTS)) return decision
  const text = `Image dimensions (pixels): ${dimensions.map((item, index) => {
    const source = `${item.source.width} × ${item.source.height}`
    const result = item.result ? ` → ${item.result.width} × ${item.result.height}` : ''
    return `${index + 1}: ${source}${result}`
  }).join('; ')}.`
  return {
    ...decision,
    additionalContexts: [
      ...(existing ?? []),
      { role: 'user', content: [{ type: 'text', text }] },
    ],
  }
}

function shouldRequestVariant(ref) {
  return ref.width > TARGET_DIMENSION || ref.height > TARGET_DIMENSION || ref.bytes > TARGET_MAX_BYTES
}

/**
 * DSH-specific opt-in adapter for successful top-level `read` Tool results.
 * Variants are durable only after saveImages(), so callers must explicitly opt in.
 */
export function createReadImageResizingListener(attachments, lifetimeSignal) {
  if (!attachments || typeof attachments.readImageRequest !== 'function' || typeof attachments.saveImages !== 'function') {
    throw new TypeError('createReadImageResizingListener requires attachments.readImageRequest and attachments.saveImages')
  }

  let disposed = false

  const listener = async (exec, result, next) => {
    // This is a waterfall observer, not the owner of the dispatch decision.
    const decision = await next()
    if (disposed || lifetimeSignal?.aborted === true || exec?.name !== 'read' || exec?.parent !== undefined
      || result?.isError !== false || !hasValidSignal(exec?.signal) || exec.signal.aborted
      || !decision || decision.kind !== 'accept' || Reflect.has(decision, 'content') || !Reflect.has(decision, 'value')) {
      return decision
    }

    try {
      const value = decision.value
      const content = value?.content
      if (!isRecord(value) || value.card !== 'read' || !Array.isArray(content)
        || content.length > MAX_CONTENT_BLOCKS || exec.signal.aborted || disposed || lifetimeSignal?.aborted === true) {
        return decision
      }

      let imageBlockCount = 0
      let totalSourceBytes = 0
      let invalidImageReference = false
      const sourceDimensions = new Map()
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'image') continue
        if (block.offloaded === true || !isSafeImageReference(block.attachment)) {
          invalidImageReference = true
          continue
        }
        imageBlockCount += 1
        if (imageBlockCount > MAX_IMAGE_BLOCKS) return decision
        const source = block.attachment
        const existingDimensions = sourceDimensions.get(source.attachmentId)
        if (existingDimensions) {
          if (existingDimensions.width !== source.width || existingDimensions.height !== source.height) invalidImageReference = true
          continue
        }
        sourceDimensions.set(source.attachmentId, { width: source.width, height: source.height })
        totalSourceBytes += source.bytes
        if (totalSourceBytes > MAX_TOTAL_SOURCE_BYTES) return decision
      }

      let dimensionNoteAllowed = !invalidImageReference
      const attempted = new Set()
      const candidates = []
      const candidateByAttachment = new Map()
      const target = { width: TARGET_DIMENSION, height: TARGET_DIMENSION, maxBytes: TARGET_MAX_BYTES }

      for (let index = 0; index < content.length; index += 1) {
        const block = content[index]
        if (!isRecord(block) || block.type !== 'image' || block.offloaded === true
          || !isSafeImageReference(block.attachment)) continue

        const source = block.attachment
        if (!shouldRequestVariant(source)) continue

        const existing = candidateByAttachment.get(source.attachmentId)
        if (existing) {
          existing.indices.push(index)
          continue
        }
        if (attempted.has(source.attachmentId)) continue
        attempted.add(source.attachmentId)

        let variant
        try {
          variant = await attachments.readImageRequest(source, target, exec.signal)
        } catch {
          // Resizing is advisory; preserve the exact tool result on any service error.
          return decision
        }
        if (disposed || lifetimeSignal?.aborted === true || exec.signal.aborted) return decision
        if (!validRequestVariant(variant, source)) {
          dimensionNoteAllowed = false
          continue
        }
        if (candidates.reduce((sum, item) => sum + item.variant.bytes, 0) + variant.bytes > MAX_TOTAL_DERIVATIVE_BYTES) {
          dimensionNoteAllowed = false
          continue
        }

        const candidate = {
          source,
          variant,
          indices: [index],
          name: safeName(source),
        }
        candidates.push(candidate)
        candidateByAttachment.set(source.attachmentId, candidate)
      }

      if (disposed || lifetimeSignal?.aborted === true || exec.signal.aborted) return decision
      if (candidates.length === 0) {
        if (!dimensionNoteAllowed) return decision
        const dimensions = [...sourceDimensions.values()].map(source => ({ source }))
        return appendDimensionContext(decision, dimensions)
      }

      let saved
      try {
        saved = await attachments.saveImages(candidates.map(candidate => ({
          data: candidate.variant.data,
          mediaType: candidate.variant.mediaType,
          ...(candidate.name === undefined ? {} : { name: candidate.name }),
        })))
      } catch {
        // saveImages validates the full batch before its durable commit.
        return decision
      }
      if (disposed || lifetimeSignal?.aborted === true || exec.signal.aborted
        || !Array.isArray(saved) || saved.length !== candidates.length) return decision

      const replacementByIndex = new Map()
      const resizedDimensions = new Map()
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex]
        const ref = saved[candidateIndex]
        if (!isSafeImageReference(ref) || !preservesAspectRatio(candidate.source, ref)
          || ref.bytes >= candidate.source.bytes
          || ref.bytes > TARGET_MAX_BYTES || ref.width > TARGET_DIMENSION || ref.height > TARGET_DIMENSION
          || ref.width > candidate.source.width || ref.height > candidate.source.height
          || ref.attachmentId === candidate.source.attachmentId) {
          dimensionNoteAllowed = false
          continue
        }
        const plainRef = toImageReference(ref)
        resizedDimensions.set(candidate.source.attachmentId, { width: ref.width, height: ref.height })
        for (const index of candidate.indices) replacementByIndex.set(index, plainRef)
      }
      if (replacementByIndex.size === 0) return decision

      const nextContent = content.map((block, index) => {
        const attachment = replacementByIndex.get(index)
        return attachment === undefined ? block : { ...block, attachment }
      })
      const resizedDecision = { ...decision, value: { ...value, content: nextContent } }
      if (!dimensionNoteAllowed) return resizedDecision
      const dimensions = [...sourceDimensions].map(([attachmentId, source]) => ({
        source,
        result: resizedDimensions.get(attachmentId),
      }))
      return appendDimensionContext(resizedDecision, dimensions)
    } catch {
      // Read-result and attachment adapters must never turn a successful Tool result
      // into a failed one because of malformed optional metadata.
      return decision
    }
  }

  return {
    listener,
    dispose() {
      disposed = true
    },
  }
}
