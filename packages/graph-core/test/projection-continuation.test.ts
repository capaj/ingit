import { describe, expect, test } from 'bun:test'
import { Projection } from '../src/projection.js'
import { orderLaneSegmentsByContinuity } from '../src/lane-ordering.js'

describe('gutters for unloaded first parents', () => {
  test('keeps a later branch left of a right rail that continues beyond loaded history', () => {
    const entries = [
      { sha: 'head', parentShas: ['main'] },
      { sha: 'green-tip', parentShas: ['green-merge'] },
      { sha: 'short-tip', parentShas: ['main'] },
      { sha: 'green-merge', parentShas: ['green-last', 'main'] },
      { sha: 'green-last', parentShas: ['unloaded'] },
      { sha: 'purple-tip', parentShas: ['purple-last'] },
      { sha: 'main', parentShas: ['base'] },
      { sha: 'purple-last', parentShas: ['base'] },
      { sha: 'base', parentShas: [] },
    ]
    const projection = new Projection('p', 'r', { kind: 'all' }, 'date')
    projection.appendEntries(entries)
    const { lanes, edges } = projection.computeGeometry(0, entries.length - 1, undefined, 'head')
    const rows = entries.map((entry, row) => ({ ...entry, row, lane: lanes.get(entry.sha)! }))

    for (const result of [lanes, orderLaneSegmentsByContinuity(rows, 2)]) {
      expect(result.get('green-tip')).toBe(1)
      expect(result.get('green-last')).toBe(1)
      expect(result.get('purple-tip')).toBeLessThan(0)
      expect(result.get('purple-last')).toBe(result.get('purple-tip'))
      expect(result.get('main')).toBe(0)
    }
    expect(edges).toContainEqual({
      fromRow: 4, toRow: -1, fromLane: 1, toLane: 1, kind: 'linear',
    })
  })

  test('ordering keeps an unloaded continuation occupied through the final row', () => {
    const rows = [
      { sha: 'green', parentShas: ['unloaded'], row: 0, lane: 1 },
      { sha: 'purple', parentShas: ['base'], row: 3, lane: 1 },
      { sha: 'base', parentShas: [], row: 8, lane: 0 },
    ]
    for (const radius of [undefined, 1, 2]) {
      const lanes = orderLaneSegmentsByContinuity(rows, radius)
      expect(lanes.get('green')).not.toBe(lanes.get('purple'))
    }
  })
})
