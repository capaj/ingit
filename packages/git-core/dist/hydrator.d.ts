import type { CommitDetailResponse } from '@ingit/rpc-contract';
import type { CatFileProcess } from './cat-file-process.js';
export declare class CommitHydrator {
    private catFile;
    constructor(catFile: CatFileProcess);
    hydrateCommit(sha: string): Promise<CommitDetailResponse>;
}
//# sourceMappingURL=hydrator.d.ts.map