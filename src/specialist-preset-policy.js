const ALLOWED_TOOL_NAMES = new Set(['read', 'glob', 'grep'])

/** A bounded Tool-dispatch policy, not an OS/filesystem/network sandbox. */
export function apply(ctx) {
  if (typeof ctx.tools?.guard !== 'function' || typeof ctx.tools?.presentAs !== 'function') {
    throw new TypeError('dsh-omo specialist preset policy requires DSH tools.guard and tools.presentAs')
  }
  const presentNative = ctx.tools.presentAs('native')
  const guard = ctx.tools.guard(exec => {
    if (typeof exec?.name !== 'string' || !ALLOWED_TOOL_NAMES.has(exec.name)) {
      return 'dsh-omo read/search preset denies this Tool; use an approved read, glob, or grep Tool.'
    }
  })
  return () => {
    guard()
    presentNative()
  }
}

export const name = 'dsh-omo-read-search-policy'
export const inject = ['tools']
