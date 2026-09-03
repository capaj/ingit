import { describe, expect, test } from 'bun:test'
import type {
  CommitRow,
  HistoryWindowResponse,
  RefSummary,
  WorktreeChangesResponse,
} from '@ingit/rpc-contract'
import {
  deriveGraphModel,
  getGraphModelCacheStats,
  resetGraphModelCacheStats,
} from './graph-model'

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
    )
    const fromLinked = deriveGraphModel(
      input,
      detachedRefs,
      detachedChanges,
      '/repo/linked',
      sharedStates,
      true,
      false,
    )

    expect(fromMain?.renderedRows.map((entry) => entry.lane)).toEqual([1, 0, 0])
    expect(fromLinked?.renderedRows.map((entry) => entry.lane)).toEqual(
      fromMain?.renderedRows.map((entry) => entry.lane),
    )
  })
})
