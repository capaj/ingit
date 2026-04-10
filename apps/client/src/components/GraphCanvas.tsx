import { useRef, useEffect, useCallback, useState, useMemo, useReducer } from 'react'
import type { CommitRow, CommitActionKind, RefSummary } from '@ingit/rpc-contract'
import { useAppStore } from '../store'

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const NODE_SPACING_Y = 56
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
const PAD_LEFT = 40
const LANE_ORIGIN_X = PAD_LEFT + GRAPH_LEFT_GUTTER

const LANE_COLORS = [
  '#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7',
  '#94e2d5', '#fab387', '#74c7ec', '#f5c2e7', '#b4befe',
]

function laneColor(lane: number) {
  const normalized = ((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length
  return LANE_COLORS[normalized]
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

function buildLayout(rows: CommitRow[]) {
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

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const node: LayoutNode = {
      row,
      x: LANE_ORIGIN_X + (row.lane + laneRadius) * LANE_WIDTH,
      y: PAD_TOP + i * NODE_SPACING_Y,
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

  return {
    nodes,
    shaToNode,
    shaToBranch,
    maxLane,
    totalWidth: PAD_LEFT * 2 + GRAPH_LEFT_GUTTER + (laneRadius * 2 + 1) * LANE_WIDTH + GRAPH_RIGHT_GUTTER,
    totalHeight: rows.length * NODE_SPACING_Y + PAD_TOP * 2,
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
    Math.floor((unscaledTop - PAD_TOP) / NODE_SPACING_Y),
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

// ---------------------------------------------------------------------------
// Compute visible window indices from scroll position
// ---------------------------------------------------------------------------

function computeVisibleRange(scrollTop: number, clientHeight: number, totalNodes: number, zoom: number) {
  // Render 3 screens worth above and below
  const overscan = clientHeight * 3
  const top = scrollTop - overscan
  const bot = scrollTop + clientHeight + overscan
  const scaledSpacing = NODE_SPACING_Y * zoom
  const firstIdx = Math.max(0, Math.floor((top - PAD_TOP * zoom) / scaledSpacing))
  const lastIdx = Math.min(totalNodes - 1, Math.ceil((bot - PAD_TOP * zoom) / scaledSpacing))
  return { firstIdx, lastIdx }
}

function edgeIntersectsRange(fromIdx: number, toIdx: number, firstIdx: number, lastIdx: number) {
  const top = Math.min(fromIdx, toIdx)
  const bottom = Math.max(fromIdx, toIdx)
  return bottom >= firstIdx && top <= lastIdx
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const timeLabelsLayerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [scrollTop, setScrollTop] = useState(0)
  const [mergePreviewVisible, setMergePreviewVisible] = useState(false)
  const zoomRef = useRef(1)
  const suppressAutoScrollUntilRef = useRef(0)
  // Force re-render counter — incremented when scroll position changes enough
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  const lastRenderedRange = useRef({ firstIdx: 0, lastIdx: 100 })

  const layout = useMemo(() => {
    if (!histWindow || histWindow.rows.length === 0) return null
    return buildLayout(histWindow.rows)
  }, [histWindow])

  useEffect(() => {
    setMergePreviewVisible(false)
  }, [selectedRefName])

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

  const locScaleMax = useMemo(
    () => (histWindow ? computeLocScaleMax(histWindow.rows) : 0),
    [histWindow],
  )

  const occupiedLanes = useMemo(
    () => (layout ? layout.nodes.map((node) => node.row.lane) : []),
    [layout],
  )

  const currentBranchEdgeKeys = useMemo(() => {
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
  }, [layout, currentBranch])

  const refreshViewport = useCallback((el: HTMLDivElement, nextZoom: number) => {
    if (!layout) return
    setScrollTop(el.scrollTop)
    if (timeLabelsLayerRef.current) {
      timeLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    }
    const { firstIdx, lastIdx } = computeVisibleRange(el.scrollTop, el.clientHeight, layout.nodes.length, nextZoom)
    lastRenderedRange.current = { firstIdx, lastIdx }
    forceRender()
  }, [layout])

  // Scroll to a specific commit when scrollToSha changes
  useEffect(() => {
    if (!scrollToSha || !layout || !scrollRef.current) return
    if (Date.now() < suppressAutoScrollUntilRef.current) return
    const node = layout.shaToNode.get(scrollToSha)
    if (!node) return
    const el = scrollRef.current
    const targetTop = node.y * zoom - el.clientHeight / 2
    el.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  }, [scrollToSha, scrollToKey, layout, zoom])

  // Scroll + resize handler: re-render only when we're about to run out of rendered nodes
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const check = () => {
      if (!layout) return
      setScrollTop(el.scrollTop)
      if (timeLabelsLayerRef.current) {
        timeLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
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
      setScrollTop(el.scrollTop)
      if (timeLabelsLayerRef.current) {
        timeLabelsLayerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
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
  }, [layout, histWindow, requestMore])

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

    const nodes = layout.nodes.slice(firstIdx, lastIdx + 1)
    const edges: Array<{ from: LayoutNode; to: LayoutNode; isMerge: boolean; key: string }> = []

    // Keep any edge whose row span crosses the virtualized window. This
    // preserves long same-lane segments even when both endpoint nodes are
    // currently outside the rendered node slice.
    for (const node of layout.nodes) {
      for (let pi = 0; pi < node.row.parentShas.length; pi++) {
        const parent = layout.shaToNode.get(node.row.parentShas[pi])
        if (!parent) continue
        if (!edgeIntersectsRange(node.idx, parent.idx, firstIdx, lastIdx)) continue
        edges.push({
          from: node, to: parent, isMerge: pi > 0,
          key: `${node.row.sha}-${parent.row.sha}`,
        })
      }
    }

    return { visibleNodes: nodes, visibleEdges: edges }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, lastRenderedRange.current.firstIdx, lastRenderedRange.current.lastIdx])

  const edgeRouting = useMemo(() => {
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
  }, [visibleEdges, occupiedLanes])

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
      if (selectedRef.isCurrent) {
        return [
          ...(canPushSelectedRef ? [{ action: 'push', label: 'Push', tone: 'neutral' as const }] : []),
          ...(canResetSelectedRef ? [{ action: 'reset', label: 'Reset', tone: 'warning' as const }] : []),
        ]
      }

      return [
        { action: 'checkout', label: 'Checkout', tone: 'neutral' },
        ...(canPushSelectedRef ? [{ action: 'push', label: 'Push', tone: 'neutral' as const }] : []),
        ...(canResetSelectedRef ? [{ action: 'reset', label: 'Reset', tone: 'warning' as const }] : []),
        { action: 'delete', label: 'Delete', tone: 'danger' },
      ]
    }

    if (selectedRef.kind === 'remote') {
      return [
        { action: 'fetch', label: 'Fetch', tone: 'neutral' },
        { action: 'delete', label: 'Delete', tone: 'danger' },
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

  const mergePreviewGeometry = useMemo(() => {
    if (!layout || !selectedRefName || !mergePreview?.mergeable) return null
    if (mergePreview.sourceRefName !== selectedRefName) return null
    if (!mergePreview.sourceSha || !mergePreview.targetSha) return null

    const sourceNode = layout.shaToNode.get(mergePreview.sourceSha)
    const targetNode = layout.shaToNode.get(mergePreview.targetSha)
    if (!sourceNode || !targetNode) return null

    const previewNode: LayoutNode = {
      row: {
        row: targetNode.row.row - 1,
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
      y: targetNode.y - NODE_SPACING_Y,
      idx: targetNode.idx - 1,
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
      color: laneColor(targetNode.row.lane),
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

  const handleRefActionClick = useCallback((action: 'checkout' | 'push' | 'fetch' | 'delete' | 'reset') => {
    if (!selectedRefName || !selectedRef) return
    setMergePreviewVisible(false)
    performRefAction(action, selectedRefName, selectedRef.targetSha).catch((err) => {
      alert(err instanceof Error ? err.message : 'Action failed')
    })
  }, [selectedRefName, selectedRef, performRefAction])

  const handleMoveBranch = useCallback((targetSha: string) => {
    if (!movableBranchRefName) return
    const confirmed = window.confirm(`Move branch ${movableBranchRefName} to commit ${targetSha.slice(0, 8)}?`)
    if (!confirmed) return

    setMergePreviewVisible(false)
    performRefAction('move', movableBranchRefName, targetSha).catch((err) => {
      alert(err instanceof Error ? err.message : 'Move failed')
    })
  }, [movableBranchRefName, performRefAction])

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
    setMergePreviewVisible(true)
    takeOverMergeViewport()
    performMergeRef(selectedRefName).catch((err) => {
      alert(err instanceof Error ? err.message : 'Merge failed')
    })
  }, [selectedRefName, performMergeRef, takeOverMergeViewport])

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
        color: laneColor(lane),
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

    const shortSha = selectedNode.row.sha.slice(0, 8)
    const confirmed = action === 'uncommit'
      ? window.confirm(`Uncommit ${shortSha}? This will move HEAD to its parent and keep the changes in your working tree.`)
      : window.confirm(`${action === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} commit ${shortSha} on the current branch?`)
    if (!confirmed) return

    performCommitAction(action, selectedNode.row.sha).catch((err) => {
      alert(err instanceof Error ? err.message : 'Action failed')
    })
  }, [selectedNode, performCommitAction])

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
  const fullHeight = estimatedCount * NODE_SPACING_Y + PAD_TOP * 2
  const scaledW = fullWidth * zoom
  const scaledH = fullHeight * zoom

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
          {visibleEdges.map((e) => (
            (() => {
              const isCurrentBranchEdge = currentBranchEdgeKeys.has(e.key)
              return (
                <path
                  key={e.key}
                  d={routedEdgePath(
                    e.from,
                    e.to,
                    edgeRouting.plans.get(e.key) ?? planEdgeRoute(e.from, e.to, e.key, occupiedLanes),
                    edgeRouting.bundleOffsets.get(e.key) ?? 0,
                  )}
                  stroke={e.isMerge ? laneColor(e.to.row.lane) : laneColor(e.from.row.lane)}
                  strokeWidth={isCurrentBranchEdge ? 4.5 : e.isMerge ? 2 : 3}
                  fill="none"
                  strokeLinecap="round"
                  opacity={isCurrentBranchEdge ? 0.95 : 0.8}
                />
              )
            })()
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
          {visibleNodes.map((node) => {
            const { row, x, y } = node
            const selected = row.sha === selectedSha
            const color = laneColor(row.lane)
            const gaugeDiameter = GAUGE_RADIUS * 2
            const gaugeTop = y - GAUGE_RADIUS
            const gaugeLeftPath = describeHalfCirclePath(x, y, GAUGE_RADIUS, 'left')
            const gaugeRightPath = describeHalfCirclePath(x, y, GAUGE_RADIUS, 'right')
            const gaugeLeftArc = describeHalfCircleArc(x, y, GAUGE_RADIUS, 'left')
            const gaugeRightArc = describeHalfCircleArc(x, y, GAUGE_RADIUS, 'right')
            const additionsFillHeight = computeGaugeFillHeight(row.additions, locScaleMax, gaugeDiameter)
            const deletionsFillHeight = computeGaugeFillHeight(row.deletions, locScaleMax, gaugeDiameter)
            const additionsFillY = gaugeTop + gaugeDiameter - additionsFillHeight
            const deletionsFillY = gaugeTop + gaugeDiameter - deletionsFillHeight
            const clipPathBaseId = `gauge-${row.sha}`
            const leftClipPathId = `${clipPathBaseId}-left`
            const rightClipPathId = `${clipPathBaseId}-right`
            const trackStroke = selected ? GAUGE_TRACK_STROKE_SELECTED : GAUGE_TRACK_STROKE
            const trackFill = selected ? GAUGE_TRACK_FILL_SELECTED : GAUGE_BACKGROUND_FILL
            return (
              <g
                key={row.sha}
                onClick={(e) => { e.stopPropagation(); selectCommit(row.sha) }}
                style={{ cursor: 'pointer', pointerEvents: 'auto' }}
              >
                <title>{`${row.subject}\n+${row.additions} / -${row.deletions} (${row.locChanged} LOC changed)`}</title>
                {selected && <circle cx={x} cy={y} r={NODE_RADIUS * 2.5} fill={color} opacity={0.15} />}
                <circle cx={x} cy={y} r={NODE_RADIUS} fill={NODE_FILL} stroke={color} strokeWidth={selected ? 3.5 : 2.75} />
                <>
                  <defs>
                    <clipPath id={leftClipPathId} clipPathUnits="userSpaceOnUse">
                      <path d={gaugeLeftPath} />
                    </clipPath>
                    <clipPath id={rightClipPathId} clipPathUnits="userSpaceOnUse">
                      <path d={gaugeRightPath} />
                    </clipPath>
                  </defs>
                  <path d={gaugeLeftPath} fill={trackFill} />
                  <path d={gaugeRightPath} fill={trackFill} />
                  {additionsFillHeight > 0 && (
                    <rect
                      x={x - GAUGE_RADIUS}
                      y={additionsFillY}
                      width={GAUGE_RADIUS}
                      height={additionsFillHeight}
                      fill={GAUGE_ADDITIONS_FILL}
                      clipPath={`url(#${leftClipPathId})`}
                    />
                  )}
                  {deletionsFillHeight > 0 && (
                    <rect
                      x={x}
                      y={deletionsFillY}
                      width={GAUGE_RADIUS}
                      height={deletionsFillHeight}
                      fill={GAUGE_DELETIONS_FILL}
                      clipPath={`url(#${rightClipPathId})`}
                    />
                  )}
                  <path d={gaugeLeftArc} stroke={trackStroke} strokeWidth={1.6} fill="none" />
                  <path d={gaugeRightArc} stroke={trackStroke} strokeWidth={1.6} fill="none" />
                  <line
                    x1={x}
                    y1={gaugeTop}
                    x2={x}
                    y2={gaugeTop + gaugeDiameter}
                    stroke={trackStroke}
                    strokeWidth={1.6}
                  />
                  {row.parentShas.length > 1 && <circle cx={x} cy={y} r={2} fill={color} />}
                </>
              </g>
            )
          })}
        </svg>

        {visibleNodes.map((node) => {
          const px = node.x + NODE_RADIUS + 8
          const py = node.y - 10
          const nodeActions = node.row.sha === selectedSha ? visibleCommitActions : []
          const showsSelectedRef = !!selectedRefName && node.row.refNames.includes(selectedRefName)
          const rowRefActions = showsSelectedRef ? selectedRefActions : []
          const rowShowsMerge = !!currentBranch && node.row.refNames.includes(currentBranch) && showMergeButton
          const rowShowsMove = !!movableBranchRefName && node.row.sha !== selectedRef?.targetSha

          if (node.row.refNames.length === 0 && nodeActions.length === 0 && rowRefActions.length === 0 && !rowShowsMerge && !rowShowsMove) return null

          return (
            <div
              key={`${node.row.sha}-refs`}
              style={{
                position: 'absolute',
                left: px,
                top: py,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'nowrap',
                zIndex: 20,
              }}
            >
              {node.row.refNames.map((refName, ri) => {
                const color = laneColor(node.row.lane)
                const isCurrent = currentBranch !== null && refName === currentBranch
                const isSelectedRef = refName === selectedRefName
                return (
                  <div
                    key={`${node.row.sha}-ref-${ri}`}
                    onClick={(e) => handleRefSelect(e, refName)}
                    style={{
                      height: 20,
                      padding: '0 7px',
                      borderRadius: 4,
                      background: isSelectedRef ? color + '35' : isCurrent ? color + '2a' : color + '18',
                      border: `1px solid ${isSelectedRef || isCurrent ? color : color + '55'}`,
                      color,
                      fontSize: 11,
                      fontWeight: 600,
                      lineHeight: '20px',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      userSelect: 'none',
                      transition: 'transform 0.3s ease, opacity 0.3s ease',
                      boxShadow: isSelectedRef || isCurrent ? `0 0 6px ${color}40` : 'none',
                    }}
                  >
                    {isRemoteRef(refName) ? '☁ ' : isCurrent ? '● ' : '⎇ '}{refName}
                  </div>
                )
              })}
              {rowRefActions.length > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginLeft: node.row.refNames.length > 0 ? 8 : 0,
                  position: 'relative',
                  top: verticalOffsetForHeight(DEFAULT_REF_ACTION_HEIGHT),
                  zIndex: 7,
                }}>
                  {rowRefActions.map((refAction) => (
                    <RefActionButton
                      key={refAction.action}
                      label={refAction.label}
                      tone={refAction.tone}
                      onClick={() => handleRefActionClick(refAction.action)}
                    />
                  ))}
                </div>
              )}
              {nodeActions.length > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginLeft: node.row.refNames.length > 0 ? 8 : 0,
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: node.row.refNames.length > 0 || nodeActions.length > 0 || rowRefActions.length > 0 ? 8 : 0, position: 'relative', zIndex: 7 }}>
                  <RefActionButton
                    label="← Move"
                    tone="neutral"
                    size="compact"
                    variant="ghost"
                    onClick={() => handleMoveBranch(node.row.sha)}
                  />
                </div>
              )}
              {rowShowsMerge && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginLeft: node.row.refNames.length > 0 || nodeActions.length > 0 || rowRefActions.length > 0 || rowShowsMove ? 8 : 0,
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

function CommitActionButton({
  label,
  onClick,
  tone,
  onMouseEnter,
  onMouseLeave,
}: {
  label: string
  onClick: () => void
  tone: 'success' | 'warning' | 'uncommit' | 'merge'
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const color = tone === 'success'
    ? '#0b1020'
    : tone === 'warning'
      ? '#fff7d6'
      : tone === 'merge'
        ? '#fff7ff'
        : '#fff7ed'
  const border = tone === 'success'
    ? '#6d9658'
    : tone === 'warning'
      ? '#d8a43a'
      : tone === 'merge'
        ? '#b764d9'
        : '#9a3412'
  const background = tone === 'success'
    ? '#8dcf78'
    : tone === 'warning'
      ? '#b88a25'
      : tone === 'merge'
        ? '#c77de4'
        : '#b45309'
  const hover = tone === 'success'
    ? '#9cda89'
    : tone === 'warning'
      ? '#c99a30'
      : tone === 'merge'
        ? '#d08bea'
        : '#c26115'

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 104,
        height: 30,
        padding: '0 12px',
        background,
        border: `1px solid ${border}`,
        borderRadius: 7,
        color,
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        position: 'relative',
        zIndex: 8,
        boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = hover }}
      onMouseLeave={(e) => { e.currentTarget.style.background = background }}
      onPointerEnter={onMouseEnter}
      onPointerLeave={onMouseLeave}
    >
      {label}
    </button>
  )
}

function RefActionButton({
  label,
  onClick,
  tone,
  size = 'default',
  variant = 'solid',
}: {
  label: string
  onClick: () => void
  tone: 'neutral' | 'warning' | 'danger'
  size?: 'default' | 'compact'
  variant?: 'solid' | 'ghost'
}) {
  const compact = size === 'compact'
  const ghost = variant === 'ghost'

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: compact ? 72 : 84,
        height: compact ? 20 : 28,
        padding: compact ? '0 8px' : '0 10px',
        background: ghost
          ? 'rgba(24,24,37,0.5)'
          : tone === 'danger'
            ? '#5c2430'
            : tone === 'warning'
              ? '#7a4e11'
              : '#2f3348',
        border: ghost
          ? '1px solid transparent'
          : `1px solid ${tone === 'danger' ? '#8b3a4a' : tone === 'warning' ? '#d19128' : '#4a4f68'}`,
        color: tone === 'danger' ? '#f5a6b8' : tone === 'warning' ? '#f9d28b' : ghost ? '#bac2de' : '#cdd6f4',
        fontSize: compact ? 11 : 12,
        fontWeight: 600,
        cursor: 'pointer',
        borderRadius: compact ? 6 : 7,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = ghost
          ? 'rgba(49,50,68,0.8)'
          : tone === 'danger'
            ? '#6a2b39'
            : tone === 'warning'
              ? '#8a5a16'
            : '#3a4058'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = ghost
          ? 'rgba(24,24,37,0.5)'
          : tone === 'danger'
            ? '#5c2430'
            : tone === 'warning'
              ? '#7a4e11'
            : '#2f3348'
      }}
    >
      {label}
    </button>
  )
}
