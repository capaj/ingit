import { describe, expect, test } from 'bun:test'
import { LaneAllocator } from '../src/lane-allocator.js'

describe('LaneAllocator', () => {
  test('keeps the current branch in the center and fans sibling branches to both sides', () => {
    const allocator = new LaneAllocator()

    allocator.reserveLane('head', 0)
    expect(allocator.assignLane('head', ['main-parent'])).toBe(0)

    expect(allocator.assignLane('branch-a', ['main-parent'])).toBe(1)
    expect(allocator.assignLane('branch-b', ['main-parent'])).toBe(-1)
  })

  test('grows beyond 16 live lanes when merge pressure requires it', () => {
    const allocator = new LaneAllocator()
    let currentHead = 'head-0'

    allocator.reserveLane(currentHead, 0)

    for (let i = 0; i < 20; i++) {
      const nextHead = `head-${i + 1}`
      allocator.assignLane(currentHead, [nextHead, `merge-parent-${i}`])
      currentHead = nextHead
    }

    const snapshot = allocator.snapshot()
    const lanes = snapshot.activeLanes.map((entry) => entry.lane)

    expect(snapshot.activeLanes.length).toBeGreaterThan(16)
    expect(lanes.some((lane) => lane < 0)).toBe(true)
    expect(lanes.some((lane) => lane > 0)).toBe(true)
  })
})
