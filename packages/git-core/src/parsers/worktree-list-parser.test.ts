import { describe, expect, test } from 'bun:test'
import { parseWorktreeList } from './worktree-list-parser.js'

describe('parseWorktreeList', () => {
  test('parses branch, detached, locked, and prunable worktrees from NUL porcelain', () => {
    const output = [
      'worktree /repo/main',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /tmp/feature tree',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/nested',
      'locked agent owns it',
      '',
      'worktree /tmp/detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
      'worktree /gone',
      'HEAD 4444444444444444444444444444444444444444',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\0')

    expect(parseWorktreeList(output, '/repo/main')).toEqual([
      {
        path: '/repo/main',
        headSha: '1111111111111111111111111111111111111111',
        branchRef: 'refs/heads/main',
        branchShortName: 'main',
        isCurrent: true,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/tmp/feature tree',
        headSha: '2222222222222222222222222222222222222222',
        branchRef: 'refs/heads/feature/nested',
        branchShortName: 'feature/nested',
        isCurrent: false,
        detached: false,
        bare: false,
        locked: true,
        lockedReason: 'agent owns it',
        prunable: false,
      },
      {
        path: '/tmp/detached',
        headSha: '3333333333333333333333333333333333333333',
        isCurrent: false,
        detached: true,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/gone',
        headSha: '4444444444444444444444444444444444444444',
        isCurrent: false,
        detached: true,
        bare: false,
        locked: false,
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      },
    ])
  })
})
