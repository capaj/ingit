import { describe, expect, test } from 'bun:test'
import {
  fitPreviewCamera,
  mergePreviewGutterX,
  placeMergePreviewAboveGraph,
  placeWorktreeAbovePreview,
  stackPreviewChainAboveTarget,
  uncommitCrossLines,
} from './action-preview-layout'

describe('mergePreviewGutterX', () => {
  test('uses the right-side source gutter when its rail is clear', () => {
    const branchNodes = [
      { x: 420, idx: 4 },
      { x: 500, idx: 8 },
      { x: 580, idx: 12 },
    ]

    const gutterX = mergePreviewGutterX(branchNodes, -1, 12, 80, 'right')

    expect(gutterX).toBe(580)
  })

  test('uses the left-side source gutter when its rail is clear', () => {
    const branchNodes = [
      { x: 420, idx: 4 },
      { x: 500, idx: 8 },
      { x: 580, idx: 12 },
    ]

    const gutterX = mergePreviewGutterX(branchNodes, -1, 4, 80, 'left')

    expect(gutterX).toBe(420)
  })

  test('does not zig-zag through an empty gutter on the opposite side', () => {
    const branchNodes = [
      { x: 155, idx: 10 },
      { x: 294, idx: 1 },
      { x: 433, idx: 13 },
      { x: 711, idx: 0 },
    ]

    expect(mergePreviewGutterX(branchNodes, -1, 0, 80, 'right')).toBe(711)
  })

  test('creates a new outward gutter when the source rail is obstructed', () => {
    const branchNodes = [
      { x: 500, idx: 4 },
      { x: 580, idx: 8 },
      { x: 580, idx: 12 },
    ]

    expect(mergePreviewGutterX(branchNodes, -1, 12, 80, 'right')).toBe(660)
  })

  test('does not invent a gutter when no graph nodes exist', () => {
    expect(mergePreviewGutterX([], -1, 20, 80, 'left')).toBeNull()
  })
})

describe('stackPreviewChainAboveTarget', () => {
  test('anchors the oldest replayed commit one row above the rebase target', () => {
    const nodes = Array.from({ length: 3 }, (_, index) => ({ id: index, y: 0, idx: index }))

    const stacked = stackPreviewChainAboveTarget(nodes, { y: 600, idx: 8 }, 56)

    expect(stacked.map((node) => node.y)).toEqual([432, 488, 544])
    expect(stacked.map((node) => node.idx)).toEqual([5, 6, 7])
    expect(stacked.map((node) => node.id)).toEqual([0, 1, 2])
    expect(stacked.every((node) => node.y < 600)).toBe(true)
  })
})

describe('placeWorktreeAbovePreview', () => {
  test('moves uncommitted changes above an appended commit preview', () => {
    const head = { id: 'head', y: 600, idx: 8 }
    const preview = { id: 'revert', y: 544, idx: 7 }

    const placement = placeWorktreeAbovePreview(head, preview, 56)

    expect(placement).toEqual({ anchor: preview, y: 488, idx: 6 })
  })

  test('stays one row above HEAD without a commit preview', () => {
    const head = { id: 'head', y: 600, idx: 8 }

    expect(placeWorktreeAbovePreview(head, null, 56)).toEqual({
      anchor: head,
      y: 544,
      idx: 7,
    })
  })
})

describe('placeMergePreviewAboveGraph', () => {
  test('places an in-progress merge above the newest graph row', () => {
    const top = { y: 152, idx: 0 }

    expect(placeMergePreviewAboveGraph(top, 56)).toEqual({ y: 96, idx: -1 })
  })
})

describe('uncommitCrossLines', () => {
  test('crosses the commit center with two opposite diagonals', () => {
    expect(uncommitCrossLines({ x: 400, y: 240 }, 20)).toEqual([
      { x1: 380, y1: 220, x2: 420, y2: 260 },
      { x1: 420, y1: 220, x2: 380, y2: 260 },
    ])
  })
})

describe('fitPreviewCamera', () => {
  test('zooms an oversized preview to fit without moving an axis that already fits', () => {
    const camera = fitPreviewCamera({
      baseZoom: 1,
      bounds: { minX: 580, minY: -100, maxX: 620, maxY: 700 },
      viewport: { width: 1200, height: 800 },
      scroll: { x: 0, y: 0 },
      margin: 16,
    })

    expect(camera.zoom).toBeCloseTo(768 / 800)
    expect(-100 * camera.zoom + camera.translateY).toBeCloseTo(16)
    expect(700 * camera.zoom + camera.translateY).toBeCloseTo(784)
    expect(camera.translateX).toBe(0)
  })

  test('moves a short preview only far enough to reveal its clipped edge', () => {
    const camera = fitPreviewCamera({
      baseZoom: 1,
      bounds: { minX: 580, minY: -32, maxX: 620, maxY: 152 },
      viewport: { width: 1200, height: 800 },
      scroll: { x: 0, y: 0 },
      margin: 12,
    })

    expect(camera).toEqual({ zoom: 1, translateX: 0, translateY: 44 })
    expect(-32 + camera.translateY).toBe(12)
  })

  test('keeps the existing camera when the preview already fits', () => {
    expect(fitPreviewCamera({
      baseZoom: 0.8,
      bounds: { minX: 400, minY: 200, maxX: 700, maxY: 600 },
      viewport: { width: 1200, height: 800 },
      scroll: { x: 0, y: 0 },
      margin: 16,
    })).toEqual({ zoom: 0.8, translateX: 0, translateY: 0 })
  })
})
