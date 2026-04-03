import { LaneAllocator } from './lane-allocator.js';
import { buildEdges } from './edge-builder.js';
export class Projection {
    id;
    repoId;
    scope;
    ordering;
    entries = [];
    shaIndex = new Map(); // sha -> index in entries array
    constructor(id, repoId, scope, ordering) {
        this.id = id;
        this.repoId = repoId;
        this.scope = scope;
        this.ordering = ordering;
    }
    /**
     * Append new entries, assigning sequential row numbers starting from the
     * current total row count.
     */
    appendEntries(entries) {
        const startRow = this.entries.length;
        for (let i = 0; i < entries.length; i++) {
            const { sha, parentShas } = entries[i];
            const row = startRow + i;
            this.entries.push({ sha, parentShas, row });
            this.shaIndex.set(sha, row);
        }
    }
    /**
     * Returns a window of entries centred around anchorRow.
     * `before` entries before anchorRow and `after` entries after.
     */
    getWindow(anchorRow, before, after) {
        const startRow = Math.max(0, anchorRow - before);
        const endRow = Math.min(this.entries.length - 1, anchorRow + after);
        return {
            entries: this.entries.slice(startRow, endRow + 1),
            startRow,
            endRow,
        };
    }
    /** Look up the row number for a SHA. Returns undefined if not loaded. */
    findRow(sha) {
        return this.shaIndex.get(sha);
    }
    /** Total number of rows loaded so far. */
    totalRows() {
        return this.entries.length;
    }
    /**
     * Compute checkpoint snapshots of lane allocator state at every `interval` rows.
     * The first checkpoint is always at row 0.
     */
    checkpoint(interval = 256) {
        const checkpoints = [];
        const allocator = new LaneAllocator();
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (i % interval === 0) {
                checkpoints.push({
                    row: entry.row,
                    sha: entry.sha,
                    laneSnapshot: allocator.snapshot(),
                });
            }
            allocator.assignLane(entry.sha, entry.parentShas);
        }
        return checkpoints;
    }
    /**
     * Restore the lane allocator to the state captured in a checkpoint so that
     * layout computation can resume from that row without replaying all prior rows.
     */
    restoreFrom(checkpoint, laneAllocator) {
        laneAllocator.restore(checkpoint.laneSnapshot);
    }
    /**
     * Compute graph geometry (lane assignments and edges) for the given row range.
     *
     * To produce accurate lane assignments for the window we replay from the
     * beginning of the projection (or from the nearest preceding checkpoint if
     * one is provided via `fromCheckpoint`). Lane assignments from before
     * `startRow` are replayed but not included in the returned map.
     */
    computeGeometry(startRow, endRow, fromCheckpoint) {
        const clampedStart = Math.max(0, startRow);
        const clampedEnd = Math.min(this.entries.length - 1, endRow);
        const allocator = new LaneAllocator();
        // Determine where to start the replay.
        let replayFrom = 0;
        if (fromCheckpoint && fromCheckpoint.row <= clampedStart) {
            this.restoreFrom(fromCheckpoint, allocator);
            replayFrom = fromCheckpoint.row;
        }
        // Replay entries up to (but not including) the window to warm up the allocator.
        for (let i = replayFrom; i < clampedStart; i++) {
            const entry = this.entries[i];
            allocator.assignLane(entry.sha, entry.parentShas);
        }
        // Assign lanes for entries in the window and record them.
        const lanes = new Map();
        const rowDescriptors = [];
        for (let i = clampedStart; i <= clampedEnd; i++) {
            const entry = this.entries[i];
            const lane = allocator.assignLane(entry.sha, entry.parentShas);
            lanes.set(entry.sha, lane);
            rowDescriptors.push({ sha: entry.sha, parentShas: entry.parentShas, row: entry.row, lane });
        }
        // Build shaToRow and shaToLane maps covering all known entries so that
        // edges to parents outside the window get correct lane info where available.
        const shaToRow = new Map();
        const shaToLane = new Map(lanes);
        for (const entry of this.entries) {
            shaToRow.set(entry.sha, entry.row);
        }
        const edges = buildEdges(rowDescriptors, shaToRow, shaToLane);
        return { lanes, edges };
    }
}
//# sourceMappingURL=projection.js.map