import type { CommitRow } from '@ingit/rpc-contract'

/**
 * A worktree node floats one row above HEAD in the current branch's lane.
 * When a fetched first-parent descendant of HEAD also uses that lane, its
 * history edge runs straight through the worktree node. Move that upstream-only
 * rail into the rightmost free gutter until it reconnects with HEAD, keeping
 * the long tracking-remote rail outside the busier branch gutters.
 */
export function routeUpstreamAroundWorktree(
  rows: CommitRow[],
  currentBranch: string | null,
): CommitRow[] {
  if (!currentBranch) return rows

  const headIndex = rows.findIndex((row) => row.refNames.includes(currentBranch))
  if (headIndex <= 0) return rows

  const head = rows[headIndex]
  const headLane = head.lane
  const childrenByFirstParent = new Map<string, number[]>()

  for (let index = 0; index < headIndex; index++) {
    const firstParent = rows[index].parentShas[0]
    if (!firstParent) continue
    const children = childrenByFirstParent.get(firstParent)
    if (children) children.push(index)
    else childrenByFirstParent.set(firstParent, [index])
  }

  // Collect the same-lane rail that grows upward from HEAD. Side branches that
  // already fan into another lane are intentionally left where they are.
  const movedIndices = new Set<number>()
  const frontier = [head.sha]
  const visited = new Set<string>()

  while (frontier.length > 0) {
    const parentSha = frontier.pop()!
    if (visited.has(parentSha)) continue
    visited.add(parentSha)

    for (const childIndex of childrenByFirstParent.get(parentSha) ?? []) {
      const child = rows[childIndex]
      if (child.lane !== headLane) continue
      movedIndices.add(childIndex)
      frontier.push(child.sha)
    }
  }

  if (movedIndices.size === 0) return rows

  const firstMovedIndex = Math.min(...movedIndices)
  // Include the row immediately above the moved rail when checking gutters.
  // This avoids snapping the rail underneath a branch that feeds into its tip.
  const occupiedFrom = Math.max(0, firstMovedIndex - 1)
  const occupiedTo = headIndex - 1
  const indexBySha = new Map(rows.map((row, index) => [row.sha, index]))

  const laneIsFree = (candidateLane: number): boolean => {
    for (let index = 0; index < rows.length; index++) {
      if (movedIndices.has(index)) continue
      const row = rows[index]

      if (
        row.lane === candidateLane
        && occupiedFrom <= index
        && index <= occupiedTo
      ) {
        return false
      }

      const parentIndex = indexBySha.get(row.parentShas[0] ?? '')
      if (parentIndex === undefined || row.lane !== candidateLane) continue
      const parent = rows[parentIndex]
      if (parent.lane !== candidateLane) continue

      const edgeFrom = Math.min(index, parentIndex)
      const edgeTo = Math.max(index, parentIndex)
      if (edgeFrom <= occupiedTo && occupiedFrom <= edgeTo) return false
    }

    return true
  }

  const rightmostOccupiedLane = Math.max(headLane, ...rows.map((row) => row.lane))
  let targetLane = Math.max(headLane + 1, rightmostOccupiedLane)
  while (!laneIsFree(targetLane)) targetLane++

  return rows.map((row, index) => (
    movedIndices.has(index) ? { ...row, lane: targetLane } : row
  ))
}
