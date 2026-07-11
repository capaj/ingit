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
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'early', parentShas: [], row: 1, lane: 1 },
      { sha: 'late', parentShas: [], row: 10, lane: 2 },
    ])

    expect(lanes.get('early')).toBe(1)
    expect(lanes.get('late')).toBe(1)
  })
})
