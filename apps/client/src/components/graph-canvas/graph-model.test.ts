import { describe, expect, test } from 'bun:test'
import type {
  CommitRow,
  HistoryWindowResponse,
  RefSummary,
  WorktreeChangesResponse,
  WorktreeGraphState,
} from '@ingit/rpc-contract'
import {
  deriveGraphModel,
  getGraphModelCacheStats,
  resetGraphModelCacheStats,
} from './graph-model'
import { LANE_WIDTH, NODE_SPACING_Y } from './layout'
import { StableLaneLayout } from './stable-lanes'

function row(sha: string, parentShas: string[], lane: number, refNames: string[] = []): CommitRow {
  return {
    row: 0,
    sha,
    parentShas,
    authorName: 'Test',
    authorEmail: 'test@example.com',
    authorUnix: 0,
    committerUnix: 0,
    subject: sha,
    additions: 0,
    deletions: 0,
    locChanged: 0,
    refNames,
    lane,
  }
}

function history(rows: CommitRow[]): HistoryWindowResponse {
  return {
    projectionId: rows.map((entry) => entry.sha).join('-'),
    rows,
    edges: [],
    hasMoreBefore: false,
    hasMoreAfter: false,
    totalRowsKnown: rows.length,
    checkpointsKnownUntilRow: rows.length - 1,
    indexingState: 'warm',
  }
}

const refs: RefSummary[] = [{
  name: 'refs/heads/main',
  shortName: 'main',
  kind: 'head',
  targetSha: 'tip',
  isCurrent: true,
  ahead: 0,
  behind: 0,
}]

const cleanWorktree: WorktreeChangesResponse = {
  headSha: 'tip',
  branch: 'main',
  staged: [],
  unstaged: [],
}

const dirtyWorktree: WorktreeChangesResponse = {
  ...cleanWorktree,
  unstaged: [{ path: 'pending.txt', status: '?' }],
}

describe('derived graph model cache', () => {
  test('keeps rendered lanes across refreshed projections and growing history', () => {
    const stableLanes = new StableLaneLayout()
    const derive = (rows: CommitRow[]) => deriveGraphModel(
      history(rows), refs, cleanWorktree, '/repo', [], true, false, stableLanes,
    )!
    const initial = derive([row('tip', ['base'], 0), row('branch', ['older'], -2)])
    const refreshed = derive([
      row('new-tip', ['branch'], 3), row('tip', ['base'], 1),
      row('branch', ['older'], 3), row('base', [], 1), row('older', [], 3),
    ])
    const initialLanes = Object.fromEntries(initial.renderedRows.map((row) => [row.sha, row.lane]))
    expect(Object.fromEntries(refreshed.renderedRows.map((row) => [row.sha, row.lane])))
      .toMatchObject({ ...initialLanes, 'new-tip': -1, base: 0, older: -1 })
    expect(derive([row('tip', ['base'], -3), row('branch', ['older'], 8)]).renderedRows.map((row) => row.lane))
      .toEqual([0, -1])
  })

  test('reuses the complete model for unchanged graph input references', () => {
    const input = history([
      row('tip', ['base'], 0, ['main']),
      row('base', [], 0),
    ])
    resetGraphModelCacheStats()

    const first = deriveGraphModel(input, refs, cleanWorktree, '/repo', [], true, true)
    const second = deriveGraphModel(input, refs, cleanWorktree, '/repo', [], true, true)

    expect(second).toBe(first)
    expect(getGraphModelCacheStats()).toMatchObject({
      requests: 2,
      referenceHits: 1,
      builds: 1,
    })
  })

  test('reuses topology work while rebinding authoritative row objects', () => {
    const optimisticRows = [
      row('tip', ['base'], 0, ['main']),
      row('base', [], 0),
    ]
    const authoritativeRows = optimisticRows.map((entry) => ({
      ...entry,
      subject: `server:${entry.subject}`,
    }))
    resetGraphModelCacheStats()

    const optimistic = deriveGraphModel(history(optimisticRows), refs, cleanWorktree, '/repo', [], true, false)
    const authoritative = deriveGraphModel(history(authoritativeRows), refs, cleanWorktree, '/repo', [], true, false)

    expect(authoritative).not.toBe(optimistic)
    expect(authoritative?.layout.nodes[0]?.row).toBe(authoritativeRows[0])
    expect(authoritative?.layout.nodes[0]?.row.subject).toBe('server:tip')
    expect(getGraphModelCacheStats()).toMatchObject({
      requests: 2,
      topologyHits: 1,
      builds: 1,
    })
  })

  test('routes every dirty worktree identically from either linked checkout', () => {
    const input = history([
      row('upstream', ['tip'], 0, ['origin/main']),
      row('tip', ['base'], 0, ['main']),
      row('base', [], 0),
    ])
    const sharedStates = [
      {
        path: '/repo/main',
        headSha: 'tip',
        branch: 'main',
        changeCount: 1,
        conflictedCount: 0,
      },
      {
        path: '/repo/linked',
        headSha: 'base',
        changeCount: 0,
        conflictedCount: 0,
      },
    ]
    const detachedRefs = refs.map(({ isCurrent: _isCurrent, ...ref }) => ref)
    const detachedChanges = { ...cleanWorktree, branch: undefined, headSha: 'base' }

    const fromMain = deriveGraphModel(
      input,
      refs,
      dirtyWorktree,
      '/repo/main',
      sharedStates,
      true,
      false,
      new StableLaneLayout(),
    )
    const fromLinked = deriveGraphModel(
      input,
      detachedRefs,
      detachedChanges,
      '/repo/linked',
      sharedStates,
      true,
      false,
      new StableLaneLayout(),
    )

    expect(fromMain?.renderedRows.map((entry) => entry.lane)).toEqual([1, 0, 0])
    expect(fromLinked?.renderedRows.map((entry) => entry.lane)).toEqual(
      fromMain?.renderedRows.map((entry) => entry.lane),
    )
  })

  test.each([false, true])('keeps a linked rebase clear of commits with stable lanes (already loaded: %s)', (alreadyLoaded) => {
    const input = history([
      row('tip', ['upstream'], 0, ['main']),
      row('upstream', ['base'], 0, ['origin/main']),
      row('base', [], 0),
    ])
    const stableLanes = new StableLaneLayout()
    const sharedStates: WorktreeGraphState[] = [{
      path: '/repo/linked',
      headSha: 'upstream',
      rebaseHeadSha: 'replayed',
      changeCount: 6,
      conflictedCount: 6,
    }]
    const derive = (states: WorktreeGraphState[]) => deriveGraphModel(
      input, refs, dirtyWorktree, '/repo/main', states, true, false, stableLanes,
    )!
    if (alreadyLoaded) derive([])

    const model = derive(sharedStates)
    const main = model.layout.shaToNode.get('tip')!
    const linkedHead = model.layout.shaToNode.get('upstream')!
    // The pending rebase occupies the row above its HEAD. Its circle and
    // conflict badge must not cover the main commit or its branch label.
    expect(linkedHead.y - NODE_SPACING_Y).toBe(main.y)
    expect(main.x - linkedHead.x).toBeGreaterThanOrEqual(LANE_WIDTH)
    expect(derive(sharedStates).renderedRows.map((entry) => entry.lane))
      .toEqual(model.renderedRows.map((entry) => entry.lane))

    // Once the rebase is resolved, restore the underlying stable lanes.
    expect(derive([]).renderedRows.map((entry) => entry.lane)).toEqual([0, 0, 0])
    expect(input.rows.map((entry) => entry.lane)).toEqual([0, 0, 0])
  })
})
