import { describe, expect, test } from 'bun:test'
import { Projection } from '../src/projection.js'

/**
 * Topology (newest first, date order) mirroring a busy repository where the
 * center branch merges the same mainline twice while side branches fork off
 * in between:
 *
 *   c0 (HEAD) ─┐
 *   m0 (main) ─┤
 *   s1 ─┐      │
 *   c1 ─┤      │
 *   c2 ─┼─ merges m2
 *   s2 ─┤      │
 *   c3 ─┤      │
 *   m1 ─┤      │
 *   c4 ─┤      │
 *   c5 ─┼─ merges m3
 *   s3 ─┤      │
 *   m2 ─┘      │
 *   c6 ─┐      │
 *   m3 ─┘      │
 *   c7, m4, c8 roots
 *
 * The mainline must render as one straight rail hugging the center line's
 * right side: the merge edges are short hops and the mainline never zigzags
 * across the graph.
 */
function buildProjection() {
  const projection = new Projection('p', 'r', { kind: 'all' }, 'date')
  projection.appendEntries([
    { sha: 'c0', parentShas: ['c1'] },
    { sha: 'm0', parentShas: ['m1'] },
    { sha: 's1', parentShas: ['c2'] },
    { sha: 'c1', parentShas: ['c2'] },
    { sha: 'c2', parentShas: ['c3', 'm2'] },
    { sha: 's2', parentShas: ['c4'] },
    { sha: 'c3', parentShas: ['c4'] },
    { sha: 'm1', parentShas: ['m2'] },
    { sha: 'c4', parentShas: ['c5'] },
    { sha: 'c5', parentShas: ['c6', 'm3'] },
    { sha: 's3', parentShas: ['c6'] },
    { sha: 'm2', parentShas: ['m3'] },
    { sha: 'c6', parentShas: ['c7'] },
    { sha: 'm3', parentShas: ['m4'] },
    { sha: 'c7', parentShas: ['c8'] },
    { sha: 'm4', parentShas: [] },
    { sha: 'c8', parentShas: [] },
  ])
  return projection
}

describe('center-line merge targets', () => {
  test('a twice-merged mainline stays one straight rail hugging the center', () => {
    const { lanes, edges } = buildProjection().computeGeometry(0, 16, undefined, 'c0')

    for (const sha of ['m0', 'm1', 'm2', 'm3', 'm4']) {
      expect(lanes.get(sha)).toBe(1)
    }

    // Both merge edges are short hops from the center line.
    const mergeEdges = edges.filter((edge) => edge.kind === 'merge')
    expect(mergeEdges).toHaveLength(2)
    for (const edge of mergeEdges) {
      expect(edge.fromLane).toBe(0)
      expect(edge.toLane).toBe(1)
    }

    // The mainline never forks across lanes: no fork edge touches it.
    const forkEdges = edges.filter((edge) => edge.kind === 'fork')
    for (const edge of forkEdges) {
      expect(edge.fromLane === 1 || edge.toLane === 1).toBe(false)
    }
  })

  test('checkpoints reproduce the same merged-line handoff when replaying', () => {
    const projection = buildProjection()
    const checkpoints = projection.checkpoint(4)
    const resumed = projection.computeGeometry(0, 16, checkpoints[1], 'c0')

    for (const sha of ['m0', 'm1', 'm2', 'm3', 'm4']) {
      expect(resumed.lanes.get(sha)).toBe(1)
    }
  })
})
