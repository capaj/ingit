import { describe, expect, test } from 'bun:test'
import { orderLaneSegmentsByContinuity } from '../src/lane-ordering.js'

describe('lane ordering', () => {
  test('moves a long-lived right-side mainline outside a shorter branch', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'main-tip', parentShas: ['main-root'], row: 2, lane: 1 },
      { sha: 'short-tip', parentShas: ['short-root'], row: 12, lane: 2 },
      { sha: 'short-root', parentShas: ['base'], row: 18, lane: 2 },
      { sha: 'main-root', parentShas: ['base'], row: 30, lane: 1 },
      { sha: 'base', parentShas: [], row: 31, lane: 0 },
    ])

    expect(lanes.get('main-tip')).toBe(2)
    expect(lanes.get('main-root')).toBe(2)
    expect(lanes.get('short-tip')).toBe(1)
    expect(lanes.get('short-root')).toBe(1)
    expect(lanes.get('base')).toBe(0)
  })

  test('keeps a disconnected upstream tip inner when its old lane is reused by main', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'origin-dev', parentShas: ['dev'], row: 0, lane: 1 },
      { sha: 'dev', parentShas: ['dev-parent'], row: 2, lane: 0 },
      { sha: 'main-tip', parentShas: ['main-root'], row: 5, lane: 1 },
      { sha: 'short-tip', parentShas: ['short-root'], row: 10, lane: 2 },
      { sha: 'short-root', parentShas: ['dev-parent'], row: 15, lane: 2 },
      { sha: 'main-root', parentShas: ['dev-parent'], row: 20, lane: 1 },
      { sha: 'dev-parent', parentShas: [], row: 21, lane: 0 },
    ])

    expect(lanes.get('origin-dev')).toBe(1)
    expect(lanes.get('main-tip')).toBe(2)
    expect(lanes.get('main-root')).toBe(2)
    expect(lanes.get('short-tip')).toBe(1)
  })

  test('applies the same outward-continuity rule on the left side', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'long-tip', parentShas: ['long-root'], row: 1, lane: -1 },
      { sha: 'short-tip', parentShas: ['short-root'], row: 10, lane: -2 },
      { sha: 'short-root', parentShas: ['base'], row: 14, lane: -2 },
      { sha: 'long-root', parentShas: ['base'], row: 25, lane: -1 },
      { sha: 'base', parentShas: [], row: 26, lane: 0 },
    ])

    expect(lanes.get('long-tip')).toBe(-2)
    expect(lanes.get('short-tip')).toBe(-1)
  })

  test('keeps equally continuous non-overlapping segments in the inner gutter', () => {
    const rows = [
      { sha: 'early', parentShas: [], row: 1, lane: 1 },
      { sha: 'late', parentShas: [], row: 10, lane: 12 },
    ]
    const lanes = orderLaneSegmentsByContinuity(rows)

    expect(lanes.get('early')).toBe(1)
    expect(lanes.get('late')).toBe(1)

    const compacted = orderLaneSegmentsByContinuity(rows, 1)
    expect(compacted.get('early')).toBe(1)
    expect(compacted.get('late')).toBe(1)
  })

  test('uses an empty opposite gutter before overlapping bounded root rails', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'long-a-tip', parentShas: ['long-a-root'], row: 0, lane: -1 },
      { sha: 'long-b-tip', parentShas: ['long-b-root'], row: 1, lane: -2 },
      { sha: 'short-tip', parentShas: ['short-root'], row: 2, lane: -3 },
      { sha: 'short-root', parentShas: [], row: 8, lane: -3 },
      { sha: 'long-b-root', parentShas: [], row: 9, lane: -2 },
      { sha: 'long-a-root', parentShas: [], row: 10, lane: -1 },
    ], 2)

    expect(new Set([
      lanes.get('long-a-tip'),
      lanes.get('long-b-tip'),
    ])).toEqual(new Set([-1, -2]))
    expect(lanes.get('short-tip')).toBe(1)
    expect(lanes.get('short-root')).toBe(1)
  })

  test('does not reuse a gutter while an earlier branch rail is still reconnecting', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'red-tip', parentShas: ['red-root'], row: 0, lane: 1 },
      { sha: 'red-root', parentShas: ['base'], row: 1, lane: 1 },
      { sha: 'yellow-tip', parentShas: ['yellow-middle'], row: 2, lane: 1 },
      { sha: 'yellow-middle', parentShas: ['yellow-root'], row: 3, lane: 1 },
      { sha: 'yellow-root', parentShas: ['base'], row: 4, lane: 1 },
      { sha: 'base', parentShas: [], row: 6, lane: 0 },
    ])

    expect(lanes.get('red-tip')).toBe(2)
    expect(lanes.get('red-root')).toBe(2)
    expect(lanes.get('yellow-tip')).toBe(1)
    expect(lanes.get('yellow-root')).toBe(1)
  })

  test('keeps a center-line merge target hugging the center over shorter branches', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'merge', parentShas: ['base', 'red-root'], row: 0, lane: 0 },
      { sha: 'yellow-tip', parentShas: ['yellow-root'], row: 1, lane: 1 },
      { sha: 'yellow-root', parentShas: [], row: 2, lane: 1 },
      { sha: 'red-root', parentShas: [], row: 4, lane: 2 },
      { sha: 'base', parentShas: [], row: 5, lane: 0 },
    ])

    // The merged-in rail hugs the center line so the merge edge stays a short
    // hop; the shorter branch fans outside it. They still never share a gutter.
    expect(lanes.get('red-root')).toBe(1)
    expect(lanes.get('yellow-tip')).toBe(2)
    expect(lanes.get('yellow-root')).toBe(2)
  })

  test('keeps separately merged sibling branches in distinct gutters', () => {
    const rows = [
      { sha: 'c0', parentShas: ['c1', 'dev-tip'], row: 0, lane: 0 },
      { sha: 'dev-tip', parentShas: ['dev'], row: 1, lane: -1 },
      { sha: 'fix-tip', parentShas: ['base'], row: 2, lane: 1 },
      { sha: 'c1', parentShas: ['c2', 'cors-tip'], row: 3, lane: 0 },
      { sha: 'cors-tip', parentShas: ['dev'], row: 4, lane: -2 },
      { sha: 'dev', parentShas: ['base'], row: 5, lane: -1 },
      { sha: 'c2', parentShas: ['c3', 'base'], row: 6, lane: 0 },
      { sha: 'base', parentShas: ['old'], row: 7, lane: 1 },
      { sha: 'c3', parentShas: [], row: 8, lane: 0 },
      { sha: 'old', parentShas: [], row: 9, lane: 1 },
    ]

    const lanes = orderLaneSegmentsByContinuity(rows)
    expect(new Set([
      lanes.get('dev-tip'),
      lanes.get('fix-tip'),
      lanes.get('cors-tip'),
    ]).size).toBe(3)

    const compacted = orderLaneSegmentsByContinuity(rows, 2)
    // A radius of two only provides two gutters on this side. Reusing one is
    // preferable to moving a sibling across the checked-out lane.
    expect(compacted.get('fix-tip')).not.toBe(compacted.get('dev-tip'))
    for (const sha of ['dev-tip', 'fix-tip', 'cors-tip']) {
      expect(compacted.get(sha)).toBeGreaterThan(0)
    }
  })

  test('balances independent merge families across both sides of the center', () => {
    const rows = [
      { sha: 'c0', parentShas: ['c1', 'branch-a'], row: 0, lane: 0 },
      { sha: 'branch-a', parentShas: [], row: 1, lane: 1 },
      { sha: 'c1', parentShas: ['c2', 'branch-b'], row: 2, lane: 0 },
      { sha: 'branch-b', parentShas: [], row: 3, lane: 2 },
      { sha: 'c2', parentShas: ['c3', 'branch-c'], row: 4, lane: 0 },
      { sha: 'branch-c', parentShas: [], row: 5, lane: 3 },
      { sha: 'c3', parentShas: ['c4', 'branch-d'], row: 6, lane: 0 },
      { sha: 'branch-d', parentShas: [], row: 7, lane: 4 },
      { sha: 'c4', parentShas: [], row: 8, lane: 0 },
    ]

    for (const radius of [undefined, 2]) {
      const lanes = orderLaneSegmentsByContinuity(rows, radius)
      const branchLanes = ['branch-a', 'branch-b', 'branch-c', 'branch-d']
        .map((sha) => lanes.get(sha) as number)
      expect(branchLanes.filter((lane) => lane < 0)).toHaveLength(2)
      expect(branchLanes.filter((lane) => lane > 0)).toHaveLength(2)
    }
  })

  test('keeps labeled nested branches on their parent side in a bounded viewport', () => {
    const rows = [
      { sha: 'branch-a', parentShas: ['p0'], row: 0, lane: 2 },
      { sha: 'branch-b', parentShas: ['p1'], row: 1, lane: 3 },
      { sha: 'branch-c', parentShas: ['p2'], row: 2, lane: 4 },
      { sha: 'p0', parentShas: ['p1'], row: 3, lane: 1 },
      { sha: 'p1', parentShas: ['p2'], row: 4, lane: 1 },
      { sha: 'p2', parentShas: ['base'], row: 5, lane: 1 },
      { sha: 'base', parentShas: [], row: 6, lane: 0 },
    ]

    const lanes = orderLaneSegmentsByContinuity(rows, 2)
    for (const sha of ['branch-a', 'branch-b', 'branch-c', 'p0', 'p1', 'p2']) {
      expect(lanes.get(sha)).toBeGreaterThan(0)
    }
  })

  test('pulls a center-line merge target to the inner gutter regardless of its lane', () => {
    // The mainline lives far out on the right while shorter branches sit
    // between it and the center. Since the center merges it in, it should hug
    // the center line so the merge edges stay short hops.
    const rows = [
      { sha: 'c0', parentShas: ['c1'], row: 0, lane: 0 },
      { sha: 'm0', parentShas: ['m1'], row: 1, lane: 3 },
      { sha: 's1', parentShas: ['c2'], row: 2, lane: -1 },
      { sha: 'c1', parentShas: ['c2'], row: 3, lane: 0 },
      { sha: 'c2', parentShas: ['c3', 'm2'], row: 4, lane: 0 },
      { sha: 's2', parentShas: ['c4'], row: 5, lane: 1 },
      { sha: 'c3', parentShas: ['c4'], row: 6, lane: 0 },
      { sha: 'm1', parentShas: ['m2'], row: 7, lane: 3 },
      { sha: 'c4', parentShas: ['c5'], row: 8, lane: 0 },
      { sha: 'c5', parentShas: ['c6', 'm3'], row: 9, lane: 0 },
      { sha: 's3', parentShas: ['c6'], row: 10, lane: -1 },
      { sha: 'm2', parentShas: ['m3'], row: 11, lane: 3 },
      { sha: 'c6', parentShas: ['c7'], row: 12, lane: 0 },
      { sha: 'm3', parentShas: ['m4'], row: 13, lane: 3 },
      { sha: 'c7', parentShas: [], row: 14, lane: 0 },
      { sha: 'm4', parentShas: [], row: 15, lane: 3 },
    ]
    const lanes = orderLaneSegmentsByContinuity(rows)

    expect(lanes.get('m0')).toBe(1)
    expect(lanes.get('m1')).toBe(1)
    expect(lanes.get('m2')).toBe(1)
    expect(lanes.get('m3')).toBe(1)
    expect(lanes.get('m4')).toBe(1)
    // The side branches fan around the mainline without sharing its gutter.
    expect(lanes.get('s2')).toBe(2)
    expect(lanes.get('s1')).toBe(-1)
    expect(lanes.get('s3')).toBe(-1)

    const compacted = orderLaneSegmentsByContinuity(rows, 2)
    expect(Math.max(...[...compacted.values()].map((lane) => Math.abs(lane)))).toBeLessThanOrEqual(2)
    expect(compacted.get('m0')).toBe(1)
    expect(compacted.get('m2')).toBe(1)
    expect(compacted.get('m4')).toBe(1)
  })

  test('pulls a line that merges the center line into the inner gutter too', () => {
    // main keeps merging the center branch into itself. Its rail belongs next
    // to the center line (not four lanes out on the left) so each merge edge
    // is a short hop instead of crossing the left-side gutters.
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'c0', parentShas: ['c1'], row: 0, lane: 0 },
      { sha: 'main-tip', parentShas: ['merge-1'], row: 1, lane: -3 },
      { sha: 's1', parentShas: ['c1'], row: 2, lane: 1 },
      { sha: 'c1', parentShas: ['c2'], row: 3, lane: 0 },
      { sha: 's2', parentShas: ['c2'], row: 4, lane: -1 },
      { sha: 'merge-1', parentShas: ['merge-2', 'c2'], row: 5, lane: -3 },
      { sha: 'c2', parentShas: ['c3'], row: 6, lane: 0 },
      { sha: 'merge-2', parentShas: ['main-base', 'c3'], row: 7, lane: -3 },
      { sha: 'c3', parentShas: [], row: 8, lane: 0 },
      { sha: 'main-base', parentShas: [], row: 9, lane: -3 },
    ])

    expect(lanes.get('main-tip')).toBe(1)
    expect(lanes.get('merge-1')).toBe(1)
    expect(lanes.get('merge-2')).toBe(1)
    expect(lanes.get('main-base')).toBe(1)
    expect(lanes.get('c2')).toBe(0)
  })

  test('places a nested branch outside its non-center first-parent gutter', () => {
    const rows = [
      { sha: 'main', parentShas: ['main-base'], row: 0, lane: 0 },
      { sha: 'side-a', parentShas: ['a-root'], row: 1, lane: 1 },
      { sha: 'side-b', parentShas: ['b-root'], row: 2, lane: -1 },
      { sha: 'other', parentShas: ['dev'], row: 3, lane: 2 },
      { sha: 'prompt-4', parentShas: ['prompt-3'], row: 4, lane: -2 },
      { sha: 'prompt-3', parentShas: ['prompt-2'], row: 5, lane: -2 },
      { sha: 'prompt-2', parentShas: ['prompt-1'], row: 6, lane: -2 },
      { sha: 'prompt-1', parentShas: ['dev'], row: 7, lane: -2 },
      { sha: 'dev', parentShas: ['dev-parent'], row: 8, lane: 2 },
      { sha: 'a-root', parentShas: [], row: 9, lane: 1 },
      { sha: 'b-root', parentShas: [], row: 10, lane: -1 },
      { sha: 'main-base', parentShas: ['main-root'], row: 11, lane: 0 },
      { sha: 'dev-parent', parentShas: [], row: 12, lane: 2 },
      { sha: 'main-root', parentShas: [], row: 13, lane: 0 },
    ]
    const lanes = orderLaneSegmentsByContinuity(rows)

    expect(lanes.get('dev')).toBe(2)
    expect(lanes.get('prompt-4')).toBe(3)
    expect(lanes.get('prompt-1')).toBe(3)

    const compacted = orderLaneSegmentsByContinuity(rows, 2)
    expect(Math.max(...compacted.values().map((lane) => Math.abs(lane)))).toBe(2)
    expect(compacted.get('dev')).toBe(1)
    expect(compacted.get('prompt-4')).toBe(2)
    expect(compacted.get('prompt-1')).toBe(2)
  })

  test('does not move a bounded nested branch across the center when its side is full', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'child-tip', parentShas: ['child-root'], row: 0, lane: 2 },
      { sha: 'child-root', parentShas: ['parent-tip'], row: 1, lane: 2 },
      { sha: 'parent-tip', parentShas: ['base'], row: 2, lane: 1 },
      { sha: 'base', parentShas: [], row: 3, lane: 0 },
    ], 1)

    expect(lanes.get('parent-tip')).toBe(1)
    expect(lanes.get('child-tip')).toBe(1)
    expect(lanes.get('child-root')).toBe(lanes.get('child-tip'))
  })
})
