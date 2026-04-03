import { GitRunResult } from './git-command.js';
export type Priority = 'interactive' | 'normal' | 'background';
export declare class GitCommandScheduler {
    private readonly cwd;
    private queues;
    private running;
    constructor(cwd: string);
    enqueue(job: {
        args: string[];
        priority: Priority;
        signal?: AbortSignal;
    }): Promise<GitRunResult>;
    private drain;
    private runJob;
}
//# sourceMappingURL=scheduler.d.ts.map