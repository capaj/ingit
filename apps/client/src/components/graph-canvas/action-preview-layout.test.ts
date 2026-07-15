import { describe, expect, test } from 'bun:test'
import { fitPreviewCamera, stackPreviewChainAboveTarget } from './action-preview-layout'

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
