import { describe, expect, test } from 'bun:test'
import { Projection } from '../src/projection.js'

/**
 * Topology (newest first, date order):
 *   O  origin/dev  parents: [D]        // upstream tip, 1 ahead of HEAD
 *   F  fix branch  parents: [D]        // side branch forked off D (D is its first parent)
 *   D  dev (HEAD)  parents: [P]
 *   P             parents: []
 *
 * When the center line is anchored at HEAD (D), the fetched commit O has no way
 * onto lane 0 — the allocator only walks first-parents downward from D. Anchor
 * it at the upstream tip O instead and O + D share lane 0, while F forks aside.
 */
function buildProjection() {
  const projection = new Projection('p', 'r', { kind: 'all' }, 'date')
  projection.appendEntries([
    { sha: 'O', parentShas: ['D'] },
    { sha: 'F', parentShas: ['D'] },
    { sha: 'D', parentShas: ['P'] },
    { sha: 'P', parentShas: [] },
  ])
  return projection
}

describe('center-line lane reservation', () => {
  test('anchoring at HEAD leaves the fetched upstream commit off the center lane', () => {
    const { lanes } = buildProjection().computeGeometry(0, 3, undefined, 'D')
    expect(lanes.get('D')).toBe(0)
    // O forks off because the downward first-parent walk from D never reaches it.
    expect(lanes.get('O')).not.toBe(0)
  })

  test('anchoring at the upstream tip keeps fetched commits on HEAD lane', () => {
    const { lanes } = buildProjection().computeGeometry(0, 3, undefined, 'O')
    expect(lanes.get('O')).toBe(0)
    expect(lanes.get('D')).toBe(0)
    expect(lanes.get('P')).toBe(0)
    // The unrelated side branch still fans out.
    expect(lanes.get('F')).not.toBe(0)
  })
})
