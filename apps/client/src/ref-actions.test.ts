import { describe, expect, test } from 'bun:test'
import type { RefSummary, WorktreeSummary } from '@ingit/rpc-contract'
import { findCheckoutWorktree, isForcePushEligible, isNonFastForwardPushError } from './ref-actions'

function branch(overrides: Partial<RefSummary> = {}): RefSummary {
  return {
    name: 'refs/heads/main',
    shortName: 'main',
    kind: 'head',
    targetSha: 'local',
    ...overrides,
  }
}

function worktree(overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: '/repo/other',
    headSha: 'local',
    branchRef: 'refs/heads/main',
    branchShortName: 'main',
    isCurrent: false,
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    ...overrides,
  }
}

describe('findCheckoutWorktree', () => {
  test('offers a checkout choice for origin/main even without a configured upstream', () => {
    const occupied = worktree()
    const remote = branch({ name: 'refs/remotes/origin/main', shortName: 'origin/main', kind: 'remote' })

    expect(findCheckoutWorktree(remote, [occupied])).toBe(occupied)
    expect(findCheckoutWorktree(branch(), [occupied])).toBe(occupied)
  })

  test('matches the checkout branch name rather than another branch tracking the remote', () => {
    const remote = branch({ name: 'refs/remotes/origin/main', shortName: 'origin/main', kind: 'remote' })
    const otherBranch = worktree({ branchRef: 'refs/heads/review', branchShortName: 'review' })

    expect(findCheckoutWorktree(remote, [otherBranch])).toBeNull()
  })

  test('preserves slashes in remote branch names', () => {
    const remote = branch({ name: 'refs/remotes/upstream/feature/blog', shortName: 'upstream/feature/blog', kind: 'remote' })
    const occupied = worktree({ branchRef: 'refs/heads/feature/blog', branchShortName: 'feature/blog' })

    expect(findCheckoutWorktree(remote, [occupied])).toBe(occupied)
  })

  test('ignores the current worktree and detached worktrees at the same commit', () => {
    expect(findCheckoutWorktree(branch(), [
      worktree({ isCurrent: true }),
      worktree({ detached: true, branchRef: undefined, branchShortName: undefined }),
    ])).toBeNull()
  })

  test('does not offer unavailable worktrees or branch choices for tags', () => {
    expect(findCheckoutWorktree(branch(), [worktree({ prunable: true }), worktree({ bare: true })])).toBeNull()
    expect(findCheckoutWorktree(branch({ name: 'refs/tags/main', kind: 'tag' }), [worktree()])).toBeNull()
    expect(findCheckoutWorktree(null, [worktree()])).toBeNull()
  })
})

describe('isForcePushEligible', () => {
  test('rejects an outdated local branch', () => {
    expect(isForcePushEligible(branch({ ahead: 0, behind: 3 }))).toBe(false)
  })

  test('rejects ordinary divergence without a verified rebase', () => {
    expect(isForcePushEligible(branch({ ahead: 2, behind: 3 }))).toBe(false)
  })

  test('allows a diverged branch marked by a history-rewriting rebase', () => {
    expect(isForcePushEligible(branch({ ahead: 2, behind: 3, forcePushEligible: true }))).toBe(true)
  })

  test('still rejects a marked branch that is only behind', () => {
    expect(isForcePushEligible(branch({ ahead: 0, behind: 3, forcePushEligible: true }))).toBe(false)
  })
})

describe('isNonFastForwardPushError', () => {
  test('accepts the typed non-fast-forward conflict', () => {
    expect(isNonFastForwardPushError({
      code: 'CONFLICT',
      data: { reason: 'non-fast-forward' },
    })).toBe(true)
  })

  test('rejects unrelated conflicts', () => {
    expect(isNonFastForwardPushError({
      code: 'CONFLICT',
      data: { reason: 'branch-in-use' },
    })).toBe(false)
    expect(isNonFastForwardPushError({ code: 'CONFLICT' })).toBe(false)
  })
})
