import { describe, expect, test } from 'bun:test'
import { circleIntersectsRectangle } from './layering'

describe('graph layering', () => {
  test('detects a ref pill crossing a protected node', () => {
    expect(circleIntersectsRectangle(
      { x: 100, y: 50, radius: 20 },
      { x: 60, y: 40, width: 100, height: 20 },
    )).toBe(true)
  })

  test('leaves a nearby non-overlapping ref pill above the graph', () => {
    expect(circleIntersectsRectangle(
      { x: 100, y: 50, radius: 20 },
      { x: 121, y: 40, width: 100, height: 20 },
    )).toBe(false)
  })
})
