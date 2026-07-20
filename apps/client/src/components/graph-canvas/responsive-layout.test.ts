import { describe, expect, test } from 'bun:test'
import type { CommitRow } from '@ingit/rpc-contract'
import {
  buildLayout,
  fitGraphToBrowserWindow,
  LANE_WIDTH,
  fitGraphToViewport,
} from './layout'

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

describe('responsive graph layout', () => {
  test('reduces the gutter budget as the viewport gets narrower', () => {
    const wide = fitGraphToViewport(2048, 260)
    const medium = fitGraphToViewport(1440, 260)
    const narrow = fitGraphToViewport(1024, 260)

    expect(wide.maxLaneRadius).toBe(6)
    expect(medium.maxLaneRadius).toBe(3)
    expect(narrow.maxLaneRadius).toBe(1)
  })

  test('fits gutters and responsive side reserves without horizontal overflow', () => {
    for (const width of [2048, 1440, 1024, 600, 400, 300]) {
      const fit = fitGraphToViewport(width, 260)
      const leftEdge = fit.laneCenterX
        - fit.maxLaneRadius * LANE_WIDTH
        - LANE_WIDTH / 2
      const rightEdge = fit.laneCenterX
        + fit.maxLaneRadius * LANE_WIDTH
        + LANE_WIDTH / 2

      expect(fit.layoutWidth).toBe(width)
      expect(fit.laneCenterX).toBe(width / 2)
      expect(leftEdge).toBeGreaterThanOrEqual(0)
      expect(rightEdge).toBeLessThanOrEqual(width)
    }

    expect(fitGraphToViewport(600, 260).extraLeftGutter).toBeLessThan(260)
  })

  test('keeps existing gutters fixed when newly loaded commits use outer lanes', () => {
    const fit = fitGraphToViewport(1440, 260)
    const laneFrame = {
      laneCenterX: fit.laneCenterX,
      laneRadius: fit.maxLaneRadius,
      totalWidth: fit.layoutWidth,
    }
    const initial = buildLayout(
      [row('center', 0)],
      fit.extraLeftGutter,
      fit.rightGutter,
      laneFrame,
    )
    const afterPagination = buildLayout(
      [
        row('center', 0),
        row('left', -fit.maxLaneRadius),
        row('right', fit.maxLaneRadius),
      ],
      fit.extraLeftGutter,
      fit.rightGutter,
      laneFrame,
    )

    expect(initial.shaToNode.get('center')?.x).toBe(fit.laneCenterX)
    expect(afterPagination.shaToNode.get('center')?.x).toBe(fit.laneCenterX)
    expect(afterPagination.totalWidth).toBe(initial.totalWidth)
  })

  test('does not change the gutter budget when a detail pane shrinks the graph canvas', () => {
    const browserFit = fitGraphToBrowserWindow(1440, 0, 1, 260)
    // The selected-node detail pane reduces the graph canvas from 1440px to
    // 1040px. Using that element width would incorrectly remove four gutters.
    const shrunkenCanvasFit = fitGraphToViewport(1040, 260)

    expect(browserFit.maxLaneRadius).toBe(3)
    expect(shrunkenCanvasFit.maxLaneRadius).toBe(1)
    expect(browserFit.laneCenterX).toBe(720)
  })

  test('keeps the center lane at the browser midpoint when a left sidebar opens', () => {
    const browserWidth = 1440
    const graphLeft = 250
    const zoom = 0.8
    const fit = fitGraphToBrowserWindow(browserWidth, graphLeft, zoom, 260)
    const renderedScreenX = graphLeft + fit.laneCenterX * zoom

    expect(renderedScreenX).toBe(browserWidth / 2)
  })
})
