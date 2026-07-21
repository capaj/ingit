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
  inwardSegmentId?: string
}

/**
 * Reorder connected rail segments on each side of the center line so long
 * uninterrupted rails sit outside shorter-lived branches. A branch whose
 * first parent is already on a non-center rail stays on that rail's side and
 * occupies a gutter farther outward. Lanes are reusable, so disconnected
 * segments that happened to use the same original lane are deliberately
 * allowed to land in different gutters. When `maxLaneRadius` is provided,
 * exhausted gutters are reused by choosing the lane with the least vertical
 * overlap instead of growing the graph beyond that hard bound.
 */
export function orderLaneSegmentsByContinuity(
  rows: LaneRow[],
  maxLaneRadius?: number,
): Map<string, number> {
  const boundedRadius = maxLaneRadius === undefined
    ? undefined
    : Math.max(0, Math.floor(maxLaneRadius))
  if (boundedRadius === 0) {
    return new Map(rows.map((row) => [row.sha, 0]))
  }

  const segments = buildSegments(rows)
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const sideBySegment = resolveSegmentSides(segments, segmentById, boundedRadius)
  const laneBySha = new Map<string, number>()

  for (const segment of segments) {
    if (segment.lane === 0) {
      for (const sha of segment.shas) laneBySha.set(sha, 0)
    }
  }

  orderSide(
    segments.filter((segment) => sideBySegment.get(segment.id) === 'left'),
    'left',
    laneBySha,
    segmentById,
    boundedRadius,
  )
  orderSide(
    segments.filter((segment) => sideBySegment.get(segment.id) === 'right'),
    'right',
    laneBySha,
    segmentById,
    boundedRadius,
  )
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

  // A cross-lane first-parent edge means this segment is a branch nested off
  // the parent segment. If that parent is not the center line, keeping the
  // child on the opposite side creates a long edge across lane 0. Record the
  // relationship so ordering can keep the child just outside its parent.
  for (const row of rows) {
    const parentSha = row.parentShas[0]
    const parent = parentSha ? rowBySha.get(parentSha) : undefined
    if (!parent) continue

    const segment = segmentByRoot.get(find(row.sha))
    const parentSegment = segmentByRoot.get(find(parent.sha))
    if (
      segment
      && parentSegment
      && segment.id !== parentSegment.id
      && segment.lane !== 0
      && parentSegment.lane !== 0
    ) {
      segment.inwardSegmentId ??= parentSegment.id
    }
  }

  return [...segmentByRoot.values()]
}

function extendSegmentToRow(segment: LaneSegment, row: number): void {
  segment.startRow = Math.min(segment.startRow, row)
  segment.endRow = Math.max(segment.endRow, row)
}

type LaneSide = 'left' | 'right'

function resolveSegmentSides(
  segments: LaneSegment[],
  segmentById: Map<string, LaneSegment>,
  maxLaneRadius?: number,
): Map<string, LaneSide> {
  const sideBySegment = new Map<string, LaneSide>()
  const resolving = new Set<string>()

  const resolve = (segment: LaneSegment): LaneSide => {
    const resolved = sideBySegment.get(segment.id)
    if (resolved) return resolved

    // The commit graph is acyclic, but retain the allocator's original side
    // if malformed input ever presents a segment cycle.
    if (resolving.has(segment.id)) {
      return segment.lane < 0 ? 'left' : 'right'
    }

    resolving.add(segment.id)
    const inwardSegment = segment.inwardSegmentId
      ? segmentById.get(segment.inwardSegmentId)
      : undefined
    const side = inwardSegment && inwardSegment.lane !== 0
      ? resolve(inwardSegment)
      : segment.lane < 0 ? 'left' : 'right'
    resolving.delete(segment.id)
    sideBySegment.set(segment.id, side)
    return side
  }

  for (const segment of segments) {
    if (segment.lane !== 0) resolve(segment)
  }

  // A bounded viewport has a fixed number of physical gutters on both sides.
  // The semantic allocator can produce many more lanes on one side than the
  // other, especially near the tips of a busy repository. Fill an empty
  // opposite-side gutter before stacking overlapping rail families in the
  // same physical lane. A root and all of its nested branches move together.
  if (maxLaneRadius !== undefined) {
    balanceRootSegmentSides(
      segments,
      segmentById,
      maxLaneRadius,
      sideBySegment,
    )
  }

  return sideBySegment
}

function balanceRootSegmentSides(
  segments: LaneSegment[],
  segmentById: Map<string, LaneSegment>,
  maxLaneRadius: number,
  sideBySegment: Map<string, LaneSide>,
): void {
  const assignedBySide: Record<LaneSide, Map<number, LaneSegment[]>> = {
    left: new Map(),
    right: new Map(),
  }
  const rootBySegmentId = new Map<string, string>()
  const findingRoots = new Set<string>()
  const findRootId = (segment: LaneSegment): string => {
    const cached = rootBySegmentId.get(segment.id)
    if (cached) return cached
    if (findingRoots.has(segment.id)) return segment.id
    findingRoots.add(segment.id)
    const inwardSegment = segment.inwardSegmentId
      ? segmentById.get(segment.inwardSegmentId)
      : undefined
    const rootId = inwardSegment && inwardSegment.lane !== 0
      ? findRootId(inwardSegment)
      : segment.id
    findingRoots.delete(segment.id)
    rootBySegmentId.set(segment.id, rootId)
    return rootId
  }
  const familiesByRootId = new Map<string, LaneSegment[]>()
  for (const segment of segments) {
    if (segment.lane === 0) continue
    const rootId = findRootId(segment)
    const family = familiesByRootId.get(rootId)
    if (family) family.push(segment)
    else familiesByRootId.set(rootId, [segment])
  }
  const families = [...familiesByRootId.entries()].sort((left, right) => {
    const leftContinuity = left[1]
      .reduce((total, segment) => total + segment.continuity, 0)
    const rightContinuity = right[1]
      .reduce((total, segment) => total + segment.continuity, 0)
    return rightContinuity - leftContinuity
      || compareSegmentsByContinuity(
        segmentById.get(left[0]) as LaneSegment,
        segmentById.get(right[0]) as LaneSegment,
      )
  })

  for (const [rootId, family] of families) {
    const root = segmentById.get(rootId) as LaneSegment
    const preferredSide: LaneSide = root.lane < 0 ? 'left' : 'right'
    const oppositeSide: LaneSide = preferredSide === 'left' ? 'right' : 'left'
    const preferredOverlap = familyPlacementOverlap(
      family,
      assignedBySide[preferredSide],
      maxLaneRadius,
    )
    const oppositeOverlap = familyPlacementOverlap(
      family,
      assignedBySide[oppositeSide],
      maxLaneRadius,
    )
    const side = oppositeOverlap < preferredOverlap
      ? oppositeSide
      : preferredSide
    for (const segment of family) sideBySegment.set(segment.id, side)
    placeFamilyInSlots(
      family,
      assignedBySide[side],
      maxLaneRadius,
    )
  }
}

function familyPlacementOverlap(
  family: LaneSegment[],
  assignedBySlot: Map<number, LaneSegment[]>,
  maxLaneRadius: number,
): number {
  const trialSlots = new Map(
    [...assignedBySlot].map(([slot, assigned]) => [slot, [...assigned]]),
  )
  return placeFamilyInSlots(family, trialSlots, maxLaneRadius)
}

function placeFamilyInSlots(
  family: LaneSegment[],
  assignedBySlot: Map<number, LaneSegment[]>,
  maxLaneRadius: number,
): number {
  let totalOverlap = 0
  for (const segment of [...family].sort(compareSegmentsByContinuity)) {
    const slot = findLeastConflictingSlot(
      segment,
      assignedBySlot,
      maxLaneRadius,
      Math.min(Math.abs(segment.lane), maxLaneRadius),
    )
    const assigned = assignedBySlot.get(slot) ?? []
    totalOverlap += assigned.reduce(
      (total, candidate) => total + segmentOverlapRows(segment, candidate),
      0,
    )
    if (assigned.length > 0) assigned.push(segment)
    else assignedBySlot.set(slot, [segment])
  }
  return totalOverlap
}

function orderSide(
  segments: LaneSegment[],
  side: 'left' | 'right',
  laneBySha: Map<string, number>,
  segmentById: Map<string, LaneSegment>,
  maxLaneRadius?: number,
): void {
  if (segments.length === 0) return

  const assignedBySlot = new Map<number, LaneSegment[]>()
  const slotBySegment = new Map<string, number>()
  const nestedSegments = segments.filter((segment) => {
    const inwardSegment = segment.inwardSegmentId
      ? segmentById.get(segment.inwardSegmentId)
      : undefined
    return inwardSegment !== undefined && inwardSegment.lane !== 0
  })
  const nestedSegmentIds = new Set(nestedSegments.map((segment) => segment.id))
  const rootSegments = segments.filter((segment) => !nestedSegmentIds.has(segment.id))

  computeMaxConcurrency(rootSegments)
  const maxSlot = maxLaneRadius
    ?? Math.max(0, ...rootSegments.map((segment) => Math.abs(segment.lane)))
  const longestFirst = [...rootSegments].sort(compareSegmentsByContinuity)

  for (const segment of longestFirst) {
    const preferredSlot = maxLaneRadius === undefined
      ? segment.maxConcurrency
      : Math.min(segment.maxConcurrency, maxSlot)
    let slot = findAvailableSlot(segment, assignedBySlot, preferredSlot, 1, -1)
    if (slot === undefined) {
      slot = findAvailableSlot(segment, assignedBySlot, preferredSlot + 1, maxSlot, 1)
    }
    slot ??= maxLaneRadius === undefined
      ? Math.abs(segment.lane)
      : findLeastConflictingSlot(
          segment,
          assignedBySlot,
          maxSlot,
          Math.min(Math.abs(segment.lane), maxSlot),
        )

    assignSegment(segment, slot, side, laneBySha, assignedBySlot, slotBySegment)
  }

  const pending = new Set(nestedSegments)
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((segment) => (
        segment.inwardSegmentId !== undefined
        && slotBySegment.has(segment.inwardSegmentId)
      ))
      .sort((left, right) => {
        const leftInwardSlot = slotBySegment.get(left.inwardSegmentId as string) as number
        const rightInwardSlot = slotBySegment.get(right.inwardSegmentId as string) as number
        return leftInwardSlot - rightInwardSlot
          || left.continuity - right.continuity
          || (left.endRow - left.startRow) - (right.endRow - right.startRow)
          || left.startRow - right.startRow
          || left.id.localeCompare(right.id)
      })

    if (ready.length === 0) {
      // Missing/cyclic ancestry should not prevent the graph from rendering.
      // Fall back to each segment's original distance from center.
      for (const segment of pending) {
        const preferredSlot = Math.max(1, Math.abs(segment.lane))
        const slot = maxLaneRadius === undefined
          ? findAvailableSlotOutward(segment, assignedBySlot, preferredSlot)
          : findBoundedNestedSlot(
              segment,
              assignedBySlot,
              maxLaneRadius,
              Math.min(preferredSlot, maxLaneRadius),
            )
        assignSegment(segment, slot, side, laneBySha, assignedBySlot, slotBySegment)
      }
      break
    }

    for (const segment of ready) {
      const inwardSlot = slotBySegment.get(segment.inwardSegmentId as string) as number
      const slot = maxLaneRadius === undefined
        ? findAvailableSlotOutward(segment, assignedBySlot, inwardSlot + 1)
        : findBoundedNestedSlot(
            segment,
            assignedBySlot,
            maxLaneRadius,
            Math.min(inwardSlot + 1, maxLaneRadius),
            inwardSlot,
          )
      assignSegment(segment, slot, side, laneBySha, assignedBySlot, slotBySegment)
      pending.delete(segment)
    }
  }
}

function compareSegmentsByContinuity(left: LaneSegment, right: LaneSegment): number {
  return right.continuity - left.continuity
    || (right.endRow - right.startRow) - (left.endRow - left.startRow)
    || left.startRow - right.startRow
    || Math.abs(left.lane) - Math.abs(right.lane)
    || left.id.localeCompare(right.id)
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

function assignSegment(
  segment: LaneSegment,
  slot: number,
  side: LaneSide,
  laneBySha: Map<string, number>,
  assignedBySlot: Map<number, LaneSegment[]>,
  slotBySegment: Map<string, number>,
): void {
  const assigned = assignedBySlot.get(slot)
  if (assigned) assigned.push(segment)
  else assignedBySlot.set(slot, [segment])
  slotBySegment.set(segment.id, slot)

  const lane = side === 'left' ? -slot : slot
  for (const sha of segment.shas) laneBySha.set(sha, lane)
}

function findBoundedNestedSlot(
  segment: LaneSegment,
  assignedBySlot: Map<number, LaneSegment[]>,
  maxSlot: number,
  preferredSlot: number,
  avoidSlot?: number,
): number {
  let slot = findAvailableSlot(segment, assignedBySlot, preferredSlot, maxSlot, 1)
  if (slot === avoidSlot) slot = undefined

  if (slot === undefined) {
    slot = findAvailableSlot(segment, assignedBySlot, 1, preferredSlot - 1, 1)
    if (slot === avoidSlot) slot = undefined
  }

  return slot ?? findLeastConflictingSlot(
    segment,
    assignedBySlot,
    maxSlot,
    preferredSlot,
    avoidSlot,
  )
}

function findLeastConflictingSlot(
  segment: LaneSegment,
  assignedBySlot: Map<number, LaneSegment[]>,
  maxSlot: number,
  preferredSlot: number,
  avoidSlot?: number,
): number {
  let bestSlot = 1
  let bestOverlap = Infinity
  let bestDistance = Infinity

  for (let slot = 1; slot <= maxSlot; slot++) {
    if (maxSlot > 1 && slot === avoidSlot) continue
    const overlap = (assignedBySlot.get(slot) ?? [])
      .reduce((total, candidate) => total + segmentOverlapRows(segment, candidate), 0)
    const distance = Math.abs(slot - preferredSlot)
    if (
      overlap < bestOverlap
      || (overlap === bestOverlap && distance < bestDistance)
      || (overlap === bestOverlap && distance === bestDistance && slot < bestSlot)
    ) {
      bestSlot = slot
      bestOverlap = overlap
      bestDistance = distance
    }
  }

  return bestSlot
}

function findAvailableSlotOutward(
  segment: LaneSegment,
  assignedBySlot: Map<number, LaneSegment[]>,
  from: number,
): number {
  for (let slot = from; ; slot++) {
    const assigned = assignedBySlot.get(slot) ?? []
    if (assigned.every((candidate) => !segmentsOverlap(segment, candidate))) return slot
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

function segmentOverlapRows(left: LaneSegment, right: LaneSegment): number {
  const startRow = Math.max(left.startRow, right.startRow)
  const endRow = Math.min(left.endRow, right.endRow)
  return endRow < startRow ? 0 : endRow - startRow + 1
}
