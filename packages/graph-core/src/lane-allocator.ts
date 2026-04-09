import type { LaneSnapshot } from './types.js'

export type { LaneSnapshot }

/**
 * Lane allocator for commit graph visualization.
 *
 * Lane 0 is reserved for the current branch and acts as the visual center.
 * Side branches grow outward on both sides without a fixed cap.
 */
export class LaneAllocator {
  private activeLanes: Map<number, string> = new Map()
  private reserved: Map<string, number> = new Map()
  private nextSideFromCenter: 'left' | 'right' = 'right'

  constructor(_maxLanes?: number) {}

  /**
   * Pre-reserve a specific lane for a SHA before processing begins.
   * Used to ensure HEAD always gets the center lane.
   */
  reserveLane(sha: string, lane: number): void {
    this.reserved.set(sha, lane)
    this.activeLanes.set(lane, sha)
  }

  assignLane(sha: string, parentShas: string[]): number {
    let lane = this.reserved.get(sha)

    if (lane !== undefined) {
      this.reserved.delete(sha)
      this.activeLanes.set(lane, sha)
    } else {
      const firstParent = parentShas[0]
      const preferredParentLane = firstParent ? this.reserved.get(firstParent) : undefined
      lane = preferredParentLane !== undefined
        ? this.findFreeLaneNear(preferredParentLane)
        : this.findFreeLane()
      this.activeLanes.set(lane, sha)
    }

    if (parentShas.length === 0) {
      this.activeLanes.delete(lane)
      return lane
    }

    // First parent continues straight down.
    const firstParent = parentShas[0]
    if (!this.reserved.has(firstParent)) {
      this.reserved.set(firstParent, lane)
      this.activeLanes.set(lane, firstParent)
    } else if (this.reserved.get(firstParent) === lane) {
      // Parent is already reserved in this same lane — keep it occupied
      // so no other commit can steal the lane in between.
      this.activeLanes.set(lane, firstParent)
    } else {
      this.activeLanes.delete(lane)
    }

    // Merge parents should live on the outside of the active cluster so they
    // do not block the inner lanes needed by future side-branch tips.
    for (let i = 1; i < parentShas.length; i++) {
      const mp = parentShas[i]
      if (!this.reserved.has(mp)) {
        const mLane = this.findFreeLaneOutsideCluster()
        this.reserved.set(mp, mLane)
        this.activeLanes.set(mLane, mp)
      }
    }

    return lane
  }

  private findFreeLane(): number {
    if (!this.activeLanes.has(0)) {
      return 0
    }

    for (let distance = 1; ; distance++) {
      const leftLane = this.activeLanes.has(-distance) ? undefined : -distance
      const rightLane = this.activeLanes.has(distance) ? undefined : distance

      if (leftLane === undefined && rightLane === undefined) continue
      return this.pickLaneFromCenter(leftLane, rightLane)
    }
  }

  private findFreeLaneNear(target: number): number {
    for (let distance = 1; ; distance++) {
      const leftLane = target - distance
      const rightLane = target + distance
      const leftFree = !this.activeLanes.has(leftLane)
      const rightFree = !this.activeLanes.has(rightLane)

      if (!leftFree && !rightFree) continue

      // Once a branch is already on one side of the current branch, keep
      // extending that side outward instead of crossing back through center.
      if (target < 0) {
        return leftFree ? leftLane : rightLane
      }

      if (target > 0) {
        return rightFree ? rightLane : leftLane
      }

      return this.pickLaneFromCenter(leftFree ? leftLane : undefined, rightFree ? rightLane : undefined)
    }
  }

  private findFreeLaneOutsideCluster(): number {
    if (this.activeLanes.size === 0) {
      return this.findFreeLane()
    }

    let minLane = Infinity
    let maxLane = -Infinity

    for (const lane of this.activeLanes.keys()) {
      if (lane < minLane) minLane = lane
      if (lane > maxLane) maxLane = lane
    }

    return this.pickLaneFromCenter(minLane - 1, maxLane + 1)
  }

  private pickLaneFromCenter(leftLane?: number, rightLane?: number): number {
    if (leftLane === undefined && rightLane === undefined) {
      throw new Error('pickLaneFromCenter requires at least one candidate lane')
    }

    if (leftLane === undefined) {
      this.recordChosenSide('right')
      return rightLane as number
    }

    if (rightLane === undefined) {
      this.recordChosenSide('left')
      return leftLane as number
    }

    const leftLoad = this.sideLoad('left')
    const rightLoad = this.sideLoad('right')

    if (leftLoad < rightLoad) {
      this.recordChosenSide('left')
      return leftLane
    }

    if (rightLoad < leftLoad) {
      this.recordChosenSide('right')
      return rightLane
    }

    const chosenSide = this.nextSideFromCenter
    this.recordChosenSide(chosenSide)
    return chosenSide === 'left' ? leftLane : rightLane
  }

  private sideLoad(side: 'left' | 'right'): number {
    let count = 0
    for (const lane of this.activeLanes.keys()) {
      if (side === 'left' && lane < 0) count++
      if (side === 'right' && lane > 0) count++
    }
    return count
  }

  private recordChosenSide(side: 'left' | 'right'): void {
    this.nextSideFromCenter = side === 'left' ? 'right' : 'left'
  }

  snapshot(): LaneSnapshot {
    return {
      activeLanes: [...this.activeLanes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([lane, sha]) => ({ lane, sha })),
      nextSideFromCenter: this.nextSideFromCenter,
    }
  }

  restore(snapshot: LaneSnapshot): void {
    this.activeLanes = new Map()
    this.reserved = new Map()
    this.nextSideFromCenter = snapshot.nextSideFromCenter

    for (const entry of snapshot.activeLanes) {
      this.activeLanes.set(entry.lane, entry.sha)
      this.reserved.set(entry.sha, entry.lane)
    }
  }
}
