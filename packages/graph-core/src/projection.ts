import type { EdgeSegment } from '@ingit/rpc-contract'
import { LaneAllocator } from './lane-allocator.js'
import { buildEdges } from './edge-builder.js'
import type { TopoEntry, ProjectionCheckpoint, LaneSnapshot } from './types.js'

export type { TopoEntry, ProjectionCheckpoint, LaneSnapshot }

export interface ProjectionScope {
  kind: 'all' | 'ref' | 'range' | 'path'
  value?: string
  secondaryValue?: string
}

export interface GeometryResult {
  lanes: Map<string, number>
  edges: EdgeSegment[]
}

export class Projection {
  readonly id: string
  readonly repoId: string
  readonly scope: ProjectionScope
  readonly ordering: 'topo' | 'date'

  private entries: TopoEntry[] = []
  private shaIndex: Map<string, number> = new Map() // sha -> index in entries array

  constructor(
    id: string,
    repoId: string,
    scope: ProjectionScope,
    ordering: 'topo' | 'date'
  ) {
    this.id = id
    this.repoId = repoId
    this.scope = scope
    this.ordering = ordering
  }

  /**
   * Append new entries, assigning sequential row numbers starting from the
   * current total row count.
   */
  appendEntries(entries: Array<{ sha: string; parentShas: string[] }>): void {
    const startRow = this.entries.length
    for (let i = 0; i < entries.length; i++) {
      const { sha, parentShas } = entries[i]
      const row = startRow + i
      this.entries.push({ sha, parentShas, row })
      this.shaIndex.set(sha, row)
    }
  }

  /**
   * Returns a window of entries centred around anchorRow.
   * `before` entries before anchorRow and `after` entries after.
   */
  getWindow(
    anchorRow: number,
    before: number,
    after: number
  ): { entries: TopoEntry[]; startRow: number; endRow: number } {
    const startRow = Math.max(0, anchorRow - before)
    const endRow = Math.min(this.entries.length - 1, anchorRow + after)
    return {
      entries: this.entries.slice(startRow, endRow + 1),
      startRow,
      endRow,
    }
  }

  /** Look up the row number for a SHA. Returns undefined if not loaded. */
  findRow(sha: string): number | undefined {
    return this.shaIndex.get(sha)
  }

  /** Total number of rows loaded so far. */
  totalRows(): number {
    return this.entries.length
  }

  /**
   * Compute checkpoint snapshots of lane allocator state at every `interval` rows.
   * The first checkpoint is always at row 0.
   */
  checkpoint(interval: number = 256): ProjectionCheckpoint[] {
    const checkpoints: ProjectionCheckpoint[] = []
    const allocator = new LaneAllocator()

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]

      if (i % interval === 0) {
        checkpoints.push({
          row: entry.row,
          sha: entry.sha,
          laneSnapshot: allocator.snapshot(),
        })
      }

      allocator.assignLane(entry.sha, entry.parentShas)
    }

    return checkpoints
  }

  /**
   * Restore the lane allocator to the state captured in a checkpoint so that
   * layout computation can resume from that row without replaying all prior rows.
   */
  restoreFrom(checkpoint: ProjectionCheckpoint, laneAllocator: LaneAllocator): void {
    laneAllocator.restore(checkpoint.laneSnapshot)
  }

  /**
   * Compute graph geometry (lane assignments and edges) for the given row range.
   *
   * To produce accurate lane assignments for the window we replay from the
   * beginning of the projection (or from the nearest preceding checkpoint if
   * one is provided via `fromCheckpoint`). Lane assignments from before
   * `startRow` are replayed but not included in the returned map.
   */
  computeGeometry(
    startRow: number,
    endRow: number,
    fromCheckpoint?: ProjectionCheckpoint,
    headSha?: string
  ): GeometryResult {
    const clampedStart = Math.max(0, startRow)
    const clampedEnd = Math.min(this.entries.length - 1, endRow)

    const allocator = new LaneAllocator()

    // Reserve lane 0 for HEAD's entire first-parent chain so the checked-out
    // branch always occupies the leftmost lane — matching Ungit's behavior
    // where switching branches rearranges the graph.
    if (headSha) {
      let walkSha: string | undefined = headSha
      while (walkSha !== undefined) {
        allocator.reserveLane(walkSha, 0)
        const idx = this.shaIndex.get(walkSha)
        if (idx === undefined) break
        const entry = this.entries[idx]
        walkSha = entry.parentShas.length > 0 ? entry.parentShas[0] : undefined
      }
    }

    // Determine where to start the replay.
    let replayFrom = 0
    if (fromCheckpoint && fromCheckpoint.row <= clampedStart) {
      this.restoreFrom(fromCheckpoint, allocator)
      replayFrom = fromCheckpoint.row
    }

    // Replay entries up to (but not including) the window to warm up the allocator.
    for (let i = replayFrom; i < clampedStart; i++) {
      const entry = this.entries[i]
      allocator.assignLane(entry.sha, entry.parentShas)
    }

    // Assign lanes for entries in the window and record them.
    const lanes = new Map<string, number>()
    const rowDescriptors: Array<{
      sha: string
      parentShas: string[]
      row: number
      lane: number
    }> = []

    for (let i = clampedStart; i <= clampedEnd; i++) {
      const entry = this.entries[i]
      const lane = allocator.assignLane(entry.sha, entry.parentShas)
      lanes.set(entry.sha, lane)
      rowDescriptors.push({ sha: entry.sha, parentShas: entry.parentShas, row: entry.row, lane })
    }

    // Build shaToRow and shaToLane maps covering all known entries so that
    // edges to parents outside the window get correct lane info where available.
    const shaToRow = new Map<string, number>()
    const shaToLane = new Map<string, number>(lanes)
    for (const entry of this.entries) {
      shaToRow.set(entry.sha, entry.row)
    }

    const edges = buildEdges(rowDescriptors, shaToRow, shaToLane)

    return { lanes, edges }
  }
}
