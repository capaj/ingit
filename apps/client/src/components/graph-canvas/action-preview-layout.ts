interface VerticalPosition {
  y: number
  idx: number
}

interface ScrollPosition {
  x: number
  y: number
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface ViewportSize {
  width: number
  height: number
}

export interface CrossLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface PreviewCamera {
  zoom: number
  translateX: number
  translateY: number
}

/**
 * Reuse the source branch's gutter when it is empty between the preview node
 * and the source. Otherwise, move outward on the source side of the graph.
 * Keeping the rail at or beyond the source prevents a preview edge from
 * crossing to the opposite side and then doubling back into its endpoint.
 */
export function mergePreviewGutterX(
  nodes: Array<{ x: number; idx: number }>,
  fromIdx: number,
  toIdx: number,
  laneWidth: number,
  fallbackSide: 'left' | 'right',
): number | null {
  if (nodes.length === 0) return null

  const topIdx = Math.min(fromIdx, toIdx)
  const bottomIdx = Math.max(fromIdx, toIdx)
  const gutterXs = [...new Set(nodes.map((node) => node.x))].sort((left, right) => left - right)
  const occupiedXs = new Set(
    nodes
      // Endpoint nodes are allowed to touch their own rail. Only commits
      // strictly between the endpoints can obstruct its vertical section.
      .filter((node) => node.idx > topIdx && node.idx < bottomIdx)
      .map((node) => node.x),
  )
  const sourceX = nodes.find((node) => node.idx === toIdx)?.x
  const sourceSideGutters = sourceX === undefined
    ? []
    : gutterXs
      .filter((gutterX) => fallbackSide === 'left' ? gutterX <= sourceX : gutterX >= sourceX)
      .sort((left, right) => fallbackSide === 'left' ? right - left : left - right)

  for (const gutterX of sourceSideGutters) {
    if (!occupiedXs.has(gutterX)) return gutterX
  }

  return fallbackSide === 'left'
    ? gutterXs[0] - laneWidth
    : gutterXs[gutterXs.length - 1] + laneWidth
}

/** Place a newest-to-oldest replay chain immediately above its rebase target. */
export function stackPreviewChainAboveTarget<T extends VerticalPosition>(
  nodes: T[],
  targetNode: VerticalPosition,
  rowSpacing: number,
): T[] {
  return nodes.map((node, index) => {
    const rowsAboveTarget = nodes.length - index
    return {
      ...node,
      y: targetNode.y - rowsAboveTarget * rowSpacing,
      idx: targetNode.idx - rowsAboveTarget,
    }
  })
}

/**
 * While a rebase preview stacks the replayed commits on the target's gutter,
 * slide the live branch line ascending from the target into a free side
 * gutter. The ghost chain then shows exactly where the rebased commits land
 * without covering the live commits they replace.
 */
export function displaceBranchAboveTarget<T extends { sha: string; parentShas: string[]; lane: number }>(
  rows: T[],
  headSha: string,
  targetSha: string,
  maxLaneRadius: number,
): T[] | null {
  if (maxLaneRadius < 1) return null

  const rowBySha = new Map(rows.map((row) => [row.sha, row]))
  const targetRow = rowBySha.get(targetSha)
  if (!targetRow) return null

  // The branch line ascending from the target: HEAD's first-parent chain down
  // to (excluding) the target. If the target is not on that line there is no
  // branch to move aside.
  const chain: T[] = []
  const seen = new Set<string>()
  let sha: string | undefined = headSha
  while (sha && sha !== targetSha && !seen.has(sha)) {
    seen.add(sha)
    const row = rowBySha.get(sha)
    if (!row) return null
    chain.push(row)
    sha = row.parentShas[0]
  }
  if (sha !== targetSha || chain.length === 0) return null

  const targetIdx = rows.indexOf(targetRow)
  const spanStart = Math.min(rows.indexOf(chain[0]), targetIdx)
  const spanEnd = Math.max(rows.indexOf(chain[chain.length - 1]), targetIdx)
  const laneFree = (lane: number): boolean => {
    for (let i = spanStart; i <= spanEnd; i++) {
      if (rows[i].lane === lane) return false
    }
    return true
  }

  // Prefer the right side, then left, nearest gutter first.
  let gutter = 0
  for (let distance = 1; distance <= maxLaneRadius && gutter === 0; distance++) {
    if (laneFree(distance)) gutter = distance
    else if (laneFree(-distance)) gutter = -distance
  }
  if (gutter === 0) return null

  const displacedShas = new Set(chain.map((row) => row.sha))
  return rows.map((row) => displacedShas.has(row.sha) ? { ...row, lane: gutter } : row)
}

/** Keep pending worktree changes one row above an appended commit preview. */
export function placeWorktreeAbovePreview<T extends VerticalPosition>(
  headNode: T,
  previewNode: T | null,
  rowSpacing: number,
): { anchor: T; y: number; idx: number } {
  const anchor = previewNode ?? headNode
  return {
    anchor,
    y: anchor.y - rowSpacing,
    idx: anchor.idx - 1,
  }
}

/** Place an in-progress merge where its completed merge commit will be inserted. */
export function placeMergePreviewAboveGraph(
  topNode: VerticalPosition,
  rowSpacing: number,
): VerticalPosition {
  return {
    y: topNode.y - rowSpacing,
    idx: topNode.idx - 1,
  }
}

/** Build the two diagonal strokes used to cross out an uncommit preview. */
export function uncommitCrossLines(
  node: { x: number; y: number },
  radius: number,
): [CrossLine, CrossLine] {
  return [
    {
      x1: node.x - radius,
      y1: node.y - radius,
      x2: node.x + radius,
      y2: node.y + radius,
    },
    {
      x1: node.x + radius,
      y1: node.y - radius,
      x2: node.x - radius,
      y2: node.y + radius,
    },
  ]
}

/**
 * Fit preview bounds into the graph viewport with the smallest possible
 * camera movement. Short previews that only cross one viewport edge should
 * slide just far enough to become visible; only oversized previews zoom out.
 * The hovered action is duplicated outside the graph and remains stationary.
 */
export function fitPreviewCamera({
  baseZoom,
  bounds,
  viewport,
  scroll,
  margin,
}: {
  baseZoom: number
  bounds: Bounds
  viewport: ViewportSize
  scroll: ScrollPosition
  margin: number
}): PreviewCamera {
  const currentMinX = bounds.minX * baseZoom - scroll.x
  const currentMaxX = bounds.maxX * baseZoom - scroll.x
  const currentMinY = bounds.minY * baseZoom - scroll.y
  const currentMaxY = bounds.maxY * baseZoom - scroll.y
  const alreadyFits = currentMinX >= margin
    && currentMaxX <= viewport.width - margin
    && currentMinY >= margin
    && currentMaxY <= viewport.height - margin
  if (alreadyFits) {
    return { zoom: baseZoom, translateX: 0, translateY: 0 }
  }

  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX)
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY)
  const availableWidth = Math.max(1, viewport.width - margin * 2)
  const availableHeight = Math.max(1, viewport.height - margin * 2)
  const zoom = Math.max(0.05, Math.min(
    baseZoom,
    availableWidth / boundsWidth,
    availableHeight / boundsHeight,
  ))

  const fittedMinX = bounds.minX * zoom - scroll.x
  const fittedMaxX = bounds.maxX * zoom - scroll.x
  const fittedMinY = bounds.minY * zoom - scroll.y
  const fittedMaxY = bounds.maxY * zoom - scroll.y

  const minimalTranslation = (
    fittedMin: number,
    fittedMax: number,
    viewportSize: number,
  ) => {
    const minTranslation = margin - fittedMin
    const maxTranslation = viewportSize - margin - fittedMax
    return Math.min(maxTranslation, Math.max(minTranslation, 0))
  }

  return {
    zoom,
    translateX: minimalTranslation(fittedMinX, fittedMaxX, viewport.width),
    translateY: minimalTranslation(fittedMinY, fittedMaxY, viewport.height),
  }
}
