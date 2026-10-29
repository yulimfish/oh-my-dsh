import assert from 'node:assert/strict'
import test from 'node:test'
import { createLspNavigationTools } from '../src/lsp-tools.js'

const cwd = '/workspace/project'
const args = { filePath: 'src/main.js', line: 1, character: 0 }
const exec = { agent: { id: 'session-1' } }

test('throwing then getters on fulfilled native Host promises do not exhaust the filesystem gate', { timeout: 3000 }, async () => {
  let resolveCalls = 0
  const service = {
    async query() {
      return { kind: 'locations', resolvedWorkspaceUri: 'file:///workspace/project', locations: [] }
    },
  }
  const sessions = {
    get(id) {
      return { header: { id, cwd } }
    },
  }
  const fs = {
    resolve(path, options) {
      resolveCalls += 1
      const root = options?.cwd ?? cwd
      const resolvedPath = path.startsWith('/') ? path : `${root}/${path}`
      const hostPromise = Promise.resolve({ path: resolvedPath })
      Object.defineProperty(hostPromise, 'then', {
        get() {
          throw new Error('Host then getter failed')
        },
      })
      return hostPromise
    },
    contains(root, file) {
      return file.path === root.path || file.path.startsWith(`${root.path}/`)
    },
    processPath(target) {
      return target.path
    },
  }
  const tool = createLspNavigationTools(service, sessions, fs)
    .find(candidate => candidate.name === 'lsp_goto_definition')

  for (let attempt = 1; attempt <= 65; attempt += 1) {
    const outcome = await tool.execute(args, exec).then(
      value => ({ value }),
      error => ({ error }),
    )
    if (outcome.error) {
      assert.doesNotMatch(
        outcome.error.message,
        /busy/iu,
        `attempt ${attempt} became busy after a fulfilled Host promise with a throwing then getter`,
      )
      assert.match(outcome.error.message, /Could not resolve the requested file/u)
    } else {
      assert.equal(outcome.value.operation, 'goToDefinition')
    }
  }

  assert.ok(resolveCalls >= 65, 'every attempt must get past the filesystem gate')
})

test('native Promise accessor failures cannot bypass the lease bound', async t => {
  const sessions = { get: id => ({ header: { id, cwd } }) }
  const service = { async query() { throw new Error('must not query') } }
  const fs = {
    contains: () => true,
    processPath: target => target.path,
  }
  for (const field of ['constructor', 'then']) {
    const host = Promise.reject(new Error('private Host rejection'))
    void host.catch(() => {}) // Isolate lease semantics from Node's unhandled-rejection process policy.
    Object.defineProperty(host, field, { get() { throw new Error('private accessor') }, configurable: true })
    const unhandled = []
    const listener = (promise, reason) => unhandled.push({ promise, reason })
    fs.resolve = () => host
    const tool = createLspNavigationTools(service, sessions, fs)[0]
    try {
      await assert.rejects(tool.execute(args, exec), error => {
        assert.match(error.message, /Could not resolve the requested file/u)
        assert.doesNotMatch(error.message, /private/u)
        return true
      })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(unhandled.length, 0)
    } finally {
      process.off('unhandledRejection', listener)
    }
  }
})
