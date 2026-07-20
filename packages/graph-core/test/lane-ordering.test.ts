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

  test('does not pack another branch under an active merge-parent rail', () => {
    const lanes = orderLaneSegmentsByContinuity([
      { sha: 'merge', parentShas: ['base', 'red-root'], row: 0, lane: 0 },
      { sha: 'yellow-tip', parentShas: ['yellow-root'], row: 1, lane: 1 },
      { sha: 'yellow-root', parentShas: [], row: 2, lane: 1 },
      { sha: 'red-root', parentShas: [], row: 4, lane: 2 },
      { sha: 'base', parentShas: [], row: 5, lane: 0 },
    ])

    expect(lanes.get('red-root')).toBe(2)
    expect(lanes.get('yellow-tip')).toBe(1)
    expect(lanes.get('yellow-root')).toBe(1)
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
    expect(compacted.get('dev')).toBe(2)
    expect(compacted.get('prompt-4')).toBe(1)
    expect(compacted.get('prompt-1')).toBe(1)
  })
})
