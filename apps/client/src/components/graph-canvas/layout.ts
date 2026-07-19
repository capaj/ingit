import type { CommitRow } from '@ingit/rpc-contract'

export const NODE_SPACING_Y = 56
export const LANE_WIDTH = 80
export const GRAPH_LEFT_GUTTER = 120
export const GRAPH_RIGHT_GUTTER = 520
export const PAD_TOP = 40
export const GRAPH_TOP_HEADROOM = NODE_SPACING_Y * 2
export const PAD_LEFT = 40
export const COMMIT_MESSAGE_GUTTER = 260
export const LANE_ORIGIN_X_BASE = PAD_LEFT + GRAPH_LEFT_GUTTER

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

export function colorForBranchName(name: string): string {
  return LANE_COLORS[hashText(name) % LANE_COLORS.length]
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

export function buildLayout(rows: CommitRow[], extraLeftGutter = 0): GraphLayout {
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
    totalWidth: PAD_LEFT * 2
      + GRAPH_LEFT_GUTTER
      + extraLeftGutter
      + (laneRadius * 2 + 1) * LANE_WIDTH
      + GRAPH_RIGHT_GUTTER,
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
