/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import { findOcclusionHookTrack, type OcclusionRouteNode } from './edge-occlusion'

const geometry = {
  laneWidth: 80,
  rowHeight: 56,
  nodeRadius: 16,
  clearance: 2,
  curveControlRatio: 0.3,
}

function node(lane: number, idx: number): OcclusionRouteNode {
  return {
    lane,
    idx,
    x: lane * geometry.laneWidth,
    y: idx * geometry.rowHeight,
  }
}

describe('findOcclusionHookTrack', () => {
  test('uses the clear source track when a short curve crosses a commit', () => {
    expect(findOcclusionHookTrack(
      node(-1, 0),
      node(1, 2),
      [-1, 0, 1],
      geometry,
      'from',
    )).toBe('from')
  })

  test('keeps the normal curve when it does not cross a commit', () => {
    expect(findOcclusionHookTrack(
      node(-1, 0),
      node(1, 2),
      [-1, 2, 1],
      geometry,
      'from',
    )).toBeNull()
  })

  test('uses the other endpoint track when the preferred gutter is occupied', () => {
    expect(findOcclusionHookTrack(
      node(-1, 0),
      node(1, 4),
      [-1, -1, 0, 0, 1],
      geometry,
      'from',
    )).toBe('to')
  })

  test('keeps the curve when neither orthogonal track is clear', () => {
    expect(findOcclusionHookTrack(
      node(-1, 0),
      node(1, 4),
      [-1, -1, 0, 1, 1],
      geometry,
      'from',
    )).toBeNull()
  })
})
