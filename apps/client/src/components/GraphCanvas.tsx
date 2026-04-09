import { useRef, useEffect, useCallback, useState, useMemo, useReducer } from 'react'
import type { HistoryWindowResponse, CommitRow } from '@ingit/rpc-contract'

interface GraphCanvasProps {
  window: HistoryWindowResponse | null
  totalCommitCount: number
  selectedSha: string | null
  scrollToSha: string | null
  scrollToKey: number
  currentBranch: string | null
  onSelectCommit: (sha: string) => void
  onRequestMore: (direction: 'up' | 'down') => void
  onRefAction?: (action: string, refName: string, sha: string) => void
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const NODE_SPACING_Y = 56
const LANE_WIDTH = 80
const NODE_RADIUS = 16
const NODE_FILL = '#11111b'
const GAUGE_RADIUS = NODE_RADIUS - 5
const GAUGE_STROKE_WIDTH = 3.25
const GAUGE_START_ANGLE = 230
const GAUGE_END_ANGLE = 490
const EDGE_CORNER_RADIUS = 12
const EDGE_SHORT_CURVE_ROWS = 6
const EDGE_RAIL_BASE_OFFSET = NODE_RADIUS + 14
const EDGE_RAIL_STAGGER_STEP = 6
const EDGE_BUNDLE_GAP = 4
const PAD_TOP = 40
const PAD_LEFT = 40

const LANE_COLORS = [
  '#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7',
  '#94e2d5', '#fab387', '#74c7ec', '#f5c2e7', '#b4befe',
]

function laneColor(lane: number) {
  return LANE_COLORS[lane % LANE_COLORS.length]
}

interface LayoutNode {
  row: CommitRow
  x: number
  y: number
  idx: number
}

type EdgeRoutePlan =
  | { mode: 'straight' }
  | { mode: 'curve' }
  | { mode: 'adjacent-hook'; laneA: number; laneB: number }
  | { mode: 'inside-rail'; minLane: number; maxLane: number; sourceRailX: number; targetRailX: number; crossoverY: number }
  | { mode: 'outer-rail'; side: 'left' | 'right'; anchorLane: number; innerLane: number; outerRailX: number }

function buildLayout(rows: CommitRow[]) {
  const sorted = [...rows].sort((a, b) => b.committerUnix - a.committerUnix)
  let maxLane = 0
  const nodes: LayoutNode[] = []
  const shaToNode = new Map<string, LayoutNode>()
  const shaToRow = new Map<string, CommitRow>()

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]
    if (row.lane > maxLane) maxLane = row.lane
    const node: LayoutNode = {
      row,
      x: PAD_LEFT + row.lane * LANE_WIDTH,
      y: PAD_TOP + i * NODE_SPACING_Y,
      idx: i,
    }
    nodes.push(node)
    shaToNode.set(row.sha, node)
    shaToRow.set(row.sha, row)
  }

  // Build sha → branch name by tracing first-parent chains from branch tips
  // Prefer local branches over remotes; skip bare remote names like "origin"
  const shaToBranch = new Map<string, string>()
  for (const row of sorted) {
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
    totalHeight: sorted.length * NODE_SPACING_Y + PAD_TOP * 2,
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
  const rightRailX = PAD_LEFT + maxLane * LANE_WIDTH + EDGE_RAIL_BASE_OFFSET + stagger
  const leftRailX = PAD_LEFT + minLane * LANE_WIDTH - EDGE_RAIL_BASE_OFFSET - stagger

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

  const insideScore = insideConflicts * 5 + laneDelta
  const leftScore = leftConflicts * 2 + minLane
  const rightScore = rightConflicts * 2 + 0.5

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

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * (Math.PI / 180)
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  }
}

function describeArc(centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(centerX, centerY, radius, endAngle)
  const end = polarToCartesian(centerX, centerY, radius, startAngle)
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`
}

function computeLocScaleMax(rows: CommitRow[]) {
  if (rows.length === 0) return 0
  const sorted = rows.map((row) => row.locChanged).sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * 0.96) - 1)
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0
}

function gaugeColor(progress: number, defaultColor: string) {
  if (progress > 2 / 3) return '#f38ba8'
  if (progress > 1 / 3) return '#fab387'
  return defaultColor
}

// ---------------------------------------------------------------------------
// Time range labels
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function computeTimeLabels(nodes: LayoutNode[], zoom: number) {
  if (nodes.length === 0) return []

  const MIN_GAP = 22 // minimum scaled pixels between labels
  const labels: Array<{ text: string; y: number; isMonth: boolean }> = []
  let prevDay = -1
  let prevMonth = -1
  let prevYear = -1
  let lastLabelY = -Infinity

  for (const node of nodes) {
    const date = new Date(node.row.committerUnix * 1000)
    const day = date.getDate()
    const month = date.getMonth()
    const year = date.getFullYear()

    if (day === prevDay && month === prevMonth && year === prevYear) continue
    const isNewMonth = month !== prevMonth || year !== prevYear
    prevDay = day
    prevMonth = month
    prevYear = year

    const y = node.y * zoom
    if (y - lastLabelY < MIN_GAP) continue

    const text = isNewMonth
      ? `${MONTH_NAMES[month]} ${day}, ${year}`
      : `${day}`

    labels.push({ text, y, isMonth: isNewMonth })
    lastLabelY = y
  }

  return labels
}

function isRemoteRef(name: string) { return name.includes('/') }
function refPillColor(name: string) {
  return isRemoteRef(name) ? '#94e2d5' : '#89b4fa'
}

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GraphCanvas({
  window: histWindow,
  totalCommitCount,
  selectedSha,
  scrollToSha,
  scrollToKey,
  currentBranch,
  onSelectCommit,
  onRequestMore,
  onRefAction,
}: GraphCanvasProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  // Force re-render counter — incremented when scroll position changes enough
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  const lastRenderedRange = useRef({ firstIdx: 0, lastIdx: 100 })
  const [activePopover, setActivePopover] = useState<{
    refName: string; sha: string; x: number; y: number
  } | null>(null)

  const layout = useMemo(() => {
    if (!histWindow || histWindow.rows.length === 0) return null
    return buildLayout(histWindow.rows)
  }, [histWindow])

  const locScaleMax = useMemo(
    () => (histWindow ? computeLocScaleMax(histWindow.rows) : 0),
    [histWindow],
  )

  const occupiedLanes = useMemo(
    () => (layout ? layout.nodes.map((node) => node.row.lane) : []),
    [layout],
  )

  // Scroll to a specific commit when scrollToSha changes
  useEffect(() => {
    if (!scrollToSha || !layout || !scrollRef.current) return
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
          onRequestMore('down')
        }
      }
    }

    // Initial
    if (layout) {
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
  }, [layout, histWindow, onRequestMore])

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
      onRequestMore('down')
    }
  }, [zoom, layout, histWindow, onRequestMore])

  // Compute visible nodes + edges based on last rendered range
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!layout) return { visibleNodes: [], visibleEdges: [] }
    const { firstIdx, lastIdx } = lastRenderedRange.current

    const nodes = layout.nodes.slice(firstIdx, lastIdx + 1)
    const visibleShas = new Set(nodes.map(n => n.row.sha))

    const edges: Array<{ from: LayoutNode; to: LayoutNode; isMerge: boolean; key: string }> = []
    // Edges from visible nodes to their parents (parent may be outside window)
    for (const node of nodes) {
      for (let pi = 0; pi < node.row.parentShas.length; pi++) {
        const parent = layout.shaToNode.get(node.row.parentShas[pi])
        if (!parent) continue
        edges.push({
          from: node, to: parent, isMerge: pi > 0,
          key: `${node.row.sha}-${parent.row.sha}`,
        })
      }
    }
    // Edges from non-visible nodes that connect TO visible nodes
    for (const node of layout.nodes) {
      if (visibleShas.has(node.row.sha)) continue
      for (let pi = 0; pi < node.row.parentShas.length; pi++) {
        const parent = layout.shaToNode.get(node.row.parentShas[pi])
        if (!parent || !visibleShas.has(parent.row.sha)) continue
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

  const handleRefClick = useCallback((e: React.MouseEvent, refName: string, sha: string, x: number, y: number) => {
    e.stopPropagation()
    setActivePopover({ refName, sha, x, y })
  }, [])

  const handleAction = useCallback((action: string) => {
    if (activePopover && onRefAction) {
      onRefAction(action, activePopover.refName, activePopover.sha)
    }
    setActivePopover(null)
  }, [activePopover, onRefAction])

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
  const fullHeight = estimatedCount * NODE_SPACING_Y + PAD_TOP * 2
  const scaledH = fullHeight * zoom

  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, height: '100%', overflow: 'auto', position: 'relative', background: '#1e1e2e', touchAction: 'pan-x pan-y' }}
      onClick={() => setActivePopover(null)}
    >
      {/* Sticky branch lane labels at top of viewport */}
      <div style={{
        position: 'sticky',
        top: 0,
        left: 0,
        zIndex: 5,
        height: 0,
        overflow: 'visible',
        pointerEvents: 'none',
      }}>
        {stickyLaneLabels.map((label) => (
          <div
            key={label.name}
            style={{
              position: 'absolute',
              left: label.x * zoom - 4,
              top: 4 + label.row * 22,
              padding: '2px 8px',
              borderRadius: 4,
              background: label.color + '20',
              border: `1px solid ${label.color}50`,
              color: label.color,
              fontSize: 10,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              pointerEvents: 'auto',
              transform: `scale(${Math.min(zoom, 1)})`,
              transformOrigin: 'top left',
            }}
          >
            {label.name}
          </div>
        ))}
      </div>

      {/* Outer spacer sized to scaled content for correct scrollbar */}
      <div style={{ height: scaledH, position: 'relative' }}>
      {/* Inner content scaled via transform */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: `${100 / zoom}%`,
        height: fullHeight,
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
      }}>
        <svg
          width="100%"
          height={fullHeight}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        >
          {visibleEdges.map((e) => (
            <path
              key={e.key}
              d={routedEdgePath(
                e.from,
                e.to,
                edgeRouting.plans.get(e.key) ?? planEdgeRoute(e.from, e.to, e.key, occupiedLanes),
                edgeRouting.bundleOffsets.get(e.key) ?? 0,
              )}
              stroke={e.isMerge ? laneColor(e.to.row.lane) : laneColor(e.from.row.lane)}
              strokeWidth={e.isMerge ? 2 : 3}
              fill="none"
              strokeLinecap="round"
              opacity={0.8}
            />
          ))}
          {visibleNodes.map((node) => {
            const { row, x, y } = node
            const selected = row.sha === selectedSha
            const color = laneColor(row.lane)
            const isHotCommit = row.locChanged > locScaleMax
            const gaugeProgress = locScaleMax > 0
              ? Math.min(row.locChanged / locScaleMax, 1)
              : 0
            const gaugeStroke = gaugeColor(gaugeProgress, color)
            const gaugeTrackPath = describeArc(x, y, GAUGE_RADIUS, GAUGE_START_ANGLE, GAUGE_END_ANGLE)
            const gaugeValuePath = gaugeProgress > 0
              ? describeArc(
                x,
                y,
                GAUGE_RADIUS,
                GAUGE_START_ANGLE,
                GAUGE_START_ANGLE + (GAUGE_END_ANGLE - GAUGE_START_ANGLE) * gaugeProgress,
              )
              : null
            return (
              <g
                key={row.sha}
                onClick={(e) => { e.stopPropagation(); onSelectCommit(row.sha) }}
                style={{ cursor: 'pointer', pointerEvents: 'auto' }}
              >
                <title>{`${row.subject}\n${row.locChanged} LOC changed`}</title>
                {selected && <circle cx={x} cy={y} r={NODE_RADIUS * 2.5} fill={color} opacity={0.15} />}
                <circle cx={x} cy={y} r={NODE_RADIUS} fill={NODE_FILL} stroke={color} strokeWidth={selected ? 3.5 : 2.75} />
                {isHotCommit ? (
                  <text
                    x={x}
                    y={y + 0.5}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={NODE_RADIUS - 3}
                    style={{
                      fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
                    }}
                  >
                    🔥
                  </text>
                ) : (
                  <>
                    <path
                      d={gaugeTrackPath}
                      stroke={selected ? '#cdd6f433' : '#45475a'}
                      strokeWidth={GAUGE_STROKE_WIDTH}
                      fill="none"
                      strokeLinecap="round"
                    />
                    {gaugeValuePath && (
                      <path
                        d={gaugeValuePath}
                        stroke={gaugeStroke}
                        strokeWidth={GAUGE_STROKE_WIDTH}
                        fill="none"
                        strokeLinecap="round"
                      />
                    )}
                    {row.parentShas.length > 1 && <circle cx={x} cy={y} r={2} fill={color} />}
                  </>
                )}
              </g>
            )
          })}
        </svg>

        {visibleNodes.flatMap((node) =>
          node.row.refNames.map((refName, ri) => {
            const color = refPillColor(refName)
            const isCurrent = currentBranch !== null && refName === currentBranch
            const px = node.x + NODE_RADIUS + 8
            const py = node.y - 10 + ri * 24
            return (
              <div
                key={`${node.row.sha}-ref-${ri}`}
                onClick={(e) => handleRefClick(e, refName, node.row.sha, px, py)}
                style={{
                  position: 'absolute', left: px, top: py, height: 20,
                  padding: '0 7px', borderRadius: 4,
                  background: isCurrent ? color + '35' : color + '20',
                  border: `1px solid ${isCurrent ? color : color + '60'}`,
                  color, fontSize: 11, fontWeight: 600, lineHeight: '20px',
                  whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
                  transition: 'transform 0.3s ease, opacity 0.3s ease',
                  boxShadow: isCurrent ? `0 0 6px ${color}40` : 'none',
                }}
              >
                {isRemoteRef(refName) ? '☁ ' : isCurrent ? '● ' : '⎇ '}{refName}
              </div>
            )
          })
        )}

        {activePopover && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', left: activePopover.x, top: activePopover.y + 24,
              background: '#313244', border: '1px solid #45475a', borderRadius: 8,
              padding: 4, zIndex: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 140,
            }}
          >
            <div style={{ padding: '4px 10px', fontSize: 11, color: '#6c7086', fontWeight: 600 }}>
              {activePopover.refName}
            </div>
            {!isRemoteRef(activePopover.refName) && (
              <>
                <PopoverButton label="Checkout" onClick={() => handleAction('checkout')} />
                <PopoverButton label="Push" onClick={() => handleAction('push')} />
              </>
            )}
            {isRemoteRef(activePopover.refName) && (
              <PopoverButton label="Fetch" onClick={() => handleAction('fetch')} />
            )}
            <PopoverButton label="Delete" onClick={() => handleAction('delete')} danger />
          </div>
        )}
      </div>

      {/* Time range labels on the right edge */}
      {timeLabels.map((label, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            right: 20,
            top: label.y - 7,
            color: label.isMonth ? '#6c7086' : '#45475a',
            fontSize: label.isMonth ? 11 : 10,
            fontWeight: label.isMonth ? 600 : 400,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          <span style={{
            display: 'inline-block',
            width: label.isMonth ? 16 : 8,
            height: 1,
            background: label.isMonth ? '#585b70' : '#313244',
            verticalAlign: 'middle',
            marginRight: 4,
          }} />
          {label.text}
        </div>
      ))}
      </div>
    </div>
  )
}

function PopoverButton({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block', width: '100%', padding: '6px 10px',
        background: 'none', border: 'none',
        color: danger ? '#f38ba8' : '#cdd6f4',
        fontSize: 12, textAlign: 'left', cursor: 'pointer',
        borderRadius: 4, fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#45475a' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
    >
      {label}
    </button>
  )
}
