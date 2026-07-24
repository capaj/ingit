/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import type { CommitRow, RefSummary } from '@ingit/rpc-contract'
import {
  predictRebase,
  predictWorktreeAfterCheckout,
  predictWorktreeAfterCommit,
  rebasePreviewUnavailableReason,
} from './optimistic-graph'

function row(sha: string, parentShas: string[], refNames: string[] = [], committerUnix = 100): CommitRow {
  return {
    row: 0,
    sha,
    parentShas,
    authorName: 'Test Author',
    authorEmail: 'test@example.com',
    authorUnix: committerUnix,
    committerUnix,
    subject: sha,
    additions: 1,
    deletions: 0,
    locChanged: 1,
    refNames,
    lane: 0,
  }
}

function branch(shortName: string, targetSha: string, isCurrent = false): RefSummary {
  return {
    name: `refs/heads/${shortName}`,
    shortName,
    kind: 'head',
    targetSha,
    isCurrent,
  }
}

describe('predictRebase', () => {
  test('places rewritten commits ahead of unrelated tips like date-ordered git history', () => {
    const rows = [
      row('banner', ['activity'], ['banner'], 190),
      row('refactor-2', ['refactor-1'], ['refactor'], 180),
      row('refactor-1', ['base'], [], 170),
      row('main', ['activity'], ['main'], 160),
      row('activity', ['base'], [], 150),
      row('payments-2', ['payments-1'], ['payments'], 140),
      row('payments-1', ['base'], [], 130),
      row('base', ['root'], ['staging'], 120),
      row('root', [], [], 110),
    ]
    const refs = [
      branch('refactor', 'refactor-2', true),
      branch('main', 'main'),
      branch('banner', 'banner'),
      branch('payments', 'payments-2'),
      branch('staging', 'base'),
    ]
    const beforeRewrite = Math.floor(Date.now() / 1000)

    const prediction = predictRebase(rows, refs, 'main')

    expect(prediction).not.toBeNull()
    expect(prediction!.rows.map((commit) => commit.sha)).toEqual([
      'refactor-2',
      'refactor-1',
      'banner',
      'main',
      'activity',
      'payments-2',
      'payments-1',
      'base',
      'root',
    ])
    expect(prediction!.rows.find((commit) => commit.sha === 'refactor-1')?.parentShas).toEqual(['main'])
    expect(prediction!.rows.find((commit) => commit.sha === 'refactor-1')?.committerUnix).toBeGreaterThanOrEqual(beforeRewrite)
    expect(rebasePreviewUnavailableReason(rows, refs, 'main')).toBeNull()
  })

  test('explains when merge commits make the preview unreliable', () => {
    const rows = [
      row('feature-tip', ['merge'], ['feature'], 200),
      row('merge', ['main-base', 'side-change'], [], 190),
      row('side-change', ['base'], [], 180),
      row('onto', ['main-base'], ['main'], 170),
      row('main-base', ['base'], [], 160),
      row('base', [], [], 150),
    ]
    const refs = [
      branch('feature', 'feature-tip', true),
      branch('main', 'onto'),
    ]

    expect(predictRebase(rows, refs, 'main')).toBeNull()
    expect(rebasePreviewUnavailableReason(rows, refs, 'main')).toBe('merge-commits')
  })

  test('explains when the target is outside the loaded history', () => {
    const rows = [row('feature-tip', ['base'], ['feature'], 200)]
    const refs = [
      branch('feature', 'feature-tip', true),
      branch('main', 'onto'),
    ]

    expect(rebasePreviewUnavailableReason(rows, refs, 'main')).toBe('history-not-loaded')
  })
})

describe('predictWorktreeAfterCommit', () => {
  test('makes the optimistic worktree clean when every change was staged', () => {
    const prediction = predictWorktreeAfterCommit({
      branch: 'main',
      headSha: 'old-head',
      staged: [{ path: 'committed.ts', status: 'M' }],
      unstaged: [],
    }, 'optimistic-commit')

    expect(prediction.staged).toEqual([])
    expect(prediction.unstaged).toEqual([])
    expect(prediction.headSha).toBe('optimistic-commit')
  })

  test('consumes staged files while preserving genuinely unstaged changes', () => {
    const changes = {
      branch: 'main',
      headSha: 'old-head',
      staged: [{ path: 'committed.ts', status: 'M' as const }],
      unstaged: [{ path: 'still-dirty.ts', status: 'M' as const }],
    }

    const prediction = predictWorktreeAfterCommit(changes, 'optimistic-commit')

    expect(prediction).toEqual({
      branch: 'main',
      headSha: 'optimistic-commit',
      staged: [],
      unstaged: [{ path: 'still-dirty.ts', status: 'M' }],
    })
    expect(changes.staged).toHaveLength(1)
  })
})

describe('predictWorktreeAfterCheckout', () => {
  test('keeps dirty files while moving their anchor to the destination branch', () => {
    const changes = {
      branch: 'main',
      headSha: 'main-head',
      staged: [{ path: 'staged.ts', status: 'M' as const }],
      unstaged: [{ path: 'unstaged.ts', status: 'M' as const }],
    }

    const prediction = predictWorktreeAfterCheckout(changes, 'feature-head', 'feature')

    expect(prediction).toEqual({
      branch: 'feature',
      headSha: 'feature-head',
      staged: [{ path: 'staged.ts', status: 'M' }],
      unstaged: [{ path: 'unstaged.ts', status: 'M' }],
    })
    expect(changes).toEqual({
      branch: 'main',
      headSha: 'main-head',
      staged: [{ path: 'staged.ts', status: 'M' }],
      unstaged: [{ path: 'unstaged.ts', status: 'M' }],
    })
  })

  test('removes the branch name for a detached checkout', () => {
    const prediction = predictWorktreeAfterCheckout({
      branch: 'main',
      headSha: 'main-head',
      staged: [],
      unstaged: [{ path: 'dirty.ts', status: 'M' }],
    }, 'detached-head', null)

    expect(prediction.branch).toBeUndefined()
    expect(prediction.headSha).toBe('detached-head')
    expect(prediction.unstaged).toHaveLength(1)
  })
})
