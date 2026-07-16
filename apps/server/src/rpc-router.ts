import assert from 'node:assert'
import { implement, ORPCError } from '@orpc/server'
import { BranchCheckedOutError, GitCommandError } from '@ingit/git-core'
import { contract } from '@ingit/rpc-contract'
import { SessionManager } from './session-manager.js'
import { handleHistoryQuery } from './history-handler.js'
import { getMergePreview } from './merge-handler.js'
import { fetchCommitCIStatus, extractOwnerRepoFromGithubUrl, resolveGithubToken } from './ci-status-handler.js'
import { fetchGithubCommitAuthor } from './github-author-handler.js'
import { discoverRepos, listDirectory } from './discover-repos.js'
import { listAgentSessions, focusAgentSession, installWindowCalls } from './agent-sessions.js'

const sessionManager = new SessionManager()

export { sessionManager }

const os = implement(contract)

function getSession(repoId: string) {
  const session = sessionManager.getSession(repoId)
  assert(session, `No session found for repoId: ${repoId}`)
  return session
}

/** Detect a push rejected because the remote tip isn't an ancestor of ours. */
function isNonFastForwardRejection(stderr: string): boolean {
  return /\bnon-fast-forward\b|\[rejected\]|\bfetch first\b|tip of your current branch is behind/i.test(stderr)
}

/**
 * Re-throw a git mutation failure as a typed oRPC error. Plain Errors are
 * masked as "Internal server error" over oRPC, which hides the actual git
 * output (conflict details, hints) from the client.
 */
function rethrowWithDetail(err: unknown): never {
  if (err instanceof ORPCError) throw err
  if (err instanceof Error) {
    throw new ORPCError('CONFLICT', { message: err.message })
  }
  throw err
}

export const router = os.router({
  openRepo: os.openRepo.handler(async ({ input }) => {
    return sessionManager.openRepo(input.path)
  }),

  getRecentRepos: os.getRecentRepos.handler(async () => {
    return sessionManager.getRecentRepos()
  }),

  discoverRepos: os.discoverRepos.handler(async ({ input }) => {
    return discoverRepos(input.folder)
  }),

  listDirectory: os.listDirectory.handler(async ({ input }) => {
    return listDirectory(input.folder)
  }),

  getRefs: os.getRefs.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getRefs()
  }),

  getWorktrees: os.getWorktrees.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getWorktrees()
  }),

  getStatus: os.getStatus.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getStatus()
  }),

  getWorktreeChanges: os.getWorktreeChanges.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getWorktreeChanges()
  }),

  getStashes: os.getStashes.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getStashes()
  }),

  getStashDiff: os.getStashDiff.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    const diff = await session.getStashDiff(input.stashSha)
    return { sha: input.stashSha, ...diff }
  }),

  getStashFileDiff: os.getStashFileDiff.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getStashFileDiff(input.stashSha, input.path, input.oldPath)
  }),

  stashAction: os.stashAction.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    const operation = input.action === 'create'
      ? session.stash(input.message)
      : input.action === 'apply'
        ? session.applyStash(input.stashSha)
        : session.dropStash(input.stashSha)
    const result = await operation.catch(rethrowWithDetail)
    return { ok: true, ...result }
  }),

  stageAction: os.stageAction.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    switch (input.action) {
      case 'stage':
        return session.stageFiles(input.paths)
      case 'unstage':
        return session.unstageFiles(input.paths)
      case 'stage-all':
        return session.stageAll()
      case 'unstage-all':
        return session.unstageAll()
      case 'discard':
        return session.discardFiles(input.paths)
      case 'discard-all':
        return session.discardAll()
    }
  }),

  getWorktreeFileDiff: os.getWorktreeFileDiff.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getWorktreeFileDiff(input.path, input.area, input.oldPath)
  }),

  commit: os.commit.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    try {
      const result = await session.commit(input.message, {
        noVerify: input.noVerify ?? false,
        amend: input.amend ?? false,
      })
      return { ok: true, ...result }
    } catch (err) {
      // Plain Errors are masked as "Internal server error" over oRPC; wrap so
      // the hook output / "nothing to commit" reason reaches the client.
      throw new ORPCError('BAD_REQUEST', {
        message: err instanceof Error ? err.message : 'Commit failed',
      })
    }
  }),

  queryHistory: os.queryHistory.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return handleHistoryQuery(session, input)
  }),

  getCommitDetail: os.getCommitDetail.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getCommitDetail(input.sha)
  }),

  getCommitAuthor: os.getCommitAuthor.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    if (!session.githubUrl) return { avatarUrl: null }

    const ownerRepo = extractOwnerRepoFromGithubUrl(session.githubUrl)
    if (!ownerRepo) return { avatarUrl: null }
    return fetchGithubCommitAuthor(ownerRepo, input.sha)
  }),

  getCommitDiff: os.getCommitDiff.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    const diff = await session.getCommitDiff(input.sha)
    return { sha: input.sha, ...diff }
  }),

  getCommitFileDiff: os.getCommitFileDiff.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getCommitFileDiff(input.sha, input.path, input.oldPath)
  }),

  getCommitPRs: os.getCommitPRs.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    if (!session.githubUrl) return []

    const ownerRepo = extractOwnerRepoFromGithubUrl(session.githubUrl)
    if (!ownerRepo) return []

    try {
      const token = await resolveGithubToken()
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ingit',
        'X-GitHub-Api-Version': '2022-11-28',
      }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(
        `https://api.github.com/repos/${ownerRepo}/commits/${input.sha}/pulls`,
        { headers, signal: AbortSignal.timeout(5_000) },
      )
      if (!res.ok) return []
      const data = await res.json() as Array<{
        number: number
        title: string
        html_url: string
        state: string
        merged_at: string | null
      }>
      return data.map(pr => ({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        state: pr.state,
        mergedAt: pr.merged_at,
      }))
    } catch {
      return []
    }
  }),

  getCommitCIStatus: os.getCommitCIStatus.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    if (!session.githubUrl) return { state: 'none' as const, runs: [] }

    const ownerRepo = extractOwnerRepoFromGithubUrl(session.githubUrl)
    if (!ownerRepo) return { state: 'none' as const, runs: [] }

    return fetchCommitCIStatus(ownerRepo, input.sha)
  }),

  getCommitCIStatuses: os.getCommitCIStatuses.handler(async ({ input }) => {
    const session = getSession(input.repoId)

    const emptyResult = Object.fromEntries(
      input.shas.map((sha) => [sha, { state: 'none' as const, runs: [] }]),
    )
    if (!session.githubUrl) return emptyResult

    const ownerRepo = extractOwnerRepoFromGithubUrl(session.githubUrl)
    if (!ownerRepo) return emptyResult

    const entries = await Promise.all(
      input.shas.map(async (sha) => [sha, await fetchCommitCIStatus(ownerRepo, sha)] as const),
    )
    return Object.fromEntries(entries)
  }),

  commitAction: os.commitAction.handler(async ({ input }) => {
    const session = getSession(input.repoId)

    const result = await (input.action === 'cherry-pick'
      ? session.cherryPick(input.sha)
      : input.action === 'uncommit'
        ? session.uncommit(input.sha)
        : session.revert(input.sha)
    ).catch(rethrowWithDetail)

    return { ok: true, ...result }
  }),

  getMergePreview: os.getMergePreview.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return getMergePreview(session, input.refName)
  }),

  mergeRef: os.mergeRef.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    const result = await session.mergeRef(input.refName).catch(rethrowWithDetail)
    return { ok: true, ...result }
  }),

  rebaseRef: os.rebaseRef.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    const result = await session.rebaseRef(input.refName).catch(rethrowWithDetail)
    return { ok: true, ...result }
  }),

  abortOperation: os.abortOperation.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    const result = await session.abortOperation(input.operation).catch(rethrowWithDetail)
    return { ok: true, ...result }
  }),

  continueOperation: os.continueOperation.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    const result = await session.continueOperation(input.operation).catch(rethrowWithDetail)
    return { ok: true, ...result }
  }),

  refAction: os.refAction.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    let message = ''
    switch (input.action) {
      case 'checkout': {
        try {
          await session.checkout(input.refName)
        } catch (err) {
          if (err instanceof BranchCheckedOutError) {
            throw new ORPCError('CONFLICT', {
              message: err.message,
              data: {
                reason: 'branch-in-use',
                branchRef: err.branchRef,
                worktreePath: err.worktreePath,
              },
            })
          }
          rethrowWithDetail(err)
        }
        break
      }
      case 'push':
        try {
          message = await session.push(input.refName, undefined, input.force ?? false)
        } catch (err) {
          if (err instanceof GitCommandError && isNonFastForwardRejection(err.stderr)) {
            // Surface as a typed error so the client can offer a force push.
            // Plain Errors are masked as "Internal server error" over oRPC;
            // ORPCError instances pass through with their message + data.
            throw new ORPCError('CONFLICT', {
              message: err.stderr.trim() || err.message,
              data: { reason: 'non-fast-forward' },
            })
          }
          throw err
        }
        break
      case 'fetch':
        message = (await session.fetch()).message
        break
      case 'delete':
        if (input.refName.includes('/')) {
          await session.deleteRemoteBranch(input.refName)
        } else {
          await session.deleteBranch(input.refName)
        }
        break
      case 'move': {
        const result = await session.moveBranch(input.refName, input.sha)
        message = result.message
        break
      }
      case 'reset': {
        const result = await session.resetBranch(input.refName)
        message = result.message
        break
      }
      case 'create': {
        const result = await session.createBranch(input.refName, input.sha)
        message = result.message
        break
      }
      case 'create-tag': {
        const result = await session.createTag(input.refName, input.sha)
        message = result.message
        break
      }
    }
    return { ok: true, message }
  }),

  getReflog: os.getReflog.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getReflog(input.ref ?? 'HEAD', input.maxCount ?? 300)
  }),

  listAgentSessions: os.listAgentSessions.handler(async () => {
    return listAgentSessions()
  }),

  focusAgentSession: os.focusAgentSession.handler(async ({ input }) => {
    const startedAt = performance.now()
    console.info(`[agent-focus] request pid=${input.pid} cwd=${input.cwd ?? '(process cwd)'}`)
    try {
      const result = await focusAgentSession(input.pid, input.cwd)
      const elapsedMs = Math.round(performance.now() - startedAt)
      console.info(
        `[agent-focus] result pid=${input.pid} ok=${result.ok} method=${result.method ?? 'none'} duration=${elapsedMs}ms${result.error ? ` error=${result.error}` : ''}`,
      )
      return result
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - startedAt)
      console.error(`[agent-focus] unhandled failure pid=${input.pid} duration=${elapsedMs}ms`, err)
      throw err
    }
  }),

  installWindowCalls: os.installWindowCalls.handler(async () => {
    return installWindowCalls()
  }),
})

export type Router = typeof router
