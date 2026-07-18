interface LaneRow {
  sha: string
  parentShas: string[]
  row: number
  lane: number
}

interface LaneSegment {
  id: string
  lane: number
  shas: string[]
  startRow: number
  endRow: number
  continuity: number
  maxConcurrency: number
}

/**
 * Reorder connected rail segments on each side of the center line so long
 * uninterrupted rails sit outside shorter-lived branches. Lanes are reusable,
 * so disconnected segments that happened to use the same original lane are
 * deliberately allowed to land in different gutters.
 */
export function orderLaneSegmentsByContinuity(rows: LaneRow[]): Map<string, number> {
  const segments = buildSegments(rows)
  const laneBySha = new Map<string, number>()

  for (const segment of segments) {
    if (segment.lane === 0) {
      for (const sha of segment.shas) laneBySha.set(sha, 0)
    }
  }

  orderSide(segments.filter((segment) => segment.lane < 0), 'left', laneBySha)
  orderSide(segments.filter((segment) => segment.lane > 0), 'right', laneBySha)
  return laneBySha
}

function buildSegments(rows: LaneRow[]): LaneSegment[] {
  const rowBySha = new Map(rows.map((row) => [row.sha, row]))
  const rootBySha = new Map(rows.map((row) => [row.sha, row.sha]))

  const find = (sha: string): string => {
    const parent = rootBySha.get(sha) as string
    if (parent === sha) return sha
    const root = find(parent)
    rootBySha.set(sha, root)
    return root
  }

  const union = (left: string, right: string) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) rootBySha.set(rightRoot, leftRoot)
  }

  for (const row of rows) {
    const firstParent = row.parentShas[0]
    const parent = firstParent ? rowBySha.get(firstParent) : undefined
    if (parent?.lane === row.lane) union(row.sha, parent.sha)
  }

  const segmentByRoot = new Map<string, LaneSegment>()
  for (const row of rows) {
    const root = find(row.sha)
    let segment = segmentByRoot.get(root)
    if (!segment) {
      segment = {
        id: root,
        lane: row.lane,
        shas: [],
        startRow: row.row,
        endRow: row.row,
        continuity: 0,
        maxConcurrency: 1,
      }
      segmentByRoot.set(root, segment)
    }
    segment.shas.push(row.sha)
    segment.startRow = Math.min(segment.startRow, row.row)
    segment.endRow = Math.max(segment.endRow, row.row)

    const firstParent = row.parentShas[0]
    const parent = firstParent ? rowBySha.get(firstParent) : undefined
    if (parent) {
      segment.continuity += Math.abs(parent.row - row.row)
      // A first-parent edge that reconnects into another lane continues along
      // the source gutter until the parent row. Count that complete rail as
      // occupied, otherwise another disconnected branch can be packed into
      // the same gutter and the two colored rails render on top of each other.
      if (parent.lane !== row.lane) {
        extendSegmentToRow(segment, parent.row)
      }
    }
  }

  // Merge edges approach on the merge parent's gutter. Keep that target
  // segment occupied up to the merge commit for the same reason.
  for (const row of rows) {
    for (const parentSha of row.parentShas.slice(1)) {
      const parent = rowBySha.get(parentSha)
      if (!parent) continue
      const parentSegment = segmentByRoot.get(find(parent.sha))
      if (!parentSegment) continue
      parentSegment.continuity += Math.abs(parent.row - row.row)
      extendSegmentToRow(parentSegment, row.row)
    }
  }

  return [...segmentByRoot.values()]
}

function extendSegmentToRow(segment: LaneSegment, row: number): void {
  segment.startRow = Math.min(segment.startRow, row)
  segment.endRow = Math.max(segment.endRow, row)
}

function orderSide(
  segments: LaneSegment[],
  side: 'left' | 'right',
  laneBySha: Map<string, number>,
): void {
  if (segments.length === 0) return
  computeMaxConcurrency(segments)

  const maxSlot = Math.max(...segments.map((segment) => Math.abs(segment.lane)))
  const assignedBySlot = new Map<number, LaneSegment[]>()
  const longestFirst = [...segments].sort((left, right) => (
    right.continuity - left.continuity
    || (right.endRow - right.startRow) - (left.endRow - left.startRow)
    || left.startRow - right.startRow
    || Math.abs(left.lane) - Math.abs(right.lane)
    || left.id.localeCompare(right.id)
  ))

  for (const segment of longestFirst) {
    let slot = findAvailableSlot(segment, assignedBySlot, segment.maxConcurrency, 1, -1)
    if (slot === undefined) {
      slot = findAvailableSlot(segment, assignedBySlot, segment.maxConcurrency + 1, maxSlot, 1)
    }
    slot ??= Math.abs(segment.lane)

    const assigned = assignedBySlot.get(slot)
    if (assigned) assigned.push(segment)
    else assignedBySlot.set(slot, [segment])

    const lane = side === 'left' ? -slot : slot
    for (const sha of segment.shas) laneBySha.set(sha, lane)
  }
}

function computeMaxConcurrency(segments: LaneSegment[]): void {
  const byStart = [...segments].sort((left, right) => left.startRow - right.startRow)
  let active: LaneSegment[] = []

  for (const segment of byStart) {
    active = active.filter((candidate) => candidate.endRow >= segment.startRow)
    active.push(segment)
    const concurrency = active.length
    for (const candidate of active) {
      candidate.maxConcurrency = Math.max(candidate.maxConcurrency, concurrency)
    }
  }
}

function findAvailableSlot(
  segment: LaneSegment,
  assignedBySlot: Map<number, LaneSegment[]>,
  from: number,
  to: number,
  step: 1 | -1,
): number | undefined {
  for (let slot = from; step > 0 ? slot <= to : slot >= to; slot += step) {
    const assigned = assignedBySlot.get(slot) ?? []
    if (assigned.every((candidate) => !segmentsOverlap(segment, candidate))) return slot
  }
  return undefined
}

function segmentsOverlap(left: LaneSegment, right: LaneSegment): boolean {
  return left.startRow <= right.endRow && right.startRow <= left.endRow
}
