import { useRef, useEffect, useCallback, useState, useMemo, useReducer } from 'react'
import { animated, to, useSpring } from '@react-spring/web'
import { prepareWithSegments, measureNaturalWidth } from '@chenglou/pretext'
import type { CommitRow, CommitActionKind, RefSummary, WorktreeChangesResponse } from '@ingit/rpc-contract'
import { useAppStore } from '../store'
import { CommitActionButton, RefActionButton } from './graph-canvas/ActionButtons'

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const NODE_SPACING_Y = 56
// Cap how many on-screen commits we look up CI for at once. Zoomed out, hundreds
// can be visible; fetching them all blasts GitHub and trips its secondary rate
// limit, so we take the newest 20 and ignore the rest.
const MAX_ONSCREEN_CI_FETCH = 20
const LANE_WIDTH = 80
const NODE_RADIUS = 16
const NODE_FILL = '#11111b'
const REF_PILL_HEIGHT = 20
const COMMIT_ACTION_HEIGHT = 30
const DEFAULT_REF_ACTION_HEIGHT = 28
const GAUGE_RADIUS = NODE_RADIUS - 5
const GAUGE_BACKGROUND_FILL = '#1e1e2e'
const GAUGE_TRACK_STROKE = '#45475a'
const GAUGE_TRACK_STROKE_SELECTED = '#cdd6f455'
const GAUGE_TRACK_FILL_SELECTED = '#cdd6f422'
const GAUGE_ADDITIONS_FILL = '#a6e3a1'
const GAUGE_DELETIONS_FILL = '#f38ba8'
const GAUGE_MIN_FILL_HEIGHT = 2
const GAUGE_SCALE_PERCENTILE = 0.85
const EDGE_CORNER_RADIUS = 12
const EDGE_SHORT_CURVE_ROWS = 6
const EDGE_RAIL_BASE_OFFSET = NODE_RADIUS + 14
const EDGE_RAIL_STAGGER_STEP = 6
const EDGE_BUNDLE_GAP = 4
const GRAPH_LEFT_GUTTER = 120
const GRAPH_RIGHT_GUTTER = 520
const PAD_TOP = 40
const GRAPH_TOP_HEADROOM = NODE_SPACING_Y * 2
const PAD_LEFT = 40
const COMMIT_MESSAGE_GUTTER = 260
const LANE_ORIGIN_X_BASE = PAD_LEFT + GRAPH_LEFT_GUTTER
const GRAPH_SPRING_CONFIG = { mass: 2.1, tension: 180, friction: 28 }
const REF_PILL_GAP = 6
const REF_PILL_HORIZONTAL_PADDING = 14
const REF_PILL_FONT = '600 11px system-ui, -apple-system, sans-serif'
const GRAPH_ENTER_OFFSET_Y = NODE_SPACING_Y * 0.55
const GRAPH_EXIT_OFFSET_Y = NODE_SPACING_Y * 0.3
const PRIMARY_LANE_HIGHLIGHT_WIDTH = 54

const LANE_COLORS = [
  '#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7',
  '#94e2d5', '#fab387', '#74c7ec', '#f5c2e7', '#b4befe',
]

// Stable empty fallback so memo factories don't allocate a fresh map per render
// when no layout is loaded yet.
const EMPTY_SHA_COLOR: Map<string, string> = new Map()

function laneColor(lane: number) {
  const normalized = ((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length
  return LANE_COLORS[normalized]
}

// Branch colors must be stable: a commit's color depends on the branch line it
// belongs to, never on its lane index. Lane indices shift on every checkout
// (the current branch is pulled to lane 0), so coloring by lane made the whole
// graph recolor itself on checkout. Hashing a stable identity (the branch name,
// or the sha for unlabeled commits) keeps each line's color fixed.
function colorForBranchName(name: string) {
  return LANE_COLORS[hashText(name) % LANE_COLORS.length]
}

function stableColorForNode(sha: string, shaToBranch: Map<string, string>) {
  const branch = shaToBranch.get(sha)
  return branch ? colorForBranchName(branch) : LANE_COLORS[hashText(sha) % LANE_COLORS.length]
}

function verticalOffsetForHeight(height: number) {
  return Math.round((REF_PILL_HEIGHT - height) / 2)
}

interface LayoutNode {
  row: CommitRow
  x: number
  y: number
  idx: number
}

interface VisibleCommitAction {
  action: CommitActionKind
  label: string
  tone: 'success' | 'warning' | 'uncommit'
}

interface VisibleRefAction {
  action: 'checkout' | 'push' | 'fetch' | 'delete' | 'move' | 'reset'
  label: string
  tone: 'neutral' | 'warning' | 'danger'
  force?: boolean
}

// The server reports a non-fast-forward push rejection as an oRPC CONFLICT error
// (plain Errors are masked as "Internal server error" over the wire).
function isNonFastForwardPushError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'CONFLICT'
}

interface RefPlacement {
  refName: string
  nodeSha: string
  x: number
  y: number
  color: string
  isCurrent: boolean
  isSelected: boolean
  isRemote: boolean
}

interface VisibleEdgeItem {
  key: string
  path: string
  x1: number
  y1: number
  x2: number
  y2: number
  isMerge: boolean
  stroke: string
  strokeWidth: number
  opacity: number
}

interface VisibleEdge {
  from: LayoutNode
  to: LayoutNode
  isMerge: boolean
  key: string
}

interface CurrentLaneHighlight {
  key: string
  x: number
  color: string
}

type GraphLayout = ReturnType<typeof buildLayout>

interface GraphAnimationSnapshot {
  fromLayout: GraphLayout
  toLayout: GraphLayout
  fromCurrentBranch: string | null
  toCurrentBranch: string | null
}

interface RenderedEdgeItem {
  key: string
  path: string
  stroke: string
  fromStrokeWidth: number
  toStrokeWidth: number
  fromOpacity: number
  toOpacity: number
  fromX1: number
  fromY1: number
  fromX2: number
  fromY2: number
  toX1: number
  toY1: number
  toX2: number
  toY2: number
}

interface RenderedNodeItem {
  key: string
  row: CommitRow
  interactive: boolean
  color: string
  fromX: number
  fromY: number
  toX: number
  toY: number
  fromOpacity: number
  toOpacity: number
}

interface RenderedRefItem {
  key: string
  placement: RefPlacement
  fromX: number
  fromY: number
  toX: number
  toY: number
  fromOpacity: number
  toOpacity: number
  fromScale: number
  toScale: number
}

interface RenderedLaneHighlight {
  key: string
  color: string
  fromX: number
  toX: number
  fromOpacity: number
  toOpacity: number
}

interface EdgeRoutingData {
  plans: Map<string, EdgeRoutePlan>
  bundleOffsets: Map<string, number>
}

function upstreamShortName(upstream?: string) {
  if (!upstream) return null
  if (upstream.startsWith('refs/remotes/')) return upstream.slice('refs/remotes/'.length)
  return upstream
}

function findTrackingRemoteRef(localRef: RefSummary, refs: RefSummary[]) {
  const explicitUpstream = upstreamShortName(localRef.upstream)
  if (explicitUpstream) {
    return refs.find((ref) => ref.kind === 'remote' && ref.shortName === explicitUpstream) ?? null
  }

  const originMatch = refs.find((ref) => ref.kind === 'remote' && ref.shortName === `origin/${localRef.shortName}`)
  if (originMatch) return originMatch

  const suffixMatches = refs.filter(
    (ref) => ref.kind === 'remote' && ref.shortName.endsWith(`/${localRef.shortName}`),
  )
  return suffixMatches.length === 1 ? suffixMatches[0] : null
}

type EdgeRoutePlan =
  | { mode: 'straight' }
  | { mode: 'curve' }
  | { mode: 'adjacent-hook'; laneA: number; laneB: number }
  | { mode: 'inside-rail'; minLane: number; maxLane: number; sourceRailX: number; targetRailX: number; crossoverY: number }
  | { mode: 'outer-rail'; side: 'left' | 'right'; anchorLane: number; innerLane: number; outerRailX: number }

function buildLayout(rows: CommitRow[], extraLeftGutter = 0) {
  let minLane = Infinity
  let maxLane = -Infinity
  const nodes: LayoutNode[] = []
  const shaToNode = new Map<string, LayoutNode>()
  const shaToRow = new Map<string, CommitRow>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.lane < minLane) minLane = row.lane
    if (row.lane > maxLane) maxLane = row.lane
    shaToRow.set(row.sha, row)
  }

  const leftmostLane = Number.isFinite(minLane) ? minLane : 0
  const rightmostLane = Number.isFinite(maxLane) ? maxLane : 0
  const laneRadius = Math.max(Math.abs(leftmostLane), Math.abs(rightmostLane))
  const laneOriginX = LANE_ORIGIN_X_BASE + extraLeftGutter

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const node: LayoutNode = {
      row,
      x: laneOriginX + (row.lane + laneRadius) * LANE_WIDTH,
      y: PAD_TOP + GRAPH_TOP_HEADROOM + i * NODE_SPACING_Y,
      idx: i,
    }
    nodes.push(node)
    shaToNode.set(row.sha, node)
  }

  // Build sha → branch name by tracing first-parent chains from branch tips
  // Prefer local branches over remotes; skip bare remote names like "origin"
  const shaToBranch = new Map<string, string>()
  for (const row of rows) {
    const bestRef = pickBestRef(row.refNames)
    if (!bestRef) continue
    let sha: string | undefined = row.sha
    while (sha && !shaToBranch.has(sha)) {
      shaToBranch.set(sha, bestRef)
      const r = shaToRow.get(sha)
      if (!r || r.parentShas.length === 0) break
      sha = r.parentShas[0]
    }
  }

  const shaToColor = new Map<string, string>()
  for (const node of nodes) {
    shaToColor.set(node.row.sha, stableColorForNode(node.row.sha, shaToBranch))
  }

  return {
    nodes,
    shaToNode,
    shaToBranch,
    shaToColor,
    maxLane,
    totalWidth: PAD_LEFT * 2 + GRAPH_LEFT_GUTTER + extraLeftGutter + (laneRadius * 2 + 1) * LANE_WIDTH + GRAPH_RIGHT_GUTTER,
    totalHeight: rows.length * NODE_SPACING_Y + PAD_TOP * 2 + GRAPH_TOP_HEADROOM,
  }
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1},${y1}L${x2},${y2}`
  const dy = y2 - y1
  return `M${x1},${y1}C${x1},${y1 + dy * 0.3} ${x2},${y2 - dy * 0.3} ${x2},${y2}`
}

function hashText(text: string) {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  return hash
}

function pointOnCircleToward(fromX: number, fromY: number, toX: number, toY: number, radius: number) {
  const dx = toX - fromX
  const dy = toY - fromY
  const dist = Math.hypot(dx, dy) || 1
  return {
    x: fromX + (dx / dist) * radius,
    y: fromY + (dy / dist) * radius,
  }
}

function roundedPolylinePath(points: Array<{ x: number; y: number }>, cornerRadius: number): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0].x},${points[0].y}`

  let d = `M${points[0].x},${points[0].y}`

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const current = points[i]
    const next = points[i + 1]

    const inDx = current.x - prev.x
    const inDy = current.y - prev.y
    const outDx = next.x - current.x
    const outDy = next.y - current.y

    const inLen = Math.hypot(inDx, inDy)
    const outLen = Math.hypot(outDx, outDy)

    if (inLen < 0.001 || outLen < 0.001) {
      d += `L${current.x},${current.y}`
      continue
    }

    const radius = Math.min(cornerRadius, inLen / 2, outLen / 2)
    const entryX = current.x - (inDx / inLen) * radius
    const entryY = current.y - (inDy / inLen) * radius
    const exitX = current.x + (outDx / outLen) * radius
    const exitY = current.y + (outDy / outLen) * radius

    d += `L${entryX},${entryY}Q${current.x},${current.y} ${exitX},${exitY}`
  }

  const last = points[points.length - 1]
  d += `L${last.x},${last.y}`
  return d
}

function chooseCrossoverY(from: LayoutNode, to: LayoutNode, edgeKey: string) {
  const rowDelta = Math.abs(to.idx - from.idx)
  const topY = Math.min(from.y, to.y)
  const hash = hashText(edgeKey)
  const fractions = rowDelta > 12 ? [0.28, 0.42, 0.56, 0.7] : [0.35, 0.5, 0.65]
  const fraction = fractions[hash % fractions.length] ?? 0.5
  const gapOffset = Math.max(0, Math.min(rowDelta - 1, Math.round((rowDelta - 1) * fraction)))
  const jitter = (((hash >> 3) % 3) - 1) * 4
  return topY + NODE_SPACING_Y * (gapOffset + 0.5) + jitter
}

function countRowsMatching(
  occupiedLanes: number[],
  fromIdx: number,
  toIdx: number,
  predicate: (lane: number, rowIdx: number) => boolean,
) {
  const start = Math.max(0, Math.min(fromIdx, toIdx) + 1)
  const end = Math.min(occupiedLanes.length - 1, Math.max(fromIdx, toIdx) - 1)
  let count = 0

  for (let idx = start; idx <= end; idx++) {
    const lane = occupiedLanes[idx]
    if (predicate(lane, idx)) count++
  }

  return count
}

function buildOuterRailPath(
  from: LayoutNode,
  to: LayoutNode,
  outerRailX: number,
) {
  const verticalDirection = to.y > from.y ? 1 : -1
  const start = pointOnCircleToward(from.x, from.y, outerRailX, from.y + verticalDirection * (NODE_RADIUS + 8), NODE_RADIUS - 1)
  const end = pointOnCircleToward(to.x, to.y, outerRailX, to.y - verticalDirection * (NODE_RADIUS + 8), NODE_RADIUS - 1)
  const sourceJoinY = from.y + verticalDirection * (NODE_RADIUS + 8)
  const targetJoinY = to.y - verticalDirection * (NODE_RADIUS + 8)

  return roundedPolylinePath(
    [
      start,
      { x: outerRailX, y: sourceJoinY },
      { x: outerRailX, y: targetJoinY },
      end,
    ],
    EDGE_CORNER_RADIUS,
  )
}

function buildAdjacentHookPath(
  from: LayoutNode,
  to: LayoutNode,
  trackX: number,
) {
  const verticalDirection = to.y > from.y ? 1 : -1
  const start = pointOnCircleToward(from.x, from.y, trackX, to.y, NODE_RADIUS - 1)
  const end = pointOnCircleToward(to.x, to.y, trackX, to.y, NODE_RADIUS - 1)
  const sourceJoinY = from.y + verticalDirection * (NODE_RADIUS + 8)

  return roundedPolylinePath(
    [
      start,
      { x: trackX, y: sourceJoinY },
      { x: trackX, y: to.y },
      end,
    ],
    EDGE_CORNER_RADIUS,
  )
}

function buildInsideRailPath(
  from: LayoutNode,
  to: LayoutNode,
  sourceRailX: number,
  targetRailX: number,
  crossoverY: number,
) {
  const start = pointOnCircleToward(from.x, from.y, to.x, to.y, NODE_RADIUS - 1)
  const end = pointOnCircleToward(to.x, to.y, from.x, from.y, NODE_RADIUS - 1)
  const verticalDirection = to.y > from.y ? 1 : -1
  const sourceJoinY = from.y + verticalDirection * (NODE_RADIUS + 8)
  const targetJoinY = to.y - verticalDirection * (NODE_RADIUS + 8)

  return roundedPolylinePath(
    [
      start,
      { x: sourceRailX, y: sourceJoinY },
      { x: sourceRailX, y: crossoverY },
      { x: targetRailX, y: crossoverY },
      { x: targetRailX, y: targetJoinY },
      end,
    ],
    EDGE_CORNER_RADIUS,
  )
}

function buildStraightEdgePath(from: LayoutNode, to: LayoutNode) {
  const start = pointOnCircleToward(from.x, from.y, to.x, to.y, NODE_RADIUS - 1)
  const end = pointOnCircleToward(to.x, to.y, from.x, from.y, NODE_RADIUS - 1)
  return `M${start.x},${start.y}L${end.x},${end.y}`
}

function buildCurvedEdgePath(from: LayoutNode, to: LayoutNode) {
  const start = pointOnCircleToward(from.x, from.y, to.x, to.y, NODE_RADIUS - 1)
  const end = pointOnCircleToward(to.x, to.y, from.x, from.y, NODE_RADIUS - 1)
  return edgePath(start.x, start.y, end.x, end.y)
}

function planEdgeRoute(
  from: LayoutNode,
  to: LayoutNode,
  edgeKey: string,
  occupiedLanes: number[],
): EdgeRoutePlan {
  const laneDelta = Math.abs(from.row.lane - to.row.lane)
  const rowDelta = Math.abs(to.idx - from.idx)

  if (laneDelta === 0) {
    return { mode: 'straight' }
  }

  if (laneDelta === 1 && rowDelta >= EDGE_SHORT_CURVE_ROWS) {
    return {
      mode: 'adjacent-hook',
      laneA: Math.min(from.row.lane, to.row.lane),
      laneB: Math.max(from.row.lane, to.row.lane),
    }
  }

  if (rowDelta < EDGE_SHORT_CURVE_ROWS) {
    return { mode: 'curve' }
  }

  const minLane = Math.min(from.row.lane, to.row.lane)
  const maxLane = Math.max(from.row.lane, to.row.lane)
  const hash = hashText(edgeKey)
  const stagger = (hash % 3) * EDGE_RAIL_STAGGER_STEP
  const direction = to.x > from.x ? 1 : -1
  const railOffset = EDGE_RAIL_BASE_OFFSET + stagger
  const sourceRailX = from.x + direction * railOffset
  const targetRailX = to.x - direction * railOffset
  const crossoverY = chooseCrossoverY(from, to, edgeKey)
  // In the centered lane layout the outermost endpoint lane is already a safe
  // routing rail. Do not push outer rails further away from the graph unless
  // bundle offsets require it, or long side branches drift too far outward.
  const rightRailX = Math.max(from.x, to.x)
  const leftRailX = Math.min(from.x, to.x)

  const insideConflicts = countRowsMatching(
    occupiedLanes,
    from.idx,
    to.idx,
    (lane) => lane > minLane && lane < maxLane,
  )
  const leftConflicts = countRowsMatching(
    occupiedLanes,
    from.idx,
    to.idx,
    (lane) => lane < minLane,
  )
  const rightConflicts = countRowsMatching(
    occupiedLanes,
    from.idx,
    to.idx,
    (lane) => lane > maxLane,
  )

  const preferredOuterSide = from.x < to.x ? 'left' : from.x > to.x ? 'right' : 'right'
  const insideScore = insideConflicts * 5 + laneDelta
  const leftScore = leftConflicts * 2 + (preferredOuterSide === 'left' ? 0 : 0.5)
  const rightScore = rightConflicts * 2 + (preferredOuterSide === 'right' ? 0 : 0.5)

  if (rightScore <= leftScore && rightScore < insideScore) {
    return {
      mode: 'outer-rail',
      side: 'right',
      anchorLane: maxLane,
      innerLane: minLane,
      outerRailX: rightRailX,
    }
  }

  if (leftScore < insideScore) {
    return {
      mode: 'outer-rail',
      side: 'left',
      anchorLane: minLane,
      innerLane: maxLane,
      outerRailX: leftRailX,
    }
  }

  return {
    mode: 'inside-rail',
    minLane,
    maxLane,
    sourceRailX,
    targetRailX,
    crossoverY,
  }
}

function edgeBundleKey(plan: EdgeRoutePlan): string | null {
  switch (plan.mode) {
    case 'outer-rail':
      return `${plan.mode}:${plan.side}:${plan.anchorLane}`
    case 'inside-rail':
      return `${plan.mode}:${plan.minLane}:${plan.maxLane}`
    case 'adjacent-hook':
      return `${plan.mode}:${plan.laneA}:${plan.laneB}`
    default:
      return null
  }
}

function routedEdgePath(
  from: LayoutNode,
  to: LayoutNode,
  plan: EdgeRoutePlan,
  bundleOffset: number,
): string {
  switch (plan.mode) {
    case 'straight':
      return buildStraightEdgePath(from, to)
    case 'curve':
      return buildCurvedEdgePath(from, to)
    case 'adjacent-hook':
      return buildAdjacentHookPath(from, to, from.x + bundleOffset)
    case 'inside-rail':
      return buildInsideRailPath(
        from,
        to,
        plan.sourceRailX + bundleOffset,
        plan.targetRailX + bundleOffset,
        plan.crossoverY,
      )
    case 'outer-rail':
      return buildOuterRailPath(from, to, plan.outerRailX + bundleOffset)
  }
}

function computeLocScaleMax(rows: CommitRow[]) {
  if (rows.length === 0) return 0
  const sorted = rows.map((row) => row.locChanged).sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * GAUGE_SCALE_PERCENTILE) - 1)
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0
}

function describeHalfCirclePath(centerX: number, centerY: number, radius: number, side: 'left' | 'right') {
  const sweepFlag = side === 'right' ? 1 : 0
  return `M ${centerX} ${centerY - radius} A ${radius} ${radius} 0 0 ${sweepFlag} ${centerX} ${centerY + radius} L ${centerX} ${centerY - radius} Z`
}

function describeHalfCircleArc(centerX: number, centerY: number, radius: number, side: 'left' | 'right') {
  const sweepFlag = side === 'right' ? 1 : 0
  return `M ${centerX} ${centerY - radius} A ${radius} ${radius} 0 0 ${sweepFlag} ${centerX} ${centerY + radius}`
}

function computeGaugeFillHeight(value: number, scaleMax: number, diameter: number) {
  if (value <= 0 || scaleMax <= 0) return 0
  const scaledHeight = diameter * Math.min(value / scaleMax, 1)
  return Math.max(GAUGE_MIN_FILL_HEIGHT, scaledHeight)
}

// ---------------------------------------------------------------------------
// Time range labels
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type TimeLabel = {
  key: string
  text: string
  y: number
  kind: 'month' | 'day' | 'hour'
}

function shouldShowHourLabels(zoom: number) {
  return zoom >= 1.4
}

function isSameDay(a: Date, b: Date) {
  return a.getDate() === b.getDate()
    && a.getMonth() === b.getMonth()
    && a.getFullYear() === b.getFullYear()
}

function isSameHour(a: Date, b: Date) {
  return isSameDay(a, b) && a.getHours() === b.getHours()
}

function formatFullDate(date: Date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

function formatHourLabel(date: Date) {
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
}

function formatTopTimeLabel(date: Date, zoom: number) {
  if (shouldShowHourLabels(zoom)) {
    return `${formatFullDate(date)} ${formatHourLabel(date)}`
  }
  return formatFullDate(date)
}

function computeTimeLabels(nodes: LayoutNode[], zoom: number) {
  if (nodes.length === 0) return []

  const showHours = shouldShowHourLabels(zoom)
  const labels: TimeLabel[] = []
  let previousSeenDate: Date | null = null
  let lastLabelY = -Infinity

  for (const node of nodes) {
    const date = new Date(node.row.committerUnix * 1000)
    const y = node.y * zoom
    const isNewDay = !previousSeenDate || !isSameDay(date, previousSeenDate)
    const isNewMonth = !previousSeenDate
      || date.getMonth() !== previousSeenDate.getMonth()
      || date.getFullYear() !== previousSeenDate.getFullYear()
    const isNewHour = !previousSeenDate || !isSameHour(date, previousSeenDate)
    previousSeenDate = date

    let label: TimeLabel | null = null

    if (showHours) {
      if (isNewDay) {
        label = { key: `${node.row.sha}:day`, text: formatFullDate(date), y, kind: 'month' }
      } else if (isNewHour) {
        label = { key: `${node.row.sha}:hour`, text: formatHourLabel(date), y, kind: 'hour' }
      }
    } else if (isNewDay) {
      label = {
        key: `${node.row.sha}:day`,
        text: isNewMonth ? formatFullDate(date) : `${date.getDate()}`,
        y,
        kind: isNewMonth ? 'month' : 'day',
      }
    }

    if (!label) continue

    const minGap = label.kind === 'hour' ? 34 : 22
    if (y - lastLabelY < minGap) continue

    labels.push(label)
    lastLabelY = y
  }

  return labels
}

function findTopVisibleNode(nodes: LayoutNode[], scrollTop: number, zoom: number) {
  if (nodes.length === 0) return null

  const unscaledTop = scrollTop / zoom
  const approxIdx = Math.max(0, Math.min(
    nodes.length - 1,
    Math.floor((unscaledTop - PAD_TOP - GRAPH_TOP_HEADROOM) / NODE_SPACING_Y),
  ))

  let idx = approxIdx
  while (idx + 1 < nodes.length && nodes[idx + 1].y * zoom <= scrollTop) {
    idx++
  }

  return nodes[idx] ?? nodes[0] ?? null
}

function isRemoteRef(name: string) { return name.includes('/') }

/** Pick the best ref name for display: prefer local branches, skip bare remote names */
function pickBestRef(refNames: string[]): string | null {
  if (refNames.length === 0) return null
  // Prefer local branches (no slash)
  const local = refNames.find(r => !r.includes('/'))
  if (local) return local
  // Fall back to remote refs that look like branch names (origin/xxx), skip bare "origin"
  const remote = refNames.find(r => r.includes('/') && r !== 'origin' && r !== 'HEAD')
  return remote ?? null
}

function areRefNamesEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function areRowsEquivalent(left: CommitRow[], right: CommitRow[]) {
  if (left.length !== right.length) return false

  for (let i = 0; i < left.length; i++) {
    const prev = left[i]
    const next = right[i]
    if (
      prev.sha !== next.sha
      || prev.row !== next.row
      || prev.lane !== next.lane
      || prev.parentShas.length !== next.parentShas.length
      || !areRefNamesEqual(prev.refNames, next.refNames)
    ) {
      return false
    }

    for (let j = 0; j < prev.parentShas.length; j++) {
      if (prev.parentShas[j] !== next.parentShas[j]) return false
    }
  }

  return true
}

function isAppendOnlyHistoryUpdate(prevRows: CommitRow[], nextRows: CommitRow[]) {
  if (nextRows.length <= prevRows.length) return false

  for (let i = 0; i < prevRows.length; i++) {
    const prev = prevRows[i]
    const next = nextRows[i]
    if (
      prev.sha !== next.sha
      || prev.row !== next.row
      || prev.lane !== next.lane
      || !areRefNamesEqual(prev.refNames, next.refNames)
    ) {
      return false
    }
  }

  return true
}

function shouldAnimateHistoryChange(prevRows: CommitRow[] | null, nextRows: CommitRow[] | null) {
  if (!prevRows || !nextRows) return false
  if (prevRows.length === 0 || nextRows.length === 0) return false
  if (areRowsEquivalent(prevRows, nextRows)) return false
  if (isAppendOnlyHistoryUpdate(prevRows, nextRows)) return false
  return true
}

function refBadgePrefix(isRemote: boolean, isCurrent: boolean) {
  if (isRemote) return '☁ '
  return isCurrent ? '● ' : '⎇ '
}

const refPillTextWidthCache = new Map<string, number>()

function measureRefPillText(text: string): number {
  const cached = refPillTextWidthCache.get(text)
  if (cached !== undefined) return cached
  const width = measureNaturalWidth(prepareWithSegments(text, REF_PILL_FONT))
  refPillTextWidthCache.set(text, width)
  return width
}

function estimateRefPillWidth(refName: string, isRemote: boolean, isCurrent: boolean) {
  const text = refBadgePrefix(isRemote, isCurrent) + refName
  return REF_PILL_HORIZONTAL_PADDING + Math.ceil(measureRefPillText(text))
}

function buildRefPlacements(
  nodes: LayoutNode[],
  currentBranch: string | null,
  selectedRefName: string | null,
  shaToColor: Map<string, string>,
) {
  const placements: RefPlacement[] = []
  const rowWidths = new Map<string, number>()

  for (const node of nodes) {
    const baseX = node.x + NODE_RADIUS + 8
    const y = node.y - 10
    let cursorX = baseX

    for (const refName of node.row.refNames) {
      const isCurrent = currentBranch !== null && refName === currentBranch
      const isRemote = isRemoteRef(refName)
      placements.push({
        refName,
        nodeSha: node.row.sha,
        x: cursorX,
        y,
        color: shaToColor.get(node.row.sha) ?? laneColor(node.row.lane),
        isCurrent,
        isSelected: refName === selectedRefName,
        isRemote,
      })
      cursorX += estimateRefPillWidth(refName, isRemote, isCurrent) + REF_PILL_GAP
    }

    rowWidths.set(
      node.row.sha,
      node.row.refNames.length > 0 ? cursorX - baseX - REF_PILL_GAP : 0,
    )
  }

  return { placements, rowWidths }
}

function buildAnimatedEdgePath(x1: number, y1: number, x2: number, y2: number) {
  const start = pointOnCircleToward(x1, y1, x2, y2, NODE_RADIUS - 1)
  const end = pointOnCircleToward(x2, y2, x1, y1, NODE_RADIUS - 1)
  return edgePath(start.x, start.y, end.x, end.y)
}

function lerp(from: number, toValue: number, progress: number) {
  return from + (toValue - from) * progress
}

// ---------------------------------------------------------------------------
// Compute visible window indices from scroll position
// ---------------------------------------------------------------------------

function computeVisibleRange(scrollTop: number, clientHeight: number, totalNodes: number, zoom: number) {
  // Render 3 screens worth above and below
  const overscan = clientHeight * 3
  const top = scrollTop - overscan
  const bot = scrollTop + clientHeight + overscan
  const scaledSpacing = NODE_SPACING_Y * zoom
  const scaledTopOffset = (PAD_TOP + GRAPH_TOP_HEADROOM) * zoom
  const firstIdx = Math.max(0, Math.floor((top - scaledTopOffset) / scaledSpacing))
  const lastIdx = Math.min(totalNodes - 1, Math.ceil((bot - scaledTopOffset) / scaledSpacing))
  return { firstIdx, lastIdx }
}

function edgeIntersectsRange(fromIdx: number, toIdx: number, firstIdx: number, lastIdx: number) {
  const top = Math.min(fromIdx, toIdx)
  const bottom = Math.max(fromIdx, toIdx)
  return bottom >= firstIdx && top <= lastIdx
}

function buildVisibleWindow(layout: GraphLayout, firstIdx: number, lastIdx: number) {
  const visibleNodes = layout.nodes.slice(firstIdx, lastIdx + 1)
  const visibleEdges: VisibleEdge[] = []

  for (const node of layout.nodes) {
    for (let parentIndex = 0; parentIndex < node.row.parentShas.length; parentIndex++) {
      const parent = layout.shaToNode.get(node.row.parentShas[parentIndex])
      if (!parent) continue
      if (!edgeIntersectsRange(node.idx, parent.idx, firstIdx, lastIdx)) continue
      visibleEdges.push({
        from: node,
        to: parent,
        isMerge: parentIndex > 0,
        key: `${node.row.sha}-${parent.row.sha}`,
      })
    }
  }

  return { visibleNodes, visibleEdges }
}

function buildCurrentBranchEdgeKeys(layout: GraphLayout | null, currentBranch: string | null) {
  const keys = new Set<string>()
  if (!layout || !currentBranch) return keys

  const currentTip = layout.nodes.find((node) => node.row.refNames.includes(currentBranch))
  if (!currentTip) return keys

  let sha: string | undefined = currentTip.row.sha
  const visited = new Set<string>()

  while (sha && !visited.has(sha)) {
    visited.add(sha)
    const node = layout.shaToNode.get(sha)
    const firstParentSha = node?.row.parentShas[0]
    if (!node || !firstParentSha) break

    const parent = layout.shaToNode.get(firstParentSha)
    if (!parent) break

    keys.add(`${node.row.sha}-${parent.row.sha}`)
    sha = parent.row.sha
  }

  return keys
}

function buildCurrentBranchShaSet(layout: GraphLayout | null, currentBranch: string | null) {
  const shas = new Set<string>()
  if (!layout || !currentBranch) return shas

  const currentTip = layout.nodes.find((node) => node.row.refNames.includes(currentBranch))
  if (!currentTip) return shas

  let sha: string | undefined = currentTip.row.sha
  while (sha && !shas.has(sha)) {
    shas.add(sha)
    const node = layout.shaToNode.get(sha)
    const firstParentSha = node?.row.parentShas[0]
    if (!node || !firstParentSha) break
    if (!layout.shaToNode.get(firstParentSha)) break
    sha = firstParentSha
  }

  return shas
}

function buildCurrentLaneHighlight(layout: GraphLayout | null, currentBranch: string | null): CurrentLaneHighlight | null {
  if (!layout || !currentBranch) return null

  const tipNode = layout.nodes.find((node) => node.row.refNames.includes(currentBranch))
  if (!tipNode) return null

  return {
    key: currentBranch,
    x: tipNode.x - PRIMARY_LANE_HIGHLIGHT_WIDTH / 2,
    color: layout.shaToColor.get(tipNode.row.sha) ?? laneColor(tipNode.row.lane),
  }
}

// The worktree label sits on the worktree node's row (one row above HEAD). Pick
// the side whose neighbouring lane is free so the text never overlays a node or
// a vertical rail. Returns null when both sides are taken, so the caller hides
// the text entirely.
function computeWorktreeLabelSide(layout: GraphLayout, headNode: LayoutNode): 'left' | 'right' | null {
  const headLane = headNode.row.lane
  const labelRow = headNode.idx - 1 // row index sharing the worktree node's y

  const laneOccupied = (lane: number) => {
    for (const node of layout.nodes) {
      // a node sitting directly on the worktree node's row
      if (node.idx === labelRow && node.row.lane === lane) return true
      // a straight vertical rail passing through that row
      if (node.row.lane !== lane) continue
      const firstParentSha = node.row.parentShas[0]
      if (!firstParentSha) continue
      const parent = layout.shaToNode.get(firstParentSha)
      if (!parent || parent.row.lane !== lane) continue
      if (node.idx <= labelRow && labelRow <= parent.idx) return true
    }
    return false
  }

  if (!laneOccupied(headLane + 1)) return 'right'
  if (!laneOccupied(headLane - 1)) return 'left'
  return null
}

function countConflictedWorktreeFiles(changes: WorktreeChangesResponse): number {
  return new Set(changes.unstaged.filter((file) => file.status === 'U').map((file) => file.path)).size
}

function buildEdgeRoutingData(visibleEdges: VisibleEdge[], occupiedLanes: number[]): EdgeRoutingData {
  const plans = new Map<string, EdgeRoutePlan>()
  const bundleGroups = new Map<string, Array<{ key: string; topIdx: number; bottomIdx: number; innerLane?: number }>>()

  for (const edge of visibleEdges) {
    const plan = planEdgeRoute(edge.from, edge.to, edge.key, occupiedLanes)
    plans.set(edge.key, plan)

    const bundleKey = edgeBundleKey(plan)
    if (!bundleKey) continue

    const group = bundleGroups.get(bundleKey)
    const item = {
      key: edge.key,
      topIdx: Math.min(edge.from.idx, edge.to.idx),
      bottomIdx: Math.max(edge.from.idx, edge.to.idx),
      innerLane: plan.mode === 'outer-rail' ? plan.innerLane : undefined,
    }
    if (group) group.push(item)
    else bundleGroups.set(bundleKey, [item])
  }

  const bundleOffsets = new Map<string, number>()

  for (const items of bundleGroups.values()) {
    const samplePlan = plans.get(items[0]?.key ?? '')
    if (!samplePlan) continue

    if (samplePlan.mode === 'outer-rail') {
      items.sort((a, b) => {
        const aLane = a.innerLane ?? samplePlan.innerLane
        const bLane = b.innerLane ?? samplePlan.innerLane
        if (samplePlan.side === 'right' && aLane !== bLane) return aLane - bLane
        if (samplePlan.side === 'left' && aLane !== bLane) return bLane - aLane
        return a.topIdx - b.topIdx || a.bottomIdx - b.bottomIdx || a.key.localeCompare(b.key)
      })
      for (let i = 0; i < items.length; i++) {
        const sign = samplePlan.side === 'right' ? 1 : -1
        bundleOffsets.set(items[i].key, i * EDGE_BUNDLE_GAP * sign)
      }
      continue
    }

    items.sort((a, b) => a.topIdx - b.topIdx || a.bottomIdx - b.bottomIdx || a.key.localeCompare(b.key))
    const middle = (items.length - 1) / 2
    for (let i = 0; i < items.length; i++) {
      bundleOffsets.set(items[i].key, (i - middle) * EDGE_BUNDLE_GAP)
    }
  }

  return { plans, bundleOffsets }
}

function buildVisibleEdgeItems(
  visibleEdges: VisibleEdge[],
  edgeRouting: EdgeRoutingData,
  occupiedLanes: number[],
  currentBranchEdgeKeys: Set<string>,
  shaToColor: Map<string, string>,
) {
  return visibleEdges.map<VisibleEdgeItem>((edge) => {
    const isCurrentBranchEdge = currentBranchEdgeKeys.has(edge.key)
    // An edge takes the color of the branch line it travels along: the child for
    // a normal edge, the merged-in parent for a merge edge.
    const colorNode = edge.isMerge ? edge.to : edge.from
    return {
      key: edge.key,
      path: routedEdgePath(
        edge.from,
        edge.to,
        edgeRouting.plans.get(edge.key) ?? planEdgeRoute(edge.from, edge.to, edge.key, occupiedLanes),
        edgeRouting.bundleOffsets.get(edge.key) ?? 0,
      ),
      x1: edge.from.x,
      y1: edge.from.y,
      x2: edge.to.x,
      y2: edge.to.y,
      isMerge: edge.isMerge,
      stroke: shaToColor.get(colorNode.row.sha) ?? laneColor(colorNode.row.lane),
      strokeWidth: isCurrentBranchEdge ? 4.5 : edge.isMerge ? 2 : 3,
      opacity: isCurrentBranchEdge ? 0.95 : 0.8,
    }
  })
}

function shouldAnimateGraphMutation(
  prevRows: CommitRow[] | null,
  nextRows: CommitRow[] | null,
  prevCurrentBranch: string | null,
  nextCurrentBranch: string | null,
  prevLayout: GraphLayout | null,
  nextLayout: GraphLayout | null,
) {
  if (shouldAnimateHistoryChange(prevRows, nextRows)) return true
  if (!prevLayout || !nextLayout) return false
  return prevCurrentBranch !== nextCurrentBranch
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GraphCanvas() {
  const histWindow = useAppStore((state) => state.historyWindow)
  const refs = useAppStore((state) => state.refs)
  const totalCommitCount = useAppStore((state) => state.totalCommitCount)
  const selectedSha = useAppStore((state) => state.selectedSha)
  const selectedRefName = useAppStore((state) => state.selectedRefName)
  const mergePreview = useAppStore((state) => state.mergePreview)
  const scrollToSha = useAppStore((state) => state.scrollToSha)
  const scrollToKey = useAppStore((state) => state.scrollToKey)
  const selectCommit = useAppStore((state) => state.selectCommit)
  const selectGraphRef = useAppStore((state) => state.selectGraphRef)
  const clearGraphRefSelection = useAppStore((state) => state.clearGraphRefSelection)
  const ensureMergePreview = useAppStore((state) => state.ensureMergePreview)
  const requestMore = useAppStore((state) => state.requestMore)
  const performRefAction = useAppStore((state) => state.performRefAction)
  const performCommitAction = useAppStore((state) => state.performCommitAction)
  const performMergeRef = useAppStore((state) => state.performMergeRef)
  const performRebaseRef = useAppStore((state) => state.performRebaseRef)
  const pendingMutation = useAppStore((state) => state.pendingMutation)
  const graphAnimationSuppressToken = useAppStore((state) => state.graphAnimationSuppressToken)
  const showCommitMessages = useAppStore((state) => state.showCommitMessages)
  const showError = useAppStore((state) => state.showError)
  const commitCIStatus = useAppStore((state) => state.commitCIStatus)
  const fetchCommitCIStatusesIfNeeded = useAppStore((state) => state.fetchCommitCIStatusesIfNeeded)
  const worktreeChanges = useAppStore((state) => state.worktreeChanges)
  const worktreeSelected = useAppStore((state) => state.worktreeSelected)
  const selectWorktree = useAppStore((state) => state.selectWorktree)

  const scrollRef = useRef<HTMLDivElement>(null)
  const timeLabelsLayerRef = useRef<HTMLDivElement>(null)
  const commitLabelsLayerRef = useRef<HTMLDivElement>(null)
  const viewportMetricsRef = useRef({ scrollTop: 0, clientHeight: 0 })
  const lastObservedScrollTopRef = useRef(0)
  const graphAnimationStartFrameRef = useRef<number | null>(null)
  const scrollTopFrameRef = useRef<number | null>(null)
  const pendingScrollTopRef = useRef(0)
  const [zoom, setZoom] = useState(1)
  const [scrollTop, setScrollTop] = useState(0)
  const [clientHeight, setClientHeight] = useState(0)
  const [graphAnimation, setGraphAnimation] = useState<GraphAnimationSnapshot | null>(null)
  const graphAnimationRef = useRef<GraphAnimationSnapshot | null>(null)
  const [mergePreviewVisible, setMergePreviewVisible] = useState(false)
  const [{ graphProgress }, graphProgressApi] = useSpring(() => ({
    graphProgress: 1,
    config: GRAPH_SPRING_CONFIG,
  }))
  const zoomRef = useRef(1)
  const suppressAutoScrollUntilRef = useRef(0)
  // While a programmatic scroll-to-commit is in flight we must not treat the
  // resulting scroll events as a user gesture that cancels the graph animation —
  // the morph and the follow-scroll are meant to play together.
  const programmaticScrollUntilRef = useRef(0)
  const previousRowsRef = useRef<CommitRow[] | null>(null)
  const previousLayoutRef = useRef<GraphLayout | null>(null)
  const previousCurrentBranchRef = useRef<string | null>(null)
  // Tracks the last reconcile token we've seen, so a server reconciliation of an
  // optimistic prediction swaps in the real layout without re-animating.
  const lastSuppressTokenRef = useRef(graphAnimationSuppressToken)
  // Force re-render counter — incremented when scroll position changes enough
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  const lastRenderedRange = useRef({ firstIdx: 0, lastIdx: 100 })

  const layout = useMemo(() => {
    if (!histWindow || histWindow.rows.length === 0) return null
    return buildLayout(histWindow.rows, showCommitMessages ? COMMIT_MESSAGE_GUTTER : 0)
  }, [histWindow, showCommitMessages])

  const refMap = useMemo(
    () => new Map(refs.map((ref) => [ref.shortName, ref])),
    [refs],
  )

  const selectedRef = useMemo(
    () => (selectedRefName ? refMap.get(selectedRefName) ?? null : null),
    [refMap, selectedRefName],
  )

  const currentBranch = useMemo(() => {
    const current = refs.find((ref) => ref.isCurrent)
    return current?.shortName ?? null
  }, [refs])

  // The working-tree / in-progress operation node floats one row above HEAD,
  // in HEAD's lane. Merge conflicts also draw a dashed second-parent edge.
  const worktreeNode = useMemo(() => {
    if (!layout || !worktreeChanges) return null
    const count = worktreeChanges.staged.length + worktreeChanges.unstaged.length
    if (count === 0) return null
    // Anchor to the current branch tip, which updates synchronously with `refs`
    // on checkout, so the node follows the graph immediately. Fall back to the
    // worktree's reported HEAD sha for detached HEAD (no current branch).
    const headNode =
      (currentBranch ? layout.nodes.find((node) => node.row.refNames.includes(currentBranch)) : undefined)
      ?? layout.shaToNode.get(worktreeChanges.headSha)
    if (!headNode) return null
    const operation = worktreeChanges.mergeHeadShas?.length
      ? 'merge'
      : worktreeChanges.rebaseHeadSha
        ? 'rebase'
        : 'worktree'
    const conflictedCount = countConflictedWorktreeFiles(worktreeChanges)
    const y = headNode.y - NODE_SPACING_Y
    const color = operation === 'worktree'
      ? layout.shaToColor.get(headNode.row.sha) ?? laneColor(headNode.row.lane)
      : '#fab387'
    const pendingNode: LayoutNode = {
      row: {
        row: headNode.row.row - 1,
        sha: `${operation}:${worktreeChanges.headSha}:${worktreeChanges.mergeHeadShas?.[0] ?? worktreeChanges.rebaseHeadSha ?? 'dirty'}`,
        parentShas: [headNode.row.sha, ...(worktreeChanges.mergeHeadShas?.slice(0, 1) ?? [])],
        authorName: '',
        authorEmail: '',
        authorUnix: 0,
        committerUnix: 0,
        subject: operation === 'merge'
          ? 'Merge in progress'
          : operation === 'rebase'
            ? 'Rebase in progress'
            : 'Uncommitted changes',
        additions: 0,
        deletions: 0,
        locChanged: 0,
        refNames: [],
        lane: headNode.row.lane,
      },
      x: headNode.x,
      y,
      idx: headNode.idx - 1,
    }
    const occupied = layout.nodes.map((node) => node.row.lane)
    const targetKey = `${pendingNode.row.sha}-${headNode.row.sha}`
    const targetPath = routedEdgePath(
      pendingNode,
      headNode,
      planEdgeRoute(pendingNode, headNode, targetKey, occupied),
      0,
    )
    const sourceSha = worktreeChanges.mergeHeadShas?.[0]
    const sourceNode = sourceSha ? layout.shaToNode.get(sourceSha) ?? null : null
    const sourcePath = sourceNode
      ? routedEdgePath(
          pendingNode,
          sourceNode,
          planEdgeRoute(pendingNode, sourceNode, `${pendingNode.row.sha}-${sourceNode.row.sha}`, occupied),
          0,
        )
      : null
    return {
      kind: operation,
      x: pendingNode.x,
      y: pendingNode.y,
      headY: headNode.y,
      color,
      count,
      conflictedCount,
      targetPath,
      sourcePath,
      labelSide: computeWorktreeLabelSide(layout, headNode),
    }
  }, [layout, worktreeChanges, currentBranch])

  const syncScrollTopState = useCallback((nextScrollTop: number) => {
    pendingScrollTopRef.current = nextScrollTop
    if (scrollTopFrameRef.current !== null) return

    scrollTopFrameRef.current = requestAnimationFrame(() => {
      scrollTopFrameRef.current = null
      setScrollTop(pendingScrollTopRef.current)
    })
  }, [])

  const stopGraphAnimation = useCallback(() => {
    if (graphAnimationStartFrameRef.current !== null) {
      cancelAnimationFrame(graphAnimationStartFrameRef.current)
      graphAnimationStartFrameRef.current = null
    }
    if (!graphAnimationRef.current) return
    graphProgressApi.stop()
    graphProgressApi.set({ graphProgress: 1 })
    graphAnimationRef.current = null
    setGraphAnimation(null)
  }, [graphProgressApi])

  const startGraphAnimation = useCallback((snapshot: GraphAnimationSnapshot) => {
    if (graphAnimationStartFrameRef.current !== null) {
      cancelAnimationFrame(graphAnimationStartFrameRef.current)
      graphAnimationStartFrameRef.current = null
    }
    graphProgressApi.stop()
    graphProgressApi.set({ graphProgress: 0 })
    graphAnimationRef.current = snapshot
    setGraphAnimation(snapshot)
    // Let the snapshot paint once before motion starts so the opening frames
    // do not appear skipped when the graph relayout work is expensive.
    graphAnimationStartFrameRef.current = requestAnimationFrame(() => {
      graphAnimationStartFrameRef.current = requestAnimationFrame(() => {
        graphAnimationStartFrameRef.current = null
        if (graphAnimationRef.current !== snapshot) return
        void graphProgressApi.start({
          graphProgress: 1,
          immediate: false,
          config: GRAPH_SPRING_CONFIG,
          onRest: (result) => {
            if (!result.finished) return
            setGraphAnimation((current) => {
              if (current !== snapshot) return current
              graphAnimationRef.current = null
              return null
            })
          },
        })
      })
    })
  }, [graphProgressApi])

  useEffect(() => {
    setMergePreviewVisible(false)
  }, [selectedRefName])

  useEffect(() => {
    if (!layout || !histWindow) {
      previousRowsRef.current = histWindow?.rows ?? null
      previousLayoutRef.current = layout
      previousCurrentBranchRef.current = currentBranch
      stopGraphAnimation()
      return
    }

    // A bumped suppress token means this render is the server reconciling an
    // optimistic prediction we already animated to. Adopt the authoritative
    // layout as the new baseline, but let any in-flight animation finish on its
    // own — predicted ≈ real, so the final swap is invisible. Don't animate the
    // swap, and don't hard-stop (that would cut the "slow animation" short when
    // the server confirms faster than the spring settles).
    const isReconcileSwap = graphAnimationSuppressToken !== lastSuppressTokenRef.current
    lastSuppressTokenRef.current = graphAnimationSuppressToken

    if (isReconcileSwap) {
      previousRowsRef.current = histWindow.rows
      previousLayoutRef.current = layout
      previousCurrentBranchRef.current = currentBranch
      return
    }

    const shouldAnimate = shouldAnimateGraphMutation(
      previousRowsRef.current,
      histWindow.rows,
      previousCurrentBranchRef.current,
      currentBranch,
      previousLayoutRef.current,
      layout,
    )

    if (shouldAnimate && previousLayoutRef.current) {
      startGraphAnimation({
        fromLayout: previousLayoutRef.current,
        toLayout: layout,
        fromCurrentBranch: previousCurrentBranchRef.current,
        toCurrentBranch: currentBranch,
      })
    } else {
      stopGraphAnimation()
    }

    previousRowsRef.current = histWindow.rows
    previousLayoutRef.current = layout
    previousCurrentBranchRef.current = currentBranch
  }, [currentBranch, histWindow, layout, graphAnimationSuppressToken, startGraphAnimation, stopGraphAnimation])

  useEffect(() => () => {
    graphProgressApi.stop()
    if (graphAnimationStartFrameRef.current !== null) {
      cancelAnimationFrame(graphAnimationStartFrameRef.current)
    }
    if (scrollTopFrameRef.current !== null) {
      cancelAnimationFrame(scrollTopFrameRef.current)
    }
  }, [graphProgressApi])

  const locScaleMax = useMemo(
    () => (histWindow ? computeLocScaleMax(histWindow.rows) : 0),
    [histWindow],
  )

  const occupiedLanes = useMemo(
    () => (layout ? layout.nodes.map((node) => node.row.lane) : []),
    [layout],
  )

  const currentBranchEdgeKeys = useMemo(
    () => buildCurrentBranchEdgeKeys(layout, currentBranch),
    [layout, currentBranch],
  )

  const refreshViewport = useCallback((el: HTMLDivElement, nextZoom: number) => {
    if (!layout) return
    viewportMetricsRef.current = { scrollTop: el.scrollTop, clientHeight: el.clientHeight }
    lastObservedScrollTopRef.current = el.scrollTop
    syncScrollTopState(el.scrollTop)
    if (timeLabelsLayerRef.current) {
      timeLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    }
    const { firstIdx, lastIdx } = computeVisibleRange(el.scrollTop, el.clientHeight, layout.nodes.length, nextZoom)
    lastRenderedRange.current = { firstIdx, lastIdx }
    forceRender()
  }, [layout, syncScrollTopState])

  // Scroll to a specific commit when scrollToSha changes
  useEffect(() => {
    if (!scrollToSha || !layout || !scrollRef.current) return
    if (Date.now() < suppressAutoScrollUntilRef.current) return
    const node = layout.shaToNode.get(scrollToSha)
    if (!node) return
    const el = scrollRef.current
    const targetTop = node.y * zoom - el.clientHeight / 2
    // Let the follow-scroll ride alongside an in-flight graph animation instead
    // of cancelling it (see programmaticScrollUntilRef).
    programmaticScrollUntilRef.current = Date.now() + 700
    el.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  }, [scrollToSha, scrollToKey, layout, zoom])

  // Scroll + resize handler: re-render only when we're about to run out of rendered nodes
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const check = () => {
      if (!layout) return
      const nextScrollTop = el.scrollTop
      const didScroll = Math.abs(nextScrollTop - lastObservedScrollTopRef.current) > 0.5
      viewportMetricsRef.current = { scrollTop: el.scrollTop, clientHeight: el.clientHeight }
      setClientHeight(el.clientHeight)
      lastObservedScrollTopRef.current = nextScrollTop
      // A user scroll cancels the morph, but a programmatic follow-scroll riding
      // alongside it must not.
      if (didScroll && Date.now() >= programmaticScrollUntilRef.current) stopGraphAnimation()
      syncScrollTopState(el.scrollTop)
      if (timeLabelsLayerRef.current) {
        timeLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
      }
      if (commitLabelsLayerRef.current) {
        commitLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
      }
      const { firstIdx, lastIdx } = computeVisibleRange(el.scrollTop, el.clientHeight, layout.nodes.length, zoomRef.current)
      const prev = lastRenderedRange.current

      // Re-render if we've scrolled past half the overscan
      const margin = Math.floor((prev.lastIdx - prev.firstIdx) * 0.25)
      if (firstIdx < prev.firstIdx + margin || lastIdx > prev.lastIdx - margin) {
        lastRenderedRange.current = { firstIdx, lastIdx }
        forceRender()
      }

      // Request more data when scrolled past the last loaded commit
      if (histWindow && histWindow.hasMoreAfter && layout) {
        const lastLoadedY = layout.nodes.length * NODE_SPACING_Y * zoomRef.current
        const viewBottom = el.scrollTop + el.clientHeight
        if (viewBottom > lastLoadedY - el.clientHeight) {
          void requestMore('down')
        }
      }
    }

    // Initial
    if (layout) {
      viewportMetricsRef.current = { scrollTop: el.scrollTop, clientHeight: el.clientHeight }
      setClientHeight(el.clientHeight)
      lastObservedScrollTopRef.current = el.scrollTop
      syncScrollTopState(el.scrollTop)
      if (timeLabelsLayerRef.current) {
        timeLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
      }
      if (commitLabelsLayerRef.current) {
        commitLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
      }
      const { firstIdx, lastIdx } = computeVisibleRange(el.scrollTop, el.clientHeight, layout.nodes.length, zoomRef.current)
      lastRenderedRange.current = { firstIdx, lastIdx }
      forceRender()
    }

    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(() => check())
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', check)
      ro.disconnect()
    }
  }, [layout, histWindow, requestMore, stopGraphAnimation, syncScrollTopState])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !timeLabelsLayerRef.current) return
    refreshViewport(el, zoom)
  }, [layout, zoom, refreshViewport])

  // Ctrl+wheel zoom — capture phase on document so we intercept before the
  // browser's native page-zoom handler processes it.
  // Read scrollRef lazily inside the handler so we don't miss it when
  // the component initially renders without layout (early return).
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      const el = scrollRef.current
      if (!el || !el.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()

      const rect = el.getBoundingClientRect()
      const mouseY = e.clientY - rect.top + el.scrollTop

      const oldZoom = zoomRef.current
      const delta = e.deltaY > 0 ? -0.1 : 0.1
      const newZoom = Math.max(0.1, Math.min(3, oldZoom + delta))

      zoomRef.current = newZoom
      setZoom(newZoom)

      // Adjust scroll to keep the point under the cursor stable
      const newScrollTop = (mouseY / oldZoom) * newZoom - (e.clientY - rect.top)
      el.scrollTop = Math.max(0, newScrollTop)
    }
    document.addEventListener('wheel', handler, { passive: false, capture: true })
    return () => document.removeEventListener('wheel', handler, { capture: true })
  }, [])

  // Request more commits when zoomed out far enough to see beyond loaded range
  useEffect(() => {
    if (!layout || !scrollRef.current || !histWindow?.hasMoreAfter) return
    const el = scrollRef.current
    const visibleContentHeight = el.clientHeight / zoom
    const loadedContentHeight = layout.nodes.length * NODE_SPACING_Y
    if (visibleContentHeight > loadedContentHeight * 0.8) {
      void requestMore('down')
    }
  }, [zoom, layout, histWindow, requestMore])

  // Compute visible nodes + edges based on last rendered range
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!layout) return { visibleNodes: [], visibleEdges: [] }
    const { firstIdx, lastIdx } = lastRenderedRange.current
    return buildVisibleWindow(layout, firstIdx, lastIdx)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, lastRenderedRange.current.firstIdx, lastRenderedRange.current.lastIdx])

  const edgeRouting = useMemo(
    () => buildEdgeRoutingData(visibleEdges, occupiedLanes),
    [visibleEdges, occupiedLanes],
  )

  const { placements: visibleRefPlacements, rowWidths: rowRefWidths } = useMemo(
    () => buildRefPlacements(visibleNodes, currentBranch, selectedRefName, layout?.shaToColor ?? EMPTY_SHA_COLOR),
    [visibleNodes, currentBranch, selectedRefName, layout],
  )

  const visibleEdgeItems = useMemo(
    () => buildVisibleEdgeItems(visibleEdges, edgeRouting, occupiedLanes, currentBranchEdgeKeys, layout?.shaToColor ?? EMPTY_SHA_COLOR),
    [visibleEdges, edgeRouting, occupiedLanes, currentBranchEdgeKeys, layout],
  )

  const currentLaneHighlight = useMemo(
    () => buildCurrentLaneHighlight(layout, currentBranch),
    [layout, currentBranch],
  )

  const graphAnimationRenderData = useMemo(() => {
    if (!graphAnimation) return null

    const viewportScrollTop = viewportMetricsRef.current.scrollTop
    const viewportHeight = viewportMetricsRef.current.clientHeight || scrollRef.current?.clientHeight || 0
    const fromOccupiedLanes = graphAnimation.fromLayout.nodes.map((node) => node.row.lane)
    const toOccupiedLanes = graphAnimation.toLayout.nodes.map((node) => node.row.lane)
    const fromRange = computeVisibleRange(viewportScrollTop, viewportHeight, graphAnimation.fromLayout.nodes.length, zoom)
    const toRange = computeVisibleRange(viewportScrollTop, viewportHeight, graphAnimation.toLayout.nodes.length, zoom)
    const fromWindow = buildVisibleWindow(graphAnimation.fromLayout, fromRange.firstIdx, fromRange.lastIdx)
    const toWindow = buildVisibleWindow(graphAnimation.toLayout, toRange.firstIdx, toRange.lastIdx)
    const fromRouting = buildEdgeRoutingData(fromWindow.visibleEdges, fromOccupiedLanes)
    const toRouting = buildEdgeRoutingData(toWindow.visibleEdges, toOccupiedLanes)
    const fromEdgeItems = buildVisibleEdgeItems(
      fromWindow.visibleEdges,
      fromRouting,
      fromOccupiedLanes,
      buildCurrentBranchEdgeKeys(graphAnimation.fromLayout, graphAnimation.fromCurrentBranch),
      graphAnimation.fromLayout.shaToColor,
    )
    const toEdgeItems = buildVisibleEdgeItems(
      toWindow.visibleEdges,
      toRouting,
      toOccupiedLanes,
      buildCurrentBranchEdgeKeys(graphAnimation.toLayout, graphAnimation.toCurrentBranch),
      graphAnimation.toLayout.shaToColor,
    )
    const fromRefPlacements = buildRefPlacements(
      fromWindow.visibleNodes,
      graphAnimation.fromCurrentBranch,
      selectedRefName,
      graphAnimation.fromLayout.shaToColor,
    ).placements
    const toRefPlacements = buildRefPlacements(
      toWindow.visibleNodes,
      graphAnimation.toCurrentBranch,
      selectedRefName,
      graphAnimation.toLayout.shaToColor,
    ).placements
    const fromLaneHighlight = buildCurrentLaneHighlight(graphAnimation.fromLayout, graphAnimation.fromCurrentBranch)
    const toLaneHighlight = buildCurrentLaneHighlight(graphAnimation.toLayout, graphAnimation.toCurrentBranch)

    const fromNodeMap = new Map(fromWindow.visibleNodes.map((node) => [node.row.sha, node]))
    const toNodeMap = new Map(toWindow.visibleNodes.map((node) => [node.row.sha, node]))
    const fromEdgeMap = new Map(fromEdgeItems.map((edge) => [edge.key, edge]))
    const toEdgeMap = new Map(toEdgeItems.map((edge) => [edge.key, edge]))
    const fromRefMap = new Map(fromRefPlacements.map((placement) => [placement.refName, placement]))
    const toRefMap = new Map(toRefPlacements.map((placement) => [placement.refName, placement]))

    const nodes = [...new Set([...fromNodeMap.keys(), ...toNodeMap.keys()])]
      .map((key) => {
        const fromNode = fromNodeMap.get(key)
        const toNode = toNodeMap.get(key)
        const displayNode = toNode ?? fromNode
        if (!displayNode) return null

        const colorLayout = toNode ? graphAnimation.toLayout : graphAnimation.fromLayout
        return {
          sortIdx: toNode?.idx ?? fromNode?.idx ?? 0,
          item: {
            key,
            row: displayNode.row,
            interactive: !!toNode,
            color: colorLayout.shaToColor.get(key) ?? laneColor(displayNode.row.lane),
            fromX: fromNode?.x ?? displayNode.x,
            fromY: fromNode ? fromNode.y : displayNode.y + GRAPH_ENTER_OFFSET_Y,
            toX: toNode?.x ?? displayNode.x,
            toY: toNode ? toNode.y : displayNode.y - GRAPH_EXIT_OFFSET_Y,
            fromOpacity: fromNode ? 1 : 0,
            toOpacity: toNode ? 1 : 0,
          } satisfies RenderedNodeItem,
        }
      })
      .filter((entry): entry is { sortIdx: number; item: RenderedNodeItem } => entry !== null)
      .sort((left, right) => left.sortIdx - right.sortIdx)
      .map((entry) => entry.item)

    const edges = [...new Set([...fromEdgeMap.keys(), ...toEdgeMap.keys()])]
      .map((key) => {
        const fromEdge = fromEdgeMap.get(key)
        const toEdge = toEdgeMap.get(key)
        const displayEdge = toEdge ?? fromEdge
        if (!displayEdge) return null

        const sortY = Math.min(toEdge?.y1 ?? fromEdge?.y1 ?? 0, toEdge?.y2 ?? fromEdge?.y2 ?? 0)
        return {
          sortY,
          item: {
            key,
            path: toEdge?.path ?? fromEdge?.path ?? '',
            stroke: toEdge?.stroke ?? fromEdge?.stroke ?? '#cdd6f4',
            fromStrokeWidth: fromEdge?.strokeWidth ?? displayEdge.strokeWidth,
            toStrokeWidth: toEdge?.strokeWidth ?? displayEdge.strokeWidth,
            fromOpacity: fromEdge?.opacity ?? 0,
            toOpacity: toEdge?.opacity ?? 0,
            fromX1: fromEdge?.x1 ?? displayEdge.x1,
            fromY1: fromEdge ? fromEdge.y1 : displayEdge.y1 + GRAPH_ENTER_OFFSET_Y,
            fromX2: fromEdge?.x2 ?? displayEdge.x2,
            fromY2: fromEdge ? fromEdge.y2 : displayEdge.y2 + GRAPH_ENTER_OFFSET_Y,
            toX1: toEdge?.x1 ?? displayEdge.x1,
            toY1: toEdge ? toEdge.y1 : displayEdge.y1 - GRAPH_EXIT_OFFSET_Y,
            toX2: toEdge?.x2 ?? displayEdge.x2,
            toY2: toEdge ? toEdge.y2 : displayEdge.y2 - GRAPH_EXIT_OFFSET_Y,
          } satisfies RenderedEdgeItem,
        }
      })
      .filter((entry): entry is { sortY: number; item: RenderedEdgeItem } => entry !== null)
      .sort((left, right) => left.sortY - right.sortY)
      .map((entry) => entry.item)

    const refs = [...new Set([...fromRefMap.keys(), ...toRefMap.keys()])]
      .map((key) => {
        const fromPlacement = fromRefMap.get(key)
        const toPlacement = toRefMap.get(key)
        const displayPlacement = toPlacement ?? fromPlacement
        if (!displayPlacement) return null

        return {
          sortY: toPlacement?.y ?? fromPlacement?.y ?? 0,
          item: {
            key,
            placement: displayPlacement,
            fromX: fromPlacement?.x ?? displayPlacement.x,
            fromY: fromPlacement ? fromPlacement.y : displayPlacement.y + GRAPH_ENTER_OFFSET_Y,
            toX: toPlacement?.x ?? displayPlacement.x,
            toY: toPlacement ? toPlacement.y : displayPlacement.y - GRAPH_EXIT_OFFSET_Y,
            fromOpacity: fromPlacement ? 1 : 0,
            toOpacity: toPlacement ? 1 : 0,
            fromScale: fromPlacement ? 1 : 0.9,
            toScale: toPlacement ? 1 : 0.92,
          } satisfies RenderedRefItem,
        }
      })
      .filter((entry): entry is { sortY: number; item: RenderedRefItem } => entry !== null)
      .sort((left, right) => left.sortY - right.sortY)
      .map((entry) => entry.item)

    const lane = fromLaneHighlight || toLaneHighlight
      ? {
          key: toLaneHighlight?.key ?? fromLaneHighlight?.key ?? 'current-lane',
          color: toLaneHighlight?.color ?? fromLaneHighlight?.color ?? '#89b4fa',
          fromX: fromLaneHighlight?.x ?? toLaneHighlight?.x ?? 0,
          toX: toLaneHighlight?.x ?? fromLaneHighlight?.x ?? 0,
          fromOpacity: fromLaneHighlight ? 1 : 0,
          toOpacity: toLaneHighlight ? 1 : 0,
        } satisfies RenderedLaneHighlight
      : null

    return { nodes, edges, refs, lane }
  }, [graphAnimation, selectedRefName, zoom])

  const renderedNodeItems = useMemo(
    () => graphAnimationRenderData?.nodes ?? visibleNodes.map((node) => ({
      key: node.row.sha,
      row: node.row,
      interactive: true,
      color: layout?.shaToColor.get(node.row.sha) ?? laneColor(node.row.lane),
      fromX: node.x,
      fromY: node.y,
      toX: node.x,
      toY: node.y,
      fromOpacity: 1,
      toOpacity: 1,
    })),
    [graphAnimationRenderData, visibleNodes, layout],
  )

  const renderedEdgeItems = useMemo(
    () => graphAnimationRenderData?.edges ?? visibleEdgeItems.map((edge) => ({
      key: edge.key,
      path: edge.path,
      stroke: edge.stroke,
      fromStrokeWidth: edge.strokeWidth,
      toStrokeWidth: edge.strokeWidth,
      fromOpacity: edge.opacity,
      toOpacity: edge.opacity,
      fromX1: edge.x1,
      fromY1: edge.y1,
      fromX2: edge.x2,
      fromY2: edge.y2,
      toX1: edge.x1,
      toY1: edge.y1,
      toX2: edge.x2,
      toY2: edge.y2,
    })),
    [graphAnimationRenderData, visibleEdgeItems],
  )

  const renderedRefItems = useMemo(
    () => graphAnimationRenderData?.refs ?? visibleRefPlacements.map((placement) => ({
      key: placement.refName,
      placement,
      fromX: placement.x,
      fromY: placement.y,
      toX: placement.x,
      toY: placement.y,
      fromOpacity: 1,
      toOpacity: 1,
      fromScale: 1,
      toScale: 1,
    })),
    [graphAnimationRenderData, visibleRefPlacements],
  )

  const renderedLaneHighlight = useMemo(() => {
    if (graphAnimationRenderData) return graphAnimationRenderData.lane
    if (!currentLaneHighlight) return null
    return {
      key: currentLaneHighlight.key,
      color: currentLaneHighlight.color,
      fromX: currentLaneHighlight.x,
      toX: currentLaneHighlight.x,
      fromOpacity: 1,
      toOpacity: 1,
    } satisfies RenderedLaneHighlight
  }, [graphAnimationRenderData, currentLaneHighlight])

  const currentHeadNode = useMemo(
    () => (layout && currentBranch ? layout.nodes.find((node) => node.row.refNames.includes(currentBranch)) ?? null : null),
    [layout, currentBranch],
  )

  const selectedRemoteRef = useMemo(() => {
    if (!selectedRef || selectedRef.kind !== 'head') return null
    return findTrackingRemoteRef(selectedRef, refs)
  }, [selectedRef, refs])

  const canPushSelectedRef = useMemo(() => {
    if (!selectedRef || selectedRef.kind !== 'head') return false
    return !selectedRemoteRef || selectedRemoteRef.targetSha !== selectedRef.targetSha
  }, [selectedRef, selectedRemoteRef])

  const canResetSelectedRef = useMemo(() => {
    if (!selectedRef || selectedRef.kind !== 'head' || !selectedRemoteRef) return false
    if (selectedRemoteRef.targetSha === selectedRef.targetSha) return false
    return (selectedRef.ahead ?? 0) > 0
  }, [selectedRef, selectedRemoteRef])

  const selectedRefActions = useMemo<VisibleRefAction[]>(() => {
    if (!selectedRef) return []
    if (selectedRef.kind === 'head') {
      // The branch diverged from its upstream (e.g. after a rebase), so a normal
      // push would be rejected as non-fast-forward — force-push instead.
      const needsForcePush = (selectedRef.behind ?? 0) > 0
      const pushAction: VisibleRefAction = needsForcePush
        ? { action: 'push', label: 'Force push', tone: 'warning', force: true }
        : { action: 'push', label: 'Push', tone: 'neutral' }

      if (selectedRef.isCurrent) {
        return [
          ...(canPushSelectedRef ? [pushAction] : []),
          ...(canResetSelectedRef ? [{ action: 'reset' as const, label: 'Reset', tone: 'warning' as const }] : []),
        ]
      }

      return [
        { action: 'checkout' as const, label: 'Checkout', tone: 'neutral' as const },
        ...(canPushSelectedRef ? [pushAction] : []),
        ...(canResetSelectedRef ? [{ action: 'reset' as const, label: 'Reset', tone: 'warning' as const }] : []),
        { action: 'delete' as const, label: 'Delete', tone: 'danger' as const },
      ]
    }

    if (selectedRef.kind === 'remote') {
      return [
        { action: 'checkout' as const, label: 'Checkout', tone: 'neutral' as const },
        { action: 'delete' as const, label: 'Delete', tone: 'danger' as const },
      ]
    }

    return []
  }, [selectedRef, canPushSelectedRef, canResetSelectedRef])

  const movableBranchRefName = useMemo(() => {
    if (!selectedRef || selectedRef.kind !== 'head' || selectedRef.isCurrent) return null
    return selectedRef.shortName
  }, [selectedRef])

  const showMergeButton = useMemo(() => (
    !!currentHeadNode
    && !!currentBranch
    && !!selectedRefName
    && selectedRefName !== currentBranch
    && mergePreview?.sourceRefName === selectedRefName
    && mergePreview.mergeable
  ), [currentHeadNode, currentBranch, selectedRefName, mergePreview])

  const selectedCurrentBranchRef = useMemo(() => (
    selectedRef && selectedRef.kind === 'head' && selectedRef.isCurrent ? selectedRef : null
  ), [selectedRef])

  const mergePreviewGeometry = useMemo(() => {
    if (!layout || !selectedRefName || !mergePreview?.mergeable) return null
    if (mergePreview.sourceRefName !== selectedRefName) return null
    if (!mergePreview.sourceSha || !mergePreview.targetSha) return null

    const sourceNode = layout.shaToNode.get(mergePreview.sourceSha)
    const targetNode = layout.shaToNode.get(mergePreview.targetSha)
    if (!sourceNode || !targetNode) return null

    const topNode = layout.nodes[0] ?? targetNode

    const previewNode: LayoutNode = {
      row: {
        row: topNode.row.row - 1,
        sha: `preview:${mergePreview.sourceSha}:${mergePreview.targetSha}`,
        parentShas: [targetNode.row.sha, sourceNode.row.sha],
        authorName: '',
        authorEmail: '',
        authorUnix: 0,
        committerUnix: 0,
        subject: 'Merge preview',
        additions: 0,
        deletions: 0,
        locChanged: 0,
        refNames: [],
        lane: targetNode.row.lane,
      },
      x: targetNode.x,
      y: topNode.y - NODE_SPACING_Y,
      idx: topNode.idx - 1,
    }

    const targetKey = `${previewNode.row.sha}-${targetNode.row.sha}`
    const sourceKey = `${previewNode.row.sha}-${sourceNode.row.sha}`
    const targetPlan = planEdgeRoute(previewNode, targetNode, targetKey, occupiedLanes)
    const sourcePlan = planEdgeRoute(previewNode, sourceNode, sourceKey, occupiedLanes)

    return {
      previewNode,
      sourceNode,
      targetNode,
      sourcePath: routedEdgePath(
        previewNode,
        sourceNode,
        sourcePlan,
        edgeRouting.bundleOffsets.get(sourceKey) ?? 0,
      ),
      targetPath: routedEdgePath(
        previewNode,
        targetNode,
        targetPlan,
        edgeRouting.bundleOffsets.get(targetKey) ?? 0,
      ),
      color: layout.shaToColor.get(targetNode.row.sha) ?? laneColor(targetNode.row.lane),
    }
  }, [layout, selectedRefName, mergePreview, occupiedLanes, edgeRouting.bundleOffsets])

  const previewOverlay = useMemo(
    () => (mergePreviewVisible ? mergePreviewGeometry : null),
    [mergePreviewVisible, mergePreviewGeometry],
  )

  const handleRefSelect = useCallback((e: React.MouseEvent, refName: string) => {
    e.stopPropagation()
    setMergePreviewVisible(false)
    selectGraphRef(refName)
  }, [selectGraphRef])

  const handleRefActionClick = useCallback((action: VisibleRefAction['action'], force = false) => {
    if (!selectedRefName || !selectedRef) return
    if (pendingMutation) return
    setMergePreviewVisible(false)
    const sha = selectedRef.targetSha
    const refName = selectedRefName
    performRefAction(action, refName, sha, force).catch((err) => {
      if (action === 'push' && !force && isNonFastForwardPushError(err)) {
        // Remote rejected the push because our branch isn't a fast-forward
        // (diverged / rewritten history). Offer to force-push instead.
        showError('Push rejected', err, {
          label: 'Force push',
          run: () => {
            performRefAction('push', refName, sha, true).catch((e) => showError('Force push failed', e))
          },
        })
      } else {
        showError(`${action} failed`, err)
      }
    })
  }, [selectedRefName, selectedRef, performRefAction, showError, pendingMutation])

  const handleMoveBranch = useCallback((targetSha: string) => {
    if (!movableBranchRefName) return
    if (pendingMutation) return
    const confirmed = window.confirm(`Move branch ${movableBranchRefName} to commit ${targetSha.slice(0, 8)}?`)
    if (!confirmed) return

    setMergePreviewVisible(false)
    performRefAction('move', movableBranchRefName, targetSha).catch((err) => {
      showError('Move failed', err)
    })
  }, [movableBranchRefName, performRefAction, showError, pendingMutation])

  const handleMergeHoverStart = useCallback(() => {
    if (!selectedRefName) return
    setMergePreviewVisible(true)
    if (!mergePreview || mergePreview.sourceRefName !== selectedRefName) {
      void ensureMergePreview(selectedRefName)
    }
  }, [selectedRefName, mergePreview, ensureMergePreview])

  const handleMergeHoverEnd = useCallback(() => {
    setMergePreviewVisible(false)
  }, [])

  const takeOverMergeViewport = useCallback(() => {
    const el = scrollRef.current
    if (!el || !mergePreviewGeometry) return

    const previewBottom = Math.max(
      mergePreviewGeometry.previewNode.y + NODE_RADIUS,
      mergePreviewGeometry.sourceNode.y + NODE_RADIUS,
      mergePreviewGeometry.targetNode.y + NODE_RADIUS,
    )
    const requiredHeight = Math.max(previewBottom + PAD_TOP, NODE_SPACING_Y * 4)
    const fitZoom = Math.min(zoomRef.current, Math.max(0.18, Math.min(1, el.clientHeight / requiredHeight)))

    suppressAutoScrollUntilRef.current = Date.now() + 500
    zoomRef.current = fitZoom
    setZoom(fitZoom)
    el.scrollTo({ top: 0, behavior: 'smooth' })
    requestAnimationFrame(() => refreshViewport(el, fitZoom))
  }, [mergePreviewGeometry, refreshViewport])

  const handleMergeClick = useCallback(() => {
    if (!selectedRefName) return
    if (pendingMutation) return
    setMergePreviewVisible(true)
    takeOverMergeViewport()
    performMergeRef(selectedRefName).catch((err) => {
      showError('Merge failed', err)
    })
  }, [selectedRefName, performMergeRef, takeOverMergeViewport, showError, pendingMutation])

  const handleRebaseClick = useCallback((targetRefName: string) => {
    if (!selectedCurrentBranchRef) return
    if (pendingMutation) return

    const confirmed = window.confirm(
      `Rebase ${selectedCurrentBranchRef.shortName} onto ${targetRefName}? This rewrites the current branch history.`,
    )
    if (!confirmed) return

    setMergePreviewVisible(false)
    performRebaseRef(targetRefName).catch((err) => {
      showError('Rebase failed', err)
    })
  }, [selectedCurrentBranchRef, performRebaseRef, showError, pendingMutation])

  // Sticky lane labels: show a branch name when its tip is above the viewport
  // AND the topmost visible commit on that lane belongs to that branch
  const stickyLaneLabels = useMemo(() => {
    if (!layout || !scrollRef.current) return []
    const scrollTop = scrollRef.current.scrollTop

    // Find the topmost visible commit per lane
    const topmostPerLane = new Map<number, LayoutNode>()
    for (const node of visibleNodes) {
      const existing = topmostPerLane.get(node.row.lane)
      if (!existing || node.y < existing.y) {
        topmostPerLane.set(node.row.lane, node)
      }
    }

    const labels = new Map<number, { name: string; x: number; color: string }>()

    for (const node of layout.nodes) {
      if (node.row.refNames.length === 0) continue
      const tipScreenY = node.y * zoom
      if (tipScreenY >= scrollTop) continue // tip still on screen

      const lane = node.row.lane
      if (labels.has(lane)) continue

      // Check that the topmost visible commit on this lane actually belongs to this branch
      const topVisible = topmostPerLane.get(lane)
      if (!topVisible) continue

      const refName = pickBestRef(node.row.refNames)
      if (!refName) continue
      const topBranch = layout.shaToBranch.get(topVisible.row.sha)
      if (topBranch !== refName) continue

      labels.set(lane, {
        name: refName,
        x: node.x,
        color: colorForBranchName(refName),
      })
    }
    // Assign vertical rows to avoid overlaps
    const sorted = [...labels.values()].sort((a, b) => a.x - b.x)
    const CHAR_WIDTH = 7
    const LABEL_PAD = 20
    const result: Array<{ name: string; x: number; color: string; row: number }> = []
    // Track the right edge of each row
    const rowRightEdges: number[] = []

    for (const label of sorted) {
      const labelLeft = label.x * zoom - 4
      const labelWidth = label.name.length * CHAR_WIDTH + LABEL_PAD
      let assignedRow = 0
      for (let r = 0; r < rowRightEdges.length; r++) {
        if (labelLeft >= rowRightEdges[r]) {
          assignedRow = r
          break
        }
        assignedRow = r + 1
      }
      if (assignedRow >= rowRightEdges.length) rowRightEdges.push(0)
      rowRightEdges[assignedRow] = labelLeft + labelWidth + 4
      result.push({ ...label, row: assignedRow })
    }
    return result
  }, [layout, visibleNodes, zoom])

  const timeLabels = useMemo(
    () => (layout ? computeTimeLabels(layout.nodes, zoom) : []),
    [layout, zoom],
  )

  const topTimeLabel = useMemo(() => {
    if (!layout) return null
    const node = findTopVisibleNode(layout.nodes, scrollTop, zoom)
    if (!node) return null
    const date = new Date(node.row.committerUnix * 1000)
    return formatTopTimeLabel(date, zoom)
  }, [layout, scrollTop, zoom])

  const floatingTimeLabels = useMemo(
    () => timeLabels.filter((label) => label.y - scrollTop > 28),
    [timeLabels, scrollTop],
  )

  const currentBranchShas = useMemo(
    () => buildCurrentBranchShaSet(layout, currentBranch),
    [layout, currentBranch],
  )

  const commitMessageLabels = useMemo(() => {
    if (!layout || currentBranchShas.size === 0 || !showCommitMessages) return []
    return layout.nodes
      .filter((node) => currentBranchShas.has(node.row.sha))
      .map((node) => ({
        key: node.row.sha,
        sha: node.row.sha,
        y: node.y * zoom,
        text: node.row.subject,
      }))
  }, [layout, currentBranchShas, zoom, showCommitMessages])

  const floatingCommitLabels = useMemo(
    () => commitMessageLabels.filter((label) => label.y - scrollTop > 28),
    [commitMessageLabels, scrollTop],
  )

  // Commits actually within the viewport, newest first (commitMessageLabels is
  // already top-to-bottom = newest-to-oldest).
  const onScreenCommitLabels = useMemo(() => {
    if (clientHeight === 0) return []
    return commitMessageLabels.filter((label) => {
      const viewY = label.y - scrollTop
      return viewY > 0 && viewY < clientHeight
    })
  }, [commitMessageLabels, scrollTop, clientHeight])

  // Fetch CI for the on-screen commits (capped, newest first) so each row shows
  // a status dot — without prefetching the whole graph, which tripped GitHub's
  // secondary rate limit. The 200ms debounce coalesces scroll/zoom churn.
  useEffect(() => {
    if (onScreenCommitLabels.length === 0) return
    const handle = window.setTimeout(() => {
      const shas = onScreenCommitLabels.slice(0, MAX_ONSCREEN_CI_FETCH).map((l) => l.sha)
      fetchCommitCIStatusesIfNeeded(shas)
    }, 200)
    return () => window.clearTimeout(handle)
  }, [onScreenCommitLabels, fetchCommitCIStatusesIfNeeded])

  const selectedNode = useMemo(
    () => (layout && selectedSha ? layout.shaToNode.get(selectedSha) ?? null : null),
    [layout, selectedSha],
  )

  const selectedOnCurrentBranch = useMemo(() => {
    if (!layout || !selectedNode || !currentBranch) return false

    const currentTip = layout.nodes.find((node) => node.row.refNames.includes(currentBranch))
    if (!currentTip) return false

    let sha: string | undefined = currentTip.row.sha
    const visited = new Set<string>()
    while (sha && !visited.has(sha)) {
      if (sha === selectedNode.row.sha) return true
      visited.add(sha)
      const node = layout.shaToNode.get(sha)
      if (!node || node.row.parentShas.length === 0) break
      sha = node.row.parentShas[0]
    }

    return false
  }, [layout, selectedNode, currentBranch])

  const selectedIsCurrentHead = useMemo(() => {
    if (!selectedNode || !currentBranch) return false
    return selectedNode.row.refNames.includes(currentBranch)
  }, [selectedNode, currentBranch])

  const visibleCommitActions = useMemo<VisibleCommitAction[]>(() => {
    if (!selectedNode) return []

    const actions: VisibleCommitAction[] = []
    const canRevert = selectedNode.row.parentShas.length === 1

    if (selectedIsCurrentHead) {
      actions.push({ action: 'uncommit', label: 'Uncommit', tone: 'uncommit' })
      if (canRevert) {
        actions.push({ action: 'revert', label: 'Revert', tone: 'warning' })
      }
      return actions
    }

    if (selectedOnCurrentBranch) {
      if (canRevert) {
        actions.push({ action: 'revert', label: 'Revert', tone: 'warning' })
      }
      return actions
    }

    if (canRevert) {
      actions.push({ action: 'cherry-pick', label: 'Cherry pick', tone: 'success' })
      actions.push({ action: 'revert', label: 'Revert', tone: 'warning' })
    }

    return actions
  }, [selectedNode, selectedIsCurrentHead, selectedOnCurrentBranch])

  const handleCommitAction = useCallback((action: CommitActionKind) => {
    if (!selectedNode) return
    if (pendingMutation) return

    const shortSha = selectedNode.row.sha.slice(0, 8)
    const confirmed = action === 'uncommit'
      ? window.confirm(`Uncommit ${shortSha}? This will move HEAD to its parent and keep the changes in your working tree.`)
      : window.confirm(`${action === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} commit ${shortSha} on the current branch?`)
    if (!confirmed) return

    performCommitAction(action, selectedNode.row.sha).catch((err) => {
      showError(`${action} failed`, err)
    })
  }, [selectedNode, performCommitAction, showError, pendingMutation])
  const isGraphAnimating = graphAnimation !== null

  if (!layout) {
    return (
      <div style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#45475a', fontSize: 13 }}>
        No commits to display
      </div>
    )
  }

  // Use totalCommitCount as estimate, but shrink to actual loaded count once all are loaded
  const estimatedCount = histWindow?.hasMoreAfter === false
    ? layout.nodes.length
    : Math.max(totalCommitCount, layout.nodes.length)
  const fullWidth = layout.totalWidth
  const fullHeight = estimatedCount * NODE_SPACING_Y + PAD_TOP * 2 + GRAPH_TOP_HEADROOM
  const scaledW = fullWidth * zoom
  const scaledH = fullHeight * zoom
  const worktreeConflictBadgeWidth = worktreeNode
    ? Math.max(22, String(worktreeNode.conflictedCount).length * 7 + 14)
    : 0
  const worktreeLabel = worktreeNode?.kind === 'merge'
    ? worktreeNode.conflictedCount > 0 ? 'Merge conflicts' : 'Merge in progress'
    : worktreeNode?.kind === 'rebase'
      ? worktreeNode.conflictedCount > 0 ? 'Rebase conflicts' : 'Rebase in progress'
      : 'Uncommitted changes'
  const worktreeTitle = worktreeNode?.kind === 'worktree'
    ? `Uncommitted changes — ${worktreeNode.count} file${worktreeNode.count === 1 ? '' : 's'}\nClick to stage / unstage`
    : `${worktreeLabel} — ${worktreeNode?.conflictedCount ?? 0} conflict${worktreeNode?.conflictedCount === 1 ? '' : 's'}\nClick to review files`

  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, height: '100%', overflow: 'auto', position: 'relative', background: '#1e1e2e', touchAction: 'pan-x pan-y' }}
      onClick={() => {
        setMergePreviewVisible(false)
        clearGraphRefSelection()
      }}
    >
      {/* Sticky branch lane labels at top of viewport */}
      <div style={{
        position: 'sticky',
        top: 0,
        left: 0,
        zIndex: 20,
        height: 0,
        overflow: 'visible',
        pointerEvents: 'none',
      }}>
        {stickyLaneLabels.map((label) => (
          <div
            key={label.name}
            onClick={(e) => handleRefSelect(e, label.name)}
            style={{
              position: 'absolute',
              left: label.x * zoom - 4,
              top: 4 + label.row * 22,
              padding: '2px 8px',
              borderRadius: 4,
              background: selectedRefName === label.name ? label.color + '35' : label.color + '20',
              border: `1px solid ${selectedRefName === label.name ? label.color : label.color + '50'}`,
              color: label.color,
              fontSize: 10,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              pointerEvents: 'auto',
              transform: `scale(${Math.min(zoom, 1)})`,
              transformOrigin: 'top left',
              cursor: 'pointer',
              boxShadow: selectedRefName === label.name ? `0 0 8px ${label.color}40` : 'none',
            }}
          >
            {label.name}
          </div>
        ))}
      </div>

      {/* Time range labels pinned to the right edge of the viewport */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          left: 0,
          width: '100%',
          height: 0,
          overflow: 'visible',
          zIndex: 5,
          pointerEvents: 'none',
        }}
      >
        {topTimeLabel && (
          <div
            style={{
              position: 'absolute',
              right: 20,
              top: 6,
              padding: '3px 8px',
              borderRadius: 6,
              background: '#181825',
              border: '1px solid #313244',
              color: '#9399b2',
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            }}
          >
            {topTimeLabel}
          </div>
        )}
        <div ref={commitLabelsLayerRef} style={{ position: 'relative' }}>
          {floatingCommitLabels.map((label) => {
            const status = commitCIStatus[label.sha]
            const dotColor: Record<string, string> = {
              success: '#a6e3a1',
              pending: '#f9e2af',
              failure: '#f38ba8',
              error: '#f38ba8',
              neutral: '#6c7086',
              loading: '#585b70',
              none: '#45475a',
            }
            // CI is only looked up for commits the user opens, so most rows have
            // no status — show a dot only once we actually have one, rather than
            // a perpetual "loading" dot for the entire graph.
            const dot = status ? dotColor[status.state] : undefined
            return (
              <div
                key={label.key}
                style={{
                  position: 'absolute',
                  left: 20,
                  top: label.y - 7,
                  maxWidth: (LANE_ORIGIN_X_BASE + COMMIT_MESSAGE_GUTTER - 40) * zoom,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#a6adc8',
                  fontSize: 12,
                  pointerEvents: 'none',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {dot && (
                  <span style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: dot,
                    flexShrink: 0,
                  }} />
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {label.text}
                </span>
              </div>
            )
          })}
        </div>
        <div ref={timeLabelsLayerRef} style={{ position: 'relative' }}>
          {floatingTimeLabels.map((label) => (
            <div
              key={label.key}
              style={{
                position: 'absolute',
                right: 20,
                top: label.y - 7,
                padding: '2px 6px',
                borderRadius: 6,
                background: '#1e1e2e',
                color: label.kind === 'month' ? '#6c7086' : label.kind === 'hour' ? '#585b70' : '#45475a',
                fontSize: label.kind === 'month' ? 11 : 10,
                fontWeight: label.kind === 'month' ? 600 : label.kind === 'hour' ? 500 : 400,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              <span style={{
                display: 'inline-block',
                width: label.kind === 'month' ? 16 : label.kind === 'hour' ? 6 : 8,
                height: 1,
                background: label.kind === 'month' ? '#585b70' : label.kind === 'hour' ? '#45475a' : '#313244',
                verticalAlign: 'middle',
                marginRight: 4,
              }} />
              {label.text}
            </div>
          ))}
        </div>
      </div>

      {/* Outer spacer sized to scaled content for correct scrollbar */}
      <div style={{ width: scaledW, height: scaledH, position: 'relative', zIndex: 10 }}>
      {/* Inner content scaled via transform */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: fullWidth,
        height: fullHeight,
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
      }}>
        <svg
          width={fullWidth}
          height={fullHeight}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
        >
          {renderedLaneHighlight && (
            <animated.g
              key={renderedLaneHighlight.key}
              opacity={isGraphAnimating
                ? to(
                    graphProgress,
                    (progress) => lerp(renderedLaneHighlight.fromOpacity, renderedLaneHighlight.toOpacity, progress) * 0.95,
                  )
                : renderedLaneHighlight.toOpacity * 0.95}
            >
              <animated.rect
                x={isGraphAnimating
                  ? to(graphProgress, (progress) => lerp(renderedLaneHighlight.fromX, renderedLaneHighlight.toX, progress))
                  : renderedLaneHighlight.toX}
                y={0}
                width={PRIMARY_LANE_HIGHLIGHT_WIDTH}
                height={fullHeight}
                rx={18}
                fill={`${renderedLaneHighlight.color}10`}
              />
              <animated.rect
                x={isGraphAnimating
                  ? to(graphProgress, (progress) => lerp(renderedLaneHighlight.fromX, renderedLaneHighlight.toX, progress) + 2)
                  : renderedLaneHighlight.toX + 2}
                y={0}
                width={PRIMARY_LANE_HIGHLIGHT_WIDTH - 4}
                height={fullHeight}
                rx={16}
                fill={`${renderedLaneHighlight.color}06`}
              />
            </animated.g>
          )}
          {previewOverlay && (
            <>
              <path
                d={previewOverlay.targetPath}
                stroke={previewOverlay.color}
                strokeWidth={3}
                fill="none"
                strokeLinecap="round"
                strokeDasharray="8 6"
                opacity={0.7}
              />
              <path
                d={previewOverlay.sourcePath}
                stroke={previewOverlay.color}
                strokeWidth={2.5}
                fill="none"
                strokeLinecap="round"
                strokeDasharray="8 6"
                opacity={0.55}
              />
            </>
          )}
          {renderedEdgeItems.map((edge) => (
            <animated.path
              key={edge.key}
              d={isGraphAnimating
                ? to(graphProgress, (progress) => {
                    if (progress >= 0.999) return edge.path
                    return buildAnimatedEdgePath(
                      lerp(edge.fromX1, edge.toX1, progress),
                      lerp(edge.fromY1, edge.toY1, progress),
                      lerp(edge.fromX2, edge.toX2, progress),
                      lerp(edge.fromY2, edge.toY2, progress),
                    )
                  })
                : edge.path}
              stroke={edge.stroke}
              strokeWidth={isGraphAnimating
                ? to(graphProgress, (progress) => lerp(edge.fromStrokeWidth, edge.toStrokeWidth, progress))
                : edge.toStrokeWidth}
              fill="none"
              strokeLinecap="round"
              opacity={isGraphAnimating
                ? to(graphProgress, (progress) => lerp(edge.fromOpacity, edge.toOpacity, progress))
                : edge.toOpacity}
            />
          ))}
          {previewOverlay && (
            <g>
              <circle
                cx={previewOverlay.previewNode.x}
                cy={previewOverlay.previewNode.y}
                r={NODE_RADIUS * 1.9}
                fill={previewOverlay.color}
                opacity={0.12}
              />
              <circle
                cx={previewOverlay.previewNode.x}
                cy={previewOverlay.previewNode.y}
                r={NODE_RADIUS}
                fill={NODE_FILL}
                stroke={previewOverlay.color}
                strokeWidth={3}
                strokeDasharray="6 4"
              />
              <circle
                cx={previewOverlay.previewNode.x}
                cy={previewOverlay.previewNode.y}
                r={2.5}
                fill={previewOverlay.color}
              />
            </g>
          )}
          {renderedNodeItems.map((node) => {
            const { row } = node
            const selected = row.sha === selectedSha
            const color = node.color
            const gaugeDiameter = GAUGE_RADIUS * 2
            const additionsFillHeight = computeGaugeFillHeight(row.additions, locScaleMax, gaugeDiameter)
            const deletionsFillHeight = computeGaugeFillHeight(row.deletions, locScaleMax, gaugeDiameter)
            const clipPathBaseId = `gauge-${row.sha}`
            const leftClipPathId = `${clipPathBaseId}-left`
            const rightClipPathId = `${clipPathBaseId}-right`
            const trackStroke = selected ? GAUGE_TRACK_STROKE_SELECTED : GAUGE_TRACK_STROKE
            const trackFill = selected ? GAUGE_TRACK_FILL_SELECTED : GAUGE_BACKGROUND_FILL
            const nodeX = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromX, node.toX, progress))
              : node.toX
            const nodeY = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromY, node.toY, progress))
              : node.toY
            const nodeOpacity = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromOpacity, node.toOpacity, progress))
              : node.toOpacity
            const leftGaugePath = isGraphAnimating
              ? to(graphProgress, (progress) => describeHalfCirclePath(
                  lerp(node.fromX, node.toX, progress),
                  lerp(node.fromY, node.toY, progress),
                  GAUGE_RADIUS,
                  'left',
                ))
              : describeHalfCirclePath(node.toX, node.toY, GAUGE_RADIUS, 'left')
            const rightGaugePath = isGraphAnimating
              ? to(graphProgress, (progress) => describeHalfCirclePath(
                  lerp(node.fromX, node.toX, progress),
                  lerp(node.fromY, node.toY, progress),
                  GAUGE_RADIUS,
                  'right',
                ))
              : describeHalfCirclePath(node.toX, node.toY, GAUGE_RADIUS, 'right')
            const leftGaugeArc = isGraphAnimating
              ? to(graphProgress, (progress) => describeHalfCircleArc(
                  lerp(node.fromX, node.toX, progress),
                  lerp(node.fromY, node.toY, progress),
                  GAUGE_RADIUS,
                  'left',
                ))
              : describeHalfCircleArc(node.toX, node.toY, GAUGE_RADIUS, 'left')
            const rightGaugeArc = isGraphAnimating
              ? to(graphProgress, (progress) => describeHalfCircleArc(
                  lerp(node.fromX, node.toX, progress),
                  lerp(node.fromY, node.toY, progress),
                  GAUGE_RADIUS,
                  'right',
                ))
              : describeHalfCircleArc(node.toX, node.toY, GAUGE_RADIUS, 'right')

            return (
              <animated.g
                key={row.sha}
                onClick={node.interactive ? (e) => { e.stopPropagation(); selectCommit(row.sha) } : undefined}
                opacity={nodeOpacity}
                style={{ cursor: node.interactive ? 'pointer' : 'default', pointerEvents: node.interactive ? 'auto' : 'none' }}
              >
                <title>{`${row.subject}\n+${row.additions} / -${row.deletions} (${row.locChanged} LOC changed)`}</title>
                {selected && (
                  <animated.circle
                    cx={nodeX}
                    cy={nodeY}
                    r={NODE_RADIUS * 2.5}
                    fill={color}
                    opacity={0.15}
                  />
                )}
                <animated.circle
                  cx={nodeX}
                  cy={nodeY}
                  r={NODE_RADIUS}
                  fill={NODE_FILL}
                  stroke={color}
                  strokeWidth={selected ? 3.5 : 2.75}
                />
                <defs>
                  <clipPath id={leftClipPathId} clipPathUnits="userSpaceOnUse">
                    <animated.path d={leftGaugePath} />
                  </clipPath>
                  <clipPath id={rightClipPathId} clipPathUnits="userSpaceOnUse">
                    <animated.path d={rightGaugePath} />
                  </clipPath>
                </defs>
                <animated.path d={leftGaugePath} fill={trackFill} />
                <animated.path d={rightGaugePath} fill={trackFill} />
                {additionsFillHeight > 0 && (
                  <animated.rect
                    x={isGraphAnimating
                      ? to(graphProgress, (progress) => lerp(node.fromX, node.toX, progress) - GAUGE_RADIUS)
                      : node.toX - GAUGE_RADIUS}
                    y={isGraphAnimating
                      ? to(graphProgress, (progress) => lerp(node.fromY, node.toY, progress) + GAUGE_RADIUS - additionsFillHeight)
                      : node.toY + GAUGE_RADIUS - additionsFillHeight}
                    width={GAUGE_RADIUS}
                    height={additionsFillHeight}
                    fill={GAUGE_ADDITIONS_FILL}
                    clipPath={`url(#${leftClipPathId})`}
                  />
                )}
                {deletionsFillHeight > 0 && (
                  <animated.rect
                    x={nodeX}
                    y={isGraphAnimating
                      ? to(graphProgress, (progress) => lerp(node.fromY, node.toY, progress) + GAUGE_RADIUS - deletionsFillHeight)
                      : node.toY + GAUGE_RADIUS - deletionsFillHeight}
                    width={GAUGE_RADIUS}
                    height={deletionsFillHeight}
                    fill={GAUGE_DELETIONS_FILL}
                    clipPath={`url(#${rightClipPathId})`}
                  />
                )}
                <animated.path d={leftGaugeArc} stroke={trackStroke} strokeWidth={1.6} fill="none" />
                <animated.path d={rightGaugeArc} stroke={trackStroke} strokeWidth={1.6} fill="none" />
                <animated.line
                  x1={nodeX}
                  y1={isGraphAnimating
                    ? to(graphProgress, (progress) => lerp(node.fromY, node.toY, progress) - GAUGE_RADIUS)
                    : node.toY - GAUGE_RADIUS}
                  x2={nodeX}
                  y2={isGraphAnimating
                    ? to(graphProgress, (progress) => lerp(node.fromY, node.toY, progress) + GAUGE_RADIUS)
                    : node.toY + GAUGE_RADIUS}
                  stroke={trackStroke}
                  strokeWidth={1.6}
                />
                {row.parentShas.length > 1 && (
                  <animated.circle
                    cx={nodeX}
                    cy={nodeY}
                    r={2}
                    fill={color}
                  />
                )}
              </animated.g>
            )
          })}
          {worktreeNode && !isGraphAnimating && (
            <g
              onClick={(e) => { e.stopPropagation(); selectWorktree() }}
              style={{ cursor: 'pointer', pointerEvents: 'auto' }}
            >
              <title>{worktreeTitle}</title>
              {worktreeNode.sourcePath && (
                <path
                  d={worktreeNode.sourcePath}
                  stroke={worktreeNode.color}
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  strokeDasharray="3 5"
                  fill="none"
                  opacity={0.55}
                />
              )}
              <path
                d={worktreeNode.targetPath}
                stroke={worktreeNode.color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray="3 5"
                fill="none"
                opacity={0.7}
              />
              {worktreeSelected && (
                <circle cx={worktreeNode.x} cy={worktreeNode.y} r={NODE_RADIUS * 2.5} fill={worktreeNode.color} opacity={0.15} />
              )}
              <circle
                cx={worktreeNode.x}
                cy={worktreeNode.y}
                r={NODE_RADIUS}
                fill={NODE_FILL}
                stroke={worktreeNode.color}
                strokeWidth={worktreeSelected ? 3.5 : 2.75}
                strokeDasharray="4 3"
              />
              {worktreeNode.kind === 'worktree' ? (
                <text
                  x={worktreeNode.x}
                  y={worktreeNode.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={700}
                  fill={worktreeNode.color}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {worktreeNode.count}
                </text>
              ) : (
                <>
                  <circle cx={worktreeNode.x} cy={worktreeNode.y} r={2.5} fill={worktreeNode.color} />
                  {worktreeNode.conflictedCount > 0 && (
                    <g style={{ pointerEvents: 'none', userSelect: 'none' }}>
                      <rect
                        x={worktreeNode.x + NODE_RADIUS + 6}
                        y={worktreeNode.y - 10}
                        width={worktreeConflictBadgeWidth}
                        height={20}
                        rx={10}
                        fill="#fab38722"
                        stroke="#fab387"
                        strokeWidth={1.4}
                      />
                      <text
                        x={worktreeNode.x + NODE_RADIUS + 6 + worktreeConflictBadgeWidth / 2}
                        y={worktreeNode.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={11}
                        fontWeight={800}
                        fill="#fab387"
                      >
                        {worktreeNode.conflictedCount}
                      </text>
                    </g>
                  )}
                </>
              )}
              {worktreeNode.labelSide && (
                <text
                  x={worktreeNode.labelSide === 'left'
                    ? worktreeNode.x - NODE_RADIUS - 10
                    : worktreeNode.x + NODE_RADIUS + 10 + (worktreeNode.kind === 'worktree' || worktreeNode.conflictedCount === 0
                      ? 0
                      : worktreeConflictBadgeWidth + 6)}
                  y={worktreeNode.y}
                  textAnchor={worktreeNode.labelSide === 'left' ? 'end' : 'start'}
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={600}
                  fill={worktreeSelected ? worktreeNode.color : '#a6adc8'}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {worktreeLabel}
                </text>
              )}
            </g>
          )}
        </svg>

        {renderedRefItems.map((refItem) => {
          const { placement } = refItem

          return (
            <animated.div
              key={refItem.key}
              onClick={(e) => handleRefSelect(e, placement.refName)}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                zIndex: 20,
                height: 20,
                padding: '0 7px',
                borderRadius: 4,
                background: placement.isSelected ? placement.color + '35' : placement.isCurrent ? placement.color + '2a' : placement.color + '18',
                border: `1px solid ${placement.isSelected || placement.isCurrent ? placement.color : placement.color + '55'}`,
                color: placement.color,
                fontSize: 11,
                fontWeight: 600,
                lineHeight: '20px',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                userSelect: 'none',
                boxShadow: placement.isSelected || placement.isCurrent ? `0 0 6px ${placement.color}40` : 'none',
                transformOrigin: 'top left',
                opacity: isGraphAnimating
                  ? to(graphProgress, (progress) => lerp(refItem.fromOpacity, refItem.toOpacity, progress))
                  : refItem.toOpacity,
                transform: isGraphAnimating
                  ? to(
                      graphProgress,
                      (progress) => `translate(${lerp(refItem.fromX, refItem.toX, progress)}px, ${lerp(refItem.fromY, refItem.toY, progress)}px) scale(${lerp(refItem.fromScale, refItem.toScale, progress)})`,
                    )
                  : `translate(${refItem.toX}px, ${refItem.toY}px) scale(${refItem.toScale})`,
              }}
            >
              {refBadgePrefix(placement.isRemote, placement.isCurrent)}{placement.refName}
            </animated.div>
          )
        })}

        {visibleNodes.map((node) => {
          const refRowWidth = rowRefWidths.get(node.row.sha) ?? 0
          const px = node.x + NODE_RADIUS + 8 + refRowWidth + (refRowWidth > 0 ? 8 : 0)
          const py = node.y - 10
          const nodeActions = node.row.sha === selectedSha ? visibleCommitActions : []
          const showsSelectedRef = !!selectedRefName && node.row.refNames.includes(selectedRefName)
          const rowRefActions = showsSelectedRef ? selectedRefActions : []
          const rowShowsMerge = !!currentBranch && node.row.refNames.includes(currentBranch) && showMergeButton
          const rowShowsMove = !!movableBranchRefName && node.row.sha !== selectedRef?.targetSha
          const rowRebaseTargetRef = selectedCurrentBranchRef && node.row.sha !== selectedCurrentBranchRef.targetSha
            ? pickBestRef(node.row.refNames.filter((refName) => refName !== selectedCurrentBranchRef.shortName))
            : null

          if (nodeActions.length === 0 && rowRefActions.length === 0 && !rowShowsMerge && !rowShowsMove && !rowRebaseTargetRef) return null

          return (
            <div
              key={`${node.row.sha}-actions`}
              style={{
                position: 'absolute',
                left: px,
                top: py,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                flexWrap: 'nowrap',
                zIndex: 20,
              }}
            >
              {rowRefActions.length > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  position: 'relative',
                  top: verticalOffsetForHeight(DEFAULT_REF_ACTION_HEIGHT),
                  zIndex: 7,
                }}>
                  {rowRefActions.map((refAction) => (
                    <RefActionButton
                      key={refAction.action}
                      label={refAction.label}
                      tone={refAction.tone}
                      onClick={() => handleRefActionClick(refAction.action, refAction.force)}
                    />
                  ))}
                </div>
              )}
              {nodeActions.length > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  position: 'relative',
                  top: verticalOffsetForHeight(COMMIT_ACTION_HEIGHT),
                  zIndex: 7,
                }}>
                  {nodeActions.map((commitAction) => (
                    <CommitActionButton
                      key={commitAction.action}
                      label={commitAction.label}
                      tone={commitAction.tone}
                      onClick={() => handleCommitAction(commitAction.action)}
                    />
                  ))}
                </div>
              )}
              {rowShowsMove && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative', zIndex: 7 }}>
                  <RefActionButton
                    label="← Move"
                    tone="neutral"
                    size="compact"
                    variant="ghost"
                    onClick={() => handleMoveBranch(node.row.sha)}
                  />
                </div>
              )}
              {rowRebaseTargetRef && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  position: 'relative',
                  top: verticalOffsetForHeight(COMMIT_ACTION_HEIGHT),
                  zIndex: 7,
                }}>
                  <CommitActionButton
                    label="Rebase"
                    tone="success"
                    onClick={() => handleRebaseClick(rowRebaseTargetRef)}
                  />
                </div>
              )}
              {rowShowsMerge && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  position: 'relative',
                  top: verticalOffsetForHeight(COMMIT_ACTION_HEIGHT),
                  zIndex: 7,
                }}>
                  <CommitActionButton
                    label="Merge"
                    tone="merge"
                    onClick={handleMergeClick}
                    onMouseEnter={handleMergeHoverStart}
                    onMouseLeave={handleMergeHoverEnd}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      </div>

    </div>
  )
}
