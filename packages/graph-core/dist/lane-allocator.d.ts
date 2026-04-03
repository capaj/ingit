import type { LaneSnapshot } from './types.js';
export type { LaneSnapshot };
export declare class LaneAllocator {
    private activeLanes;
    private reserved;
    /**
     * Assign a lane to the given commit SHA, given its parent SHAs.
     * Returns the lane index assigned to this commit.
     */
    assignLane(sha: string, parentShas: string[]): number;
    /** Return the current lane index reserved or active for a given SHA, if any. */
    currentLane(sha: string): number | undefined;
    snapshot(): LaneSnapshot;
    restore(snapshot: LaneSnapshot): void;
}
//# sourceMappingURL=lane-allocator.d.ts.map