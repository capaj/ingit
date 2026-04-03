export interface RevListEntry {
    sha: string;
    parentShas: string[];
}
export declare function parseRevListLine(line: string): RevListEntry | null;
export declare function streamRevList(args: string[], cwd: string, onCommit: (entry: RevListEntry) => void, signal?: AbortSignal): Promise<number>;
//# sourceMappingURL=rev-list-parser.d.ts.map