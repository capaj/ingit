import { Fragment, useRef, useEffect, useCallback, useState, useMemo, useReducer } from 'react'
import { createPortal } from 'react-dom'
import { animated, to, useSpring } from '@react-spring/web'
import { prepareWithSegments, measureNaturalWidth } from '@chenglou/pretext'
import type { CommitRow, CommitActionKind, RefSummary, WorktreeChangesResponse, WorktreeSummary } from '@ingit/rpc-contract'
import { useAppStore } from '../store'
import { shouldApplyCommitScrollRequest, shouldRequestMoreHistory } from '../history-pagination'
import { predictAppendOnHead, predictRebase, type OptimisticGraph } from '../optimistic-graph'
import { CommitActionButton, RefActionButton } from './graph-canvas/ActionButtons'
import { CommitMessageIcon, findCommitIcon, useCommitIconRules } from './graph-canvas/CommitIcons'
import {
  fitPreviewCamera,
  mergePreviewGutterX,
  stackPreviewChainAboveTarget,
} from './graph-canvas/action-preview-layout'
import { findClearEndpointRail, findOcclusionHookTrack } from './graph-canvas/edge-occlusion'
import { routeUpstreamAroundWorktree } from './graph-canvas/worktree-lane-layout'
import { NativeConfirmDialog, NativeTextInputDialog } from './NativeDialogs'

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
const ADD_REF_BUTTON_SIZE = 24
const ADD_REF_MENU_WIDTH = 112
const GAUGE_RADIUS = NODE_RADIUS - 5
const GAUGE_BACKGROUND_FILL = '#1e1e2e'
const GAUGE_TRACK_STROKE = '#45475a'
const GAUGE_TRACK_STROKE_SELECTED = '#cdd6f455'
const GAUGE_TRACK_FILL_SELECTED = '#cdd6f422'
const GAUGE_ADDITIONS_FILL = '#a6e3a1'
const GAUGE_DELETIONS_FILL = '#f38ba8'
const ACTION_PREVIEW_COLOR = '#a6e3a1'
const GAUGE_MIN_FILL_HEIGHT = 2
const GAUGE_SCALE_PERCENTILE = 0.85
const EDGE_CORNER_RADIUS = 12
const EDGE_SHORT_CURVE_ROWS = 6
const EDGE_RAIL_BASE_OFFSET = NODE_RADIUS + 14
const EDGE_RAIL_STAGGER_STEP = 6
const EDGE_TARGET_JOIN_GAP = 6
const EDGE_VERTICAL_RAIL_CLEARANCE = 3
const GRAPH_LEFT_GUTTER = 120
const GRAPH_RIGHT_GUTTER = 520
const PAD_TOP = 40
const GRAPH_TOP_HEADROOM = NODE_SPACING_Y * 2
const PAD_LEFT = 40
const COMMIT_MESSAGE_GUTTER = 260
const LANE_ORIGIN_X_BASE = PAD_LEFT + GRAPH_LEFT_GUTTER
const GRAPH_SPRING_CONFIG = { mass: 2.1, tension: 180, friction: 28 }
const GRAPH_CAMERA_TRANSITION_MS = 220
const REBASE_PREVIEW_CAMERA_TRANSITION_MS = 900
const GRAPH_CAMERA_TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const REF_PILL_GAP = 6
const REF_PILL_HORIZONTAL_PADDING = 14
const REF_PILL_FONT = '600 11px system-ui, -apple-system, sans-serif'
const GRAPH_ENTER_OFFSET_Y = NODE_SPACING_Y * 0.55
const GRAPH_EXIT_OFFSET_Y = NODE_SPACING_Y * 0.3
const PRIMARY_LANE_HIGHLIGHT_WIDTH = 54
const EDGE_OCCLUSION_GEOMETRY = {
  laneWidth: LANE_WIDTH,
  rowHeight: NODE_SPACING_Y,
  nodeRadius: NODE_RADIUS,
  clearance: 2,
  curveControlRatio: 0.3,
}

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

interface EdgePoint {
  x: number
  y: number
}

interface VisibleCommitAction {
  action: CommitActionKind
  label: string
  tone: 'success' | 'warning' | 'uncommit'
}

interface VisibleRefAction {
  action: 'checkout' | 'push' | 'fetch' | 'delete' | 'move' | 'reset' | 'open-worktree'
  label: string
  tone: 'neutral' | 'warning' | 'danger'
  force?: boolean
  worktreePath?: string
}

interface PendingRefAction extends Omit<VisibleRefAction, 'action' | 'worktreePath'> {
  action: 'checkout' | 'push' | 'fetch' | 'delete' | 'move' | 'reset'
  refName: string
  sha: string
  force: boolean
}

function samePendingRefAction(a: PendingRefAction | null, b: PendingRefAction) {
  return !!a
    && a.action === b.action
    && a.refName === b.refName
    && a.sha === b.sha
    && a.force === b.force
}

type CreateRefKind = 'branch' | 'tag'

interface CreateRefDialogState {
  kind: CreateRefKind
  targetSha: string
}

interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
}

type ActionPreviewState =
  | { kind: 'commit'; action: 'cherry-pick' | 'revert'; sha: string }
  | { kind: 'rebase'; targetRefName: string }

interface ActionPreviewGeometry {
  nodes: Array<{ node: LayoutNode; color: string }>
  edges: Array<{ key: string; path: string; color: string; dashed: boolean }>
  gutterX?: number
}

interface RebaseHoverLock {
  targetRefName: string
  buttonRect: { left: number; top: number; width: number; height: number }
  buttonScale: number
  baseZoom: number
  viewport: { width: number; height: number }
  scroll: { x: number; y: number }
  targetNode: { x: number; y: number }
}

interface ParsedVersionTag {
  major: number
  minor: number
  patch: number
  hasVPrefix: boolean
}

// The server reports a non-fast-forward push rejection as an oRPC CONFLICT error
// (plain Errors are masked as "Internal server error" over the wire).
function isNonFastForwardPushError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'CONFLICT'
}

function checkoutConflictWorktreePath(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const data = (err as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const detail = data as { reason?: unknown; worktreePath?: unknown }
  return detail.reason === 'branch-in-use' && typeof detail.worktreePath === 'string'
    ? detail.worktreePath
    : null
}

function pathBaseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]+/).at(-1) || path
}

function parseVersionTag(name: string): ParsedVersionTag | null {
  const match = /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(name)
  if (!match) return null
  return {
    hasVPrefix: match[1] === 'v',
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  }
}

function compareVersionTags(left: ParsedVersionTag, right: ParsedVersionTag): number {
  return left.major - right.major
    || left.minor - right.minor
    || left.patch - right.patch
    || Number(left.hasVPrefix) - Number(right.hasVPrefix)
}

function nextVersionTagName(refs: RefSummary[]): string {
  let latest: ParsedVersionTag | null = null

  for (const ref of refs) {
    if (ref.kind !== 'tag') continue
    const parsed = parseVersionTag(ref.shortName)
    if (!parsed) continue
    if (!latest || compareVersionTags(parsed, latest) > 0) {
      latest = parsed
    }
  }

  if (!latest) return ''
  const prefix = latest.hasVPrefix ? 'v' : ''
  return `${prefix}${latest.major}.${latest.minor}.${latest.patch + 1}`
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
  linkedWorktrees: WorktreeSummary[]
}

interface DetachedWorktreePlacement {
  worktree: WorktreeSummary
  nodeSha: string
  x: number
  y: number
}

interface VisibleEdgeItem {
  key: string
  fromSha: string
  toSha: string
  path: string
  plan: EdgeRoutePlan
  bundleOffset: number
  targetJoinOffset: number
  targetNodeRadius: number
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

interface WorktreeNodeGeometry {
  kind: 'merge' | 'rebase' | 'worktree'
  x: number
  y: number
  idx: number
  lane: number
  headX: number
  headY: number
  color: string
  count: number
  conflictedCount: number
  targetPlan: EdgeRoutePlan
  sourcePath: string | null
}

interface RenderedEdgeItem {
  key: string
  fromSha: string
  toSha: string
  path: string
  fromPlan: EdgeRoutePlan
  toPlan: EdgeRoutePlan
  fromBundleOffset: number
  toBundleOffset: number
  fromTargetJoinOffset: number
  toTargetJoinOffset: number
  fromTargetNodeRadius: number
  toTargetNodeRadius: number
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
  fromRadius: number
  toRadius: number
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
  targetJoinOffsets: Map<string, number>
  targetNodeRadii: Map<string, number>
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
  | { mode: 'straight'; bundleJoinY?: number }
  | {
    mode: 'curve'
    targetSide?: 'left' | 'right'
    sourceSide?: 'left' | 'right'
  }
  | { mode: 'adjacent-hook'; laneA: number; laneB: number; track: 'from' | 'to' }
  | { mode: 'occlusion-hook'; laneA: number; laneB: number; track: 'from' | 'to' }
  | { mode: 'target-hook'; laneA: number; laneB: number; track: 'from' }
  | { mode: 'inside-rail'; minLane: number; maxLane: number; sourceRailX: number; targetRailX: number; crossoverY: number }
  | {
    mode: 'outer-rail'
    side: 'left' | 'right'
    anchorLane: number
    innerLane: number
    outerRailX: number
    horizontalTargetJoin?: boolean
  }

export function buildLayout(rows: CommitRow[], extraLeftGutter = 0) {
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

function sameParents(left: CommitRow, right: CommitRow) {
  return left.parentShas.length === right.parentShas.length
    && left.parentShas.every((sha, index) => sha === right.parentShas[index])
}

function buildActionPreviewGeometry(
  baseLayout: GraphLayout,
  prediction: OptimisticGraph,
  extraLeftGutter: number,
  preview: ActionPreviewState,
): ActionPreviewGeometry | null {
  const previewLayout = buildLayout(prediction.rows, extraLeftGutter)

  if (preview.kind === 'commit') {
    const newNode = previewLayout.nodes.find((node) => !baseLayout.shaToNode.has(node.row.sha))
    if (!newNode) return null
    const parent = baseLayout.shaToNode.get(newNode.row.parentShas[0])
    if (!parent) return null

    // Keep the existing graph stationary while previewing an appended commit.
    // The real mutation will insert a row and animate everything down; putting
    // the ghost one row above the current graph communicates that result
    // without making the hover itself move live content.
    const topNode = baseLayout.nodes[0] ?? parent
    const ghostNode: LayoutNode = {
      ...newNode,
      x: parent.x,
      y: topNode.y - NODE_SPACING_Y,
      idx: topNode.idx - 1,
    }
    const key = `${ghostNode.row.sha}-${parent.row.sha}`
    const occupied = baseLayout.nodes.map((node) => node.row.lane)
    const plan = planEdgeRoute(ghostNode, parent, key, occupied)

    return {
      nodes: [{ node: ghostNode, color: ACTION_PREVIEW_COLOR }],
      edges: [{
        key,
        path: routedEdgePath(ghostNode, parent, plan, 0),
        color: ACTION_PREVIEW_COLOR,
        dashed: true,
      }],
    }
  }

  const changedTopology = new Set<string>()
  for (const node of previewLayout.nodes) {
    const currentNode = baseLayout.shaToNode.get(node.row.sha)
    if (!currentNode || !sameParents(currentNode.row, node.row)) {
      changedTopology.add(node.row.sha)
    }
  }

  const currentRef = prediction.refs.find((ref) => ref.kind === 'head' && ref.isCurrent)
  const currentChain: LayoutNode[] = []
  const visited = new Set<string>()
  let sha = currentRef?.targetSha
  while (sha && !visited.has(sha)) {
    visited.add(sha)
    const node = previewLayout.shaToNode.get(sha)
    if (!node) break
    currentChain.push(node)
    sha = node.row.parentShas[0]
  }

  const oldestChangedIndex = currentChain.findIndex((node) => changedTopology.has(node.row.sha))
  const affectedNodes = oldestChangedIndex >= 0
    ? currentChain.slice(0, oldestChangedIndex + 1)
    : prediction.headSha
      ? [previewLayout.shaToNode.get(prediction.headSha)].filter((node): node is LayoutNode => !!node)
      : []
  if (affectedNodes.length === 0) return null

  const targetRef = prediction.refs.find((ref) => ref.shortName === preview.targetRefName)
  const targetSha = targetRef?.peeledSha ?? targetRef?.targetSha
  const targetNode = targetSha
    ? baseLayout.shaToNode.get(targetSha) ?? previewLayout.shaToNode.get(targetSha)
    : null
  const laneAlignedNodes = targetNode
    ? affectedNodes.map((node) => ({
        ...node,
        x: targetNode.x,
        row: { ...node.row, lane: targetNode.row.lane },
      }))
    : affectedNodes
  const previewAnchor = targetNode ?? baseLayout.nodes[0]
  if (!previewAnchor) return null

  // Keep the preview local to the operation: the oldest replayed commit sits
  // directly above the target and newer commits continue upward from there.
  // Long chains can still extend beyond the viewport for the camera to fit.
  const alignedNodes = stackPreviewChainAboveTarget(
    laneAlignedNodes,
    previewAnchor,
    NODE_SPACING_Y,
  )
  const affectedShas = new Set(alignedNodes.map((node) => node.row.sha))
  const affectedNodeBySha = new Map(alignedNodes.map((node) => [node.row.sha, node]))
  const occupied = previewLayout.nodes.map((node) => node.row.lane)
  const edges: ActionPreviewGeometry['edges'] = []

  for (const node of alignedNodes) {
    for (let parentIndex = 0; parentIndex < node.row.parentShas.length; parentIndex++) {
      const parentSha = node.row.parentShas[parentIndex]
      // Replayed commits connect within the stacked preview. The unchanged
      // target remains anchored to the live graph so the ghost path visibly
      // reconnects to what is already on screen.
      const parent = affectedShas.has(parentSha)
        ? affectedNodeBySha.get(parentSha)
        : baseLayout.shaToNode.get(parentSha) ?? previewLayout.shaToNode.get(parentSha)
      if (!parent) continue
      const key = `action-preview:${node.row.sha}-${parent.row.sha}`
      const plan = planEdgeRoute(node, parent, key, occupied, {
        adjacentTrack: parentIndex > 0 ? 'to' : 'from',
      })
      edges.push({
        key,
        path: routedEdgePath(node, parent, plan, 0),
        color: ACTION_PREVIEW_COLOR,
        dashed: true,
      })
    }
  }

  return {
    nodes: [
      ...alignedNodes.map((node) => ({ node, color: ACTION_PREVIEW_COLOR })),
    ],
    edges,
    gutterX: targetNode ? targetNode.x - PRIMARY_LANE_HIGHLIGHT_WIDTH / 2 : undefined,
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

export function buildOuterRailPath(
  from: EdgePoint,
  to: EdgePoint,
  outerRailX: number,
  horizontalTargetJoin = false,
  targetJoinOffset = 0,
  targetNodeRadius = NODE_RADIUS,
) {
  const verticalDirection = to.y > from.y ? 1 : -1
  const sourceJoinY = from.y + verticalDirection * (NODE_RADIUS + 8)
  const targetRadius = Math.max(1, targetNodeRadius - 1)
  const usesTargetRail = (
    !horizontalTargetJoin
    && Math.abs(outerRailX - to.x) < 0.001
    && Math.abs(from.x - to.x) > 0.001
  )
  if (usesTargetRail) {
    const sourceSide = from.x < to.x ? -1 : 1
    const sourceVerticalSide = -verticalDirection
    const diagonalRadius = targetRadius * Math.SQRT1_2
    const end = {
      x: to.x + sourceSide * diagonalRadius,
      y: to.y + sourceVerticalSide * diagonalRadius,
    }
    const terminalLength = 18
    const targetLead = {
      x: end.x + sourceSide * terminalLength * Math.SQRT1_2,
      y: end.y + sourceVerticalSide * terminalLength * Math.SQRT1_2,
    }
    const shiftedRailX = targetLead.x
    const shiftedStart = pointOnCircleToward(
      from.x,
      from.y,
      shiftedRailX,
      sourceJoinY,
      NODE_RADIUS - 1,
    )

    return roundedPolylinePath(
      [
        shiftedStart,
        { x: shiftedRailX, y: sourceJoinY },
        targetLead,
        end,
      ],
      Math.min(5, terminalLength / 2),
    )
  }

  const usesSourceRail = (
    Math.abs(outerRailX - from.x) < 0.001
    && Math.abs(from.x - to.x) > 0.001
  )
  let routeRailX = outerRailX
  let sourcePoints: EdgePoint[]
  if (usesSourceRail) {
    const targetSide = to.x < from.x ? -1 : 1
    const sourceRadius = NODE_RADIUS - 1
    const diagonalRadius = sourceRadius * Math.SQRT1_2
    const start = {
      x: from.x + targetSide * diagonalRadius,
      y: from.y + verticalDirection * diagonalRadius,
    }
    const terminalLength = 18
    const sourceLead = {
      x: start.x + targetSide * terminalLength * Math.SQRT1_2,
      y: start.y + verticalDirection * terminalLength * Math.SQRT1_2,
    }
    routeRailX = sourceLead.x
    sourcePoints = [start, sourceLead]
  } else {
    const start = pointOnCircleToward(
      from.x,
      from.y,
      outerRailX,
      sourceJoinY,
      NODE_RADIUS - 1,
    )
    sourcePoints = [start, { x: outerRailX, y: sourceJoinY }]
  }

  const boundedTargetJoinOffset = horizontalTargetJoin
    ? Math.max(-targetRadius, Math.min(targetRadius, targetJoinOffset))
    : targetJoinOffset
  const targetJoinY = horizontalTargetJoin
    ? to.y + boundedTargetJoinOffset
    : to.y - verticalDirection * (NODE_RADIUS + 8)
  const end = horizontalTargetJoin
    ? {
        // Preserve the bundle's Y offset all the way to the node. A generic
        // point-toward calculation would aim from the center to the distant
        // rail, causing parallel hooks to converge and overlap too early.
        x: to.x
          + Math.sign(routeRailX - to.x || 1)
            * Math.sqrt(Math.max(0, targetRadius ** 2 - boundedTargetJoinOffset ** 2)),
        y: targetJoinY,
      }
    : pointOnCircleToward(to.x, to.y, routeRailX, targetJoinY, targetRadius)

  return roundedPolylinePath(
    [
      ...sourcePoints,
      { x: routeRailX, y: targetJoinY },
      end,
    ],
    EDGE_CORNER_RADIUS,
  )
}

export function buildAdjacentHookPath(
  from: EdgePoint,
  to: EdgePoint,
  trackX: number,
  targetJoinOffset = 0,
  targetNodeRadius = NODE_RADIUS,
) {
  const verticalDirection = to.y > from.y ? 1 : -1
  const sourceJoinY = from.y + verticalDirection * (NODE_RADIUS + 8)
  const hasHorizontalTargetJoin = Math.abs(trackX - to.x) > 0.001
  const targetRadius = Math.max(1, targetNodeRadius - 1)
  const usesTargetTrack = (
    !hasHorizontalTargetJoin
    && Math.abs(from.x - to.x) > 0.001
  )
  if (usesTargetTrack) {
    const sourceSide = from.x < to.x ? -1 : 1
    const sourceVerticalSide = -verticalDirection
    const diagonalRadius = targetRadius * Math.SQRT1_2
    const end = {
      x: to.x + sourceSide * diagonalRadius,
      y: to.y + sourceVerticalSide * diagonalRadius,
    }
    const terminalLength = 18
    const targetLead = {
      x: end.x + sourceSide * terminalLength * Math.SQRT1_2,
      y: end.y + sourceVerticalSide * terminalLength * Math.SQRT1_2,
    }
    const shiftedTrackX = targetLead.x
    const shiftedStart = pointOnCircleToward(
      from.x,
      from.y,
      shiftedTrackX,
      sourceJoinY,
      NODE_RADIUS - 1,
    )

    return roundedPolylinePath(
      [
        shiftedStart,
        { x: shiftedTrackX, y: sourceJoinY },
        targetLead,
        end,
      ],
      Math.min(5, terminalLength / 2),
    )
  }

  const usesSourceTrack = (
    Math.abs(trackX - from.x) < 0.001
    && Math.abs(from.x - to.x) > 0.001
  )
  let routeTrackX = trackX
  let sourcePoints: EdgePoint[]
  if (usesSourceTrack) {
    const targetSide = to.x < from.x ? -1 : 1
    const sourceRadius = NODE_RADIUS - 1
    const diagonalRadius = sourceRadius * Math.SQRT1_2
    const start = {
      x: from.x + targetSide * diagonalRadius,
      y: from.y + verticalDirection * diagonalRadius,
    }
    const terminalLength = 18
    const sourceLead = {
      x: start.x + targetSide * terminalLength * Math.SQRT1_2,
      y: start.y + verticalDirection * terminalLength * Math.SQRT1_2,
    }
    routeTrackX = sourceLead.x
    sourcePoints = [start, sourceLead]
  } else {
    const start = pointOnCircleToward(
      from.x,
      from.y,
      trackX,
      to.y,
      NODE_RADIUS - 1,
    )
    sourcePoints = [start, { x: trackX, y: sourceJoinY }]
  }

  const boundedTargetJoinOffset = hasHorizontalTargetJoin
    ? Math.max(-targetRadius, Math.min(targetRadius, targetJoinOffset))
    : 0
  const targetJoinY = to.y + boundedTargetJoinOffset
  const end = hasHorizontalTargetJoin
    ? {
        x: to.x
          + Math.sign(routeTrackX - to.x)
            * Math.sqrt(Math.max(0, targetRadius ** 2 - boundedTargetJoinOffset ** 2)),
        y: targetJoinY,
      }
    : pointOnCircleToward(to.x, to.y, routeTrackX, targetJoinY, targetRadius)

  return roundedPolylinePath(
    [
      ...sourcePoints,
      { x: routeTrackX, y: targetJoinY },
      end,
    ],
    EDGE_CORNER_RADIUS,
  )
}

function buildInsideRailPath(
  from: EdgePoint,
  to: EdgePoint,
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

export function buildStraightEdgePath(
  from: EdgePoint,
  to: EdgePoint,
  bundleOffset = 0,
  targetNodeRadius = NODE_RADIUS,
  bundleJoinY?: number,
) {
  if (Math.abs(from.x - to.x) < 0.001 && Math.abs(bundleOffset) > 0.001) {
    const verticalDirection = to.y > from.y ? 1 : -1
    const sourceRadius = NODE_RADIUS - 1
    const targetRadius = Math.max(1, targetNodeRadius - 1)
    const boundedOffset = Math.max(
      -Math.min(sourceRadius, targetRadius),
      Math.min(Math.min(sourceRadius, targetRadius), bundleOffset),
    )
    const targetInset = Math.sqrt(Math.max(0, targetRadius ** 2 - boundedOffset ** 2))
    const edgeLength = Math.abs(to.y - from.y)
    const requestedJoinDistance = bundleJoinY === undefined
      ? NODE_RADIUS + 18
      : Math.abs(bundleJoinY - from.y)
    const minimumJoinDistance = Math.min(edgeLength / 2, NODE_RADIUS + 18)
    const maximumJoinDistance = Math.max(minimumJoinDistance, edgeLength - targetInset - 8)
    const trackJoinDistance = Math.max(
      minimumJoinDistance,
      Math.min(maximumJoinDistance, requestedJoinDistance),
    )
    const trackJoinY = from.y + verticalDirection * trackJoinDistance
    const sourceJoinY = trackJoinY - verticalDirection * 10
    const end = {
      x: to.x + boundedOffset,
      y: to.y - verticalDirection * targetInset,
    }

    return roundedPolylinePath(
      [
        { x: from.x, y: from.y + verticalDirection * sourceRadius },
        { x: from.x, y: sourceJoinY },
        { x: from.x + boundedOffset, y: trackJoinY },
        end,
      ],
      Math.min(EDGE_CORNER_RADIUS, 6),
    )
  }

  const start = pointOnCircleToward(from.x, from.y, to.x, to.y, NODE_RADIUS - 1)
  const end = pointOnCircleToward(to.x, to.y, from.x, from.y, Math.max(1, targetNodeRadius - 1))
  return `M${start.x},${start.y}L${end.x},${end.y}`
}

export function buildCurvedEdgePath(
  from: EdgePoint,
  to: EdgePoint,
  targetSide?: 'left' | 'right',
  targetNodeRadius = NODE_RADIUS,
  sourceSide?: 'left' | 'right',
) {
  if (targetSide) {
    const targetRadius = Math.max(1, targetNodeRadius - 1)
    const verticalDirection = to.y >= from.y ? 1 : -1
    const sourceRadius = NODE_RADIUS - 1
    const sourceDiagonalRadius = sourceRadius * Math.SQRT1_2
    const start = sourceSide
      ? {
          x: from.x + (sourceSide === 'left' ? -sourceDiagonalRadius : sourceDiagonalRadius),
          y: from.y + verticalDirection * sourceDiagonalRadius,
        }
      : {
          x: from.x,
          y: from.y + verticalDirection * sourceRadius,
        }
    const end = {
      x: to.x + (targetSide === 'left' ? -targetRadius : targetRadius),
      y: to.y,
    }
    // Leave enough radial run at each node for the terminal bends to read
    // clearly, even when the long diagonal is already close to that angle.
    const terminalLength = Math.min(18, Math.hypot(end.x - start.x, end.y - start.y) * 0.2)
    const sourceLead = {
      x: start.x + (
        sourceSide === 'left'
          ? -terminalLength * Math.SQRT1_2
          : sourceSide === 'right'
            ? terminalLength * Math.SQRT1_2
            : 0
      ),
      y: start.y + verticalDirection * (
        sourceSide ? terminalLength * Math.SQRT1_2 : terminalLength
      ),
    }
    const targetLead = {
      x: end.x + (targetSide === 'left' ? -terminalLength : terminalLength),
      y: end.y,
    }

    return roundedPolylinePath(
      [start, sourceLead, targetLead, end],
      Math.min(5, terminalLength / 2),
    )
  }

  const start = pointOnCircleToward(from.x, from.y, to.x, to.y, NODE_RADIUS - 1)
  const end = pointOnCircleToward(to.x, to.y, from.x, from.y, NODE_RADIUS - 1)
  return edgePath(start.x, start.y, end.x, end.y)
}

function planEdgeRoute(
  from: LayoutNode,
  to: LayoutNode,
  edgeKey: string,
  occupiedLanes: number[],
  opts: {
    adjacentTrack?: 'from' | 'to'
    additionalOccupiedLanes?: ReadonlyMap<number, readonly number[]>
  } = {},
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
      track: opts.adjacentTrack ?? 'from',
    }
  }

  if (rowDelta < EDGE_SHORT_CURVE_ROWS) {
    const preferredTrack = opts.adjacentTrack ?? 'from'
    const occlusionTrack = findOcclusionHookTrack(
      { x: from.x, y: from.y, idx: from.idx, lane: from.row.lane },
      { x: to.x, y: to.y, idx: to.idx, lane: to.row.lane },
      occupiedLanes,
      EDGE_OCCLUSION_GEOMETRY,
      preferredTrack,
      opts.additionalOccupiedLanes,
    )
    if (occlusionTrack) {
      return {
        mode: 'occlusion-hook',
        laneA: Math.min(from.row.lane, to.row.lane),
        laneB: Math.max(from.row.lane, to.row.lane),
        track: occlusionTrack,
      }
    }
    return { mode: 'curve' }
  }

  const preferredTrack = opts.adjacentTrack ?? 'from'
  const fromRouteNode = { x: from.x, y: from.y, idx: from.idx, lane: from.row.lane }
  const toRouteNode = { x: to.x, y: to.y, idx: to.idx, lane: to.row.lane }

  // Lane ordering reserves the complete source rail for first-parent edges and
  // the complete target rail for merge edges. Prefer that guaranteed-clear
  // endpoint gutter: it produces one vertical rail and one horizontal join,
  // instead of zig-zagging between two interior rails.
  const endpointRail = findClearEndpointRail(
    fromRouteNode,
    toRouteNode,
    occupiedLanes,
    preferredTrack,
    opts.additionalOccupiedLanes,
  )
  if (endpointRail) {
    return {
      mode: 'outer-rail',
      ...endpointRail,
      horizontalTargetJoin: true,
    }
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

function edgeBundleKey(edge: VisibleEdge, plan: EdgeRoutePlan): string | null {
  const railKey = (x: number) => `vertical:${Math.round(x * 1000) / 1000}`
  switch (plan.mode) {
    case 'straight':
      return railKey(edge.from.x)
    case 'outer-rail':
      return railKey(plan.outerRailX)
    case 'inside-rail':
      return `${plan.mode}:${plan.minLane}:${plan.maxLane}`
    case 'adjacent-hook':
    case 'occlusion-hook':
    case 'target-hook':
      return railKey(plan.track === 'to' ? edge.to.x : edge.from.x)
    default:
      return null
  }
}

function routedEdgePath(
  from: EdgePoint,
  to: EdgePoint,
  plan: EdgeRoutePlan,
  bundleOffset: number,
  targetJoinOffset = 0,
  targetNodeRadius = NODE_RADIUS,
): string {
  switch (plan.mode) {
    case 'straight':
      return buildStraightEdgePath(from, to, bundleOffset, targetNodeRadius, plan.bundleJoinY)
    case 'curve':
      return buildCurvedEdgePath(
        from,
        to,
        plan.targetSide,
        targetNodeRadius,
        plan.sourceSide,
      )
    case 'adjacent-hook':
    case 'occlusion-hook':
    case 'target-hook':
      return buildAdjacentHookPath(
        from,
        to,
        (plan.track === 'to' ? to.x : from.x) + bundleOffset,
        targetJoinOffset,
        targetNodeRadius,
      )
    case 'inside-rail':
      return buildInsideRailPath(
        from,
        to,
        plan.sourceRailX + bundleOffset,
        plan.targetRailX + bundleOffset,
        plan.crossoverY,
      )
    case 'outer-rail':
      return buildOuterRailPath(
        from,
        to,
        plan.outerRailX + bundleOffset,
        plan.horizontalTargetJoin,
        targetJoinOffset,
        targetNodeRadius,
      )
  }
}

function lerpEdgeRoutePlan(fromPlan: EdgeRoutePlan, toPlan: EdgeRoutePlan, progress: number): EdgeRoutePlan {
  if (fromPlan.mode !== toPlan.mode) return progress < 0.5 ? fromPlan : toPlan

  switch (toPlan.mode) {
    case 'straight': {
      const fromStraight = fromPlan as Extract<EdgeRoutePlan, { mode: 'straight' }>
      return {
        mode: 'straight',
        bundleJoinY: fromStraight.bundleJoinY === undefined
          ? toPlan.bundleJoinY
          : toPlan.bundleJoinY === undefined
            ? fromStraight.bundleJoinY
            : lerp(fromStraight.bundleJoinY, toPlan.bundleJoinY, progress),
      }
    }
    case 'curve':
      return toPlan
    case 'adjacent-hook':
    case 'occlusion-hook':
    case 'target-hook':
      return toPlan
    case 'inside-rail': {
      const fromInside = fromPlan as Extract<EdgeRoutePlan, { mode: 'inside-rail' }>
      return {
        ...toPlan,
        sourceRailX: lerp(fromInside.sourceRailX, toPlan.sourceRailX, progress),
        targetRailX: lerp(fromInside.targetRailX, toPlan.targetRailX, progress),
        crossoverY: lerp(fromInside.crossoverY, toPlan.crossoverY, progress),
      }
    }
    case 'outer-rail': {
      const fromOuter = fromPlan as Extract<EdgeRoutePlan, { mode: 'outer-rail' }>
      return {
        ...toPlan,
        outerRailX: lerp(fromOuter.outerRailX, toPlan.outerRailX, progress),
      }
    }
  }
}

function buildAnimatedRoutedEdgePath(edge: RenderedEdgeItem, progress: number) {
  const fromNode = {
    x: lerp(edge.fromX1, edge.toX1, progress),
    y: lerp(edge.fromY1, edge.toY1, progress),
  }
  const toNode = {
    x: lerp(edge.fromX2, edge.toX2, progress),
    y: lerp(edge.fromY2, edge.toY2, progress),
  }
  const plan = lerpEdgeRoutePlan(edge.fromPlan, edge.toPlan, progress)
  const bundleOffset = lerp(edge.fromBundleOffset, edge.toBundleOffset, progress)
  const targetJoinOffset = lerp(edge.fromTargetJoinOffset, edge.toTargetJoinOffset, progress)
  const targetNodeRadius = lerp(edge.fromTargetNodeRadius, edge.toTargetNodeRadius, progress)
  return routedEdgePath(fromNode, toNode, plan, bundleOffset, targetJoinOffset, targetNodeRadius)
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

function linkedWorktreeSuffix(worktrees: WorktreeSummary[]) {
  return worktrees.map((worktree) => `  ▣ ${pathBaseName(worktree.path)}`).join('')
}

function estimateRefPillWidth(
  refName: string,
  isRemote: boolean,
  isCurrent: boolean,
  linkedWorktrees: WorktreeSummary[],
) {
  const text = refBadgePrefix(isRemote, isCurrent) + refName + linkedWorktreeSuffix(linkedWorktrees)
  return REF_PILL_HORIZONTAL_PADDING + Math.ceil(measureRefPillText(text))
}

function buildRefPlacements(
  nodes: LayoutNode[],
  currentBranch: string | null,
  selectedRefName: string | null,
  shaToColor: Map<string, string>,
  worktrees: WorktreeSummary[],
  nodeRadii?: ReadonlyMap<string, number>,
) {
  const placements: RefPlacement[] = []
  const rowWidths = new Map<string, number>()

  for (const node of nodes) {
    const baseX = node.x + (nodeRadii?.get(node.row.sha) ?? NODE_RADIUS) + 8
    const y = node.y - 10
    let cursorX = baseX

    for (const refName of node.row.refNames) {
      const isCurrent = currentBranch !== null && refName === currentBranch
      const isRemote = isRemoteRef(refName)
      const linkedWorktrees = worktrees.filter(
        (worktree) => !worktree.isCurrent
          && !worktree.bare
          && !worktree.prunable
          && worktree.branchShortName === refName,
      )
      placements.push({
        refName,
        nodeSha: node.row.sha,
        x: cursorX,
        y,
        color: shaToColor.get(node.row.sha) ?? laneColor(node.row.lane),
        isCurrent,
        isSelected: refName === selectedRefName,
        isRemote,
        linkedWorktrees,
      })
      cursorX += estimateRefPillWidth(refName, isRemote, isCurrent, linkedWorktrees) + REF_PILL_GAP
    }

    rowWidths.set(
      node.row.sha,
      node.row.refNames.length > 0 ? cursorX - baseX - REF_PILL_GAP : 0,
    )
  }

  return { placements, rowWidths }
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

export function buildVisibleWindow(layout: GraphLayout, firstIdx: number, lastIdx: number) {
  const visibleNodes = layout.nodes.slice(firstIdx, lastIdx + 1)
  const visibleEdges: VisibleEdge[] = []

  for (const node of layout.nodes) {
    for (let parentIndex = 0; parentIndex < node.row.parentShas.length; parentIndex++) {
      const parentSha = node.row.parentShas[parentIndex]
      const loadedParent = layout.shaToNode.get(parentSha)
      // A parent beyond the loaded history prefix is still a real edge. Keep
      // its rail running through the bottom of the loaded graph instead of
      // making the child look like an unrelated root. Once pagination loads
      // the parent, this synthetic endpoint is replaced by the real node while
      // retaining the same edge key.
      const parent: LayoutNode = loadedParent ?? {
        row: {
          ...node.row,
          sha: parentSha,
          parentShas: [],
          refNames: [],
        },
        x: node.x,
        y: layout.totalHeight,
        idx: layout.nodes.length,
      }
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

    keys.add(`${node.row.sha}-${firstParentSha}`)
    const parent = layout.shaToNode.get(firstParentSha)
    if (!parent) break

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

function countConflictedWorktreeFiles(changes: WorktreeChangesResponse): number {
  return new Set(changes.unstaged.filter((file) => file.status === 'U').map((file) => file.path)).size
}

interface TargetJoinCandidate {
  key: string
  targetKey: string
  side: 'left' | 'right'
  railX: number
}

interface VerticalRailCandidate {
  key: string
  railKey: string
  topIdx: number
  bottomIdx: number
  bundleOrder?: number
  railStartY?: number
  strokeWidth?: number
}

function verticalRailCandidatesConflict(
  left: VerticalRailCandidate,
  right: VerticalRailCandidate,
): boolean {
  const overlapStart = Math.max(left.topIdx, right.topIdx)
  const overlapEnd = Math.min(left.bottomIdx, right.bottomIdx)
  // Rails that merely meet at a node approach it from opposite vertical
  // halves. The node hides their attachment transition, so the outgoing rail
  // can recenter immediately instead of inheriting an incoming bundle offset.
  return overlapStart < overlapEnd
}

export function buildVerticalBundleOffsets(
  candidates: VerticalRailCandidate[],
  clearance = EDGE_VERTICAL_RAIL_CLEARANCE,
): Map<string, number> {
  const groups = new Map<string, VerticalRailCandidate[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.railKey)
    if (group) group.push(candidate)
    else groups.set(candidate.railKey, [candidate])
  }

  const offsets = new Map<string, number>()
  for (const group of groups.values()) {
    group.sort((left, right) => (
      left.topIdx - right.topIdx
      || left.bottomIdx - right.bottomIdx
      || left.key.localeCompare(right.key)
    ))

    // Keep unrelated time ranges centered in their gutter. Only candidates
    // connected by a real overlap (or by competing for the same node) need to
    // participate in one bundle; otherwise one busy merge could shift a rail
    // thousands of rows away from the intersection.
    const roots = group.map((_, index) => index)
    const findRoot = (index: number): number => {
      if (roots[index] === index) return index
      roots[index] = findRoot(roots[index])
      return roots[index]
    }
    const union = (left: number, right: number) => {
      const leftRoot = findRoot(left)
      const rightRoot = findRoot(right)
      if (leftRoot !== rightRoot) roots[rightRoot] = leftRoot
    }

    for (let left = 0; left < group.length; left++) {
      for (let right = left + 1; right < group.length; right++) {
        if (group[right].topIdx > group[left].bottomIdx) break
        if (verticalRailCandidatesConflict(group[left], group[right])) union(left, right)
      }
    }

    const components = new Map<number, VerticalRailCandidate[]>()
    for (let index = 0; index < group.length; index++) {
      const root = findRoot(index)
      const component = components.get(root)
      if (component) component.push(group[index])
      else components.set(root, [group[index]])
    }

    for (const component of components.values()) {
      const orderedComponent = [...component].sort((left, right) => (
        (left.bundleOrder ?? 0) - (right.bundleOrder ?? 0)
        || left.topIdx - right.topIdx
        || left.bottomIdx - right.bottomIdx
        || left.key.localeCompare(right.key)
      ))
      const slots: VerticalRailCandidate[][] = []
      const slotWidths: number[] = []
      const assignments: Array<{ key: string; slot: number }> = []
      for (const candidate of orderedComponent) {
        let slot = slots.findIndex((assigned) => (
          assigned.every((previous) => !verticalRailCandidatesConflict(previous, candidate))
        ))
        if (slot < 0) {
          slot = slots.length
          slots.push([])
        }
        slots[slot].push(candidate)
        slotWidths[slot] = Math.max(slotWidths[slot] ?? 0, candidate.strokeWidth ?? 3)
        assignments.push({ key: candidate.key, slot })
      }

      const slotPositions = [0]
      for (let slot = 1; slot < slotWidths.length; slot++) {
        slotPositions[slot] = slotPositions[slot - 1]
          + slotWidths[slot - 1] / 2
          + clearance
          + slotWidths[slot] / 2
      }
      const middleSlot = Math.floor(slotPositions.length / 2)
      const anchor = slotPositions.length % 2 === 1
        ? slotPositions[middleSlot]
        : (slotPositions[middleSlot - 1] + slotPositions[middleSlot]) / 2

      for (const assignment of assignments) {
        offsets.set(assignment.key, slotPositions[assignment.slot] - anchor)
      }
    }
  }

  return offsets
}

export function buildTargetJoinOffsets(
  candidates: TargetJoinCandidate[],
  gap = EDGE_TARGET_JOIN_GAP,
): Map<string, number> {
  const groups = new Map<string, TargetJoinCandidate[]>()

  for (const candidate of candidates) {
    const groupKey = `${candidate.targetKey}:${candidate.side}`
    const group = groups.get(groupKey)
    if (group) group.push(candidate)
    else groups.set(groupKey, [candidate])
  }

  const offsets = new Map<string, number>()
  for (const candidatesInGroup of groups.values()) {
    candidatesInGroup.sort((left, right) => {
      const railOrder = left.side === 'right'
        ? left.railX - right.railX
        : right.railX - left.railX
      return railOrder || left.key.localeCompare(right.key)
    })

    const middle = (candidatesInGroup.length - 1) / 2
    for (let index = 0; index < candidatesInGroup.length; index++) {
      offsets.set(candidatesInGroup[index].key, (index - middle) * gap)
    }
  }

  return offsets
}

export function buildTargetNodeRadii(
  candidates: TargetJoinCandidate[],
  gap = EDGE_TARGET_JOIN_GAP,
): Map<string, number> {
  const counts = new Map<string, { targetKey: string; count: number }>()
  for (const candidate of candidates) {
    const groupKey = `${candidate.targetKey}:${candidate.side}`
    const group = counts.get(groupKey)
    if (group) group.count++
    else counts.set(groupKey, { targetKey: candidate.targetKey, count: 1 })
  }

  const radii = new Map<string, number>()
  for (const { targetKey, count } of counts.values()) {
    if (count < 5) continue
    const radius = NODE_RADIUS + Math.ceil((count - 4) * gap / 2)
    radii.set(targetKey, Math.max(radii.get(targetKey) ?? NODE_RADIUS, radius))
  }
  return radii
}

function targetJoinRailX(
  edge: VisibleEdge,
  plan: EdgeRoutePlan | undefined,
  bundleOffset = 0,
): number | null {
  if (plan?.mode === 'outer-rail' && plan.horizontalTargetJoin) {
    return plan.outerRailX + bundleOffset
  }
  if (
    plan?.mode === 'adjacent-hook'
    || plan?.mode === 'occlusion-hook'
    || plan?.mode === 'target-hook'
  ) {
    return (plan.track === 'to' ? edge.to.x : edge.from.x) + bundleOffset
  }
  return null
}

export function buildEdgeRoutingData(
  visibleEdges: VisibleEdge[],
  occupiedLanes: number[],
  additionalOccupiedLanes?: ReadonlyMap<number, readonly number[]>,
): EdgeRoutingData {
  const plans = new Map<string, EdgeRoutePlan>()

  for (const edge of visibleEdges) {
    const plan = planEdgeRoute(edge.from, edge.to, edge.key, occupiedLanes, {
      adjacentTrack: edge.isMerge ? 'to' : 'from',
      additionalOccupiedLanes,
    })
    plans.set(edge.key, plan)
  }

  // Align clear short curves when a horizontal hook already enters the same
  // side, or when multiple curves would otherwise converge on one attachment
  // point. Keeping the complete same-side group in one hook bundle prevents
  // both occlusion and crossings near the target.
  const alignedTargetSides = new Set<string>()
  const curveTargetSideCounts = new Map<string, number>()
  for (const edge of visibleEdges) {
    const railX = targetJoinRailX(edge, plans.get(edge.key))
    if (railX === null || Math.abs(railX - edge.to.x) < 0.001) continue
    const side = railX < edge.to.x ? 'left' : 'right'
    alignedTargetSides.add(`${edge.to.row.sha}:${side}`)
  }
  for (const edge of visibleEdges) {
    if (plans.get(edge.key)?.mode !== 'curve') continue
    const side = edge.from.x < edge.to.x ? 'left' : edge.from.x > edge.to.x ? 'right' : null
    if (!side) continue
    const groupKey = `${edge.to.row.sha}:${side}`
    curveTargetSideCounts.set(groupKey, (curveTargetSideCounts.get(groupKey) ?? 0) + 1)
  }
  for (const [groupKey, count] of curveTargetSideCounts) {
    if (count > 1) alignedTargetSides.add(groupKey)
  }

  for (const edge of visibleEdges) {
    if (plans.get(edge.key)?.mode !== 'curve') continue
    const side = edge.from.x < edge.to.x ? 'left' : edge.from.x > edge.to.x ? 'right' : null
    if (!side || !alignedTargetSides.has(`${edge.to.row.sha}:${side}`)) continue

    const endpointRail = findClearEndpointRail(
      { x: edge.from.x, y: edge.from.y, idx: edge.from.idx, lane: edge.from.row.lane },
      { x: edge.to.x, y: edge.to.y, idx: edge.to.idx, lane: edge.to.row.lane },
      occupiedLanes,
      'from',
      additionalOccupiedLanes,
    )
    if (!endpointRail || endpointRail.side !== side) continue

    plans.set(edge.key, {
      mode: 'target-hook',
      laneA: Math.min(edge.from.row.lane, edge.to.row.lane),
      laneB: Math.max(edge.from.row.lane, edge.to.row.lane),
      track: 'from',
    })
  }

  const verticalRailCandidates = visibleEdges.flatMap((edge) => {
    const plan = plans.get(edge.key)
    if (!plan) return []
    const railKey = edgeBundleKey(edge, plan)
    if (!railKey) return []
    return [{
      key: edge.key,
      railKey,
      topIdx: Math.min(edge.from.idx, edge.to.idx),
      bottomIdx: Math.max(edge.from.idx, edge.to.idx),
      // Keep the first-parent continuation to the left and incoming merge
      // rails to the right, independent of which interval starts first.
      bundleOrder: edge.isMerge ? 1 : 0,
      railStartY: Math.min(edge.from.y, edge.to.y) + NODE_RADIUS + 8,
      strokeWidth: edge.isMerge ? 2 : 4.5,
    }]
  })
  const bundleOffsets = buildVerticalBundleOffsets(verticalRailCandidates)

  for (const candidate of verticalRailCandidates) {
    const plan = plans.get(candidate.key)
    if (plan?.mode !== 'straight' || Math.abs(bundleOffsets.get(candidate.key) ?? 0) < 0.001) continue

    const firstCompetingRail = verticalRailCandidates
      .filter((other) => (
        other.key !== candidate.key
        && other.railKey === candidate.railKey
        && other.topIdx > candidate.topIdx
        && other.topIdx < candidate.bottomIdx
        && verticalRailCandidatesConflict(candidate, other)
      ))
      .sort((left, right) => left.topIdx - right.topIdx || left.key.localeCompare(right.key))[0]
    if (firstCompetingRail?.railStartY === undefined) continue

    plans.set(candidate.key, {
      mode: 'straight',
      // Complete the jog just before the competing line reaches this gutter.
      bundleJoinY: firstCompetingRail.railStartY - 8,
    })
  }

  const bundledIncomingByTarget = new Map<string, string[]>()
  const targetsWithCenteredContinuation = new Set<string>()
  for (const edge of visibleEdges) {
    const plan = plans.get(edge.key)
    if (
      plan?.mode === 'straight'
      && edge.from.idx < edge.to.idx
      && Math.abs(edge.from.x - edge.to.x) < 0.001
    ) {
      targetsWithCenteredContinuation.add(edge.from.row.sha)
    }
    if (edge.from.idx >= edge.to.idx || !edgeBundleKey(edge, plan ?? { mode: 'curve' })) continue
    const incoming = bundledIncomingByTarget.get(edge.to.row.sha)
    if (incoming) incoming.push(edge.key)
    else bundledIncomingByTarget.set(edge.to.row.sha, [edge.key])
  }

  for (const edge of visibleEdges) {
    const plan = plans.get(edge.key)
    if (plan?.mode !== 'curve' || Math.abs(edge.from.x - edge.to.x) < 0.001) continue
    const incoming = bundledIncomingByTarget.get(edge.to.row.sha) ?? []
    const hasBusyIncomingBundle = (
      incoming.length < 2
      ? false
      : incoming.some((key) => Math.abs(bundleOffsets.get(key) ?? 0) > 0.001)
    )
    if (
      !hasBusyIncomingBundle
      && !targetsWithCenteredContinuation.has(edge.to.row.sha)
    ) continue

    plans.set(edge.key, {
      mode: 'curve',
      // Enter through the free side of the target instead of crossing the
      // centered continuation or parallel rails attached to the commit.
      targetSide: edge.from.x < edge.to.x ? 'left' : 'right',
      // If this commit's main continuation already leaves vertically in the
      // same direction, peel the side edge away at 45 degrees immediately.
      ...(targetsWithCenteredContinuation.has(edge.from.row.sha)
        ? { sourceSide: edge.to.x < edge.from.x ? 'left' as const : 'right' as const }
        : {}),
    })
  }

  const targetJoinCandidates = visibleEdges.flatMap((edge) => {
    const plan = plans.get(edge.key)
    const bundleOffset = bundleOffsets.get(edge.key) ?? 0
    const railX = targetJoinRailX(edge, plan, bundleOffset)
    if (railX === null || Math.abs(railX - edge.to.x) < 0.001) return []

    return [{
      key: edge.key,
      targetKey: edge.to.row.sha,
      side: railX < edge.to.x ? 'left' as const : 'right' as const,
      railX,
    }]
  })
  const targetJoinOffsets = buildTargetJoinOffsets(targetJoinCandidates)
  const targetNodeRadii = buildTargetNodeRadii(targetJoinCandidates)

  return { plans, bundleOffsets, targetJoinOffsets, targetNodeRadii }
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
    const plan = edgeRouting.plans.get(edge.key) ?? planEdgeRoute(edge.from, edge.to, edge.key, occupiedLanes, {
      adjacentTrack: edge.isMerge ? 'to' : 'from',
    })
    const bundleOffset = edgeRouting.bundleOffsets.get(edge.key) ?? 0
    const targetJoinOffset = edgeRouting.targetJoinOffsets.get(edge.key) ?? 0
    const targetNodeRadius = edgeRouting.targetNodeRadii.get(edge.to.row.sha) ?? NODE_RADIUS
    // An edge takes the color of the branch line it travels along: the child for
    // a normal edge, the merged-in parent for a merge edge.
    const colorNode = edge.isMerge ? edge.to : edge.from
    return {
      key: edge.key,
      fromSha: edge.from.row.sha,
      toSha: edge.to.row.sha,
      path: routedEdgePath(edge.from, edge.to, plan, bundleOffset, targetJoinOffset, targetNodeRadius),
      plan,
      bundleOffset,
      targetJoinOffset,
      targetNodeRadius,
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
  const commitIconRules = useCommitIconRules()
  const histWindow = useAppStore((state) => state.historyWindow)
  const refs = useAppStore((state) => state.refs)
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
  const pendingCheckout = useAppStore((state) => state.pendingCheckout)
  const graphAnimationSuppressToken = useAppStore((state) => state.graphAnimationSuppressToken)
  const showCommitMessages = useAppStore((state) => state.showCommitMessages)
  const showGutterColors = useAppStore((state) => state.showGutterColors)
  const showError = useAppStore((state) => state.showError)
  const commitCIStatus = useAppStore((state) => state.commitCIStatus)
  const fetchCommitCIStatusesIfNeeded = useAppStore((state) => state.fetchCommitCIStatusesIfNeeded)
  const worktreeChanges = useAppStore((state) => state.worktreeChanges)
  const worktrees = useAppStore((state) => state.worktrees)
  const worktreeSelected = useAppStore((state) => state.worktreeSelected)
  const selectWorktree = useAppStore((state) => state.selectWorktree)
  const openRepoByPath = useAppStore((state) => state.openRepoByPath)
  const [pendingRefAction, setPendingRefAction] = useState<PendingRefAction | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const timeLabelsLayerRef = useRef<HTMLDivElement>(null)
  const commitLabelsLayerRef = useRef<HTMLDivElement>(null)
  const viewportMetricsRef = useRef({ scrollTop: 0, clientHeight: 0 })
  const lastObservedScrollTopRef = useRef(0)
  const graphAnimationStartFrameRef = useRef<number | null>(null)
  const scrollTopFrameRef = useRef<number | null>(null)
  const retainedWorktreeNodeRef = useRef<WorktreeNodeGeometry | null>(null)
  const worktreeMotionInitializedRef = useRef(false)
  const addRefHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingScrollTopRef = useRef(0)
  const [zoom, setZoom] = useState(1)
  const [scrollTop, setScrollTop] = useState(0)
  const [clientHeight, setClientHeight] = useState(0)
  const [graphAnimation, setGraphAnimation] = useState<GraphAnimationSnapshot | null>(null)
  const graphAnimationRef = useRef<GraphAnimationSnapshot | null>(null)
  const [mergePreviewVisible, setMergePreviewVisible] = useState(false)
  const [actionPreview, setActionPreview] = useState<ActionPreviewState | null>(null)
  const [rebaseHoverLock, setRebaseHoverLock] = useState<RebaseHoverLock | null>(null)
  const [rebaseCameraTransitionActive, setRebaseCameraTransitionActive] = useState(false)
  const [hoveredAddRefSha, setHoveredAddRefSha] = useState<string | null>(null)
  const [openAddRefSha, setOpenAddRefSha] = useState<string | null>(null)
  const [createRefDialog, setCreateRefDialog] = useState<CreateRefDialogState | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [{ graphProgress }, graphProgressApi] = useSpring(() => ({
    graphProgress: 1,
    config: GRAPH_SPRING_CONFIG,
  }))
  const zoomRef = useRef(1)
  const suppressAutoScrollUntilRef = useRef(0)
  const lastAppliedCommitScrollKeyRef = useRef<number | null>(null)
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

  const currentBranch = useMemo(() => {
    const current = refs.find((ref) => ref.isCurrent)
    return current?.shortName ?? null
  }, [refs])

  const worktreeChangeCount = worktreeChanges
    ? worktreeChanges.staged.length + worktreeChanges.unstaged.length
    : 0
  const renderedRows = useMemo(() => {
    if (!histWindow) return null
    return worktreeChangeCount > 0
      ? routeUpstreamAroundWorktree(histWindow.rows, currentBranch)
      : histWindow.rows
  }, [histWindow, currentBranch, worktreeChangeCount])

  const layout = useMemo(() => {
    if (!renderedRows || renderedRows.length === 0) return null
    return buildLayout(renderedRows, showCommitMessages ? COMMIT_MESSAGE_GUTTER : 0)
  }, [renderedRows, showCommitMessages])

  const refMap = useMemo(
    () => new Map(refs.map((ref) => [ref.shortName, ref])),
    [refs],
  )

  const worktreesByBranch = useMemo(() => {
    const result = new Map<string, WorktreeSummary[]>()
    for (const worktree of worktrees) {
      if (!worktree.branchShortName || worktree.bare || worktree.prunable) continue
      const existing = result.get(worktree.branchShortName) ?? []
      existing.push(worktree)
      result.set(worktree.branchShortName, existing)
    }
    return result
  }, [worktrees])

  const selectedRef = useMemo(
    () => (selectedRefName ? refMap.get(selectedRefName) ?? null : null),
    [refMap, selectedRefName],
  )

  const selectedRefWorktree = useMemo(() => {
    if (!selectedRef) return null
    if (selectedRef.kind === 'head') {
      return worktreesByBranch.get(selectedRef.shortName)?.find((worktree) => !worktree.isCurrent) ?? null
    }
    if (selectedRef.kind === 'remote') {
      const trackingBranch = refs.find(
        (ref) => ref.kind === 'head' && ref.upstream === selectedRef.name,
      )
      return trackingBranch
        ? worktreesByBranch.get(trackingBranch.shortName)?.find((worktree) => !worktree.isCurrent) ?? null
        : null
    }
    return null
  }, [selectedRef, refs, worktreesByBranch])

  const defaultNextTagName = useMemo(
    () => nextVersionTagName(refs),
    [refs],
  )

  const actionPreviewPrediction = useMemo(() => {
    if (!actionPreview || !histWindow) return null
    if (actionPreview.kind === 'rebase') {
      return predictRebase(histWindow.rows, refs, actionPreview.targetRefName)
    }

    const original = histWindow.rows.find((row) => row.sha === actionPreview.sha)
    if (!original) return null
    const subject = actionPreview.action === 'revert'
      ? `Revert "${original.subject}"`
      : original.subject
    return predictAppendOnHead(histWindow.rows, refs, subject, actionPreview.action)
  }, [actionPreview, histWindow, refs])

  const actionPreviewGeometry = useMemo(() => {
    if (!layout || !actionPreview || !actionPreviewPrediction) return null
    return buildActionPreviewGeometry(
      layout,
      actionPreviewPrediction,
      showCommitMessages ? COMMIT_MESSAGE_GUTTER : 0,
      actionPreview,
    )
  }, [layout, actionPreview, actionPreviewPrediction, showCommitMessages])

  const rebasePreviewCamera = useMemo(() => {
    if (
      actionPreview?.kind !== 'rebase'
      || !rebaseHoverLock
      || rebaseHoverLock.targetRefName !== actionPreview.targetRefName
      || !actionPreviewGeometry
      || actionPreviewGeometry.nodes.length === 0
    ) return null

    const halo = NODE_RADIUS * 2
    const previewNodes = [
      ...actionPreviewGeometry.nodes.map(({ node }) => node),
      rebaseHoverLock.targetNode,
    ]
    return fitPreviewCamera({
      baseZoom: rebaseHoverLock.baseZoom,
      bounds: {
        minX: Math.min(...previewNodes.map((node) => node.x)) - halo,
        minY: Math.min(...previewNodes.map((node) => node.y)) - halo,
        maxX: Math.max(...previewNodes.map((node) => node.x)) + halo,
        maxY: Math.max(...previewNodes.map((node) => node.y)) + halo,
      },
      viewport: rebaseHoverLock.viewport,
      scroll: rebaseHoverLock.scroll,
      margin: 12,
    })
  }, [actionPreview, actionPreviewGeometry, rebaseHoverLock])

  const renderedZoom = rebasePreviewCamera?.zoom ?? zoom
  const graphTranslateX = rebasePreviewCamera?.translateX ?? 0
  const graphTranslateY = rebasePreviewCamera?.translateY ?? 0
  const cameraTransition = `${rebaseCameraTransitionActive
    ? REBASE_PREVIEW_CAMERA_TRANSITION_MS
    : GRAPH_CAMERA_TRANSITION_MS}ms ${GRAPH_CAMERA_TRANSITION_EASING}`

  // The working-tree / in-progress operation node floats one row above HEAD,
  // in HEAD's lane. Merge conflicts also draw a dashed second-parent edge.
  const worktreeNode = useMemo<WorktreeNodeGeometry | null>(() => {
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
    const targetPlan = planEdgeRoute(pendingNode, headNode, targetKey, occupied)
    const sourceSha = worktreeChanges.mergeHeadShas?.[0]
    const sourceNode = sourceSha ? layout.shaToNode.get(sourceSha) ?? null : null
    const sourcePath = sourceNode
      ? routedEdgePath(
          pendingNode,
          sourceNode,
          planEdgeRoute(pendingNode, sourceNode, `${pendingNode.row.sha}-${sourceNode.row.sha}`, occupied, { adjacentTrack: 'to' }),
          0,
        )
      : null
    return {
      kind: operation,
      x: pendingNode.x,
      y: pendingNode.y,
      idx: pendingNode.idx,
      lane: pendingNode.row.lane,
      headX: headNode.x,
      headY: headNode.y,
      color,
      count,
      conflictedCount,
      targetPlan,
      sourcePath,
    }
  }, [layout, worktreeChanges, currentBranch])

  const renderedWorktreeNode = worktreeNode
    ?? (pendingCheckout ? retainedWorktreeNodeRef.current : null)
  const shouldInitializeWorktreeMotion = !!renderedWorktreeNode
    && !worktreeMotionInitializedRef.current
  const {
    worktreeX,
    worktreeY,
    worktreeHeadX,
    worktreeHeadY,
    worktreeOpacity,
  } = useSpring({
    worktreeX: renderedWorktreeNode?.x ?? 0,
    worktreeY: renderedWorktreeNode?.y ?? 0,
    worktreeHeadX: renderedWorktreeNode?.headX ?? 0,
    worktreeHeadY: renderedWorktreeNode?.headY ?? 0,
    worktreeOpacity: renderedWorktreeNode
      ? pendingCheckout ? 0.5 : 1
      : 0,
    immediate: (key) => key !== 'worktreeOpacity' && shouldInitializeWorktreeMotion,
    config: (key) => key === 'worktreeOpacity'
      ? { mass: 1, tension: 210, friction: 26, clamp: true }
      : GRAPH_SPRING_CONFIG,
  })

  useEffect(() => {
    if (worktreeNode) retainedWorktreeNodeRef.current = worktreeNode
    else if (!pendingCheckout) retainedWorktreeNodeRef.current = null

    if (renderedWorktreeNode) worktreeMotionInitializedRef.current = true
    else if (!pendingCheckout) worktreeMotionInitializedRef.current = false
  }, [worktreeNode, renderedWorktreeNode, pendingCheckout])

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

  const clearAddRefHoverTimer = useCallback(() => {
    if (addRefHoverTimeoutRef.current === null) return
    clearTimeout(addRefHoverTimeoutRef.current)
    addRefHoverTimeoutRef.current = null
  }, [])

  const showAddRefControls = useCallback((sha: string) => {
    clearAddRefHoverTimer()
    setHoveredAddRefSha(sha)
  }, [clearAddRefHoverTimer])

  const scheduleHideAddRefControls = useCallback((sha: string) => {
    clearAddRefHoverTimer()
    addRefHoverTimeoutRef.current = setTimeout(() => {
      setHoveredAddRefSha((current) => current === sha ? null : current)
      addRefHoverTimeoutRef.current = null
    }, 120)
  }, [clearAddRefHoverTimer])

  useEffect(() => {
    setMergePreviewVisible(false)
    setActionPreview(null)
    setRebaseHoverLock(null)
    setOpenAddRefSha(null)
  }, [selectedRefName, selectedSha])

  // Keep the slower timing in place while the graph returns from a rebase
  // preview. Dropping it together with the hover lock would make the return
  // transition use the normal, much faster camera duration.
  useEffect(() => {
    if (rebaseHoverLock || !rebaseCameraTransitionActive) return
    const timeout = window.setTimeout(
      () => setRebaseCameraTransitionActive(false),
      REBASE_PREVIEW_CAMERA_TRANSITION_MS,
    )
    return () => window.clearTimeout(timeout)
  }, [rebaseHoverLock, rebaseCameraTransitionActive])

  useEffect(() => () => {
    clearAddRefHoverTimer()
  }, [clearAddRefHoverTimer])

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

  const additionalOccupiedLanes = useMemo<ReadonlyMap<number, readonly number[]> | undefined>(
    () => renderedWorktreeNode
      ? new Map([[renderedWorktreeNode.idx, [renderedWorktreeNode.lane]]])
      : undefined,
    [renderedWorktreeNode],
  )

  const gutterBackgrounds = useMemo(() => {
    if (!layout || !showGutterColors) return []
    const xByLane = new Map<number, number>()
    for (const node of layout.nodes) xByLane.set(node.row.lane, node.x)
    return [...xByLane]
      .sort(([leftLane], [rightLane]) => leftLane - rightLane)
      .map(([lane, x]) => ({ lane, x, color: laneColor(lane) }))
  }, [layout, showGutterColors])

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

  // Apply each explicit commit-focus request once. Layout changes also rerun
  // this effect so a not-yet-loaded target can become available, but pagination
  // must not replay an old request and pull the user away from their position.
  useEffect(() => {
    if (!scrollToSha || !layout || !scrollRef.current) return
    if (Date.now() < suppressAutoScrollUntilRef.current) return
    const node = layout.shaToNode.get(scrollToSha)
    if (!shouldApplyCommitScrollRequest(
      lastAppliedCommitScrollKeyRef.current,
      scrollToKey,
      !!node,
    ) || !node) return
    lastAppliedCommitScrollKeyRef.current = scrollToKey
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

      // Start fetching the next page halfway through the loaded history so it
      // is normally ready before the user reaches the end.
      if (histWindow && histWindow.hasMoreAfter && layout) {
        const loadedContentHeight = layout.totalHeight * zoomRef.current
        if (shouldRequestMoreHistory(el.scrollTop, el.clientHeight, loadedContentHeight)) {
          void requestMore('down')
        }
      }
    }

    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(() => check())
    ro.observe(el)
    check()
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
    () => buildEdgeRoutingData(visibleEdges, occupiedLanes, additionalOccupiedLanes),
    [visibleEdges, occupiedLanes, additionalOccupiedLanes],
  )

  const { placements: visibleRefPlacements, rowWidths: refRowWidths } = useMemo(
    () => buildRefPlacements(
      visibleNodes,
      currentBranch,
      selectedRefName,
      layout?.shaToColor ?? EMPTY_SHA_COLOR,
      worktrees,
      edgeRouting.targetNodeRadii,
    ),
    [visibleNodes, currentBranch, selectedRefName, layout, worktrees, edgeRouting],
  )

  const { detachedWorktreePlacements, rowWidths: rowRefWidths } = useMemo(() => {
    const placements: DetachedWorktreePlacement[] = []
    const rowWidths = new Map(refRowWidths)
    const detachedBySha = new Map<string, WorktreeSummary[]>()

    for (const worktree of worktrees) {
      if (!worktree.detached || !worktree.headSha || worktree.bare || worktree.prunable) continue
      const existing = detachedBySha.get(worktree.headSha) ?? []
      existing.push(worktree)
      detachedBySha.set(worktree.headSha, existing)
    }

    for (const node of visibleNodes) {
      const detached = detachedBySha.get(node.row.sha) ?? []
      if (detached.length === 0) continue
      const baseX = node.x + (edgeRouting.targetNodeRadii.get(node.row.sha) ?? NODE_RADIUS) + 8
      let width = rowWidths.get(node.row.sha) ?? 0
      let cursorX = baseX + width + (width > 0 ? REF_PILL_GAP : 0)

      for (const worktree of detached) {
        const text = `▣ ${pathBaseName(worktree.path)}`
        placements.push({ worktree, nodeSha: node.row.sha, x: cursorX, y: node.y - 10 })
        const chipWidth = REF_PILL_HORIZONTAL_PADDING + Math.ceil(measureRefPillText(text))
        width = cursorX - baseX + chipWidth
        cursorX += chipWidth + REF_PILL_GAP
      }
      rowWidths.set(node.row.sha, width)
    }

    return { detachedWorktreePlacements: placements, rowWidths }
  }, [visibleNodes, refRowWidths, worktrees, edgeRouting])

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
      worktrees,
      fromRouting.targetNodeRadii,
    ).placements
    const toRefPlacements = buildRefPlacements(
      toWindow.visibleNodes,
      graphAnimation.toCurrentBranch,
      selectedRefName,
      graphAnimation.toLayout.shaToColor,
      worktrees,
      toRouting.targetNodeRadii,
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
            fromRadius: fromNode
              ? fromRouting.targetNodeRadii.get(key) ?? NODE_RADIUS
              : toRouting.targetNodeRadii.get(key) ?? NODE_RADIUS,
            toRadius: toNode
              ? toRouting.targetNodeRadii.get(key) ?? NODE_RADIUS
              : fromRouting.targetNodeRadii.get(key) ?? NODE_RADIUS,
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

        // When an edge enters or exits but its endpoint commits survive, keep
        // it attached to those commits as they move. This is especially
        // important for rebase, where one parent edge exits while another
        // enters; offsetting either whole edge leaves a rail floating in space.
        const enteringFromNode = toEdge
          ? graphAnimation.fromLayout.shaToNode.get(toEdge.fromSha)
          : undefined
        const enteringToNode = toEdge
          ? graphAnimation.fromLayout.shaToNode.get(toEdge.toSha)
          : undefined
        const exitingFromNode = fromEdge
          ? graphAnimation.toLayout.shaToNode.get(fromEdge.fromSha)
          : undefined
        const exitingToNode = fromEdge
          ? graphAnimation.toLayout.shaToNode.get(fromEdge.toSha)
          : undefined

        const sortY = Math.min(toEdge?.y1 ?? fromEdge?.y1 ?? 0, toEdge?.y2 ?? fromEdge?.y2 ?? 0)
        return {
          sortY,
          item: {
            key,
            fromSha: displayEdge.fromSha,
            toSha: displayEdge.toSha,
            path: toEdge?.path ?? fromEdge?.path ?? '',
            fromPlan: fromEdge?.plan ?? toEdge?.plan ?? { mode: 'curve' },
            toPlan: toEdge?.plan ?? fromEdge?.plan ?? { mode: 'curve' },
            fromBundleOffset: fromEdge?.bundleOffset ?? toEdge?.bundleOffset ?? 0,
            toBundleOffset: toEdge?.bundleOffset ?? fromEdge?.bundleOffset ?? 0,
            fromTargetJoinOffset: fromEdge?.targetJoinOffset ?? toEdge?.targetJoinOffset ?? 0,
            toTargetJoinOffset: toEdge?.targetJoinOffset ?? fromEdge?.targetJoinOffset ?? 0,
            fromTargetNodeRadius: fromEdge?.targetNodeRadius ?? toEdge?.targetNodeRadius ?? NODE_RADIUS,
            toTargetNodeRadius: toEdge?.targetNodeRadius ?? fromEdge?.targetNodeRadius ?? NODE_RADIUS,
            stroke: toEdge?.stroke ?? fromEdge?.stroke ?? '#cdd6f4',
            fromStrokeWidth: fromEdge?.strokeWidth ?? displayEdge.strokeWidth,
            toStrokeWidth: toEdge?.strokeWidth ?? displayEdge.strokeWidth,
            fromOpacity: fromEdge?.opacity ?? 0,
            toOpacity: toEdge?.opacity ?? 0,
            fromX1: fromEdge?.x1 ?? enteringFromNode?.x ?? displayEdge.x1,
            fromY1: fromEdge?.y1 ?? enteringFromNode?.y ?? displayEdge.y1 + GRAPH_ENTER_OFFSET_Y,
            fromX2: fromEdge?.x2 ?? enteringToNode?.x ?? displayEdge.x2,
            fromY2: fromEdge?.y2 ?? enteringToNode?.y ?? displayEdge.y2 + GRAPH_ENTER_OFFSET_Y,
            toX1: toEdge?.x1 ?? exitingFromNode?.x ?? displayEdge.x1,
            toY1: toEdge?.y1 ?? exitingFromNode?.y ?? displayEdge.y1 - GRAPH_EXIT_OFFSET_Y,
            toX2: toEdge?.x2 ?? exitingToNode?.x ?? displayEdge.x2,
            toY2: toEdge?.y2 ?? exitingToNode?.y ?? displayEdge.y2 - GRAPH_EXIT_OFFSET_Y,
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
  }, [graphAnimation, selectedRefName, zoom, worktrees])

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
      fromRadius: edgeRouting.targetNodeRadii.get(node.row.sha) ?? NODE_RADIUS,
      toRadius: edgeRouting.targetNodeRadii.get(node.row.sha) ?? NODE_RADIUS,
    })),
    [graphAnimationRenderData, visibleNodes, layout],
  )

  const renderedEdgeItems = useMemo(
    () => graphAnimationRenderData?.edges ?? visibleEdgeItems.map((edge) => ({
      key: edge.key,
      fromSha: edge.fromSha,
      toSha: edge.toSha,
      path: edge.path,
      fromPlan: edge.plan,
      toPlan: edge.plan,
      fromBundleOffset: edge.bundleOffset,
      toBundleOffset: edge.bundleOffset,
      fromTargetJoinOffset: edge.targetJoinOffset,
      toTargetJoinOffset: edge.targetJoinOffset,
      fromTargetNodeRadius: edge.targetNodeRadius,
      toTargetNodeRadius: edge.targetNodeRadius,
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
    if (actionPreviewGeometry?.gutterX !== undefined) {
      return {
        key: 'action-preview-gutter',
        color: ACTION_PREVIEW_COLOR,
        fromX: actionPreviewGeometry.gutterX,
        toX: actionPreviewGeometry.gutterX,
        fromOpacity: 1,
        toOpacity: 1,
      } satisfies RenderedLaneHighlight
    }
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
  }, [actionPreviewGeometry, graphAnimationRenderData, currentLaneHighlight])

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

      if (selectedRefWorktree) {
        return [
          {
            action: 'open-worktree' as const,
            label: 'Open worktree',
            tone: 'neutral' as const,
            worktreePath: selectedRefWorktree.path,
          },
          ...(canPushSelectedRef ? [pushAction] : []),
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
        ...(selectedRefWorktree
          ? [{
              action: 'open-worktree' as const,
              label: 'Open worktree',
              tone: 'neutral' as const,
              worktreePath: selectedRefWorktree.path,
            }]
          : [{ action: 'checkout' as const, label: 'Checkout', tone: 'neutral' as const }]),
        { action: 'delete' as const, label: 'Delete', tone: 'danger' as const },
      ]
    }

    return [
      { action: 'push' as const, label: 'Push', tone: 'neutral' as const },
    ]
  }, [selectedRef, selectedRefWorktree, canPushSelectedRef, canResetSelectedRef])

  const movableBranchRefName = useMemo(() => {
    if (!selectedRef || selectedRef.kind !== 'head' || selectedRef.isCurrent || selectedRefWorktree) return null
    return selectedRef.shortName
  }, [selectedRef, selectedRefWorktree])

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
    const sourceSide = sourceNode.x < previewNode.x ? 'left' : 'right'
    const sourceGutterX = mergePreviewGutterX(
      layout.nodes,
      previewNode.idx,
      sourceNode.idx,
      LANE_WIDTH,
      sourceSide,
    )
    const sourceGutterNode = layout.nodes.find((node) => node.x === sourceGutterX)
    const sourceGutterSide = sourceGutterX !== null
      && sourceGutterX < Math.min(previewNode.x, sourceNode.x)
      ? 'left'
      : 'right'
    const sourcePlan: EdgeRoutePlan = sourceGutterX === null
      ? planEdgeRoute(previewNode, sourceNode, sourceKey, occupiedLanes, { adjacentTrack: 'to' })
      : {
          mode: 'outer-rail',
          side: sourceGutterSide,
          anchorLane: sourceGutterNode?.row.lane
            ?? (sourceGutterSide === 'left'
              ? Math.min(...occupiedLanes) - 1
              : Math.max(...occupiedLanes) + 1),
          innerLane: sourceGutterSide === 'left'
            ? Math.max(previewNode.row.lane, sourceNode.row.lane)
            : Math.min(previewNode.row.lane, sourceNode.row.lane),
          outerRailX: sourceGutterX,
        }

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
    setActionPreview(null)
    setRebaseHoverLock(null)
    selectGraphRef(refName)
  }, [selectGraphRef])

  const runRefAction = useCallback((pendingAction: PendingRefAction) => {
    setPendingRefAction(pendingAction)
    return performRefAction(pendingAction.action, pendingAction.refName, pendingAction.sha, pendingAction.force)
      .finally(() => {
        setPendingRefAction((current) => samePendingRefAction(current, pendingAction) ? null : current)
      })
  }, [performRefAction])

  const handleRefActionClick = useCallback((refAction: VisibleRefAction) => {
    if (!selectedRefName || !selectedRef) return
    if (pendingMutation) return
    setMergePreviewVisible(false)
    if (refAction.action === 'open-worktree') {
      if (refAction.worktreePath) void openRepoByPath(refAction.worktreePath)
      return
    }
    const gitAction: PendingRefAction['action'] = refAction.action
    const sha = selectedRef.targetSha
    const refName = selectedRefName
    const pendingAction: PendingRefAction = {
      action: gitAction,
      label: refAction.label,
      tone: refAction.tone,
      refName,
      sha,
      force: !!refAction.force,
    }
    runRefAction(pendingAction).catch((err) => {
      if (refAction.action === 'push' && !refAction.force && isNonFastForwardPushError(err)) {
        // Remote rejected the push because our branch isn't a fast-forward
        // (diverged / rewritten history). Offer to force-push instead.
        showError('Push rejected', err, {
          label: 'Force push',
          run: () => {
            runRefAction({
              action: 'push',
              label: 'Force push',
              tone: 'warning',
              force: true,
              refName,
              sha,
            }).catch((e) => showError('Force push failed', e))
          },
        })
      } else {
        const worktreePath = refAction.action === 'checkout'
          ? checkoutConflictWorktreePath(err)
          : null
        if (worktreePath) {
          showError('Branch is already checked out', err, {
            label: 'Open worktree',
            run: () => { void openRepoByPath(worktreePath) },
          })
          return
        }
        showError(`${refAction.action} failed`, err)
      }
    })
  }, [selectedRefName, selectedRef, runRefAction, showError, pendingMutation, openRepoByPath])

  const handleMoveBranch = useCallback((targetSha: string) => {
    if (!movableBranchRefName) return
    if (pendingMutation) return
    setConfirmDialog({
      title: 'Move branch',
      message: `Move branch ${movableBranchRefName} to commit ${targetSha.slice(0, 8)}?`,
      confirmLabel: 'Move',
      onConfirm: () => {
        setMergePreviewVisible(false)
        performRefAction('move', movableBranchRefName, targetSha).catch((err) => {
          showError('Move failed', err)
        })
      },
    })
  }, [movableBranchRefName, performRefAction, showError, pendingMutation])

  const handleCreateRef = useCallback((kind: CreateRefKind, targetSha: string) => {
    if (pendingMutation) return
    setMergePreviewVisible(false)
    setOpenAddRefSha(null)
    setHoveredAddRefSha(null)
    setCreateRefDialog({ kind, targetSha })
  }, [pendingMutation])

  const handleCreateRefSubmit = useCallback((name: string) => {
    if (!createRefDialog) return

    const { kind, targetSha } = createRefDialog
    setCreateRefDialog(null)
    performRefAction(kind === 'branch' ? 'create' : 'create-tag', name, targetSha).catch((err) => {
      showError(`Create ${kind} failed`, err)
    })
  }, [createRefDialog, performRefAction, showError])

  const closeCreateRefDialog = useCallback(() => setCreateRefDialog(null), [])

  const createRefNameLabel = createRefDialog?.kind === 'branch' ? 'Branch name' : 'Tag name'
  const createRefTitle = createRefDialog
    ? `Create ${createRefDialog.kind} at ${createRefDialog.targetSha.slice(0, 8)}`
    : 'Create ref'
  const createRefInitialName = createRefDialog?.kind === 'tag' ? defaultNextTagName : ''

  const handleMergeHoverStart = useCallback(() => {
    if (!selectedRefName) return
    setActionPreview(null)
    setRebaseHoverLock(null)
    setMergePreviewVisible(true)
    if (!mergePreview || mergePreview.sourceRefName !== selectedRefName) {
      void ensureMergePreview(selectedRefName)
    }
  }, [selectedRefName, mergePreview, ensureMergePreview])

  const handleMergeHoverEnd = useCallback(() => {
    setMergePreviewVisible(false)
  }, [])

  const handleCommitActionHoverStart = useCallback((action: CommitActionKind, sha: string) => {
    if (action === 'uncommit') return
    setMergePreviewVisible(false)
    setRebaseHoverLock(null)
    setActionPreview({ kind: 'commit', action, sha })
  }, [])

  const handleRebaseHoverStart = useCallback((
    targetRefName: string,
    targetNode: LayoutNode,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    const viewport = scrollRef.current
    if (!viewport) return

    const buttonRect = event.currentTarget.getBoundingClientRect()
    const baseZoom = zoomRef.current

    setMergePreviewVisible(false)
    setRebaseCameraTransitionActive(true)
    setRebaseHoverLock({
      targetRefName,
      buttonRect: {
        left: buttonRect.left,
        top: buttonRect.top,
        width: buttonRect.width,
        height: buttonRect.height,
      },
      buttonScale: buttonRect.height / COMMIT_ACTION_HEIGHT,
      baseZoom,
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      scroll: { x: viewport.scrollLeft, y: viewport.scrollTop },
      targetNode: { x: targetNode.x, y: targetNode.y },
    })
    setActionPreview({ kind: 'rebase', targetRefName })
  }, [])

  const handleActionPreviewEnd = useCallback(() => {
    setActionPreview(null)
    setRebaseHoverLock(null)
  }, [])

  const handleRebaseHoverEnd = useCallback(() => {
    setActionPreview((current) => current?.kind === 'rebase' ? null : current)
    setRebaseHoverLock(null)
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

  const runRebase = useCallback((targetRefName: string) => {
    setMergePreviewVisible(false)
    setActionPreview(null)
    setRebaseHoverLock(null)
    performRebaseRef(targetRefName).catch((err) => {
      showError('Rebase failed', err)
    })
  }, [performRebaseRef, showError])

  const handleRebaseClick = useCallback((targetRefName: string) => {
    if (!selectedCurrentBranchRef) return
    if (pendingMutation) return
    runRebase(targetRefName)
  }, [selectedCurrentBranchRef, runRebase, pendingMutation])

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
      const tipScreenY = node.y * renderedZoom + graphTranslateY
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
      const labelLeft = label.x * renderedZoom + graphTranslateX - 4
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
  }, [layout, visibleNodes, renderedZoom, graphTranslateX, graphTranslateY])

  const timeLabels = useMemo(
    () => (layout
      ? computeTimeLabels(layout.nodes, renderedZoom).map((label) => ({
          ...label,
          y: label.y + graphTranslateY,
        }))
      : []),
    [layout, renderedZoom, graphTranslateY],
  )

  const topTimeLabel = useMemo(() => {
    if (!layout) return null
    const node = findTopVisibleNode(
      layout.nodes,
      Math.max(0, scrollTop - graphTranslateY),
      renderedZoom,
    )
    if (!node) return null
    const date = new Date(node.row.committerUnix * 1000)
    return formatTopTimeLabel(date, renderedZoom)
  }, [layout, scrollTop, renderedZoom, graphTranslateY])

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
        y: node.y * renderedZoom + graphTranslateY,
        text: node.row.subject,
      }))
  }, [layout, currentBranchShas, renderedZoom, graphTranslateY, showCommitMessages])

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

    setActionPreview(null)
    setRebaseHoverLock(null)
    if (action === 'cherry-pick') {
      performCommitAction(action, selectedNode.row.sha).catch((err) => {
        showError(`${action} failed`, err)
      })
      return
    }

    const shortSha = selectedNode.row.sha.slice(0, 8)
    const title = action === 'uncommit'
      ? 'Uncommit'
      : 'Revert commit'
    const message = action === 'uncommit'
      ? `Uncommit ${shortSha}? This will move HEAD to its parent and keep the changes in your working tree.`
      : `Revert commit ${shortSha} on the current branch?`
    const confirmLabel = action === 'uncommit'
      ? 'Uncommit'
      : 'Revert'

    setConfirmDialog({
      title,
      message,
      confirmLabel,
      onConfirm: () => {
        performCommitAction(action, selectedNode.row.sha).catch((err) => {
          showError(`${action} failed`, err)
        })
      },
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

  const fullWidth = layout.totalWidth
  // The scroll range represents loaded rows only. It grows as pages arrive,
  // preventing the scrollbar from jumping into unloaded blank history.
  const fullHeight = layout.totalHeight
  const scaledW = fullWidth * zoom
  const scaledH = fullHeight * zoom
  const worktreeConflictBadgeWidth = renderedWorktreeNode
    ? Math.max(22, String(renderedWorktreeNode.conflictedCount).length * 7 + 14)
    : 0
  const worktreeLabel = renderedWorktreeNode?.kind === 'merge'
    ? renderedWorktreeNode.conflictedCount > 0 ? 'Merge conflicts' : 'Merge in progress'
    : renderedWorktreeNode?.kind === 'rebase'
      ? renderedWorktreeNode.conflictedCount > 0 ? 'Rebase conflicts' : 'Rebase in progress'
      : 'Uncommitted changes'
  const worktreeTitle = renderedWorktreeNode?.kind === 'worktree'
    ? `Uncommitted changes — ${renderedWorktreeNode.count} file${renderedWorktreeNode.count === 1 ? '' : 's'}\nClick to stage / unstage`
    : `${worktreeLabel} — ${renderedWorktreeNode?.conflictedCount ?? 0} conflict${renderedWorktreeNode?.conflictedCount === 1 ? '' : 's'}\nClick to review files`

  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, height: '100%', overflow: 'auto', position: 'relative', background: '#1e1e2e', touchAction: 'pan-x pan-y' }}
      onClick={() => {
        setMergePreviewVisible(false)
        setActionPreview(null)
        setRebaseHoverLock(null)
        setOpenAddRefSha(null)
        setHoveredAddRefSha(null)
        clearAddRefHoverTimer()
        clearGraphRefSelection()
      }}
    >
      <NativeTextInputDialog
        open={!!createRefDialog}
        title={createRefTitle}
        label={createRefNameLabel}
        initialValue={createRefInitialName}
        confirmLabel="Create"
        onSubmit={handleCreateRefSubmit}
        onClose={closeCreateRefDialog}
      />
      <NativeConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel={confirmDialog?.confirmLabel ?? 'Confirm'}
        onConfirm={() => {
          const run = confirmDialog?.onConfirm
          setConfirmDialog(null)
          run?.()
        }}
        onClose={() => setConfirmDialog(null)}
      />

      {rebaseHoverLock && createPortal(
        <div
          style={{
            position: 'fixed',
            left: rebaseHoverLock.buttonRect.left,
            top: rebaseHoverLock.buttonRect.top,
            width: rebaseHoverLock.buttonRect.width,
            height: rebaseHoverLock.buttonRect.height,
            zIndex: 10_000,
            pointerEvents: 'auto',
          }}
        >
          <div style={{
            width: rebaseHoverLock.buttonRect.width / rebaseHoverLock.buttonScale,
            height: rebaseHoverLock.buttonRect.height / rebaseHoverLock.buttonScale,
            transform: `scale(${rebaseHoverLock.buttonScale})`,
            transformOrigin: 'top left',
          }}>
            <CommitActionButton
              label="Rebase"
              tone="success"
              onClick={() => handleRebaseClick(rebaseHoverLock.targetRefName)}
              onMouseLeave={handleRebaseHoverEnd}
            />
          </div>
        </div>,
        document.body,
      )}

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
              left: label.x * renderedZoom + graphTranslateX - 4,
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
              transform: `scale(${Math.min(renderedZoom, 1)})`,
              transformOrigin: 'top left',
              transition: `left ${cameraTransition}, transform ${cameraTransition}`,
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
          {renderedWorktreeNode && renderedWorktreeNode.y * renderedZoom + graphTranslateY - scrollTop > 28 && (
            <animated.div
              style={{
                position: 'absolute',
                left: 20,
                top: to(
                  worktreeY,
                  (y) => y * renderedZoom + graphTranslateY - 7,
                ),
                opacity: worktreeOpacity,
                maxWidth: (LANE_ORIGIN_X_BASE + COMMIT_MESSAGE_GUTTER - 40) * renderedZoom,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: worktreeSelected ? renderedWorktreeNode.color : '#a6adc8',
                fontSize: 12,
                fontWeight: 600,
                pointerEvents: 'none',
                userSelect: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                transition: `max-width ${cameraTransition}`,
              }}
            >
              <span style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: renderedWorktreeNode.color,
                flexShrink: 0,
              }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {worktreeLabel}
              </span>
            </animated.div>
          )}
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
                  maxWidth: (LANE_ORIGIN_X_BASE + COMMIT_MESSAGE_GUTTER - 40) * renderedZoom,
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
                  transition: `top ${cameraTransition}, max-width ${cameraTransition}`,
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
                transition: `top ${cameraTransition}`,
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
        transform: `translate(${graphTranslateX}px, ${graphTranslateY}px) scale(${renderedZoom})`,
        transformOrigin: 'top left',
        transition: `transform ${cameraTransition}`,
        willChange: rebaseHoverLock ? 'transform' : undefined,
      }}>
        <svg
          width={fullWidth}
          height={fullHeight}
          style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, pointerEvents: 'none', overflow: 'visible' }}
        >
          {gutterBackgrounds.map((gutter) => (
            <rect
              key={`gutter-${gutter.lane}`}
              x={gutter.x - LANE_WIDTH / 2 + 2}
              y={0}
              width={LANE_WIDTH - 4}
              height={fullHeight}
              rx={16}
              fill={`${gutter.color}16`}
              stroke={`${gutter.color}24`}
              strokeWidth={1}
            />
          ))}
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
                    return buildAnimatedRoutedEdgePath(edge, progress)
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
          {actionPreviewGeometry?.edges.map((edge) => (
            <path
              key={edge.key}
              d={edge.path}
              stroke={edge.color}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={edge.dashed ? '7 6' : undefined}
              opacity={0.9}
            />
          ))}
        </svg>

        {/* Nodes sit above ref pills; edges and gutter rails stay below them. */}
        <svg
          width={fullWidth}
          height={fullHeight}
          style={{ position: 'absolute', top: 0, left: 0, zIndex: 30, pointerEvents: 'none', overflow: 'visible' }}
        >
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
            const commitIcon = findCommitIcon(row.subject, commitIconRules)
            const nodeX = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromX, node.toX, progress))
              : node.toX
            const nodeY = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromY, node.toY, progress))
              : node.toY
            const nodeOpacity = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromOpacity, node.toOpacity, progress))
              : node.toOpacity
            const nodeRadius = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromRadius, node.toRadius, progress))
              : node.toRadius
            const nodeHaloRadius = isGraphAnimating
              ? to(graphProgress, (progress) => lerp(node.fromRadius, node.toRadius, progress) * 2.5)
              : node.toRadius * 2.5
            const iconTransform = isGraphAnimating
              ? to(
                  graphProgress,
                  (progress) => `translate(${lerp(node.fromX, node.toX, progress)} ${lerp(node.fromY, node.toY, progress)})`,
                )
              : `translate(${node.toX} ${node.toY})`
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
                key={node.key}
                onClick={node.interactive ? (e) => { e.stopPropagation(); selectCommit(row.sha) } : undefined}
                onPointerEnter={node.interactive ? () => showAddRefControls(row.sha) : undefined}
                onPointerLeave={node.interactive ? () => scheduleHideAddRefControls(row.sha) : undefined}
                opacity={nodeOpacity}
                style={{ cursor: node.interactive ? 'pointer' : 'default', pointerEvents: node.interactive ? 'auto' : 'none' }}
              >
                <title>{`${row.subject}${commitIcon ? `\n${commitIcon.label} commit` : ''}\n+${row.additions} / -${row.deletions} (${row.locChanged} LOC changed)`}</title>
                {selected && (
                  <animated.circle
                    cx={nodeX}
                    cy={nodeY}
                    r={nodeHaloRadius}
                    fill={color}
                    opacity={0.15}
                  />
                )}
                <animated.circle
                  cx={nodeX}
                  cy={nodeY}
                  r={nodeRadius}
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
                {!commitIcon && row.parentShas.length > 1 && (
                  <animated.circle
                    cx={nodeX}
                    cy={nodeY}
                    r={2}
                    fill={color}
                  />
                )}
                {commitIcon && (
                  <>
                    <animated.circle
                      cx={nodeX}
                      cy={nodeY}
                      r={7.4}
                      fill={NODE_FILL}
                      opacity={0.9}
                    />
                    <animated.g transform={iconTransform}>
                      <CommitMessageIcon icon={commitIcon.icon} color={color} customSvg={commitIcon.customSvg} />
                    </animated.g>
                  </>
                )}
              </animated.g>
            )
          })}
          {actionPreviewGeometry?.nodes.map(({ node, color }) => (
            <g key={`action-preview:${node.row.sha}`}>
              <circle
                cx={node.x}
                cy={node.y}
                r={NODE_RADIUS * 1.9}
                fill={color}
                opacity={0.12}
              />
              <circle
                cx={node.x}
                cy={node.y}
                r={NODE_RADIUS}
                fill={NODE_FILL}
                stroke={color}
                strokeWidth={3}
                strokeDasharray="6 4"
              />
              <circle cx={node.x} cy={node.y} r={2.5} fill={color} />
            </g>
          ))}
          {renderedWorktreeNode && (
            <animated.g
              onClick={(e) => { e.stopPropagation(); selectWorktree() }}
              opacity={worktreeOpacity}
              style={{ cursor: 'pointer', pointerEvents: 'auto' }}
            >
              <title>{worktreeTitle}</title>
              {renderedWorktreeNode.sourcePath && (
                <path
                  d={renderedWorktreeNode.sourcePath}
                  stroke={renderedWorktreeNode.color}
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  strokeDasharray="3 5"
                  fill="none"
                  opacity={0.55}
                />
              )}
              <animated.path
                d={to(
                  [worktreeX, worktreeY, worktreeHeadX, worktreeHeadY],
                  (x, y, headX, headY) => routedEdgePath(
                    { x, y },
                    { x: headX, y: headY },
                    renderedWorktreeNode.targetPlan,
                    0,
                  ),
                )}
                stroke={renderedWorktreeNode.color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray="3 5"
                fill="none"
                opacity={0.7}
              />
              {worktreeSelected && (
                <animated.circle
                  cx={worktreeX}
                  cy={worktreeY}
                  r={NODE_RADIUS * 2.5}
                  fill={renderedWorktreeNode.color}
                  opacity={0.15}
                />
              )}
              <animated.circle
                cx={worktreeX}
                cy={worktreeY}
                r={NODE_RADIUS}
                fill={NODE_FILL}
                stroke={renderedWorktreeNode.color}
                strokeWidth={worktreeSelected ? 3.5 : 2.75}
                strokeDasharray="4 3"
              />
              {renderedWorktreeNode.kind === 'worktree' ? (
                <animated.text
                  x={worktreeX}
                  y={worktreeY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={700}
                  fill={renderedWorktreeNode.color}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {renderedWorktreeNode.count}
                </animated.text>
              ) : (
                <>
                  <animated.circle cx={worktreeX} cy={worktreeY} r={2.5} fill={renderedWorktreeNode.color} />
                  {renderedWorktreeNode.conflictedCount > 0 && (
                    <g style={{ pointerEvents: 'none', userSelect: 'none' }}>
                      <animated.rect
                        x={to(worktreeX, (x) => x + NODE_RADIUS + 6)}
                        y={to(worktreeY, (y) => y - 10)}
                        width={worktreeConflictBadgeWidth}
                        height={20}
                        rx={10}
                        fill="#fab38722"
                        stroke="#fab387"
                        strokeWidth={1.4}
                      />
                      <animated.text
                        x={to(
                          worktreeX,
                          (x) => x + NODE_RADIUS + 6 + worktreeConflictBadgeWidth / 2,
                        )}
                        y={worktreeY}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={11}
                        fontWeight={800}
                        fill="#fab387"
                      >
                        {renderedWorktreeNode.conflictedCount}
                      </animated.text>
                    </g>
                  )}
                </>
              )}
            </animated.g>
          )}
        </svg>

        {renderedRefItems.map((refItem) => {
          const { placement } = refItem
          const isEmphasized = placement.isSelected || placement.isCurrent
          const pillTint = placement.isSelected
            ? placement.color + '35'
            : placement.isCurrent
              ? placement.color + '2a'
              : placement.color + '18'
          const pillShadow = [
            'inset 0 1px 0 rgba(255, 255, 255, 0.14)',
            `inset 0 -1px 0 ${placement.color}18`,
            isEmphasized ? `0 0 8px ${placement.color}38` : '0 2px 5px rgba(0, 0, 0, 0.18)',
          ].join(', ')

          return (
            <animated.div
              key={refItem.key}
              onClick={(e) => handleRefSelect(e, placement.refName)}
              onPointerEnter={() => showAddRefControls(placement.nodeSha)}
              onPointerLeave={() => scheduleHideAddRefControls(placement.nodeSha)}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                zIndex: 20,
                height: 20,
                padding: '0 7px',
                borderRadius: 4,
                background: `linear-gradient(135deg, rgba(255, 255, 255, 0.09) 0%, rgba(255, 255, 255, 0.015) 38%, ${placement.color}18 100%), linear-gradient(${pillTint}, ${pillTint}), rgba(24, 24, 37, 0.5)`,
                backdropFilter: 'blur(3px) saturate(145%) contrast(103%)',
                WebkitBackdropFilter: 'blur(3px) saturate(145%) contrast(103%)',
                border: `1px solid ${isEmphasized ? placement.color : placement.color + '66'}`,
                color: placement.color,
                fontSize: 11,
                fontWeight: 600,
                lineHeight: '20px',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                userSelect: 'none',
                boxShadow: pillShadow,
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
              {placement.linkedWorktrees.map((worktree) => (
                <span
                  key={worktree.path}
                  title={`Open linked worktree\n${worktree.path}${worktree.lockedReason ? `\nLocked: ${worktree.lockedReason}` : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void openRepoByPath(worktree.path)
                  }}
                  style={{
                    display: 'inline-block',
                    marginLeft: 7,
                    paddingLeft: 7,
                    borderLeft: `1px solid ${placement.color}55`,
                    color: '#a6adc8',
                  }}
                >
                  ▣ {pathBaseName(worktree.path)}
                </span>
              ))}
            </animated.div>
          )
        })}
        {!isGraphAnimating && detachedWorktreePlacements.map((placement) => {
          const { worktree } = placement
          return (
            <div
              key={`detached-worktree:${worktree.path}`}
              title={`${worktree.isCurrent ? 'Current detached worktree' : 'Open detached worktree'}\n${worktree.path}\n${worktree.headSha?.slice(0, 12) ?? ''}`}
              onClick={(event) => {
                event.stopPropagation()
                if (!worktree.isCurrent) void openRepoByPath(worktree.path)
              }}
              onPointerEnter={() => showAddRefControls(placement.nodeSha)}
              onPointerLeave={() => scheduleHideAddRefControls(placement.nodeSha)}
              style={{
                position: 'absolute',
                left: placement.x,
                top: placement.y,
                zIndex: 20,
                height: 20,
                padding: '0 7px',
                borderRadius: 4,
                border: `1px solid ${worktree.isCurrent ? '#f9e2af99' : '#6c708666'}`,
                background: worktree.isCurrent ? '#f9e2af18' : 'rgba(24,24,37,0.72)',
                color: worktree.isCurrent ? '#f9e2af' : '#a6adc8',
                fontSize: 11,
                fontWeight: 600,
                lineHeight: '20px',
                whiteSpace: 'nowrap',
                cursor: worktree.isCurrent ? 'default' : 'pointer',
                userSelect: 'none',
                boxShadow: '0 2px 5px rgba(0,0,0,0.18)',
              }}
            >
              ▣ {pathBaseName(worktree.path)}
            </div>
          )
        })}
        {visibleNodes.map((node) => {
          const refRowWidth = rowRefWidths.get(node.row.sha) ?? 0
          const nodeRadius = edgeRouting.targetNodeRadii.get(node.row.sha) ?? NODE_RADIUS
          const px = node.x + nodeRadius + 8 + refRowWidth + (refRowWidth > 0 ? 8 : 0)
          const py = node.y - 10
          const refActionInFlight = pendingRefAction !== null
          const nodeActions = !refActionInFlight && node.row.sha === selectedSha ? visibleCommitActions : []
          const showsSelectedRef = !!selectedRefName && node.row.refNames.includes(selectedRefName)
          const rowRefActions = showsSelectedRef ? selectedRefActions : []
          const pendingRowRefAction = refActionInFlight && showsSelectedRef && pendingRefAction
            ? rowRefActions.find((refAction) => refAction.action === pendingRefAction.action)
              ?? pendingRefAction
            : null
          const visibleRowRefActions = refActionInFlight
            ? (pendingRowRefAction ? [pendingRowRefAction] : [])
            : rowRefActions
          const rowShowsMerge = !refActionInFlight && !!currentBranch && node.row.refNames.includes(currentBranch) && showMergeButton
          const rowShowsMove = !refActionInFlight && !!movableBranchRefName && node.row.sha !== selectedRef?.targetSha
          const rowShowsAddRef = !pendingMutation
            && !refActionInFlight
            && !isGraphAnimating
            && (hoveredAddRefSha === node.row.sha || openAddRefSha === node.row.sha)
          const rowRebaseTargetRef = !refActionInFlight && selectedCurrentBranchRef && node.row.sha !== selectedCurrentBranchRef.targetSha
            ? pickBestRef(node.row.refNames.filter((refName) => refName !== selectedCurrentBranchRef.shortName))
            : null
          const visibleRowRebaseTargetRef = rowRebaseTargetRef
            && (actionPreview?.kind !== 'rebase' || actionPreview.targetRefName === rowRebaseTargetRef)
            ? rowRebaseTargetRef
            : null
          const hasTrailingActions = visibleRowRefActions.length > 0
            || rowShowsMerge
            || rowShowsMove
            || rowShowsAddRef
            || !!visibleRowRebaseTargetRef

          if (nodeActions.length === 0 && !hasTrailingActions) return null

          return (
            <Fragment key={`${node.row.sha}-actions`}>
              {nodeActions.length > 0 && (
                <div style={{
                  position: 'absolute',
                  left: node.x - NODE_RADIUS - 12,
                  top: node.y,
                  transform: 'translate(-100%, -50%)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'nowrap',
                  // Keep commit actions usable when the uncommitted-worktree
                  // node overlaps this row.
                  zIndex: 40,
                }}>
                  {nodeActions.map((commitAction) => (
                    <CommitActionButton
                      key={commitAction.action}
                      label={commitAction.label}
                      tone={commitAction.tone}
                      onClick={() => handleCommitAction(commitAction.action)}
                      onMouseEnter={() => handleCommitActionHoverStart(commitAction.action, node.row.sha)}
                      onMouseLeave={handleActionPreviewEnd}
                    />
                  ))}
                </div>
              )}

              {hasTrailingActions && (
                <div
                  onPointerEnter={() => showAddRefControls(node.row.sha)}
                  onPointerLeave={() => scheduleHideAddRefControls(node.row.sha)}
                  style={{
                    position: 'absolute',
                    left: px,
                    top: py,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    flexWrap: 'nowrap',
                    zIndex: openAddRefSha === node.row.sha ? 40 : 20,
                  }}
                >
              {visibleRowRefActions.length > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  position: 'relative',
                  top: verticalOffsetForHeight(DEFAULT_REF_ACTION_HEIGHT),
                  zIndex: 7,
                }}>
                  {visibleRowRefActions.map((refAction) => (
                    <RefActionButton
                      key={refAction.action}
                      label={refAction.label}
                      tone={refAction.tone}
                      loading={!!pendingRowRefAction && refAction.action === pendingRowRefAction.action}
                      onClick={() => handleRefActionClick(refAction)}
                    />
                  ))}
                </div>
              )}
              {rowShowsMove && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative', zIndex: 7 }}>
                  <RefActionButton
                    label="Move"
                    tone="neutral"
                    size="compact"
                    variant="ghost"
                    onClick={() => handleMoveBranch(node.row.sha)}
                  />
                </div>
              )}
              {visibleRowRebaseTargetRef && (
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
                    onClick={() => handleRebaseClick(visibleRowRebaseTargetRef)}
                    onMouseEnter={(event) => handleRebaseHoverStart(visibleRowRebaseTargetRef, node, event)}
                    onMouseLeave={rebaseHoverLock?.targetRefName === visibleRowRebaseTargetRef
                      ? undefined
                      : handleRebaseHoverEnd}
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
              {rowShowsAddRef && (
                <div style={{
                  position: 'relative',
                  top: verticalOffsetForHeight(ADD_REF_BUTTON_SIZE),
                  zIndex: 8,
                }}>
                  <button
                    type="button"
                    title="Create branch or tag"
                    aria-label="Create branch or tag"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMergePreviewVisible(false)
                      setOpenAddRefSha((current) => current === node.row.sha ? null : node.row.sha)
                      setHoveredAddRefSha(node.row.sha)
                    }}
                    style={{
                      width: ADD_REF_BUTTON_SIZE,
                      height: ADD_REF_BUTTON_SIZE,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                      borderRadius: 6,
                      border: '1px solid #4a4f68',
                      background: '#2f3348',
                      color: '#cdd6f4',
                      fontSize: 21,
                      fontWeight: 600,
                      lineHeight: 1,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      boxShadow: '0 8px 20px rgba(0,0,0,0.28)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#3a4058' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '#2f3348' }}
                  >
                    +
                  </button>
                  {openAddRefSha === node.row.sha && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: ADD_REF_BUTTON_SIZE + 6,
                        width: ADD_REF_MENU_WIDTH,
                        padding: 5,
                        borderRadius: 7,
                        border: '1px solid #4a4f68',
                        background: '#181825',
                        boxShadow: '0 14px 30px rgba(0,0,0,0.42)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      {(['branch', 'tag'] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleCreateRef(kind, node.row.sha)
                          }}
                          style={{
                            height: 28,
                            padding: '0 9px',
                            borderRadius: 5,
                            border: '1px solid transparent',
                            background: 'transparent',
                            color: '#cdd6f4',
                            fontSize: 12,
                            fontWeight: 600,
                            fontFamily: 'inherit',
                            textAlign: 'left',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = '#313244'
                            e.currentTarget.style.borderColor = '#45475a'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent'
                            e.currentTarget.style.borderColor = 'transparent'
                          }}
                        >
                          {kind === 'branch' ? 'Branch' : 'Tag'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
                </div>
              )}
            </Fragment>
          )
        })}
      </div>

      </div>

    </div>
  )
}
