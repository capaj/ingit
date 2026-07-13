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

export interface PreviewCamera {
  zoom: number
  translateX: number
  translateY: number
}

/**
 * Place a newest-to-oldest preview chain entirely above the live graph.
 *
 * Long chains intentionally receive negative y positions so the temporary
 * preview camera can fit them without moving any live graph rows.
 */
export function stackPreviewChainAboveGraph<T extends VerticalPosition>(
  nodes: T[],
  topNode: VerticalPosition,
  rowSpacing: number,
): T[] {
  return nodes.map((node, index) => {
    const rowsAboveGraph = nodes.length - index
    return {
      ...node,
      y: topNode.y - rowsAboveGraph * rowSpacing,
      idx: topNode.idx - rowsAboveGraph,
    }
  })
}

/**
 * Fit preview bounds into the full graph viewport. The hovered action is
 * duplicated outside the graph, so the camera is free to reposition beneath
 * that fixed hover target.
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
  const fittedWidth = boundsWidth * zoom
  const fittedHeight = boundsHeight * zoom
  const viewportLeft = (viewport.width - fittedWidth) / 2
  const viewportTop = (viewport.height - fittedHeight) / 2

  return {
    zoom,
    translateX: scroll.x + viewportLeft - bounds.minX * zoom,
    translateY: scroll.y + viewportTop - bounds.minY * zoom,
  }
}
