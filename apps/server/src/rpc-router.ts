import { implement } from '@orpc/server'
import { contract } from '@ingit/rpc-contract'
import { SessionManager } from './session-manager.js'
import { handleHistoryQuery } from './history-handler.js'
import { getMergePreview } from './merge-handler.js'
import { fetchCommitCIStatus, extractOwnerRepoFromGithubUrl } from './ci-status-handler.js'

const sessionManager = new SessionManager()

export { sessionManager }

const os = implement(contract)

export const router = os.router({
  openRepo: os.openRepo.handler(async ({ input }) => {
    return sessionManager.openRepo(input.path)
  }),

  getRecentRepos: os.getRecentRepos.handler(async () => {
    return sessionManager.getRecentRepos()
  }),

  getRefs: os.getRefs.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    return session.getRefs()
  }),

  getStatus: os.getStatus.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    return session.getStatus()
  }),

  getWorktreeChanges: os.getWorktreeChanges.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    return session.getWorktreeChanges()
  }),

  stageAction: os.stageAction.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
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

  queryHistory: os.queryHistory.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    return handleHistoryQuery(session, input)
  }),

  getCommitDetail: os.getCommitDetail.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    return session.getCommitDetail(input.sha)
  }),

  getCommitDiff: os.getCommitDiff.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    const diff = await session.getCommitDiff(input.sha)
    return { sha: input.sha, ...diff }
  }),

  getCommitPRs: os.getCommitPRs.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
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
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    if (!session.githubUrl) return { state: 'none' as const, runs: [] }

    const ownerRepo = extractOwnerRepoFromGithubUrl(session.githubUrl)
    if (!ownerRepo) return { state: 'none' as const, runs: [] }

    return fetchCommitCIStatus(ownerRepo, input.sha)
  }),

  getCommitCIStatuses: os.getCommitCIStatuses.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')

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
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')

    const result = input.action === 'cherry-pick'
      ? await session.cherryPick(input.sha)
      : input.action === 'uncommit'
        ? await session.uncommit(input.sha)
        : await session.revert(input.sha)

    return { ok: true, ...result }
  }),

  getMergePreview: os.getMergePreview.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    return getMergePreview(session, input.refName)
  }),

  mergeRef: os.mergeRef.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    const result = await session.mergeRef(input.refName)
    return { ok: true, ...result }
  }),

  rebaseRef: os.rebaseRef.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    const result = await session.rebaseRef(input.refName)
    return { ok: true, ...result }
  }),

  refAction: os.refAction.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    let message = ''
    switch (input.action) {
      case 'checkout': {
        await session.checkout(input.refName)
        break
      }
      case 'push':
        message = await session.push(input.refName)
        break
      case 'fetch':
        await session.fetch()
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
    }
    return { ok: true, message }
  }),

  getReflog: os.getReflog.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    return session.getReflog(input.ref ?? 'HEAD', input.maxCount ?? 300)
  }),
})

export type Router = typeof router
