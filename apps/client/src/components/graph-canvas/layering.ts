export interface CircleBounds {
  x: number
  y: number
  radius: number
}

export interface RectangleBounds {
  x: number
  y: number
  width: number
  height: number
}

export function circleIntersectsRectangle(circle: CircleBounds, rectangle: RectangleBounds): boolean {
  const closestX = Math.max(rectangle.x, Math.min(circle.x, rectangle.x + rectangle.width))
  const closestY = Math.max(rectangle.y, Math.min(circle.y, rectangle.y + rectangle.height))
  const dx = circle.x - closestX
  const dy = circle.y - closestY
  return dx * dx + dy * dy <= circle.radius * circle.radius
}
