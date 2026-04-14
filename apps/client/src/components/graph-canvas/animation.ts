import type { CommitRow } from '@ingit/rpc-contract'

const REF_PILL_GAP = 6
const REF_PILL_HORIZONTAL_PADDING = 14
const REF_PILL_CHARACTER_WIDTH = 7

export const GRAPH_MUTATION_SETTLE_MS = 2600
export const GRAPH_SPRING_CONFIG = { mass: 2.1, tension: 180, friction: 28 }
export const GRAPH_ENTER_OFFSET_Y = 56 * 0.55
export const GRAPH_EXIT_OFFSET_Y = 56 * 0.3
export const CURRENT_LANE_HIGHLIGHT_WIDTH = 54

export interface RefPlacement {
  refName: string
  nodeSha: string
  x: number
  y: number
  color: string
  isCurrent: boolean
  isSelected: boolean
  isRemote: boolean
}

export interface VisibleEdgeItem {
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

export interface CurrentLaneHighlight {
  key: string
  x: number
  color: string
}

interface RefPlacementNode {
  row: {
    sha: string
    lane: number
    refNames: string[]
  }
  x: number
  y: number
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

export function shouldAnimateHistoryChange(prevRows: CommitRow[] | null, nextRows: CommitRow[] | null) {
  if (!prevRows || !nextRows) return false
  if (prevRows.length === 0 || nextRows.length === 0) return false
  if (areRowsEquivalent(prevRows, nextRows)) return false
  if (isAppendOnlyHistoryUpdate(prevRows, nextRows)) return false
  return true
}

export function refBadgePrefix(isRemote: boolean, isCurrent: boolean) {
  if (isRemote) return '☁ '
  return isCurrent ? '● ' : '⎇ '
}

function estimateRefPillWidth(refName: string, isRemote: boolean, isCurrent: boolean) {
  return REF_PILL_HORIZONTAL_PADDING + (refBadgePrefix(isRemote, isCurrent).length + refName.length) * REF_PILL_CHARACTER_WIDTH
}

export function buildRefPlacements(
  nodes: RefPlacementNode[],
  currentBranch: string | null,
  selectedRefName: string | null,
  nodeRadius: number,
  laneColor: (lane: number) => string,
  isRemoteRef: (name: string) => boolean,
) {
  const placements: RefPlacement[] = []
  const rowWidths = new Map<string, number>()

  for (const node of nodes) {
    const baseX = node.x + nodeRadius + 8
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
        color: laneColor(node.row.lane),
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
