import type { EdgeSegment } from '@ingit/rpc-contract';
import { LaneAllocator } from './lane-allocator.js';
import type { TopoEntry, ProjectionCheckpoint, LaneSnapshot } from './types.js';
export type { TopoEntry, ProjectionCheckpoint, LaneSnapshot };
export interface ProjectionScope {
    kind: 'all' | 'ref' | 'range' | 'path';
    value?: string;
    secondaryValue?: string;
}
export interface GeometryResult {
    lanes: Map<string, number>;
    edges: EdgeSegment[];
}
export declare class Projection {
    readonly id: string;
    readonly repoId: string;
    readonly scope: ProjectionScope;
    readonly ordering: 'topo' | 'date';
    private entries;
    private shaIndex;
    constructor(id: string, repoId: string, scope: ProjectionScope, ordering: 'topo' | 'date');
    /**
     * Append new entries, assigning sequential row numbers starting from the
     * current total row count.
     */
    appendEntries(entries: Array<{
        sha: string;
        parentShas: string[];
    }>): void;
    /**
     * Returns a window of entries centred around anchorRow.
     * `before` entries before anchorRow and `after` entries after.
     */
    getWindow(anchorRow: number, before: number, after: number): {
        entries: TopoEntry[];
        startRow: number;
        endRow: number;
    };
    /** Look up the row number for a SHA. Returns undefined if not loaded. */
    findRow(sha: string): number | undefined;
    /** Total number of rows loaded so far. */
    totalRows(): number;
    /**
     * Compute checkpoint snapshots of lane allocator state at every `interval` rows.
     * The first checkpoint is always at row 0.
     */
    checkpoint(interval?: number): ProjectionCheckpoint[];
    /**
     * Restore the lane allocator to the state captured in a checkpoint so that
     * layout computation can resume from that row without replaying all prior rows.
     */
    restoreFrom(checkpoint: ProjectionCheckpoint, laneAllocator: LaneAllocator): void;
    /**
     * Compute graph geometry (lane assignments and edges) for the given row range.
     *
     * To produce accurate lane assignments for the window we replay from the
     * beginning of the projection (or from the nearest preceding checkpoint if
     * one is provided via `fromCheckpoint`). Lane assignments from before
     * `startRow` are replayed but not included in the returned map.
     */
    computeGeometry(startRow: number, endRow: number, fromCheckpoint?: ProjectionCheckpoint): GeometryResult;
}
//# sourceMappingURL=projection.d.ts.map