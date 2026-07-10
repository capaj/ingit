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

interface Point {
  x: number
  y: number
}

function pointOnCircleToward(from: Point, to: Point, radius: number): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  return {
    x: from.x + (dx / distance) * radius,
    y: from.y + (dy / distance) * radius,
  }
}

function cubicPoint(start: Point, controlA: Point, controlB: Point, end: Point, progress: number): Point {
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

function squaredDistanceToSegment(point: Point, start: Point, end: Point): number {
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

function curveIntersectsIntermediateNode(
  from: OcclusionRouteNode,
  to: OcclusionRouteNode,
  occupiedLanes: number[],
  geometry: EdgeOcclusionGeometry,
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
  const intermediateNodes: Point[] = []
  for (let idx = firstIntermediateRow; idx <= lastIntermediateRow; idx++) {
    const lane = occupiedLanes[idx]
    if (lane === undefined) continue
    intermediateNodes.push({
      x: from.x + (lane - from.lane) * geometry.laneWidth,
      y: from.y + (idx - from.idx) * geometry.rowHeight,
    })
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

function hookTrackIsClear(
  from: OcclusionRouteNode,
  to: OcclusionRouteNode,
  occupiedLanes: number[],
  track: OcclusionHookTrack,
): boolean {
  const trackLane = track === 'from' ? from.lane : to.lane
  const firstIntermediateRow = Math.min(from.idx, to.idx) + 1
  const lastIntermediateRow = Math.max(from.idx, to.idx) - 1

  for (let idx = firstIntermediateRow; idx <= lastIntermediateRow; idx++) {
    if (occupiedLanes[idx] === trackLane) return false
  }
  return true
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
): OcclusionHookTrack | null {
  if (Math.abs(to.idx - from.idx) < 2) return null
  if (!curveIntersectsIntermediateNode(from, to, occupiedLanes, geometry)) return null

  if (hookTrackIsClear(from, to, occupiedLanes, preferredTrack)) return preferredTrack
  const alternateTrack = preferredTrack === 'from' ? 'to' : 'from'
  return hookTrackIsClear(from, to, occupiedLanes, alternateTrack) ? alternateTrack : null
}
