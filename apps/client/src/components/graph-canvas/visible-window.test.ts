import { describe, expect, test } from 'bun:test'
import type { CommitRow } from '@ingit/rpc-contract'
import { buildLayout, buildVisibleWindow } from '../GraphCanvas'

function row(sha: string, parentShas: string[], lane = 0): CommitRow {
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
    refNames: [],
    lane,
  }
}

describe('visible graph window', () => {
  test('continues an edge when its parent is beyond the loaded history', () => {
    const layout = buildLayout([
      row('tip', ['unloaded-parent'], -1),
      row('other', [], 0),
    ])

    const { visibleEdges } = buildVisibleWindow(layout, 0, 1)

    expect(visibleEdges).toHaveLength(1)
    expect(visibleEdges[0].key).toBe('tip-unloaded-parent')
    expect(visibleEdges[0].from.row.sha).toBe('tip')
    expect(visibleEdges[0].to.row.sha).toBe('unloaded-parent')
    expect(visibleEdges[0].to.x).toBe(visibleEdges[0].from.x)
    expect(visibleEdges[0].to.y).toBe(layout.totalHeight)
    expect(visibleEdges[0].to.idx).toBe(layout.nodes.length)
  })

  test('uses the real parent endpoint once it is loaded', () => {
    const layout = buildLayout([
      row('tip', ['parent'], -1),
      row('unrelated', [], 0),
      row('parent', [], 1),
    ])

    const { visibleEdges } = buildVisibleWindow(layout, 0, 2)
    const edge = visibleEdges.find((candidate) => candidate.key === 'tip-parent')

    expect(edge?.to).toBe(layout.shaToNode.get('parent'))
  })
})
