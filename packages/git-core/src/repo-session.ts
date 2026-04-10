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

export interface ResolvedRef {
  refName: string
  fullName: string
  sha: string
  kind: 'head' | 'remote' | 'tag' | 'other'
  remoteName?: string
  remoteBranch?: string
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

  private async getHeadSha(): Promise<string> {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], this.rootPath)
    return stdout.trim()
  }

  async resolveRef(ref: string): Promise<ResolvedRef | null> {
    try {
      const [{ stdout: shaOut }, { stdout: fullNameOut }] = await Promise.all([
        runGit(['rev-parse', '--verify', `${ref}^{commit}`], this.rootPath),
        runGit(['rev-parse', '--symbolic-full-name', ref], this.rootPath),
      ])

      const sha = shaOut.trim()
      const fullName = fullNameOut.trim()
      let kind: ResolvedRef['kind'] = 'other'
      let remoteName: string | undefined
      let remoteBranch: string | undefined

      if (fullName.startsWith('refs/heads/')) {
        kind = 'head'
      } else if (fullName.startsWith('refs/remotes/')) {
        kind = 'remote'
        const remotePath = fullName.slice('refs/remotes/'.length)
        const [remote, ...branchParts] = remotePath.split('/')
        remoteName = remote
        remoteBranch = branchParts.join('/')
      } else if (fullName.startsWith('refs/tags/')) {
        kind = 'tag'
      }

      return { refName: ref, fullName, sha, kind, remoteName, remoteBranch }
    } catch {
      return null
    }
  }

  private async getCommitParents(sha: string): Promise<string[]> {
    const commit = await this.getCommitDetail(sha)
    return commit.parents
  }

  private async assertNonMergeCommitActionSupported(sha: string): Promise<void> {
    const parents = await this.getCommitParents(sha)
    if (parents.length > 1) {
      throw new Error('Cherry-pick and revert are not supported for merge commits yet')
    }
  }

  async checkout(ref: string): Promise<void> {
    // Use git CLI — ziggit FFI only does tree checkout without switching HEAD
    await runGit(['checkout', ref], this.rootPath)
  }

  async cherryPick(sha: string): Promise<{ message: string; headSha: string }> {
    await this.assertNonMergeCommitActionSupported(sha)
    const { stdout, stderr } = await runGit(['cherry-pick', sha], this.rootPath)
    return {
      message: (stdout + stderr).trim(),
      headSha: await this.getHeadSha(),
    }
  }

  async revert(sha: string): Promise<{ message: string; headSha: string }> {
    await this.assertNonMergeCommitActionSupported(sha)
    const { stdout, stderr } = await runGit(['revert', '--no-edit', sha], this.rootPath)
    return {
      message: (stdout + stderr).trim(),
      headSha: await this.getHeadSha(),
    }
  }

  async uncommit(sha: string): Promise<{ message: string; headSha: string }> {
    const headSha = await this.getHeadSha()
    if (sha !== headSha) {
      throw new Error('Uncommit is only supported for the current HEAD commit')
    }

    const parents = await this.getCommitParents(sha)
    const parentSha = parents[0]
    if (!parentSha) {
      throw new Error('Uncommit is not supported for the initial commit yet')
    }

    const { stdout, stderr } = await runGit(['reset', '--mixed', parentSha], this.rootPath)
    return {
      message: (stdout + stderr).trim() || `Reset HEAD to ${parentSha.slice(0, 8)}`,
      headSha: await this.getHeadSha(),
    }
  }

  async mergeRef(ref: string): Promise<{ message: string; headSha: string }> {
    const resolved = await this.resolveRef(ref)
    if (!resolved || resolved.kind === 'tag' || resolved.kind === 'other') {
      throw new Error(`Cannot merge ref ${ref}`)
    }

    if (resolved.kind === 'remote') {
      if (!resolved.remoteName || !resolved.remoteBranch) {
        throw new Error(`Cannot fetch remote ref ${ref}`)
      }
      await runGit(['fetch', resolved.remoteName, resolved.remoteBranch], this.rootPath)
    }

    const { stdout, stderr } = await runGit(['merge', '--no-ff', '--no-edit', ref], this.rootPath)
    return {
      message: (stdout + stderr).trim(),
      headSha: await this.getHeadSha(),
    }
  }

  async moveBranch(ref: string, sha: string): Promise<{ message: string }> {
    const resolved = await this.resolveRef(ref)
    if (!resolved || resolved.kind !== 'head') {
      throw new Error('Only local branches can be moved')
    }

    const status = await this.getStatus()
    if (status.branch && resolved.refName === status.branch) {
      throw new Error('Cannot move the checked out branch')
    }

    const { stdout, stderr } = await runGit(['branch', '-f', ref, sha], this.rootPath)
    return {
      message: (stdout + stderr).trim() || `Moved ${ref} to ${sha.slice(0, 8)}`,
    }
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
