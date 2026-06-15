import { describe, test, expect } from 'bun:test'
import { parseWorktreeChanges } from './worktree-changes-parser.js'

describe('parseWorktreeChanges', () => {
  test('splits staged, unstaged, untracked and a path with both sides', () => {
    const lines = [
      '# branch.oid abc123',
      '# branch.head main',
      // staged add
      '1 A. N... 000000 100644 100644 0000000 1111111 added.ts',
      // unstaged modify
      '1 .M N... 100644 100644 100644 2222222 2222222 changed.ts',
      // staged + unstaged on the same file
      '1 MM N... 100644 100644 100644 3333333 4444444 both.ts',
      // untracked
      '? new-file.ts',
    ]

    const result = parseWorktreeChanges(lines)

    expect(result.branch).toBe('main')
    expect(result.headSha).toBe('abc123')

    expect(result.staged).toEqual([
      { path: 'added.ts', status: 'A' },
      { path: 'both.ts', status: 'M' },
    ])
    expect(result.unstaged).toEqual([
      { path: 'changed.ts', status: 'M' },
      { path: 'both.ts', status: 'M' },
      { path: 'new-file.ts', status: '?' },
    ])
  })

  test('handles renames and reports detached head as no branch', () => {
    const lines = [
      '# branch.oid deadbeef',
      '# branch.head (detached)',
      '2 R. N... 100644 100644 100644 5555555 5555555 R100 new-name.ts\told-name.ts',
    ]

    const result = parseWorktreeChanges(lines)

    expect(result.branch).toBeUndefined()
    expect(result.staged).toEqual([
      { path: 'new-name.ts', oldPath: 'old-name.ts', status: 'R' },
    ])
    expect(result.unstaged).toEqual([])
  })
})
