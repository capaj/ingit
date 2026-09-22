import { describe, expect, test } from 'bun:test'
import type { CommitRow } from '@ingit/rpc-contract'
import { StableLaneLayout } from './stable-lanes'

function row(sha: string, lane: number, ...parentShas: string[]): CommitRow {
  return {
    sha, lane, parentShas, row: 0, authorName: '', authorEmail: '', authorUnix: 0,
    committerUnix: 0, subject: sha, additions: 0, deletions: 0, locChanged: 0, refNames: [],
  }
}
const lanes = (rows: CommitRow[]) => Object.fromEntries(rows.map((row) => [row.sha, row.lane]))

describe('stable repository lanes', () => {
  test('retains every known lane when a refresh reverses the proposed branch order', () => {
    const layout = new StableLaneLayout()
    const original = [row('a', -2, 'root'), row('main', 0, 'root'), row('b', 1, 'root'), row('root', 0)]
    const initial = layout.stabilize(original)
    const refreshed = original.map((row) => ({ ...row, lane: -row.lane || 0, subject: `updated ${row.sha}` }))
    const stable = layout.stabilize(refreshed)
    expect(lanes(stable)).toEqual(lanes(initial))
    expect(stable[0].subject).toBe('updated a')
    expect(refreshed[0].lane).toBe(2)
    expect(layout.stabilize(refreshed)).toBe(stable)
  })

  test('continues paginated parents in their reserved gutters across shorter refreshes', () => {
    const layout = new StableLaneLayout()
    layout.stabilize([row('main', 0, 'main-parent'), row('branch', -2, 'branch-parent')])
    const extended = layout.stabilize([
      row('main', 4, 'main-parent'), row('branch', 1, 'branch-parent'),
      row('main-parent', 4, 'root'), row('branch-parent', 1, 'root'), row('root', 4),
    ])
    expect(lanes(extended)).toEqual({ main: 0, branch: -1, 'main-parent': 0, 'branch-parent': -1, root: 0 })
    layout.stabilize([row('main', 7, 'main-parent')])
    expect(lanes(layout.stabilize(extended.map((entry) => ({ ...entry, lane: 10 })))))
      .toEqual(lanes(extended))
  })

  test('prepends a new chain to its existing tip without moving either branch', () => {
    const layout = new StableLaneLayout()
    layout.stabilize([row('main', 0, 'root'), row('branch', -1, 'root'), row('root', 0)])
    expect(lanes(layout.stabilize([
      row('new-tip', 5, 'new-parent'), row('new-parent', 5, 'branch'),
      row('main', -1, 'root'), row('branch', 2, 'root'), row('root', 3),
    ]))).toEqual({ 'new-tip': -1, 'new-parent': -1, main: 0, branch: -1, root: 0 })
  })

  test('adds gutters for fetched siblings instead of displacing existing rails', () => {
    const layout = new StableLaneLayout()
    layout.stabilize([row('left', -1, 'root'), row('main', 0, 'root'), row('right', 1, 'root'), row('root', 0)])
    const result = lanes(layout.stabilize([
      row('new-left', -1, 'left-parent'), row('new-right', 1, 'right-parent'),
      row('left', 4, 'root'), row('main', 3, 'root'), row('right', -1, 'root'),
      row('left-parent', -1, 'root'), row('right-parent', 1, 'root'), row('root', 2),
    ]))
    expect(result).toMatchObject({ left: -1, main: 0, right: 1, root: 0 })
    expect(result['new-left']).toBe(result['left-parent'])
    expect(result['new-left']).toBeLessThan(-1)
    expect(result['new-right']).toBe(result['right-parent'])
    expect(result['new-right']).toBeGreaterThan(1)
  })

  test('repository sessions do not share lane ownership', () => {
    const first = new StableLaneLayout()
    const second = new StableLaneLayout()
    first.stabilize([row('shared', -3)])
    expect(lanes(second.stabilize([row('shared', 2)]))).toEqual({ shared: 1 })
  })

  test('reuses an inner gutter once an earlier branch reconnects with main', () => {
    for (const side of [-1, 1]) {
      const layout = new StableLaneLayout()
      const initial = [row('main', 0, 'base'), row('branch', side * 30, 'base'), row('base', 0, 'root')]
      expect(lanes(layout.stabilize(initial)).branch).toBe(side)
      const expanded = layout.stabilize([
        ...initial, row('next-branch', side * 40, 'next-parent'),
        row('next-parent', side * 40, 'root'), row('root', 0),
      ])
      expect(lanes(expanded)).toMatchObject({ branch: side, 'next-branch': side, 'next-parent': side })
      // The same packing applies on the first load, not just when paginating.
      expect(lanes(new StableLaneLayout().stabilize(expanded.map((row) => ({
        ...row, lane: row.lane === 0 ? 0 : side * 90,
      }))))).toEqual(lanes(expanded))
    }
  })

  test('uses an empty opposite inner gutter before expanding farther on the preferred side', () => {
    const layout = new StableLaneLayout()
    layout.stabilize([row('main', 0, 'base'), row('busy', 1, 'base'), row('base', 0)])
    const result = layout.stabilize([
      row('main', 0, 'base'), row('busy', 1, 'base'), row('new', 50, 'base'), row('base', 0),
    ])
    expect(lanes(result)).toMatchObject({ busy: 1, new: -1 })
  })

  test('does not reuse a gutter occupied by a rail without an intermediate node', () => {
    const layout = new StableLaneLayout()
    layout.stabilize([row('main', 0, 'base'), row('right', 1, 'base'), row('left', -1, 'base'), row('base', 0)])
    const result = layout.stabilize([
      row('main', 0, 'base'), row('right', 1, 'base'), row('left', -1, 'base'),
      row('isolated', 90), row('base', 0),
    ])
    expect(lanes(result)).toMatchObject({ right: 1, left: -1, isolated: 2 })
  })

  test('reserves an incoming merge rail above the first commit on its branch', () => {
    const result = new StableLaneLayout().stabilize([
      row('merge', 0, 'base', 'merged'), row('nearby', 1, 'nearby-end'),
      row('nearby-end', 1), row('base', 0, 'root'), row('merged', 50, 'root'), row('root', 0),
    ])
    expect(lanes(result)).toMatchObject({ nearby: 1, 'nearby-end': 1, merged: -1 })
  })
})
