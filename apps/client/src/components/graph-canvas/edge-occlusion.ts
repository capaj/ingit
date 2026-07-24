export interface OcclusionRouteNode {
  x: number
  y: number
  idx: number
  lane: number
}

export interface EdgeOcclusionGeometry {
  laneWidth: number
  rowHeight: number
  nodeRadius: number
  clearance: number
  curveControlRatio: number
}

export type OcclusionHookTrack = 'from' | 'to'

export interface ClearEndpointRail {
  side: 'left' | 'right'
  anchorLane: number
  innerLane: number
  outerRailX: number
}

export interface EdgeRoutePoint {
  x: number
  y: number
}

export interface VerticalClearanceRail {
  x: number
  startY: number
  endY: number
}

function pointOnCircleToward(from: EdgeRoutePoint, to: EdgeRoutePoint, radius: number): EdgeRoutePoint {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  return {
    x: from.x + (dx / distance) * radius,
    y: from.y + (dy / distance) * radius,
  }
}

function cubicPoint(
  start: EdgeRoutePoint,
  controlA: EdgeRoutePoint,
  controlB: EdgeRoutePoint,
  end: EdgeRoutePoint,
  progress: number,
): EdgeRoutePoint {
  const remaining = 1 - progress
  const startWeight = remaining ** 3
  const controlAWeight = 3 * remaining ** 2 * progress
  const controlBWeight = 3 * remaining * progress ** 2
  const endWeight = progress ** 3

  return {
    x: start.x * startWeight + controlA.x * controlAWeight + controlB.x * controlBWeight + end.x * endWeight,
    y: start.y * startWeight + controlA.y * controlAWeight + controlB.y * controlBWeight + end.y * endWeight,
  }
}

function squaredDistanceToSegment(
  point: EdgeRoutePoint,
  start: EdgeRoutePoint,
  end: EdgeRoutePoint,
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2

  const progress = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  ))
  const closestX = start.x + progress * dx
  const closestY = start.y + progress * dy
  return (point.x - closestX) ** 2 + (point.y - closestY) ** 2
}

function squaredDistanceToVerticalRail(
  start: EdgeRoutePoint,
  end: EdgeRoutePoint,
  rail: VerticalClearanceRail,
) {
  const railTop = Math.min(rail.startY, rail.endY)
  const railBottom = Math.max(rail.startY, rail.endY)
  const segmentDx = end.x - start.x

  if (Math.abs(segmentDx) >= 0.001) {
    const progress = (rail.x - start.x) / segmentDx
    if (progress >= 0 && progress <= 1) {
      const intersectionY = start.y + progress * (end.y - start.y)
      if (intersectionY >= railTop && intersectionY <= railBottom) return 0
    }
  } else if (
    Math.abs(start.x - rail.x) < 0.001
    && Math.max(Math.min(start.y, end.y), railTop)
      <= Math.min(Math.max(start.y, end.y), railBottom)
  ) {
    return 0
  }

  const squaredDistanceFromPointToRail = (point: EdgeRoutePoint) => {
    const nearestY = Math.max(railTop, Math.min(railBottom, point.y))
    return (point.x - rail.x) ** 2 + (point.y - nearestY) ** 2
  }
  return Math.min(
    squaredDistanceFromPointToRail(start),
    squaredDistanceFromPointToRail(end),
    squaredDistanceToSegment({ x: rail.x, y: railTop }, start, end),
    squaredDistanceToSegment({ x: rail.x, y: railBottom }, start, end),
  )
}

function polylineClearsVerticalRails(
  points: EdgeRoutePoint[],
  rails: VerticalClearanceRail[],
  clearanceSquared: number,
) {
  return rails.every((rail) => {
    for (let index = 1; index < points.length; index++) {
      if (squaredDistanceToVerticalRail(
        points[index - 1],
        points[index],
        rail,
      ) < clearanceSquared) return false
    }
    return true
  })
}

/**
 * Extend a side-entry curve's target lead past a nearby vertical rail, but
 * only when the resulting polyline has the requested clearance from all rails.
 */
export function findClearTargetLeadXAroundRails(
  points: EdgeRoutePoint[],
  targetSide: 'left' | 'right',
  rails: VerticalClearanceRail[],
  clearance: number,
): number | undefined {
  if (points.length < 4) return undefined
  const clearanceSquared = clearance ** 2
  if (polylineClearsVerticalRails(points, rails, clearanceSquared)) return undefined

  const targetEnd = points[points.length - 1]
  const defaultTargetLead = points[points.length - 2]
  const sourceLead = points[1]
  const direction = targetSide === 'left' ? -1 : 1
  const defaultDistance = direction * (defaultTargetLead.x - targetEnd.x)
  const maximumDistance = direction * (sourceLead.x - targetEnd.x) - clearance
  if (maximumDistance <= defaultDistance) return undefined

  const candidates = rails
    .filter((rail) => (
      direction * (rail.x - targetEnd.x) > defaultDistance
      && direction * (rail.x - targetEnd.x) < maximumDistance
    ))
    .map((rail) => rail.x + direction * clearance)
    .filter((targetLeadX) => (
      direction * (targetLeadX - targetEnd.x) <= maximumDistance
    ))
    .sort((left, right) => direction * (left - right))

  for (const targetLeadX of candidates) {
    const candidatePoints = [...points]
    candidatePoints[candidatePoints.length - 2] = {
      ...defaultTargetLead,
      x: targetLeadX,
    }
    if (polylineClearsVerticalRails(candidatePoints, rails, clearanceSquared)) {
      return targetLeadX
    }
  }
  return undefined
}

function curveIntersectsIntermediateNode(
  from: OcclusionRouteNode,
  to: OcclusionRouteNode,
  occupiedLanes: number[],
  geometry: EdgeOcclusionGeometry,
  additionalOccupiedLanes?: ReadonlyMap<number, readonly number[]>,
): boolean {
  const clipRadius = geometry.nodeRadius - 1
  const start = pointOnCircleToward(from, to, clipRadius)
  const end = pointOnCircleToward(to, from, clipRadius)
  const curveDy = end.y - start.y
  const controlA = { x: start.x, y: start.y + curveDy * geometry.curveControlRatio }
  const controlB = { x: end.x, y: end.y - curveDy * geometry.curveControlRatio }
  const collisionRadiusSquared = (geometry.nodeRadius + geometry.clearance) ** 2

  // The short curves checked here span only a handful of rows. Sampling them
  // into small line segments keeps the collision check simple while remaining
  // comfortably sub-pixel at graph scale.
  const sampleCount = Math.max(32, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 4))
  const firstIntermediateRow = Math.min(from.idx, to.idx) + 1
  const lastIntermediateRow = Math.max(from.idx, to.idx) - 1
  const intermediateNodes: EdgeRoutePoint[] = []
  for (let idx = firstIntermediateRow; idx <= lastIntermediateRow; idx++) {
    const lane = occupiedLanes[idx]
    const lanes = [
      ...(lane === undefined ? [] : [lane]),
      ...(additionalOccupiedLanes?.get(idx) ?? []),
    ]
    for (const occupiedLane of lanes) {
      intermediateNodes.push({
        x: from.x + (occupiedLane - from.lane) * geometry.laneWidth,
        y: from.y + (idx - from.idx) * geometry.rowHeight,
      })
    }
  }

  let previous = start
  for (let sample = 1; sample <= sampleCount; sample++) {
    const current = cubicPoint(start, controlA, controlB, end, sample / sampleCount)
    if (intermediateNodes.some((node) => (
      squaredDistanceToSegment(node, previous, current) <= collisionRadiusSquared
    ))) return true
    previous = current
  }

  return false
}

function endpointTrackIsClear(
  from: OcclusionRouteNode,
  to: OcclusionRouteNode,
  occupiedLanes: number[],
  track: OcclusionHookTrack,
  additionalOccupiedLanes?: ReadonlyMap<number, readonly number[]>,
): boolean {
  const trackLane = track === 'from' ? from.lane : to.lane
  const firstIntermediateRow = Math.min(from.idx, to.idx) + 1
  const lastIntermediateRow = Math.max(from.idx, to.idx) - 1

  for (let idx = firstIntermediateRow; idx <= lastIntermediateRow; idx++) {
    if (occupiedLanes[idx] === trackLane) return false
    if (additionalOccupiedLanes?.get(idx)?.includes(trackLane)) return false
  }
  return true
}

/**
 * Use the preferred endpoint's own gutter as the single vertical rail when it
 * is clear across the edge span. The caller can connect the other endpoint
 * with one diagonal instead of switching between two interior rails.
 */
export function findClearEndpointRail(
  from: OcclusionRouteNode,
  to: OcclusionRouteNode,
  occupiedLanes: number[],
  preferredTrack: OcclusionHookTrack,
  additionalOccupiedLanes?: ReadonlyMap<number, readonly number[]>,
): ClearEndpointRail | null {
  if (!endpointTrackIsClear(from, to, occupiedLanes, preferredTrack, additionalOccupiedLanes)) {
    return null
  }

  const railNode = preferredTrack === 'from' ? from : to
  const otherNode = preferredTrack === 'from' ? to : from
  return {
    side: railNode.x <= otherNode.x ? 'left' : 'right',
    anchorLane: railNode.lane,
    innerLane: otherNode.lane,
    outerRailX: railNode.x,
  }
}

/**
 * Pick an endpoint lane for an orthogonal hook only when the normal short
 * curve would pass under another commit and that hook's vertical track is
 * empty. Returning null preserves the normal curved route.
 */
export function findOcclusionHookTrack(
  from: OcclusionRouteNode,
  to: OcclusionRouteNode,
  occupiedLanes: number[],
  geometry: EdgeOcclusionGeometry,
  preferredTrack: OcclusionHookTrack,
  additionalOccupiedLanes?: ReadonlyMap<number, readonly number[]>,
): OcclusionHookTrack | null {
  if (Math.abs(to.idx - from.idx) < 2) return null
  if (!curveIntersectsIntermediateNode(
    from,
    to,
    occupiedLanes,
    geometry,
    additionalOccupiedLanes,
  )) return null

  if (endpointTrackIsClear(from, to, occupiedLanes, preferredTrack, additionalOccupiedLanes)) return preferredTrack
  const alternateTrack = preferredTrack === 'from' ? 'to' : 'from'
  return endpointTrackIsClear(from, to, occupiedLanes, alternateTrack, additionalOccupiedLanes)
    ? alternateTrack
    : null
}
