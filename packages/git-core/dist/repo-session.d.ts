import type { RefSummary, WorktreeStatusResponse, CommitDetailResponse, ChangedPath } from '@ingit/rpc-contract';
import { GitCommandScheduler } from './scheduler.js';
import { CatFileProcess } from './cat-file-process.js';
import type { RevListEntry } from './parsers/rev-list-parser.js';
export interface HeadState {
    kind: 'symbolic' | 'detached';
    refName?: string;
    sha: string;
}
export declare class RepoSession {
    readonly repoId: string;
    readonly rootPath: string;
    readonly gitDir: string;
    readonly head: HeadState;
    readonly scheduler: GitCommandScheduler;
    readonly catFile: CatFileProcess;
    private readonly hydrator;
    private constructor();
    static open(repoPath: string): Promise<RepoSession>;
    getRefs(): Promise<RefSummary[]>;
    getStatus(): Promise<WorktreeStatusResponse>;
    getCommitDetail(sha: string): Promise<CommitDetailResponse>;
    getCommitDiff(sha: string): Promise<ChangedPath[]>;
    streamTopology(args: string[], onCommit: (entry: RevListEntry) => void, signal?: AbortSignal): Promise<number>;
    close(): void;
}
//# sourceMappingURL=repo-session.d.ts.map