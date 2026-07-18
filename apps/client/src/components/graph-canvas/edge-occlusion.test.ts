/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import {
  findClearEndpointRail,
  findOcclusionHookTrack,
  type OcclusionRouteNode,
} from './edge-occlusion'

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

  test('routes around a synthetic worktree node in an otherwise occupied row', () => {
    expect(findOcclusionHookTrack(
      node(-1, 0),
      node(0, 4),
      [-1, 2, 2, 2, 0],
      geometry,
      'from',
      new Map([[3, [0]]]),
    )).toBe('from')
  })
})

describe('findClearEndpointRail', () => {
  test('selects a clear long-lived source gutter despite branches farther outside', () => {
    expect(findClearEndpointRail(
      node(-2, 0),
      node(0, 6),
      [-2, -3, -1, 1, 2, -3, 0],
      'from',
    )).toEqual({
      side: 'left',
      anchorLane: -2,
      innerLane: 0,
      outerRailX: -160,
    })
  })

  test('rejects an endpoint gutter occupied between the connected commits', () => {
    expect(findClearEndpointRail(
      node(-2, 0),
      node(0, 6),
      [-2, -3, -2, 1, 2, -3, 0],
      'from',
    )).toBeNull()
  })
})
