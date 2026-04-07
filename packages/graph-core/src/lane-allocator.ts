import type { LaneSnapshot } from './types.js'

export type { LaneSnapshot }

/**
 * Lane allocator for commit graph visualization.
 *
 * Hard-caps the number of lanes. When all lanes are occupied,
 * the allocator forces reuse by evicting the least recently
 * referenced lane.
 */
export class LaneAllocator {
  private activeLanes: (string | null)[]
  private reserved: Map<string, number> = new Map()
  private maxLanes: number

  constructor(maxLanes: number = 8) {
    this.maxLanes = maxLanes
    this.activeLanes = new Array(maxLanes).fill(null) as (string | null)[]
  }

  /**
   * Pre-reserve a specific lane for a SHA before processing begins.
   * Used to ensure HEAD always gets lane 0.
   */
  reserveLane(sha: string, lane: number): void {
    this.reserved.set(sha, lane)
    this.activeLanes[lane] = sha
  }

  assignLane(sha: string, parentShas: string[]): number {
    let lane = this.reserved.get(sha)

    if (lane !== undefined) {
      this.reserved.delete(sha)
      this.activeLanes[lane] = sha
    } else {
      lane = this.findFreeLane()
      this.activeLanes[lane] = sha
    }

    if (parentShas.length === 0) {
      this.activeLanes[lane] = null
      return lane
    }

    // First parent continues straight down.
    const firstParent = parentShas[0]
    if (!this.reserved.has(firstParent)) {
      this.reserved.set(firstParent, lane)
      this.activeLanes[lane] = firstParent
    } else if (this.reserved.get(firstParent) === lane) {
      // Parent is already reserved in this same lane — keep it occupied
      // so no other commit can steal the lane in between.
      this.activeLanes[lane] = firstParent
    } else {
      this.activeLanes[lane] = null
    }

    // Merge parents: reserve a nearby lane.
    for (let i = 1; i < parentShas.length; i++) {
      const mp = parentShas[i]
      if (!this.reserved.has(mp)) {
        const mLane = this.findFreeLaneNear(lane)
        this.reserved.set(mp, mLane)
        this.activeLanes[mLane] = mp
      }
    }

    return lane
  }

  private findFreeLane(): number {
    for (let i = 0; i < this.activeLanes.length; i++) {
      if (this.activeLanes[i] === null) return i
    }
    // All lanes occupied — evict the first lane that is NOT reserved
    // (i.e., nobody is waiting for it, so it's "stale").
    for (let i = this.activeLanes.length - 1; i >= 0; i--) {
      const occupant = this.activeLanes[i]
      if (occupant && !this.reserved.has(occupant)) {
        this.activeLanes[i] = null
        return i
      }
    }
    // Worst case: evict the highest lane.
    this.activeLanes[this.activeLanes.length - 1] = null
    return this.activeLanes.length - 1
  }

  private findFreeLaneNear(target: number): number {
    for (let dist = 1; dist < this.activeLanes.length; dist++) {
      const right = target + dist
      if (right < this.activeLanes.length && this.activeLanes[right] === null) return right
      const left = target - dist
      if (left >= 0 && this.activeLanes[left] === null) return left
    }
    // No free lane — evict.
    return this.findFreeLane()
  }

  snapshot(): LaneSnapshot {
    return { activeLanes: [...this.activeLanes] }
  }

  restore(snapshot: LaneSnapshot): void {
    this.activeLanes = [...snapshot.activeLanes]
    this.reserved = new Map()
    for (let i = 0; i < this.activeLanes.length; i++) {
      const sha = this.activeLanes[i]
      if (sha !== null) {
        this.reserved.set(sha, i)
      }
    }
  }
}
