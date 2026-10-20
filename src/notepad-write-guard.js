import { normalize, sep } from 'node:path'

const MAX_TOOL_NAME_CHARS = 128
const MAX_NOTEPAD_PATH_CHARS = 4_096
export const NOTEPAD_WRITE_PATH_LIMIT_REASON = `Refused: Write path exceeds ${MAX_NOTEPAD_PATH_CHARS} UTF-16 code units; cannot verify it is outside protected notepad roots.`
const NOTEPAD_ROOTS = Object.freeze([
  Object.freeze(['.omo', 'notepads']),
  Object.freeze(['.sisyphus', 'notepads']),
])

export const NOTEPAD_WRITE_GUARD_REASON = 'Refused: .omo/notepads and .sisyphus/notepads are append-only history. Do not bypass this Tool guard with another tool or direct filesystem access; report the original Edit failure and ask the user for guidance.'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value) {
  if (!isObject(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function ownDataValue(value, key) {
  if (!isObject(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function notepadPathArgument(args) {
  if (!isPlainRecord(args)) return undefined
  let candidate = ownDataValue(args, 'filePath')
  if (candidate === null || candidate === undefined) candidate = ownDataValue(args, 'path')
  if (candidate === null || candidate === undefined) candidate = ownDataValue(args, 'file_path')
  return candidate
}

function containsNotepadRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NOTEPAD_PATH_CHARS) return false
  let segments
  try {
    segments = normalize(value).split(sep).filter(Boolean)
  } catch {
    return false
  }
  return NOTEPAD_ROOTS.some(root => {
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (segments[index] === root[0] && segments[index + 1] === root[1]) return true
    }
    return false
  })
}

export function createNotepadWriteGuard() {
  return execution => {
    const name = ownDataValue(execution, 'name')
    if (typeof name !== 'string' || name.length > MAX_TOOL_NAME_CHARS || name.toLowerCase() !== 'write') return undefined
    const args = ownDataValue(execution, 'arguments')
    const selectedPath = notepadPathArgument(args)
    if (typeof selectedPath === 'string' && selectedPath.length > MAX_NOTEPAD_PATH_CHARS) {
      return NOTEPAD_WRITE_PATH_LIMIT_REASON
    }
    return containsNotepadRoot(selectedPath) ? NOTEPAD_WRITE_GUARD_REASON : undefined
  }
}

export function registerNotepadWriteGuard(ctx) {
  if (!ctx?.tools || typeof ctx.tools.guard !== 'function') {
    throw new TypeError('registerNotepadWriteGuard requires DSH tools.guard')
  }
  const disposeGuard = ctx.tools.guard(createNotepadWriteGuard())
  if (typeof disposeGuard !== 'function') throw new TypeError('DSH tools.guard must return a disposer')
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeGuard()
  }
}
