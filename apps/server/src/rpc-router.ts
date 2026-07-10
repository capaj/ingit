import assert from 'node:assert'
import { implement, ORPCError } from '@orpc/server'
import { GitCommandError } from '@ingit/git-core'
import { contract } from '@ingit/rpc-contract'
import { SessionManager } from './session-manager.js'
import { handleHistoryQuery } from './history-handler.js'
import { getMergePreview } from './merge-handler.js'
import { fetchCommitCIStatus, extractOwnerRepoFromGithubUrl } from './ci-status-handler.js'
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

  getStatus: os.getStatus.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getStatus()
  }),

  getWorktreeChanges: os.getWorktreeChanges.handler(async ({ input }) => {
    const session = getSession(input.repoId)
    return session.getWorktreeChanges()
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

    // Extract owner/repo from githubUrl like https://github.com/owner/repo
    const match = session.githubUrl.match(/github\.com\/([^/]+\/[^/]+)/)
    if (!match) return []
    const ownerRepo = match[1]

    try {
      const token = process.env.GITHUB_TOKEN ?? ''
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ingit',
      }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(
        `https://api.github.com/repos/${ownerRepo}/commits/${input.sha}/pulls`,
        { headers },
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
        await session.checkout(input.refName)
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
    return focusAgentSession(input.pid, input.cwd)
  }),

  installWindowCalls: os.installWindowCalls.handler(async () => {
    return installWindowCalls()
  }),
})

export type Router = typeof router
