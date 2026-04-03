import type { EdgeSegment } from '@ingit/rpc-contract';
export type { EdgeSegment };
export interface RowDescriptor {
    sha: string;
    parentShas: string[];
    row: number;
    lane: number;
}
/**
 * Build edge segments for a set of commit rows.
 *
 * For each row:
 * - First parent: 'linear' if same lane, 'fork' if different lane.
 * - Additional parents (merge parents): 'merge'.
 * - If a parent is not found in shaToRow, toRow is set to -1 as a sentinel
 *   meaning "continues beyond the loaded viewport".
 */
export declare function buildEdges(rows: RowDescriptor[], shaToRow: Map<string, number>, shaToLane: Map<string, number>): EdgeSegment[];
//# sourceMappingURL=edge-builder.d.ts.map