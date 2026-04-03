import { useRef, useEffect, useCallback } from 'react'
import type { HistoryWindowResponse, CommitRow, EdgeSegment } from '@ingit/rpc-contract'

interface GraphCanvasProps {
  window: HistoryWindowResponse | null
  selectedSha: string | null
  onSelectCommit: (sha: string) => void
  onScroll: (direction: 'up' | 'down') => void
}

const ROW_HEIGHT = 32
const LANE_WIDTH = 18
const DOT_RADIUS = 5
const GRAPH_PAD_LEFT = 12
const TEXT_PAD_LEFT = 10
const FONT = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
const PILL_FONT = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

const LANE_COLORS = [
  '#89b4fa',
  '#a6e3a1',
  '#f9e2af',
  '#f38ba8',
  '#cba6f7',
  '#94e2d5',
  '#fab387',
  '#74c7ec',
]

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]
}

function rowY(row: number, windowStartRow: number): number {
  return (row - windowStartRow) * ROW_HEIGHT
}

function rowCenterY(row: number, windowStartRow: number): number {
  return rowY(row, windowStartRow) + ROW_HEIGHT / 2
}

function laneX(lane: number): number {
  return GRAPH_PAD_LEFT + lane * LANE_WIDTH + LANE_WIDTH / 2
}

export function GraphCanvas({
  window: histWindow,
  selectedSha,
  onSelectCommit,
  onScroll,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height

    // Background
    ctx.fillStyle = '#1e1e2e'
    ctx.fillRect(0, 0, W, H)

    if (!histWindow || histWindow.rows.length === 0) {
      ctx.fillStyle = '#45475a'
      ctx.font = FONT
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('No commits', W / 2, H / 2)
      return
    }

    const rows = histWindow.rows
    const edges = histWindow.edges
    const startRow = rows[0].row

    // Compute max lane for graph area width
    let maxLane = 0
    for (const row of rows) {
      if (row.lane > maxLane) maxLane = row.lane
    }
    const graphWidth = GRAPH_PAD_LEFT + (maxLane + 1) * LANE_WIDTH + TEXT_PAD_LEFT

    // Selected row highlight
    if (selectedSha) {
      const selRow = rows.find((r) => r.sha === selectedSha)
      if (selRow) {
        const y = rowY(selRow.row, startRow)
        ctx.fillStyle = '#313244'
        ctx.fillRect(0, y, W, ROW_HEIGHT)
      }
    }

    // Draw edges
    for (const edge of edges) {
      // Only draw edges that are at least partially visible
      const minRow = Math.min(edge.fromRow, edge.toRow)
      const maxRowE = Math.max(edge.fromRow, edge.toRow)
      if (maxRowE < startRow || minRow >= startRow + rows.length) continue

      const color = laneColor(edge.fromLane)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5

      const x1 = laneX(edge.fromLane)
      const y1 = rowCenterY(edge.fromRow, startRow)
      const x2 = laneX(edge.toLane)
      const y2 = rowCenterY(edge.toRow, startRow)

      ctx.beginPath()

      if (edge.fromLane === edge.toLane) {
        // Straight vertical line
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
      } else {
        // Bezier curve for lane changes
        const midY = (y1 + y2) / 2
        ctx.moveTo(x1, y1)
        ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2)
      }

      ctx.stroke()
    }

    // Draw commit dots, text, and ref pills
    ctx.font = FONT
    ctx.textBaseline = 'middle'

    for (const row of rows) {
      const cx = laneX(row.lane)
      const cy = rowCenterY(row.row, startRow)

      // Dot
      const color = laneColor(row.lane)
      ctx.beginPath()
      ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = row.sha === selectedSha ? '#ffffff' : color
      ctx.fill()
      if (row.sha === selectedSha) {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Subject text
      let textX = graphWidth

      // Ref pills first (draw them before text, accumulate width used)
      const pills = row.refNames
      let pillX = textX
      const pillsWidths: number[] = []
      ctx.font = PILL_FONT
      for (const ref of pills) {
        const tw = ctx.measureText(ref).width
        pillsWidths.push(tw + 10)
      }
      ctx.font = FONT

      const totalPillWidth = pillsWidths.reduce((a, b) => a + b + 4, 0)
      const textAreaX = textX + totalPillWidth + (pills.length > 0 ? 6 : 0)
      const maxTextWidth = W - textAreaX - 16

      // Draw subject
      ctx.fillStyle = row.sha === selectedSha ? '#cdd6f4' : '#bac2de'
      ctx.textAlign = 'left'
      const subject = truncateText(ctx, row.subject, maxTextWidth)
      ctx.fillText(subject, textAreaX, cy)

      // Draw pills
      ctx.font = PILL_FONT
      for (let i = 0; i < pills.length; i++) {
        const ref = pills[i]
        const pw = pillsWidths[i]
        const pillColor = ref.startsWith('HEAD') ? '#f38ba8' :
                          ref.includes('/') ? '#94e2d5' : '#89b4fa'

        const py = cy - 8
        const ph = 16

        ctx.fillStyle = pillColor + '33'
        roundRect(ctx, pillX, py, pw, ph, 4)
        ctx.fill()

        ctx.strokeStyle = pillColor
        ctx.lineWidth = 1
        roundRect(ctx, pillX, py, pw, ph, 4)
        ctx.stroke()

        ctx.fillStyle = pillColor
        ctx.textAlign = 'center'
        ctx.fillText(ref, pillX + pw / 2, cy)

        pillX += pw + 4
      }

      ctx.font = FONT
    }
  }, [histWindow, selectedSha])

  // Schedule draw
  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      draw()
      rafRef.current = null
    })
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [draw])

  // Resize observer
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        canvas.width = Math.floor(width)
        canvas.height = Math.floor(height)
        draw()
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [draw])

  // Click handler
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!histWindow || histWindow.rows.length === 0) return
      const rect = canvasRef.current!.getBoundingClientRect()
      const y = e.clientY - rect.top
      const rows = histWindow.rows
      const startRow = rows[0].row
      const clickedIndex = Math.floor(y / ROW_HEIGHT)
      const row = rows[clickedIndex]
      if (row) {
        onSelectCommit(row.sha)
      }
    },
    [histWindow, onSelectCommit]
  )

  // Wheel handler
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      onScroll(e.deltaY > 0 ? 'down' : 'up')
    },
    [onScroll]
  )

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, height: '100%', overflow: 'hidden', position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
        onClick={handleClick}
        onWheel={handleWheel}
      />
    </div>
  )
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  const width = ctx.measureText(text).width
  if (width <= maxWidth) return text
  const ellipsis = '…'
  const eWidth = ctx.measureText(ellipsis).width
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (ctx.measureText(text.slice(0, mid)).width + eWidth <= maxWidth) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return text.slice(0, lo) + ellipsis
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
