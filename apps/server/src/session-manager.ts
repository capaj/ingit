import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { ORPCError } from '@orpc/server'
import {
  GitCommandError,
  RepoSession,
  type RemoveWorktreeResult,
} from '@ingit/git-core'
import type { OpenRepoResponse } from '@ingit/rpc-contract'
import { RecentReposStore } from './recent-repos-store.js'

function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

export class SessionManager {
  readonly sessions: Map<string, RepoSession> = new Map()
  private readonly recentReposStore: RecentReposStore

  constructor(recentReposStore = new RecentReposStore()) {
    this.recentReposStore = recentReposStore
  }

  async openRepo(path: string): Promise<OpenRepoResponse> {
    const absPath = resolve(expandTilde(path))
    await assertDirectory(absPath)

    // Check if we already have a session for this root path
    for (const session of this.sessions.values()) {
      if (session.rootPath === absPath) {
        await this.recentReposStore.record(session.rootPath)
        return {
          repoId: session.repoId,
          rootPath: session.rootPath,
          currentWorktreePath: session.rootPath,
          totalCommitCount: session.totalCommitCount,
          githubUrl: session.githubUrl,
          head: session.head,
        }
      }
    }

    const session = await openRepoSession(absPath)

    // Check again by resolved root path (in case the user passed a subdir)
    for (const existing of this.sessions.values()) {
      if (existing.rootPath === session.rootPath) {
        session.close()
        await this.recentReposStore.record(existing.rootPath)
        return {
          repoId: existing.repoId,
          rootPath: existing.rootPath,
          currentWorktreePath: existing.rootPath,
          totalCommitCount: existing.totalCommitCount,
          githubUrl: existing.githubUrl,
          head: existing.head,
        }
      }
    }

    this.sessions.set(session.repoId, session)
    await this.recentReposStore.record(session.rootPath)

    return {
      repoId: session.repoId,
      rootPath: session.rootPath,
      currentWorktreePath: session.rootPath,
      totalCommitCount: session.totalCommitCount,
      githubUrl: session.githubUrl,
      head: session.head,
    }
  }

  getSession(repoId: string): RepoSession | undefined {
    return this.sessions.get(repoId)
  }

  async removeWorktree(
    repoId: string,
    path: string,
    moveCurrentBranchToMain = false,
  ): Promise<RemoveWorktreeResult> {
    const session = this.sessions.get(repoId)
    if (!session) throw new Error(`No session found for repoId: ${repoId}`)

    try {
      const result = await session.removeWorktree(path, { moveCurrentBranchToMain })

      if (result.nextWorktreePath) {
        // The current session points at a directory that no longer exists. A
        // main-worktree session may also have cached the branch that was just
        // replaced, so force both paths to reopen with fresh state.
        this.closeSessionsAtPaths([session.rootPath, result.nextWorktreePath])
      }

      return result
    } catch (err) {
      // Removing the current worktree closes its long-lived git processes so
      // Windows can delete the directory. If Git then rejects the removal,
      // recreate the same logical session so the client remains usable.
      if (session.isClosed) {
        try {
          const replacement = await RepoSession.open(session.rootPath, { repoId })
          this.sessions.set(repoId, replacement)
        } catch {
          this.sessions.delete(repoId)
        }
      }
      throw err
    }
  }

  getRecentRepos(): Promise<string[]> {
    return this.recentReposStore.list()
  }

  private closeSessionsAtPaths(paths: string[]): void {
    const normalizedPaths = new Set(paths.map((path) => resolve(path)))
    for (const [repoId, session] of this.sessions) {
      if (!normalizedPaths.has(resolve(session.rootPath))) continue
      session.close()
      this.sessions.delete(repoId)
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close()
    }
    this.sessions.clear()
  }
}

async function assertDirectory(absPath: string): Promise<void> {
  try {
    const stats = await stat(absPath)
    if (!stats.isDirectory()) {
      throw new ORPCError('BAD_REQUEST', { message: `Not a directory: ${absPath}` })
    }
  } catch (err) {
    if (err instanceof ORPCError) throw err

    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ORPCError('BAD_REQUEST', { message: `No such directory: ${absPath}` })
    }

    throw err
  }
}

async function openRepoSession(absPath: string): Promise<RepoSession> {
  try {
    return await RepoSession.open(absPath)
  } catch (err) {
    if (err instanceof GitCommandError && err.stderr.includes('not a git repository')) {
      throw new ORPCError('BAD_REQUEST', { message: `Not a Git repository: ${absPath}` })
    }

    throw err
  }
}
