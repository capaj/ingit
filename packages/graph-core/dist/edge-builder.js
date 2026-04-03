/**
 * Build edge segments for a set of commit rows.
 *
 * For each row:
 * - First parent: 'linear' if same lane, 'fork' if different lane.
 * - Additional parents (merge parents): 'merge'.
 * - If a parent is not found in shaToRow, toRow is set to -1 as a sentinel
 *   meaning "continues beyond the loaded viewport".
 */
export function buildEdges(rows, shaToRow, shaToLane) {
    const edges = [];
    for (const { sha: _sha, parentShas, row, lane } of rows) {
        for (let i = 0; i < parentShas.length; i++) {
            const parentSha = parentShas[i];
            const parentRow = shaToRow.get(parentSha) ?? -1;
            const parentLane = shaToLane.get(parentSha) ?? lane;
            let kind;
            if (i === 0) {
                kind = lane === parentLane ? 'linear' : 'fork';
            }
            else {
                kind = 'merge';
            }
            edges.push({
                fromRow: row,
                toRow: parentRow,
                fromLane: lane,
                toLane: parentLane,
                kind,
            });
        }
    }
    return edges;
}
//# sourceMappingURL=edge-builder.js.map