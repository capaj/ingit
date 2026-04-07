import { implement } from '@orpc/server'
import { contract } from '@ingit/rpc-contract'
import { runGit } from '@ingit/git-core'
import { SessionManager } from './session-manager.js'
import { handleHistoryQuery } from './history-handler.js'

const sessionManager = new SessionManager()

export { sessionManager }

const os = implement(contract)

export const router = os.router({
  openRepo: os.openRepo.handler(async ({ input }) => {
    return sessionManager.openRepo(input.path)
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
    const changedPaths = await session.getCommitDiff(input.sha)
    return { sha: input.sha, changedPaths }
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

  refAction: os.refAction.handler(async ({ input }) => {
    const session = sessionManager.getSession(input.repoId)
    if (!session) throw new Error('No session found for this repoId')
    let message = ''
    switch (input.action) {
      case 'checkout': {
        console.log(`checkout: ref="${input.refName}" cwd="${session.rootPath}"`)
        const { stdout: cOut, stderr: cErr } = await runGit(['checkout', input.refName], session.rootPath)
        console.log('checkout stdout:', cOut.trim())
        console.log('checkout stderr:', cErr.trim())
        const { stdout: headOut } = await runGit(['symbolic-ref', '--short', 'HEAD'], session.rootPath)
        console.log('checkout: HEAD is now:', headOut.trim())
        break
      }
      case 'push':
        message = await session.push(input.refName)
        break
      case 'fetch':
        session.fetch()
        break
      case 'delete':
        if (input.refName.includes('/')) {
          await session.deleteRemoteBranch(input.refName)
        } else {
          await session.deleteBranch(input.refName)
        }
        break
    }
    return { ok: true, message }
  }),
})

export type Router = typeof router
