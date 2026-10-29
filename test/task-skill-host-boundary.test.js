import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'

// The Host's caller-facing promise lease is not a hard limit on provider work.
test('aborting a real Host skill lookup settles it while the provider remains pending', async () => {
  const ctx = new Context()
  ctx.logger = { warn() {} }
  const skills = new SkillRegistry(ctx)
  const candidate = {
    name: 'boundary', description: 'Boundary test', source: 'test', provider: 'deferred',
    invocation: { modelInvocable: true, userInvocable: true }, rank: 1, locator: 'local',
  }
  let resolveProvider, signalSeen, markStarted
  let providerSettled = false
  const started = new Promise(resolve => { markStarted = resolve })
  const deferred = new Promise(resolve => { resolveProvider = resolve })
  const providerResult = deferred.then(value => { providerSettled = true; return value })
  const dispose = skills.registerProvider(() => ({
    name: 'deferred',
    list: async () => [candidate],
    get: (_candidate, options) => {
      signalSeen = options.signal
      markStarted()
      return providerResult // Deliberately ignores cancellation; no network involved.
    },
  }))
  const controller = new AbortController()
  const reason = new Error('caller aborted')
  const lookup = skills.get('boundary', { signal: controller.signal })
  // Attach a rejection handler immediately, including if an assertion fails.
  const outcome = lookup.then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error }),
  )
  const bounded = (promise, phase) => {
    let timer
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${phase}`)), 5000) }),
    ]).finally(() => clearTimeout(timer))
  }
  try {
    await bounded(started, 'provider start')
    assert.equal(signalSeen, controller.signal)
    controller.abort(reason)
    const result = await bounded(outcome, 'Host lookup cancellation')
    assert.equal(result.status, 'rejected')
    assert.equal(result.error, reason)
    assert.equal(providerSettled, false, 'Host cancellation must not be mistaken for provider settlement')
  } finally {
    controller.abort()
    resolveProvider(undefined)
    await providerResult
    await dispose()
  }
})
