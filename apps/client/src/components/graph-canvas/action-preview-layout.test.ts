import { describe, expect, test } from 'bun:test'
import { fitPreviewCamera, stackPreviewChainAboveGraph } from './action-preview-layout'

describe('stackPreviewChainAboveGraph', () => {
  test('anchors the oldest preview row above the graph and lets a long chain continue past the top edge', () => {
    const nodes = Array.from({ length: 5 }, (_, index) => ({ id: index, y: 0, idx: index }))

    const stacked = stackPreviewChainAboveGraph(nodes, { y: 152, idx: 0 }, 56)

    expect(stacked.map((node) => node.y)).toEqual([-128, -72, -16, 40, 96])
    expect(stacked.map((node) => node.idx)).toEqual([-5, -4, -3, -2, -1])
    expect(stacked.map((node) => node.id)).toEqual([0, 1, 2, 3, 4])
    expect(stacked.every((node) => node.y < 152)).toBe(true)
  })
})

describe('fitPreviewCamera', () => {
  test('uses the full viewport to fit and center the preview', () => {
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
    expect((580 + 620) / 2 * camera.zoom + camera.translateX).toBeCloseTo(600)
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
