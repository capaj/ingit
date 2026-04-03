export interface TopoEntry {
    sha: string;
    parentShas: string[];
    row: number;
}
export interface LaneSnapshot {
    activeLanes: (string | null)[];
}
export interface ProjectionCheckpoint {
    row: number;
    sha: string;
    laneSnapshot: LaneSnapshot;
}
//# sourceMappingURL=types.d.ts.map