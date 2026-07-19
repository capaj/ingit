import { describe, expect, test } from 'bun:test'
import type { CommitRow } from '@ingit/rpc-contract'
import {
  buildAdjacentHookPath,
  buildEdgeRoutingData,
  buildCurvedEdgePath,
  buildLayout,
  buildOuterRailPath,
  buildStraightEdgePath,
  buildTargetJoinOffsets,
  buildTargetNodeRadii,
  buildVerticalBundleOffsets,
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

  test('enters a target-side rail diagonally without overlapping its vertical line', () => {
    const path = buildOuterRailPath(
      { x: 0, y: 200 },
      { x: 100, y: 0 },
      100,
    )

    expect(path).toContain('Q')
    expect(path).not.toContain('L100,')
    expect(path).toEndWith('L89.39339828220179,10.606601717798213')
  })

  test('leaves a source-side rail diagonally without overlapping its vertical line', () => {
    const path = buildOuterRailPath(
      { x: 100, y: 0 },
      { x: 0, y: 200 },
      100,
      true,
    )

    expect(path).toStartWith('M89.39339828220179,10.606601717798213')
    expect(path).not.toContain('M100,')
    expect(path).toEndWith('L15,200')
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

    expect(cyanPath).toMatch(/Q[^ ]+,197 /)
    expect(yellowPath).toMatch(/Q[^ ]+,203 /)
    expect(cyanPath).toEndWith(',197')
    expect(yellowPath).toEndWith(',203')
  })

  test('leaves a source-side adjacent hook at 45 degrees', () => {
    const path = buildAdjacentHookPath(
      { x: 100, y: 0 },
      { x: 0, y: 200 },
      100,
    )

    expect(path).toStartWith('M89.39339828220179,10.606601717798213')
    expect(path).toEndWith('L15,200')
  })

  test('enters a target-side adjacent hook at 45 degrees', () => {
    const path = buildAdjacentHookPath(
      { x: 0, y: 200 },
      { x: 100, y: 0 },
      100,
    )

    expect(path).toEndWith('L89.39339828220179,10.606601717798213')
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

  test('aligns a short curve with existing horizontal hooks into the same target', () => {
    const rows = [
      row('long-parent', 0),
      row('filler-1', 3),
      row('filler-2', 3),
      row('filler-3', 3),
      row('filler-4', 3),
      row('filler-5', 3),
      row('filler-6', 3),
      row('short-parent', 1),
      row('target', 3),
    ]
    const layout = buildLayout(rows)
    const target = layout.nodes[8]
    const routing = buildEdgeRoutingData(
      [
        { key: 'long-target', from: layout.nodes[0], to: target, isMerge: false },
        { key: 'short-target', from: layout.nodes[7], to: target, isMerge: false },
      ],
      layout.nodes.map((node) => node.row.lane),
    )

    expect(routing.plans.get('long-target')?.mode).toBe('outer-rail')
    expect(routing.plans.get('short-target')?.mode).toBe('target-hook')
    expect(routing.targetJoinOffsets.get('short-target')).toBe(-3)
    expect(routing.targetJoinOffsets.get('long-target')).toBe(3)
  })

  test('aligns a short merge curve with an existing horizontal hook', () => {
    const rows = [
      row('long-parent', 0),
      row('filler-1', 3),
      row('filler-2', 3),
      row('filler-3', 3),
      row('filler-4', 3),
      row('filler-5', 3),
      row('filler-6', 3),
      row('merge-parent', 1),
      row('target', 3),
    ]
    const layout = buildLayout(rows)
    const target = layout.nodes[8]
    const routing = buildEdgeRoutingData(
      [
        { key: 'long-target', from: layout.nodes[0], to: target, isMerge: false },
        { key: 'merge-target', from: layout.nodes[7], to: target, isMerge: true },
      ],
      layout.nodes.map((node) => node.row.lane),
    )

    expect(routing.plans.get('long-target')?.mode).toBe('outer-rail')
    expect(routing.plans.get('merge-target')?.mode).toBe('target-hook')
    expect(routing.targetJoinOffsets.get('merge-target')).toBe(-3)
    expect(routing.targetJoinOffsets.get('long-target')).toBe(3)
  })

  test('aligns multiple same-side curves without an existing hook', () => {
    const rows = [
      row('near-source', 1),
      row('far-source', 2),
      row('target', 0),
    ]
    const layout = buildLayout(rows)
    const target = layout.nodes[2]
    const routing = buildEdgeRoutingData(
      [
        { key: 'near-target', from: layout.nodes[0], to: target, isMerge: false },
        { key: 'far-target', from: layout.nodes[1], to: target, isMerge: true },
      ],
      layout.nodes.map((node) => node.row.lane),
    )

    expect(routing.plans.get('near-target')?.mode).toBe('target-hook')
    expect(routing.plans.get('far-target')?.mode).toBe('target-hook')
    expect(routing.targetJoinOffsets.get('near-target')).toBe(-3)
    expect(routing.targetJoinOffsets.get('far-target')).toBe(3)
  })

  test('routes a long cross-center merge around the outside of its source', () => {
    const rows = [
      row('merge', 2),
      row('filler-1', 4),
      row('filler-2', 0),
      row('filler-3', 2),
      row('filler-4', 2),
      row('filler-5', 0),
      row('filler-6', -1),
      row('filler-7', -2),
      row('filler-8', 0),
      row('filler-9', -4),
      row('merged-parent', -6),
    ]
    const layout = buildLayout(rows)
    const routing = buildEdgeRoutingData(
      [{
        key: 'merge-parent',
        from: layout.nodes[0],
        to: layout.nodes[10],
        isMerge: true,
      }],
      rows.map((entry) => entry.lane),
    )

    expect(routing.plans.get('merge-parent')).toEqual({
      mode: 'outer-rail',
      side: 'right',
      anchorLane: 3,
      innerLane: -6,
      outerRailX: layout.nodes[0].x + 80,
      horizontalTargetJoin: true,
    })
  })

  test('grows a target node once five or more hooks need attachment points', () => {
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      key: `edge-${index}`,
      targetKey: 'busy-target',
      side: 'left' as const,
      railX: index * 80,
    }))

    expect(buildTargetNodeRadii(candidates.slice(0, 4)).get('busy-target')).toBeUndefined()
    expect(buildTargetNodeRadii(candidates.slice(0, 5)).get('busy-target')).toBe(19)
    expect(buildTargetNodeRadii(candidates).get('busy-target')).toBe(22)
  })

  test('spaces overlapping vertical rails and reuses tracks after they clear', () => {
    const offsets = buildVerticalBundleOffsets([
      { key: 'long', railKey: 'gutter-2', topIdx: 0, bottomIdx: 10 },
      { key: 'nested', railKey: 'gutter-2', topIdx: 2, bottomIdx: 8 },
      { key: 'third', railKey: 'gutter-2', topIdx: 8, bottomIdx: 12 },
      { key: 'later', railKey: 'gutter-2', topIdx: 11, bottomIdx: 20 },
      { key: 'other-gutter', railKey: 'gutter-3', topIdx: 0, bottomIdx: 20 },
    ])

    expect(offsets.get('long')).toBe(-3)
    expect(offsets.get('nested')).toBe(3)
    expect(offsets.get('third')).toBe(3)
    expect(offsets.get('later')).toBe(-3)
    expect(offsets.get('other-gutter')).toBe(0)
  })

  test('keeps a merge rail in the middle and gives every vertical stroke visible clearance', () => {
    const offsets = buildVerticalBundleOffsets([
      {
        key: 'branch-continuation',
        railKey: 'gutter-2',
        topIdx: 0,
        bottomIdx: 10,
        strokeWidth: 4.5,
      },
      {
        key: 'upper-merge',
        railKey: 'gutter-2',
        topIdx: 2,
        bottomIdx: 10,
        strokeWidth: 2,
      },
      {
        key: 'lower-merge',
        railKey: 'gutter-2',
        topIdx: 4,
        bottomIdx: 10,
        strokeWidth: 2,
      },
    ])

    expect(offsets.get('branch-continuation')).toBe(-6.25)
    expect(offsets.get('upper-merge')).toBe(0)
    expect(offsets.get('lower-merge')).toBe(5)
  })

  test('keeps an earlier incoming merge rail right of the branch continuation', () => {
    const offsets = buildVerticalBundleOffsets([
      {
        key: 'incoming-merge',
        railKey: 'gutter-2',
        topIdx: 0,
        bottomIdx: 10,
        bundleOrder: 1,
        strokeWidth: 2,
      },
      {
        key: 'branch-continuation',
        railKey: 'gutter-2',
        topIdx: 2,
        bottomIdx: 10,
        bundleOrder: 0,
        strokeWidth: 4.5,
      },
    ])

    expect(offsets.get('branch-continuation')).toBeLessThan(offsets.get('incoming-merge')!)
  })

  test('bundles a straight continuation with merge rails sharing its gutter', () => {
    const rows = Array.from({ length: 11 }, (_, index) => row(
      `node-${index}`,
      index === 0 || index === 10 ? 0 : index === 2 ? 3 : index === 4 ? 2 : index === 8 ? -1 : 1,
    ))
    const layout = buildLayout(rows)
    const routing = buildEdgeRoutingData(
      [
        { key: 'branch', from: layout.nodes[0], to: layout.nodes[10], isMerge: false },
        { key: 'upper-merge', from: layout.nodes[2], to: layout.nodes[10], isMerge: true },
        { key: 'lower-merge', from: layout.nodes[4], to: layout.nodes[10], isMerge: true },
        { key: 'side-curve', from: layout.nodes[8], to: layout.nodes[10], isMerge: false },
      ],
      rows.map((entry) => entry.lane),
    )

    expect(routing.plans.get('branch')).toEqual({
      mode: 'straight',
      bundleJoinY: layout.nodes[2].y + 16,
    })
    expect(routing.plans.get('upper-merge')?.mode).toBe('outer-rail')
    expect(routing.plans.get('lower-merge')?.mode).toBe('outer-rail')
    expect(routing.plans.get('side-curve')).toEqual({ mode: 'curve', targetSide: 'left' })
    expect(routing.bundleOffsets.get('branch')).toBe(-6.25)
    expect(routing.bundleOffsets.get('upper-merge')).toBe(0)
    expect(routing.bundleOffsets.get('lower-merge')).toBe(5)
  })

  test('starts a bundled straight rail centered before jogging onto its track', () => {
    const path = buildStraightEdgePath(
      { x: 100, y: 100 },
      { x: 100, y: 400 },
      -6.25,
      16,
      280,
    )

    expect(path).toStartWith('M100,115')
    expect(path).toContain('100,270')
    expect(path).toContain('93.75,280')
    expect(path).toMatch(/L93\.75,386\.3641098567\d+$/)
  })

  test('bends a side-entry curve into radial segments at both node borders', () => {
    const path = buildCurvedEdgePath(
      { x: 100, y: 100 },
      { x: 180, y: 400 },
      'left',
    )

    expect(path).toContain('Q')
    expect(path).toStartWith('M100,115L100,128')
    expect(path).toEndWith('L165,400')
  })

  test('uses a side entry when the target continues vertically', () => {
    const rows = [
      row('side-source', 0),
      row('filler-1', 2),
      row('filler-2', 2),
      row('target', 1),
      row('target-parent', 1),
    ]
    const layout = buildLayout(rows)
    const routing = buildEdgeRoutingData(
      [
        {
          key: 'side-target',
          from: layout.nodes[0],
          to: layout.nodes[3],
          isMerge: false,
        },
        {
          key: 'target-parent',
          from: layout.nodes[3],
          to: layout.nodes[4],
          isMerge: false,
        },
      ],
      rows.map((entry) => entry.lane),
    )

    expect(routing.plans.get('target-parent')).toEqual({ mode: 'straight' })
    expect(routing.plans.get('side-target')).toEqual({
      mode: 'curve',
      targetSide: 'left',
    })
  })

  test('leaves at 45 degrees when the source also continues vertically', () => {
    const rows = [
      row('source', 2),
      row('filler-1', 0),
      row('target', 1),
      row('target-parent', 1),
      row('source-parent', 2),
    ]
    const layout = buildLayout(rows)
    const routing = buildEdgeRoutingData(
      [
        {
          key: 'source-target',
          from: layout.nodes[0],
          to: layout.nodes[2],
          isMerge: true,
        },
        {
          key: 'target-parent',
          from: layout.nodes[2],
          to: layout.nodes[3],
          isMerge: false,
        },
        {
          key: 'source-parent',
          from: layout.nodes[0],
          to: layout.nodes[4],
          isMerge: false,
        },
      ],
      rows.map((entry) => entry.lane),
    )

    expect(routing.plans.get('source-target')).toEqual({
      mode: 'curve',
      targetSide: 'right',
      sourceSide: 'left',
    })
  })

  test('keeps connected first-parent segments on one vertical track', () => {
    const offsets = buildVerticalBundleOffsets([
      {
        key: 'tip-parent',
        railKey: 'gutter-2',
        topIdx: 0,
        bottomIdx: 5,
      },
      {
        key: 'parent-root',
        railKey: 'gutter-2',
        topIdx: 5,
        bottomIdx: 10,
      },
    ])

    expect(offsets.get('tip-parent')).toBe(0)
    expect(offsets.get('parent-root')).toBe(0)
  })

  test('recenters an outgoing rail below a busy merge node', () => {
    const offsets = buildVerticalBundleOffsets([
      {
        key: 'incoming-merge',
        railKey: 'gutter-2',
        topIdx: 0,
        bottomIdx: 5,
      },
      {
        key: 'outgoing-branch',
        railKey: 'gutter-2',
        topIdx: 5,
        bottomIdx: 10,
      },
    ])

    expect(offsets.get('incoming-merge')).toBe(0)
    expect(offsets.get('outgoing-branch')).toBe(0)
  })

  test('does not shift an unrelated vertical range because another range is busy', () => {
    const offsets = buildVerticalBundleOffsets([
      { key: 'busy-left', railKey: 'gutter-2', topIdx: 0, bottomIdx: 5 },
      { key: 'busy-right', railKey: 'gutter-2', topIdx: 1, bottomIdx: 4 },
      { key: 'unrelated', railKey: 'gutter-2', topIdx: 10, bottomIdx: 15 },
    ])

    expect(offsets.get('busy-left')).toBe(-3)
    expect(offsets.get('busy-right')).toBe(3)
    expect(offsets.get('unrelated')).toBe(0)
  })
})
