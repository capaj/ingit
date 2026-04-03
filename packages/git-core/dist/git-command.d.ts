export declare class GitCommandError extends Error {
    readonly code: number;
    readonly stderr: string;
    readonly args: string[];
    constructor(args: string[], code: number, stderr: string);
}
export interface GitRunResult {
    stdout: string;
    stderr: string;
    code: number;
}
export interface GitRunOptions {
    timeout?: number;
    signal?: AbortSignal;
}
export declare function runGit(args: string[], cwd: string, opts?: GitRunOptions): Promise<GitRunResult>;
export declare function runGitLines(args: string[], cwd: string, opts?: GitRunOptions): Promise<string[]>;
//# sourceMappingURL=git-command.d.ts.map