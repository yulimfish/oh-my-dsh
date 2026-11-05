import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'

const ALLOWED_TOOL_NAMES = new Set(['read', 'glob', 'grep'])

/** A bounded Tool-dispatch policy, not an OS/filesystem/network sandbox. */
export function apply(ctx) {
  if (typeof ctx.tools?.guard !== 'function' || typeof ctx.tools?.setExecutor !== 'function') {
    throw new TypeError('dsh-omo specialist preset policy requires DSH tools.guard and tools.setExecutor')
  }
  const selectNative = ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  if (typeof selectNative !== 'function') {
    throw new TypeError('DSH tools.setExecutor must return a disposer')
  }
  let removeGuard
  try {
    removeGuard = ctx.tools.guard(exec => {
      if (typeof exec?.name !== 'string' || !ALLOWED_TOOL_NAMES.has(exec.name)) {
        return 'dsh-omo read/search preset denies this Tool; use an approved read, glob, or grep Tool.'
      }
    })
    if (typeof removeGuard !== 'function') throw new TypeError('DSH tools.guard must return a disposer')
  } catch (error) {
    selectNative()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    removeGuard()
    selectNative()
  }
}

export const name = 'dsh-omo-read-search-policy'
export const inject = ['tools']
