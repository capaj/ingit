import { randomBytes } from 'node:crypto'
import type { RefSummary, WorktreeStatusResponse, CommitDetailResponse, ChangedPath } from '@ingit/rpc-contract'
import { runGit, runGitLines } from './git-command.js'
import { GitCommandScheduler } from './scheduler.js'
import { CatFileProcess } from './cat-file-process.js'
import { CommitHydrator } from './hydrator.js'
import { parseRefs } from './parsers/ref-parser.js'
import { parseStatus } from './parsers/status-parser.js'
import { parseDiffTree } from './parsers/diff-tree-parser.js'
import { streamRevList } from './parsers/rev-list-parser.js'
import type { RevListEntry } from './parsers/rev-list-parser.js'

export interface HeadState {
  kind: 'symbolic' | 'detached'
  refName?: string
  sha: string
}

export class RepoSession {
  readonly repoId: string
  readonly rootPath: string
  readonly gitDir: string
  readonly head: HeadState
  readonly scheduler: GitCommandScheduler
  readonly catFile: CatFileProcess
  private readonly hydrator: CommitHydrator

  private constructor(
    repoId: string,
    rootPath: string,
    gitDir: string,
    head: HeadState,
    scheduler: GitCommandScheduler,
    catFile: CatFileProcess,
  ) {
    this.repoId = repoId
    this.rootPath = rootPath
    this.gitDir = gitDir
    this.head = head
    this.scheduler = scheduler
    this.catFile = catFile
    this.hydrator = new CommitHydrator(catFile)
  }

  static async open(repoPath: string): Promise<RepoSession> {
    // Validate and resolve root path
    const { stdout: toplevel } = await runGit(
      ['rev-parse', '--show-toplevel'],
      repoPath,
    )
    const rootPath = toplevel.trim()

    const { stdout: gitDirOut } = await runGit(
      ['rev-parse', '--git-dir'],
      rootPath,
    )
    const gitDir = gitDirOut.trim()

    // Resolve HEAD sha
    const { stdout: headShaOut } = await runGit(['rev-parse', 'HEAD'], rootPath)
    const headSha = headShaOut.trim()

    // Determine if HEAD is symbolic or detached
    let headRefName: string | undefined
    let headKind: 'symbolic' | 'detached' = 'detached'

    try {
      const { stdout: symRef } = await runGit(
        ['symbolic-ref', '--quiet', 'HEAD'],
        rootPath,
      )
      const trimmed = symRef.trim()
      if (trimmed) {
        headRefName = trimmed
        headKind = 'symbolic'
      }
    } catch {
      // detached HEAD — expected
    }

    const head: HeadState = {
      kind: headKind,
      sha: headSha,
      ...(headRefName ? { refName: headRefName } : {}),
    }

    const repoId = randomBytes(4).toString('hex')
    const scheduler = new GitCommandScheduler(rootPath)
    const catFile = new CatFileProcess(rootPath)

    return new RepoSession(repoId, rootPath, gitDir, head, scheduler, catFile)
  }

  getRefs(): Promise<RefSummary[]> {
    return parseRefs(this.rootPath)
  }

  getStatus(): Promise<WorktreeStatusResponse> {
    return parseStatus(this.rootPath)
  }

  async getCommitDetail(sha: string): Promise<CommitDetailResponse> {
    return this.hydrator.hydrateCommit(sha)
  }

  getCommitDiff(sha: string): Promise<ChangedPath[]> {
    return parseDiffTree(this.rootPath, sha)
  }

  streamTopology(
    args: string[],
    onCommit: (entry: RevListEntry) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    return streamRevList(args, this.rootPath, onCommit, signal)
  }

  close(): void {
    this.catFile.close()
  }
}
