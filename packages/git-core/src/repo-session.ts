import { randomBytes } from 'node:crypto'
import type { RefSummary, WorktreeStatusResponse, CommitDetailResponse } from '@ingit/rpc-contract'
import { runGit } from './git-command.js'
import { GitCommandScheduler } from './scheduler.js'
import { CatFileProcess } from './cat-file-process.js'
import { CommitHydrator } from './hydrator.js'
import { parseRefs } from './parsers/ref-parser.js'
import { parseStatus } from './parsers/status-parser.js'
import { parseCommitDiff } from './parsers/diff-tree-parser.js'
import { streamRevList, streamRevListWithMeta } from './parsers/rev-list-parser.js'
import type { RevListEntry, RevListEntryWithMeta } from './parsers/rev-list-parser.js'
import { ZiggitRepo } from './ziggit-ffi.js'

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
  readonly totalCommitCount: number
  readonly githubUrl: string | null
  readonly scheduler: GitCommandScheduler
  readonly catFile: CatFileProcess
  private readonly hydrator: CommitHydrator
  private readonly ziggit: ZiggitRepo

  private constructor(
    repoId: string,
    rootPath: string,
    gitDir: string,
    head: HeadState,
    totalCommitCount: number,
    githubUrl: string | null,
    scheduler: GitCommandScheduler,
    catFile: CatFileProcess,
    ziggit: ZiggitRepo,
  ) {
    this.repoId = repoId
    this.rootPath = rootPath
    this.gitDir = gitDir
    this.head = head
    this.totalCommitCount = totalCommitCount
    this.githubUrl = githubUrl
    this.scheduler = scheduler
    this.catFile = catFile
    this.hydrator = new CommitHydrator(catFile)
    this.ziggit = ziggit
  }

  static async open(repoPath: string): Promise<RepoSession> {
    // Validate and resolve root path (no ziggit equivalent for --show-toplevel)
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

    // Open ziggit handle for this repo
    const ziggit = new ZiggitRepo(rootPath)

    // Resolve HEAD sha via ziggit FFI (no subprocess)
    const headSha = ziggit.revParseHeadFast()

    // Determine if HEAD is symbolic or detached (no ziggit equivalent)
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

    // Get total commit count (no ziggit equivalent for rev-list --count)
    let totalCommitCount = 0
    try {
      const { stdout: countOut } = await runGit(['rev-list', '--count', '--exclude=refs/stash', '--all'], rootPath)
      totalCommitCount = parseInt(countOut.trim(), 10) || 0
    } catch {
      // fallback — not critical
    }

    // Resolve GitHub URL from origin remote via ziggit FFI
    let githubUrl: string | null = null
    try {
      const raw = ziggit.remoteGetUrl('origin')
      const sshMatch = raw.match(/git@github\.com:(.+?)(?:\.git)?$/)
      const httpsMatch = raw.match(/https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
      if (sshMatch) githubUrl = `https://github.com/${sshMatch[1]}`
      else if (httpsMatch) githubUrl = `https://github.com/${httpsMatch[1]}`
    } catch {
      // no remote or not github — fine
    }

    const repoId = randomBytes(4).toString('hex')
    const scheduler = new GitCommandScheduler(rootPath)
    const catFile = new CatFileProcess(rootPath)

    return new RepoSession(repoId, rootPath, gitDir, head, totalCommitCount, githubUrl, scheduler, catFile, ziggit)
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

  getCommitDiff(sha: string): Promise<{ changedPaths: Array<{ path: string; oldPath?: string; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' }>; additions: number; deletions: number }> {
    return parseCommitDiff(this.rootPath, sha)
  }

  async checkout(ref: string): Promise<void> {
    // Use git CLI — ziggit FFI only does tree checkout without switching HEAD
    await runGit(['checkout', ref], this.rootPath)
  }

  async push(ref: string, remote = 'origin'): Promise<string> {
    // No ziggit C-API for push yet — use git CLI
    const { stdout, stderr } = await runGit(['push', remote, ref], this.rootPath)
    return (stdout + stderr).trim()
  }

  fetch(): void {
    this.ziggit.fetch()
  }

  async deleteBranch(ref: string, force = false): Promise<void> {
    await runGit(['branch', force ? '-D' : '-d', ref], this.rootPath)
  }

  async deleteRemoteBranch(ref: string): Promise<void> {
    // ref is like "origin/feature" → push --delete origin feature
    const parts = ref.split('/')
    const remote = parts[0]
    const branch = parts.slice(1).join('/')
    await runGit(['push', '--delete', remote, branch], this.rootPath)
  }

  streamTopology(
    args: string[],
    onCommit: (entry: RevListEntry) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    return streamRevList(args, this.rootPath, onCommit, signal)
  }

  streamTopologyWithMeta(
    args: string[],
    onCommit: (entry: RevListEntryWithMeta) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    return streamRevListWithMeta(args, this.rootPath, onCommit, signal)
  }

  close(): void {
    this.catFile.close()
    this.ziggit.close()
  }
}
