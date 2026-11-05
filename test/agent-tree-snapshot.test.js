import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTreeSnapshot } from '../src/agent-tree-snapshot.js'

function child({ id, parentId, depth = 1, activity = 'inactive', mode = 'continuable', label = 'delegated work', hasChildren = false } = {}) {
  return { kind: 'child', id, parentId, depth, activity, mode, label, hasChildren }
}

function diagnostic({ id, parentId, depth = 1, reason = 'unavailable' } = {}) {
  return { kind: 'diagnostic', id, parentId, depth, reason }
}

test('projects only safe tree, diagnostic, and goal summary fields', async () => {
  const root = { id: 'root-1', prompt: 'root prompt must not escape' }
  const snapshot = await createAgentTreeSnapshot({
    agents: { roots: () => [root] },
    subagents: {
      listDescendants: async id => {
        assert.equal(id, root.id)
        return [
          {
            ...child({ id: 'child-1', parentId: root.id, activity: 'running', hasChildren: true }),
            prompt: 'child prompt must not escape',
            result: 'child result must not escape',
          },
          diagnostic({ id: 'child-2', parentId: root.id, depth: 2, reason: 'corrupt' }),
        ]
      },
    },
    goals: {
      get: agent => {
        assert.equal(agent, root)
        return {
          objective: 'Ship the feature',
          phase: 'active',
          roundsStarted: 2,
          maxGoalRounds: 8,
          blockedReason: { message: 'not part of this view' },
          secret: 'must not escape',
        }
      },
    },
    now: () => 1234,
  }).read()

  assert.deepEqual(snapshot, {
    available: true,
    scope: 'live-roots',
    updatedAt: 1234,
    truncated: false,
    limits: { maxRoots: 20, maxDescendantsPerRoot: 100 },
    note: 'Shows current runtime roots only; nonresident historical roots are omitted. Inactive means no resident DSH Session was observed; it does not encode completion, success, or external-process state. Prompts and results are not included.',
    roots: [{
      id: 'root-1',
      goal: { objective: 'Ship the feature', phase: 'active', roundsStarted: 2, maxGoalRounds: 8 },
      descendants: [
        { kind: 'child', id: 'child-1', parentId: 'root-1', depth: 1, activity: 'running', mode: 'continuable', label: 'delegated work', hasChildren: true },
        { kind: 'diagnostic', id: 'child-2', parentId: 'root-1', depth: 2, reason: 'corrupt' },
      ],
    }],
  })
  assert.doesNotMatch(JSON.stringify(snapshot), /prompt must not escape|result must not escape|must not escape/u)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

test('omits an absent goal and does not treat inactive as completion', async () => {
  const snapshot = await createAgentTreeSnapshot({
    agents: { roots: () => [{ id: 'root-2' }] },
    subagents: { listDescendants: async () => [child({ id: 'idle-child', parentId: 'root-2', activity: 'inactive' })] },
    goals: { get: () => undefined },
    now: 99,
  }).read()

  assert.equal(snapshot.available, true)
  assert.equal(Object.hasOwn(snapshot.roots[0], 'goal'), false)
  assert.deepEqual(snapshot.roots[0].descendants[0], {
    kind: 'child', id: 'idle-child', parentId: 'root-2', depth: 1,
    activity: 'inactive', mode: 'continuable', label: 'delegated work', hasChildren: false,
  })
  assert.match(snapshot.note, /Inactive means no resident DSH Session was observed; it does not encode completion, success/u)
  assert.equal(Object.hasOwn(snapshot.roots[0].descendants[0], 'complete'), false)
})

test('isolates descendant and goal failures to their root', async () => {
  const roots = [{ id: 'root-fails' }, { id: 'root-works' }, { id: 'root-goal-fails' }]
  const snapshot = await createAgentTreeSnapshot({
    agents: { roots: () => roots },
    subagents: {
      listDescendants: async id => {
        if (id === 'root-fails') throw new Error('private service error')
        return [child({ id: `${id}-child`, parentId: id })]
      },
    },
    goals: {
      get: agent => {
        if (agent.id === 'root-goal-fails') throw new Error('private goal error')
        return undefined
      },
    },
    now: () => 7,
  }).read()

  assert.equal(snapshot.available, true)
  assert.deepEqual(snapshot.roots.map(root => root.id), ['root-fails', 'root-works', 'root-goal-fails'])
  assert.deepEqual(snapshot.roots[0], { id: 'root-fails', descendants: [], unavailable: true })
  assert.equal(snapshot.roots[1].descendants[0].id, 'root-works-child')
  assert.deepEqual(snapshot.roots[2].descendants.map(row => row.id), ['root-goal-fails-child'])
  assert.equal(Object.hasOwn(snapshot.roots[2], 'goal'), false)
  assert.doesNotMatch(JSON.stringify(snapshot), /private service error|private goal error/u)
})

test('bounds roots and descendant rows and sanitizes all exposed text', async () => {
  const { maxRoots, maxDescendantsPerRoot } = {
    maxRoots: 20,
    maxDescendantsPerRoot: 100,
  }
  const rawRootId = 'root\u202e-0'
  const roots = Array.from({ length: maxRoots + 2 }, (_, index) => ({
    id: index === 0 ? rawRootId : `root-${index}`,
  }))
  const rawLabel = `safe\u0000 label\u202e${'L'.repeat(300)}`
  const rawObjective = `target\u202e\n${'O'.repeat(700)}`

  const snapshot = await createAgentTreeSnapshot({
    agents: { roots: () => roots },
    subagents: {
      listDescendants: async id => {
        if (id !== rawRootId) return []
        return Array.from({ length: maxDescendantsPerRoot + 3 }, (_, index) => child({
          id: `child-${index}`,
          parentId: rawRootId,
          label: index === 0 ? rawLabel : `label-${index}`,
        }))
      },
    },
    goals: {
      get: agent => agent.id === rawRootId
        ? { objective: rawObjective, phase: 'active', roundsStarted: 0, maxGoalRounds: 5 }
        : undefined,
    },
    now: () => 42,
  }).read()

  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.roots.length, maxRoots)
  assert.equal(snapshot.roots[0].id, 'root-0')
  assert.equal(snapshot.roots[0].descendants.length, maxDescendantsPerRoot)
  assert.equal(snapshot.roots[0].goal.objective.length, 500)
  assert.equal(snapshot.roots[0].descendants[0].label.length, 160)
  assert.equal(snapshot.roots[0].descendants[0].label.startsWith('safe label'), true)
  const unsafeText = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u
  const exposedText = [
    snapshot.roots[0].id,
    snapshot.roots[0].goal.objective,
    snapshot.roots[0].descendants[0].id,
    snapshot.roots[0].descendants[0].parentId,
    snapshot.roots[0].descendants[0].label,
  ]
  for (const value of exposedText) assert.doesNotMatch(value, unsafeText)
  assert.equal(JSON.parse(JSON.stringify(snapshot)).roots[0].goal.objective, snapshot.roots[0].goal.objective)
})

test('reports missing snapshot APIs without throwing or fabricating descendants', async () => {
  const noAgentApi = await createAgentTreeSnapshot({ now: () => 12 }).read()
  assert.equal(noAgentApi.available, false)
  assert.deepEqual(noAgentApi.roots, [])
  assert.equal(noAgentApi.updatedAt, 12)

  const noSubagentApi = await createAgentTreeSnapshot({
    agents: { roots: () => [{ id: 'root-1' }] },
    goals: { get: () => undefined },
    now: () => 13,
  }).read()
  assert.equal(noSubagentApi.available, false)
  assert.deepEqual(noSubagentApi.roots, [{ id: 'root-1', descendants: [], unavailable: true }])
  assert.match(noSubagentApi.note, /Required snapshot APIs are unavailable/u)
})

test('bounds concurrent root reads and forwards a cancellable deadline signal', async () => {
  const roots = Array.from({ length: 12 }, (_, index) => ({ id: `root-${index}` }))
  let active = 0
  let maxActive = 0
  const snapshot = await createAgentTreeSnapshot({
    agents: { roots: () => roots },
    subagents: {
      async listDescendants(_id, signal) {
        assert.ok(signal instanceof AbortSignal)
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return []
      },
    },
    now: () => 17,
  }).read()

  assert.equal(snapshot.roots.length, roots.length)
  assert.equal(snapshot.truncated, false)
  assert.equal(maxActive, 4)
})
