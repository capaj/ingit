export interface Rect {
  top: number
  right: number
  bottom: number
  left: number
}

export interface Size {
  width: number
  height: number
}

/**
 * The commit detail panel normally lives in the bottom-right corner. Move it
 * to the top edge only when that bottom placement would cover the selected
 * graph node.
 */
export function shouldShowCommitDetailAtTop(
  node: Rect,
  container: Rect,
  panel: Size,
): boolean {
  const bottomPanel: Rect = {
    top: container.bottom - panel.height,
    right: container.right,
    bottom: container.bottom,
    left: container.right - panel.width,
  }

  return node.left < bottomPanel.right
    && node.right > bottomPanel.left
    && node.top < bottomPanel.bottom
    && node.bottom > bottomPanel.top
}
