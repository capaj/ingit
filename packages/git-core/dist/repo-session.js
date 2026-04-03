import { randomBytes } from 'node:crypto';
import { runGit } from './git-command.js';
import { GitCommandScheduler } from './scheduler.js';
import { CatFileProcess } from './cat-file-process.js';
import { CommitHydrator } from './hydrator.js';
import { parseRefs } from './parsers/ref-parser.js';
import { parseStatus } from './parsers/status-parser.js';
import { parseDiffTree } from './parsers/diff-tree-parser.js';
import { streamRevList } from './parsers/rev-list-parser.js';
export class RepoSession {
    repoId;
    rootPath;
    gitDir;
    head;
    scheduler;
    catFile;
    hydrator;
    constructor(repoId, rootPath, gitDir, head, scheduler, catFile) {
        this.repoId = repoId;
        this.rootPath = rootPath;
        this.gitDir = gitDir;
        this.head = head;
        this.scheduler = scheduler;
        this.catFile = catFile;
        this.hydrator = new CommitHydrator(catFile);
    }
    static async open(repoPath) {
        // Validate and resolve root path
        const { stdout: toplevel } = await runGit(['rev-parse', '--show-toplevel'], repoPath);
        const rootPath = toplevel.trim();
        const { stdout: gitDirOut } = await runGit(['rev-parse', '--git-dir'], rootPath);
        const gitDir = gitDirOut.trim();
        // Resolve HEAD sha
        const { stdout: headShaOut } = await runGit(['rev-parse', 'HEAD'], rootPath);
        const headSha = headShaOut.trim();
        // Determine if HEAD is symbolic or detached
        let headRefName;
        let headKind = 'detached';
        try {
            const { stdout: symRef } = await runGit(['symbolic-ref', '--quiet', 'HEAD'], rootPath);
            const trimmed = symRef.trim();
            if (trimmed) {
                headRefName = trimmed;
                headKind = 'symbolic';
            }
        }
        catch {
            // detached HEAD — expected
        }
        const head = {
            kind: headKind,
            sha: headSha,
            ...(headRefName ? { refName: headRefName } : {}),
        };
        const repoId = randomBytes(4).toString('hex');
        const scheduler = new GitCommandScheduler(rootPath);
        const catFile = new CatFileProcess(rootPath);
        return new RepoSession(repoId, rootPath, gitDir, head, scheduler, catFile);
    }
    getRefs() {
        return parseRefs(this.rootPath);
    }
    getStatus() {
        return parseStatus(this.rootPath);
    }
    async getCommitDetail(sha) {
        return this.hydrator.hydrateCommit(sha);
    }
    getCommitDiff(sha) {
        return parseDiffTree(this.rootPath, sha);
    }
    streamTopology(args, onCommit, signal) {
        return streamRevList(args, this.rootPath, onCommit, signal);
    }
    close() {
        this.catFile.close();
    }
}
//# sourceMappingURL=repo-session.js.map