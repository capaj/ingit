import { describe, expect, test } from 'bun:test'
import type { CommitRow } from '@ingit/rpc-contract'
import {
  buildAdjacentHookPath,
  buildEdgeRoutingData,
  buildLayout,
  buildOuterRailPath,
  buildTargetJoinOffsets,
} from '../GraphCanvas'

function row(sha: string, lane: number): CommitRow {
  return {
    row: 0,
    sha,
    parentShas: [],
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

describe('outer rail path', () => {
  test('joins the target horizontally when the endpoint gutter is clear', () => {
    const path = buildOuterRailPath(
      { x: 0, y: 0 },
      { x: 100, y: 200 },
      0,
      true,
    )

    expect(path).toEndWith('L85,200')
  })

  test('keeps shared horizontal target hooks side by side', () => {
    const offsets = buildTargetJoinOffsets([
      { key: 'cyan', targetKey: 'base', side: 'right', railX: 450 },
      { key: 'yellow', targetKey: 'base', side: 'right', railX: 610 },
      { key: 'green', targetKey: 'base', side: 'left', railX: 20 },
    ])

    expect(offsets.get('cyan')).toBe(-3)
    expect(offsets.get('yellow')).toBe(3)
    expect(offsets.get('green')).toBe(0)

    const cyanPath = buildOuterRailPath(
      { x: 450, y: 0 },
      { x: 100, y: 200 },
      450,
      true,
      offsets.get('cyan'),
    )
    const yellowPath = buildOuterRailPath(
      { x: 610, y: 0 },
      { x: 100, y: 200 },
      610,
      true,
      offsets.get('yellow'),
    )

    expect(cyanPath).toContain('Q450,197')
    expect(yellowPath).toContain('Q610,203')
    expect(cyanPath).toEndWith(',197')
    expect(yellowPath).toEndWith(',203')
  })

  test('bundles an occlusion hook with an outer rail at their shared target', () => {
    const rows = [
      row('yellow', 3),
      row('filler-1', 0),
      row('filler-2', 0),
      row('filler-3', 0),
      row('filler-4', 0),
      row('filler-5', 0),
      row('cyan', 2),
      row('filler-7', 0),
      row('obstruction', 1),
      row('filler-9', 0),
      row('target', 0),
    ]
    const layout = buildLayout(rows)
    const target = layout.nodes[10]
    const visibleEdges = [
      { key: 'yellow-target', from: layout.nodes[0], to: target, isMerge: false },
      { key: 'cyan-target', from: layout.nodes[6], to: target, isMerge: false },
    ]
    const routing = buildEdgeRoutingData(
      visibleEdges,
      layout.nodes.map((node) => node.row.lane),
    )

    expect(routing.plans.get('yellow-target')?.mode).toBe('outer-rail')
    expect(routing.plans.get('cyan-target')?.mode).toBe('occlusion-hook')
    expect(routing.targetJoinOffsets.get('cyan-target')).toBe(-3)
    expect(routing.targetJoinOffsets.get('yellow-target')).toBe(3)

    const cyanPath = buildAdjacentHookPath(
      layout.nodes[6],
      target,
      layout.nodes[6].x,
      routing.targetJoinOffsets.get('cyan-target'),
    )
    expect(cyanPath).toEndWith(`,${target.y - 3}`)
  })
})
