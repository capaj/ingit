import { randomBytes } from 'node:crypto'
import type {
  RefSummary,
  WorktreeStatusResponse,
  WorktreeChangesResponse,
  CommitDetailResponse,
  ReflogResponse,
  WorktreeFileDiffResponse,
  WorktreeDiffArea,
  CommitFileDiffResponse,
} from '@ingit/rpc-contract'
import { runGit, GitCommandError } from './git-command.js'
import { GitCommandScheduler } from './scheduler.js'
import { CatFileProcess } from './cat-file-process.js'
import { CommitHydrator } from './hydrator.js'
import { parseRefs } from './parsers/ref-parser.js'
import { parseReflog } from './parsers/reflog-parser.js'
import { parseStatus } from './parsers/status-parser.js'
import { readWorktreeChanges } from './parsers/worktree-changes-parser.js'
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

    // Resolve GitHub URL from origin remote.
    // Try ziggit FFI first; fall back to `git remote get-url` if the FFI errors
    // (the FFI has been observed to return code -1 on some repos).
    let githubUrl: string | null = null
    let raw: string | null = null
    let source = 'ffi'
    try {
      raw = ziggit.remoteGetUrl('origin').trim()
    } catch {
      source = 'git-subprocess'
      try {
        const { stdout } = await runGit(['remote', 'get-url', 'origin'], rootPath)
        raw = stdout.trim()
      } catch {
        raw = null
        source = 'failed'
      }
    }
    if (raw) {
      const sshMatch = raw.match(/git@github\.com:(.+?)(?:\.git)?$/)
      const httpsMatch = raw.match(/https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
      if (sshMatch) githubUrl = `https://github.com/${sshMatch[1]}`
      else if (httpsMatch) githubUrl = `https://github.com/${httpsMatch[1]}`
    }
    console.log('[RepoSession.open]', rootPath, 'source:', source, 'raw:', JSON.stringify(raw), '→ githubUrl:', githubUrl)

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

  getWorktreeChanges(): Promise<WorktreeChangesResponse> {
    return readWorktreeChanges(this.rootPath)
  }

  /** Stage the given paths into the index. Returns the fresh worktree state. */
  async stageFiles(paths: string[]): Promise<WorktreeChangesResponse> {
    if (paths.length > 0) {
      // `git add` stages modifications, additions and deletions for each path.
      await runGit(['add', '--', ...paths], this.rootPath)
    }
    return this.getWorktreeChanges()
  }

  /** Remove the given paths from the index, keeping worktree changes. */
  async unstageFiles(paths: string[]): Promise<WorktreeChangesResponse> {
    if (paths.length > 0) {
      await runGit(['restore', '--staged', '--', ...paths], this.rootPath)
    }
    return this.getWorktreeChanges()
  }

  async stageAll(): Promise<WorktreeChangesResponse> {
    await runGit(['add', '-A'], this.rootPath)
    return this.getWorktreeChanges()
  }

  async unstageAll(): Promise<WorktreeChangesResponse> {
    // Mixed reset of the index back to HEAD — unstages everything, keeps the
    // worktree untouched.
    await runGit(['reset', '--quiet'], this.rootPath)
    return this.getWorktreeChanges()
  }

  /** Patch for a single worktree file, either its staged or its unstaged half. */
  async getWorktreeFileDiff(
    path: string,
    area: WorktreeDiffArea,
    oldPath?: string,
  ): Promise<WorktreeFileDiffResponse> {
    let patchText: string
    if (area === 'staged') {
      // For renames/copies both paths must be in the pathspec or git shows
      // the rename as an unrelated delete + add.
      const pathspec = oldPath ? [oldPath, path] : [path]
      const { stdout } = await runGit(['diff', '--cached', '--', ...pathspec], this.rootPath)
      patchText = stdout
    } else {
      const { stdout: tracked } = await runGit(['ls-files', '--', path], this.rootPath)
      if (tracked.trim().length > 0) {
        const { stdout } = await runGit(['diff', '--', path], this.rootPath)
        patchText = stdout
      } else {
        // Untracked file: there is nothing in the index to diff against, so
        // synthesize an all-added patch. --no-index exits 1 when files differ.
        const { stdout } = await runGit(
          ['diff', '--no-index', '--', '/dev/null', path],
          this.rootPath,
          { okCodes: [1] },
        )
        patchText = stdout
      }
    }
    return {
      path,
      area,
      patchText,
      isBinary: /^Binary files .* differ$/m.test(patchText),
    }
  }

  /**
   * Commit the index. With `noVerify` the pre-commit and commit-msg hooks are
   * skipped (git commit --no-verify).
   */
  async commit(
    message: string,
    opts: { noVerify?: boolean } = {},
  ): Promise<{ headSha: string; changes: WorktreeChangesResponse }> {
    const args = ['commit', '-m', message]
    if (opts.noVerify) args.push('--no-verify')
    try {
      // Hooks can legitimately take a while (linters, test suites).
      await runGit(args, this.rootPath, { timeout: 120_000 })
    } catch (err) {
      if (err instanceof GitCommandError) {
        // Hook failures usually print to stdout, git's own errors to stderr —
        // surface both so the user sees why the commit was rejected.
        const detail = [err.stdout, err.stderr]
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .join('\n')
        throw new Error(detail || err.message)
      }
      throw err
    }
    const [headSha, changes] = await Promise.all([
      this.getHeadSha(),
      this.getWorktreeChanges(),
    ])
    return { headSha, changes }
  }

  async getCommitDetail(sha: string): Promise<CommitDetailResponse> {
    const [commit, isPushed] = await Promise.all([
      this.hydrator.hydrateCommit(sha),
      this.isCommitPushed(sha),
    ])
    return { ...commit, isPushed }
  }

  private async isCommitPushed(sha: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(['branch', '-r', '--contains', sha], this.rootPath)
      return stdout
        .split('\n')
        .map((line) => line.replace(/^\*?\s*/, '').trim())
        .some((ref) => ref.length > 0 && !/\/HEAD(?:\s|$)/.test(ref))
    } catch {
      return false
    }
  }

  getCommitDiff(sha: string): Promise<{ changedPaths: Array<{ path: string; oldPath?: string; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' }>; additions: number; deletions: number }> {
    return parseCommitDiff(this.rootPath, sha)
  }

  /** Patch for a single file as changed by a commit. */
  async getCommitFileDiff(
    sha: string,
    path: string,
    oldPath?: string,
  ): Promise<CommitFileDiffResponse> {
    const pathspec = oldPath ? [oldPath, path] : [path]
    const { stdout: patchText } = await runGit(
      ['diff-tree', '-r', '--root', '--no-commit-id', '-M', '-C', '-p', sha, '--', ...pathspec],
      this.rootPath,
    )
    return {
      sha,
      path,
      patchText,
      isBinary: /^Binary files .* differ$/m.test(patchText),
    }
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
    const resolved = await this.resolveRef(ref)
    if (resolved?.kind === 'remote') {
      const localBranchName = resolved.remoteBranch
      if (!localBranchName) {
        throw new Error(`Cannot checkout remote ref ${ref}`)
      }

      await runGit(['checkout', '-m', '-B', localBranchName, ref], this.rootPath)
      await runGit(['branch', `--set-upstream-to=${ref}`, localBranchName], this.rootPath)
      return
    }

    // Use git CLI — ziggit FFI only does tree checkout without switching HEAD
    // `-m` does a 3-way merge so uncommitted changes migrate to the target branch
    await runGit(['checkout', '-m', ref], this.rootPath)
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

    let stdout: string
    let stderr: string
    try {
      const result = await runGit(['merge', '--no-ff', '--no-edit', ref], this.rootPath)
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      if (err instanceof GitCommandError) {
        const detail = [err.stdout, err.stderr]
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .join('\n')
        throw new Error(detail || err.message)
      }
      throw err
    }
    return {
      message: (stdout + stderr).trim(),
      headSha: await this.getHeadSha(),
    }
  }

  async rebaseRef(ref: string): Promise<{ message: string; headSha: string }> {
    const resolved = await this.resolveRef(ref)
    if (!resolved || resolved.kind === 'tag' || resolved.kind === 'other') {
      throw new Error(`Cannot rebase onto ref ${ref}`)
    }

    const status = await this.getStatus()
    if (!status.branch) {
      throw new Error('Cannot rebase with detached HEAD')
    }

    if (resolved.kind === 'head' && resolved.refName === status.branch) {
      throw new Error('Cannot rebase onto the current branch')
    }

    if (resolved.kind === 'remote') {
      if (!resolved.remoteName || !resolved.remoteBranch) {
        throw new Error(`Cannot fetch remote ref ${ref}`)
      }
      await runGit(['fetch', resolved.remoteName, resolved.remoteBranch], this.rootPath)
    }

    let stdout: string
    let stderr: string
    try {
      const result = await runGit(['rebase', ref], this.rootPath)
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      if (err instanceof GitCommandError) {
        const detail = [err.stdout, err.stderr]
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .join('\n')
        throw new Error(detail || err.message)
      }
      throw err
    }
    return {
      message: (stdout + stderr).trim(),
      headSha: await this.getHeadSha(),
    }
  }

  async abortOperation(operation: 'merge' | 'rebase'): Promise<{ message: string; headSha: string; changes: WorktreeChangesResponse }> {
    const args = operation === 'merge'
      ? ['merge', '--abort']
      : ['rebase', '--abort']

    let stdout: string
    let stderr: string
    try {
      const result = await runGit(args, this.rootPath)
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      if (err instanceof GitCommandError) {
        const detail = [err.stdout, err.stderr]
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .join('\n')
        throw new Error(detail || err.message)
      }
      throw err
    }

    const [headSha, changes] = await Promise.all([
      this.getHeadSha(),
      this.getWorktreeChanges(),
    ])
    return {
      message: (stdout + stderr).trim() || `Aborted ${operation}`,
      headSha,
      changes,
    }
  }

  async continueOperation(operation: 'merge' | 'rebase'): Promise<{ message: string; headSha: string; changes: WorktreeChangesResponse }> {
    const args = operation === 'merge'
      ? ['merge', '--continue']
      : ['rebase', '--continue']

    let stdout: string
    let stderr: string
    try {
      // Both commands open an editor to confirm the commit message; force a
      // no-op editor so the server-side git never blocks waiting for one.
      const result = await runGit(args, this.rootPath, { env: { GIT_EDITOR: 'true' } })
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      if (err instanceof GitCommandError) {
        const detail = [err.stdout, err.stderr]
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .join('\n')
        throw new Error(detail || err.message)
      }
      throw err
    }

    const [headSha, changes] = await Promise.all([
      this.getHeadSha(),
      this.getWorktreeChanges(),
    ])
    return {
      message: (stdout + stderr).trim() || `Continued ${operation}`,
      headSha,
      changes,
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

  private remoteShortNameFromUpstream(upstream?: string): string | null {
    if (!upstream) return null
    if (upstream.startsWith('refs/remotes/')) {
      return upstream.slice('refs/remotes/'.length)
    }
    return upstream
  }

  private findTrackingRemoteRef(localRef: RefSummary, refs: RefSummary[]): RefSummary | null {
    const upstreamShortName = this.remoteShortNameFromUpstream(localRef.upstream)
    if (upstreamShortName) {
      return refs.find((ref) => ref.kind === 'remote' && ref.shortName === upstreamShortName) ?? null
    }

    const originMatch = refs.find((ref) => ref.kind === 'remote' && ref.shortName === `origin/${localRef.shortName}`)
    if (originMatch) return originMatch

    const suffixMatches = refs.filter(
      (ref) => ref.kind === 'remote' && ref.shortName.endsWith(`/${localRef.shortName}`),
    )
    return suffixMatches.length === 1 ? suffixMatches[0] : null
  }

  private async getCurrentUpstreamRef(): Promise<string | null> {
    try {
      const { stdout } = await runGit(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        this.rootPath,
      )
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  async resetBranch(ref: string): Promise<{ message: string; headSha: string }> {
    const refs = await this.getRefs()
    const localRef = refs.find((item) => item.kind === 'head' && item.shortName === ref)
    if (!localRef) {
      throw new Error('Only local branches can be reset')
    }

    const remoteRef = this.findTrackingRemoteRef(localRef, refs)
    if (!remoteRef) {
      throw new Error(`No remote tracking ref found for ${ref}`)
    }

    const targetRef = remoteRef.shortName
    const { stdout, stderr } = localRef.isCurrent
      ? await runGit(['reset', '--hard', targetRef], this.rootPath)
      : await runGit(['branch', '-f', ref, targetRef], this.rootPath)

    return {
      message: (stdout + stderr).trim() || `Reset ${ref} to ${targetRef}`,
      headSha: await this.getHeadSha(),
    }
  }

  async push(ref: string, remote = 'origin', force = false): Promise<string> {
    // No ziggit C-API for push yet — use git CLI.
    // `--force-with-lease` overwrites a rewritten branch (e.g. right after a
    // rebase) but still refuses if the remote moved in a way we haven't fetched,
    // so it won't clobber someone else's commits.
    const resolved = await this.resolveRef(ref)
    const pushRef = resolved?.kind === 'tag' ? `refs/tags/${ref}` : ref
    const args = force
      ? ['push', '--force-with-lease', remote, pushRef]
      : ['push', remote, pushRef]
    const { stdout, stderr } = await runGit(args, this.rootPath)
    return (stdout + stderr).trim()
  }

  async fetch(): Promise<{ message: string; headSha: string; fastForwarded: boolean }> {
    const headBefore = await this.getHeadSha()
    const messages: string[] = []

    const fetchResult = await runGit(['fetch', '--all', '--prune'], this.rootPath, { timeout: 120_000 })
    const fetchMessage = (fetchResult.stdout + fetchResult.stderr).trim()
    if (fetchMessage) messages.push(fetchMessage)

    const upstream = await this.getCurrentUpstreamRef()
    if (!upstream) {
      return {
        message: messages.join('\n') || 'Fetched remotes',
        headSha: await this.getHeadSha(),
        fastForwarded: false,
      }
    }

    try {
      const mergeResult = await runGit(['merge', '--ff-only', upstream], this.rootPath)
      const mergeMessage = (mergeResult.stdout + mergeResult.stderr).trim()
      if (mergeMessage) messages.push(mergeMessage)
    } catch (err) {
      if (!(err instanceof GitCommandError)) throw err
      const detail = (err.stdout + err.stderr).trim()
      messages.push(detail ? `Fast-forward skipped: ${detail}` : `Fast-forward skipped for ${upstream}`)
    }

    const headSha = await this.getHeadSha()
    return {
      message: messages.join('\n') || 'Fetched remotes',
      headSha,
      fastForwarded: headSha !== headBefore,
    }
  }

  async createBranch(name: string, sha: string): Promise<{ message: string }> {
    const { stdout, stderr } = await runGit(['branch', name, sha], this.rootPath)
    return {
      message: (stdout + stderr).trim() || `Created branch ${name} at ${sha.slice(0, 8)}`,
    }
  }

  async createTag(name: string, sha: string): Promise<{ message: string }> {
    const { stdout, stderr } = await runGit(['tag', name, sha], this.rootPath)
    return {
      message: (stdout + stderr).trim() || `Created tag ${name} at ${sha.slice(0, 8)}`,
    }
  }

  async getReflog(ref = 'HEAD', maxCount = 300): Promise<ReflogResponse> {
    const [entries, refs] = await Promise.all([
      parseReflog(this.rootPath, ref, maxCount),
      this.getRefs(),
    ])

    const shaToRefs = new Map<string, string[]>()
    for (const refSummary of refs) {
      const sha = refSummary.peeledSha ?? refSummary.targetSha
      const existing = shaToRefs.get(sha)
      if (existing) {
        existing.push(refSummary.shortName)
      } else {
        shaToRefs.set(sha, [refSummary.shortName])
      }
    }

    return {
      refName: ref,
      entries: entries.map((entry) => ({
        ...entry,
        refNames: shaToRefs.get(entry.sha) ?? [],
      })),
    }
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
