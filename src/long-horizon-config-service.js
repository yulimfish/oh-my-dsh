const ENTRY_ID = 'dsh-omo'
export const LONG_HORIZON_CONFIG_KEYS = Object.freeze([
  'enableFocusChain',
  'enableRepeatedCallAdvisory',
  'enableProgressContext',
  'enableGoalCompletionReview',
  'enableVerifyCommand',
  'enableTaskHandoffCommand',
])
const CONFIG_KEYS = Object.freeze([...LONG_HORIZON_CONFIG_KEYS, 'enableTaskResultTool'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function findEntry(entries) {
  return entries.find(entry => entry.id === ENTRY_ID || entry.patchId === ENTRY_ID || entry.id === `include:${ENTRY_ID}`)
}

function bool(value) {
  return value === true
}

export function createLongHorizonConfigService(configEditor) {
  if (!configEditor || typeof configEditor.entries !== 'function'
    || typeof configEditor.configuration !== 'function' || typeof configEditor.edit !== 'function') {
    throw new TypeError('Long-horizon settings require DSH configEditor entries, configuration, and edit.')
  }
  return {
    async read() {
      const entry = findEntry(configEditor.entries())
      if (!entry) return { found: false, values: {} }
      const layer = configEditor.configuration().find(item => item.entry === entry)
      const values = {}
      for (const key of CONFIG_KEYS) {
        values[key] = layer?.override?.[key] === undefined ? bool(layer?.inherited?.[key]) : bool(layer.override[key])
      }
      return { found: true, entry, values }
    },
    async update(changes) {
      if (!isPlainObject(changes)) throw new TypeError('Settings changes must be an object.')
      const entry = findEntry(configEditor.entries())
      if (!entry) return { found: false }
      const unknown = Object.keys(changes).filter(key => !CONFIG_KEYS.includes(key))
      if (unknown.length > 0 || Object.values(changes).some(value => typeof value !== 'boolean')) {
        throw new TypeError('Only long-horizon boolean settings can be changed.')
      }
      await configEditor.edit(entry, (current, inherited) => {
        const next = { ...current }
        for (const [key, value] of Object.entries(changes)) next[key] = value
        if (changes.enableTaskHandoffCommand === true) next.enableTaskResultTool = true
        if (changes.enableTaskResultTool === false) next.enableTaskHandoffCommand = false
        return next
      })
      return this.read()
    },
  }
}
