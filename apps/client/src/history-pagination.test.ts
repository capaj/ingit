import { describe, expect, test } from 'bun:test'
import type { CommitRow, HistoryWindowResponse } from '@ingit/rpc-contract'
import {
  mergeHistory,
  shouldApplyCommitScrollRequest,
  shouldRequestMoreHistory,
} from './history-pagination'

function row(sha: string): CommitRow {
  return {
    row: 0,
    sha,
    parentShas: [],
    authorName: 'Test',
    authorEmail: 'test@example.com',
    authorUnix: 0,
    committerUnix: 0,
    subject: sha,
    additions: 0,
    deletions: 0,
    locChanged: 0,
    refNames: [],
    lane: 0,
  }
}

function history(shas: string[], hasMoreAfter: boolean): HistoryWindowResponse {
  return {
    projectionId: shas.join('-'),
    rows: shas.map(row),
    edges: [],
    checkpointsKnownUntilRow: shas.length - 1,
    totalRowsKnown: shas.length,
    hasMoreBefore: false,
    hasMoreAfter,
    indexingState: 'warm',
  }
}

describe('history pagination', () => {
  test('prefetches once the viewport reaches halfway through loaded content', () => {
    expect(shouldRequestMoreHistory(399, 100, 1000)).toBe(false)
    expect(shouldRequestMoreHistory(400, 100, 1000)).toBe(true)
  })

  test('does not replay a handled commit scroll when a new history page arrives', () => {
    expect(shouldApplyCommitScrollRequest(null, 4, true)).toBe(true)
    expect(shouldApplyCommitScrollRequest(4, 4, true)).toBe(false)
    expect(shouldApplyCommitScrollRequest(4, 5, true)).toBe(true)
  })

  test('keeps an unhandled commit scroll pending until its target is loaded', () => {
    expect(shouldApplyCommitScrollRequest(null, 4, false)).toBe(false)
    expect(shouldApplyCommitScrollRequest(null, 4, true)).toBe(true)
  })

  test('adopts an expanded history prefix as the authoritative page', () => {
    const incoming = history(['a', 'b', 'c', 'd'], false)
    expect(mergeHistory(history(['a', 'b'], true), incoming)).toBe(incoming)
  })

  test('clears hasMoreAfter when a page contains no new commits', () => {
    const merged = mergeHistory(history(['a', 'b'], true), history(['b'], false))
    expect(merged.rows.map((entry) => entry.sha)).toEqual(['a', 'b'])
    expect(merged.hasMoreAfter).toBe(false)
  })
})
