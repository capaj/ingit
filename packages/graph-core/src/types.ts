export interface TopoEntry {
  sha: string
  parentShas: string[]
  row: number
}

export interface ActiveLaneEntry {
  lane: number
  sha: string
}

export interface LaneSnapshot {
  activeLanes: ActiveLaneEntry[]
  nextSideFromCenter: 'left' | 'right'
}

export interface ProjectionCheckpoint {
  row: number
  sha: string
  laneSnapshot: LaneSnapshot
}
