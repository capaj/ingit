import type { CommitRow } from '@ingit/rpc-contract'
import { orderLaneSegmentsByContinuity } from '@ingit/graph-core'

export const NODE_SPACING_Y = 56
export const LANE_WIDTH = 80
export const GRAPH_LEFT_GUTTER = 120
export const GRAPH_RIGHT_GUTTER = 520
export const PAD_TOP = 40
export const GRAPH_TOP_HEADROOM = NODE_SPACING_Y * 2
export const PAD_LEFT = 40
export const COMMIT_MESSAGE_GUTTER = 260
export const LANE_ORIGIN_X_BASE = PAD_LEFT + GRAPH_LEFT_GUTTER
const MIN_RESPONSIVE_RIGHT_GUTTER = 80
const RESPONSIVE_RIGHT_GUTTER_RATIO = 0.2
const MIN_RESPONSIVE_GUTTER_COUNT = 3

export const LANE_COLORS = [
  '#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7',
  '#94e2d5', '#fab387', '#74c7ec', '#f5c2e7', '#b4befe',
]

export interface LayoutNode {
  row: CommitRow
  x: number
  y: number
  idx: number
}

export interface GraphLayout {
  nodes: LayoutNode[]
  shaToNode: Map<string, LayoutNode>
  shaToBranch: Map<string, string>
  shaToColor: Map<string, string>
  maxLane: number
  totalWidth: number
  totalHeight: number
}

export function hashText(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  return hash
}

export function laneColor(lane: number): string {
  const normalized = ((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length
  return LANE_COLORS[normalized]
}

function mixHash(value: number): number {
  let mixed = value
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, 0x7feb352d)
  mixed ^= mixed >>> 15
  mixed = Math.imul(mixed, 0x846ca68b)
  mixed ^= mixed >>> 16
  return mixed >>> 0
}

function hashBranchName(name: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const hueSection = ((hue % 360) + 360) % 360 / 60
  const secondary = chroma * (1 - Math.abs(hueSection % 2 - 1))
  const [red, green, blue] = hueSection < 1
    ? [chroma, secondary, 0]
    : hueSection < 2
      ? [secondary, chroma, 0]
      : hueSection < 3
        ? [0, chroma, secondary]
        : hueSection < 4
          ? [0, secondary, chroma]
          : hueSection < 5
            ? [secondary, 0, chroma]
            : [chroma, 0, secondary]
  const offset = l - chroma / 2
  return `#${[red, green, blue]
    .map((component) => Math.round((component + offset) * 255).toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * Give every branch a stable color derived only from its name. Generating the
 * hue directly avoids the frequent collisions caused by a short fixed palette,
 * while the constrained saturation/lightness range stays legible on the graph.
 */
export function colorForBranchName(name: string): string {
  const hash = mixHash(hashBranchName(name))
  const hue = hash % 360
  const saturation = 64 + ((hash >>> 9) % 17)
  const lightness = 68 + ((hash >>> 17) % 9)
  return hslToHex(hue, saturation, lightness)
}

export interface GraphViewportFit {
  extraLeftGutter: number
  rightGutter: number
  maxLaneRadius: number
  laneCenterX: number
  layoutWidth: number
}

export interface GraphLaneFrame {
  laneCenterX: number
  laneRadius: number
  totalWidth: number
}

/**
 * Convert physical viewport width into a symmetric lane budget. Side reserves
 * shrink before gutters do on narrow screens, while retaining enough room for
 * ref pills and row actions when space is available.
 */
export function fitGraphToViewport(
  viewportWidth: number,
  requestedExtraLeftGutter: number,
): GraphViewportFit {
  const width = Math.max(0, viewportWidth)
  const laneCenterX = width / 2
  const minimumLaneRadius = width >= 480
    ? Math.floor(MIN_RESPONSIVE_GUTTER_COUNT / 2)
    : 0
  const minimumLaneHalfWidth = minimumLaneRadius * LANE_WIDTH + LANE_WIDTH / 2
  const maxSideReserve = Math.max(0, laneCenterX - minimumLaneHalfWidth)
  const fixedLeftReserve = LANE_ORIGIN_X_BASE - LANE_WIDTH / 2
  const fixedRightReserve = PAD_LEFT * 2
  const requestedExtra = Math.max(0, requestedExtraLeftGutter)
  const extraLeftGutter = Math.min(
    requestedExtra,
    Math.max(0, maxSideReserve - fixedLeftReserve),
  )
  const desiredRightGutter = Math.min(
    GRAPH_RIGHT_GUTTER,
    Math.max(MIN_RESPONSIVE_RIGHT_GUTTER, width * RESPONSIVE_RIGHT_GUTTER_RATIO),
  )
  const rightGutter = Math.min(
    desiredRightGutter,
    Math.max(0, maxSideReserve - fixedRightReserve),
  )
  const leftReserve = fixedLeftReserve + extraLeftGutter
  const rightReserve = fixedRightReserve + rightGutter
  const laneHalfWidth = Math.max(
    LANE_WIDTH / 2,
    Math.min(laneCenterX - leftReserve, width - laneCenterX - rightReserve),
  )
  const maxLaneRadius = Math.max(
    0,
    Math.floor((laneHalfWidth - LANE_WIDTH / 2) / LANE_WIDTH),
  )

  return {
    extraLeftGutter,
    rightGutter,
    maxLaneRadius,
    laneCenterX,
    layoutWidth: width,
  }
}

/**
 * Fit lanes against the whole browser window, not the graph element. Opening a
 * sibling panel can shrink the graph canvas without changing this lane budget.
 * The local base center compensates for a left sidebar; occupied-lane fitting
 * may subsequently move lane 0 away from that browser midpoint.
 */
export function fitGraphToBrowserWindow(
  browserWidth: number,
  graphLeft: number,
  zoom: number,
  requestedExtraLeftGutter: number,
): GraphViewportFit {
  const scale = Math.max(zoom, 0.1)
  const width = Math.max(0, browserWidth)
  const left = Math.max(0, graphLeft)
  const fit = fitGraphToViewport(width / scale, requestedExtraLeftGutter)

  return {
    ...fit,
    laneCenterX: (width / 2 - left) / scale,
    layoutWidth: Math.max(0, width - left) / scale,
  }
}

/**
 * Center the occupied lane span inside the viewport's existing gutter envelope.
 * Lane 0 remains the checked-out branch semantically, but it may move away from
 * the browser midpoint when most branch families live on one side. Keeping the
 * occupied extrema inside the original symmetric envelope preserves the
 * responsive side reserves for commit messages, ref pills, and actions.
 */
export function fitLaneFrameToRows(
  rows: Pick<CommitRow, 'lane'>[],
  viewportFit: GraphViewportFit,
): GraphLaneFrame {
  if (rows.length === 0) {
    return {
      laneCenterX: viewportFit.laneCenterX,
      laneRadius: viewportFit.maxLaneRadius,
      totalWidth: viewportFit.layoutWidth,
    }
  }

  let minLane = Infinity
  let maxLane = -Infinity
  for (const row of rows) {
    minLane = Math.min(minLane, row.lane)
    maxLane = Math.max(maxLane, row.lane)
  }

  const radius = viewportFit.maxLaneRadius
  const desiredShift = -((minLane + maxLane) / 2) * LANE_WIDTH
  const minimumShift = (-radius - minLane) * LANE_WIDTH
  const maximumShift = (radius - maxLane) * LANE_WIDTH
  const shift = Math.max(minimumShift, Math.min(maximumShift, desiredShift))

  return {
    laneCenterX: viewportFit.laneCenterX + shift,
    laneRadius: radius,
    totalWidth: viewportFit.layoutWidth,
  }
}

export function compactRowsToLaneRadius(
  rows: CommitRow[],
  maxLaneRadius: number,
): CommitRow[] {
  const laneBySha = orderLaneSegmentsByContinuity(rows, maxLaneRadius)
  let changed = false
  const compacted = rows.map((row) => {
    const lane = laneBySha.get(row.sha) ?? 0
    if (lane === row.lane) return row
    changed = true
    return { ...row, lane }
  })
  return changed ? compacted : rows
}

function stableColorForNode(sha: string, shaToBranch: Map<string, string>): string {
  const branch = shaToBranch.get(sha)
  return branch ? colorForBranchName(branch) : LANE_COLORS[hashText(sha) % LANE_COLORS.length]
}

/** Pick the best ref name for display: prefer local branches, skip bare remote names. */
export function pickBestRef(refNames: string[]): string | null {
  if (refNames.length === 0) return null
  const local = refNames.find((refName) => !refName.includes('/'))
  if (local) return local
  const remote = refNames.find(
    (refName) => refName.includes('/') && refName !== 'origin' && refName !== 'HEAD',
  )
  return remote ?? null
}

export function buildLayout(
  rows: CommitRow[],
  extraLeftGutter = 0,
  rightGutter = GRAPH_RIGHT_GUTTER,
  laneFrame?: GraphLaneFrame,
): GraphLayout {
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
  const laneRadius = laneFrame?.laneRadius
    ?? Math.max(Math.abs(leftmostLane), Math.abs(rightmostLane))
  const laneOriginX = LANE_ORIGIN_X_BASE + extraLeftGutter

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const node: LayoutNode = {
      row,
      x: laneFrame
        ? laneFrame.laneCenterX + row.lane * LANE_WIDTH
        : laneOriginX + (row.lane + laneRadius) * LANE_WIDTH,
      y: PAD_TOP + GRAPH_TOP_HEADROOM + i * NODE_SPACING_Y,
      idx: i,
    }
    nodes.push(node)
    shaToNode.set(row.sha, node)
  }

  // Build sha → branch name by tracing first-parent chains from branch tips.
  // Prefer local branches over remotes; skip bare remote names like "origin".
  const shaToBranch = new Map<string, string>()
  for (const row of rows) {
    const bestRef = pickBestRef(row.refNames)
    if (!bestRef) continue
    let sha: string | undefined = row.sha
    while (sha && !shaToBranch.has(sha)) {
      shaToBranch.set(sha, bestRef)
      const current = shaToRow.get(sha)
      if (!current || current.parentShas.length === 0) break
      sha = current.parentShas[0]
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
    totalWidth: laneFrame?.totalWidth
      ?? PAD_LEFT * 2
        + GRAPH_LEFT_GUTTER
        + extraLeftGutter
        + (laneRadius * 2 + 1) * LANE_WIDTH
        + rightGutter,
    totalHeight: rows.length * NODE_SPACING_Y + PAD_TOP * 2 + GRAPH_TOP_HEADROOM,
  }
}

/**
 * Reuse cached topology/color work while attaching the current row objects.
 * The graph renderer reads commit metadata from each node, so authoritative
 * server rows must replace optimistic row objects even when geometry matches.
 */
export function rebindLayoutRows(layout: GraphLayout, rows: CommitRow[]): GraphLayout {
  const nodes = layout.nodes.map((node, index) => ({
    ...node,
    row: rows[index]!,
  }))
  return {
    ...layout,
    nodes,
    shaToNode: new Map(nodes.map((node) => [node.row.sha, node])),
  }
}
