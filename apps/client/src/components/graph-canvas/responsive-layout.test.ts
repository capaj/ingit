import { describe, expect, test } from 'bun:test'
import type { CommitRow } from '@ingit/rpc-contract'
import {
  buildLayout,
  colorForBranchName,
  fitGraphToBrowserWindow,
  fitLaneFrameToRows,
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

  test('expands right without recentering existing nodes', () => {
    const fit = fitGraphToViewport(1440, 260)
    const initial = fitLaneFrameToRows([row('center', 0)], fit)
    const expanded = fitLaneFrameToRows([row('center', 0), row('outer', 12)], fit, initial)
    expect(expanded.laneCenterX).toBe(initial.laneCenterX)
    expect(expanded.totalWidth).toBeGreaterThan(fit.layoutWidth)
    expect(expanded.laneRadius).toBeGreaterThanOrEqual(12)
    expect(fitLaneFrameToRows([row('center', 0)], fit, expanded)).toEqual(expanded)
  })

  test('left growth preserves screen positions when the scroll origin is compensated', () => {
    const fit = fitGraphToViewport(1440, 260)
    const initial = fitLaneFrameToRows([row('center', 0)], fit)
    const expanded = fitLaneFrameToRows([row('left', -12), row('center', 0)], fit, initial)
    for (const zoom of [0.5, 1, 2]) {
      const previousScroll = 150
      const nextScroll = previousScroll + (expanded.laneCenterX - initial.laneCenterX) * zoom
      expect(expanded.laneCenterX * zoom - nextScroll).toBe(initial.laneCenterX * zoom - previousScroll)
    }
    const graph = buildLayout([row('left', -12)], 0, 0, expanded)
    expect(graph.nodes[0].x).toBeGreaterThan(0)
    expect(fitLaneFrameToRows([row('center', 0)], fit, expanded)).toEqual(expanded)
  })

  test('leaves lane zero fixed when occupied gutters are already symmetric', () => {
    const fit = fitGraphToViewport(1440, 260)
    const laneFrame = fitLaneFrameToRows([
      row('left', -2),
      row('center', 0),
      row('right', 2),
    ], fit)

    expect(laneFrame.laneCenterX).toBe(fit.laneCenterX)
  })

  test('derives stable, varied branch colors from branch names', () => {
    const names = [
      'origin/dev',
      'origin/codex/issue-651-video-placement-hygiene',
      'codex/split-cms-content-tabs',
      'codex/keyword-move-chat-action-mode',
      'origin/claude/theme-switching-navigation-bug-3qjx7p',
      'main',
      'origin/claude/github-issue-653-a2aetg',
      'groas-admin-issue-media',
    ]
    const colors = names.map(colorForBranchName)

    expect(colors.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true)
    expect(new Set(colors).size).toBe(names.length)
    expect(colorForBranchName('main')).toBe('#eca889')
  })
})
