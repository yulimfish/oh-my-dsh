import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createProjectCommandAdapter } from '../src/project-commands.js'

const cwd = '/workspace/project'
const directory = `${cwd}/.opencode/commands`

function fixture(host) {
  const target = path => ({ targetKey: path, path })
  const file = target(`${directory}/review.md`)
  const fs = {
    resolve: async path => target(path.startsWith('/') ? path : `${cwd}/${path}`),
    contains: (root, child) => child.path === root.path || child.path.startsWith(`${root.path}/`),
    lstat: (path, options, signal) => {
      signal ??= options?.signal
      if (path === cwd) return host(signal)
      if (path === '.opencode' || path === directory) return { type: 'directory', version: path }
      if (path.endsWith('.md')) return host(signal)
      return undefined
    },
    stat: async target => target.path === file.path
      ? { type: 'file', version: 'file' }
      : { type: 'directory', version: target.path },
    listDir: async () => [{ name: 'review.md', type: 'file', target: file }],
    readBytes: async () => new TextEncoder().encode('---\ndescription: Review\n---\nReview.\n'),
  }
  return createProjectCommandAdapter(fs, { sessions: { get: id => ({ header: { id, cwd } }) } })
}

if (!process.env.OMO_ABORT_REJECTION_CHILD) {
  test('synchronous Host abort cannot abandon a derived rejection', () => {
    const env = { ...process.env, OMO_ABORT_REJECTION_CHILD: '1' }
    delete env.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, [
      '--unhandled-rejections=strict', '--test', import.meta.filename,
    ], { env, encoding: 'utf8', timeout: 5_000 })
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
    assert.match(child.stdout, /pass 1/u)
  })
} else {
  test('cancelled leased Host rejection is observed', async () => {
    const controller = new AbortController()
    let release
    const pending = new Promise((_, reject) => { release = reject })
    const adapter = fixture(() => { controller.abort(); return pending })
    const call = adapter.list({ id: 'parent' }, controller.signal)
    assert.equal(controller.signal.aborted, true, 'Host must synchronously trigger the abort')
    const outcome = call.then(value => ({ value }), error => ({ error }))
    await new Promise(resolve => setImmediate(resolve))
    const result = await outcome
    assert.ok(result.error, 'caller cancellation must settle the local scan')
    release(new Error('private late rejection'))
    await new Promise(resolve => setImmediate(resolve))
  })
}
