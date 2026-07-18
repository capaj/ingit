import { describe, expect, test } from 'bun:test'
import type { CommitRow } from '@ingit/rpc-contract'
import { routeUpstreamAroundWorktree } from './worktree-lane-layout'

function row(
  sha: string,
  parentShas: string[],
  lane: number,
  refNames: string[] = [],
): CommitRow {
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

describe('worktree-aware lane layout', () => {
  test('creates a new rightmost gutter when the existing outer gutter is occupied', () => {
    const rows = [
      row('feature', ['upstream'], 1, ['origin/feature']),
      row('upstream', ['head'], 0, ['origin/dev']),
      row('side-a', ['side-b'], -2),
      row('side-b', ['base'], -2),
      row('main', ['main-parent', 'head'], 2, ['main']),
      row('head', ['base'], 0, ['dev']),
      row('base', [], 0),
    ]

    const routed = routeUpstreamAroundWorktree(rows, 'dev')

    expect(routed.find((entry) => entry.sha === 'upstream')?.lane).toBe(3)
    expect(routed.find((entry) => entry.sha === 'head')?.lane).toBe(0)
    expect(routed.find((entry) => entry.sha === 'feature')?.lane).toBe(1)
    expect(rows.find((entry) => entry.sha === 'upstream')?.lane).toBe(0)
  })

  test('moves the complete same-lane upstream rail together', () => {
    const rows = [
      row('upstream-tip', ['upstream-base'], 0, ['origin/dev']),
      row('upstream-base', ['head'], 0),
      row('head', ['base'], 0, ['dev']),
      row('base', [], 0),
    ]

    const routed = routeUpstreamAroundWorktree(rows, 'dev')

    expect(routed.slice(0, 2).map((entry) => entry.lane)).toEqual([1, 1])
    expect(routed[2].lane).toBe(0)
  })

  test('uses the right gutter when it is the only side gutter', () => {
    const rows = [
      row('left-tip', ['left-base'], -1),
      row('upstream', ['head'], 0, ['origin/dev']),
      row('left-base', ['base'], -1),
      row('head', ['base'], 0, ['dev']),
      row('base', [], 0),
    ]

    const routed = routeUpstreamAroundWorktree(rows, 'dev')

    expect(routed.find((entry) => entry.sha === 'upstream')?.lane).toBe(1)
  })

  test('reuses the rightmost gutter above HEAD instead of sharing a crowded inner gutter', () => {
    const rows = [
      row('upstream', ['head'], 0, ['origin/dev']),
      row('left-tip', ['left-base'], -1),
      row('inner-tip', ['inner-base'], 1, ['feat/backlink-intelligence']),
      row('left-base', ['base'], -1),
      row('inner-base', ['base'], 1),
      row('head', ['base'], 0, ['dev']),
      row('outer-tip', ['base'], 2, ['claude/organic-module-features']),
      row('base', [], 0),
    ]

    const routed = routeUpstreamAroundWorktree(rows, 'dev')

    expect(routed.find((entry) => entry.sha === 'upstream')?.lane).toBe(2)
    expect(routed.find((entry) => entry.sha === 'inner-tip')?.lane).toBe(1)
    expect(routed.find((entry) => entry.sha === 'outer-tip')?.lane).toBe(2)
  })
})
