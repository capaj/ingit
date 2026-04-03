import { resolve } from 'node:path'
import { RepoSession } from '@ingit/git-core'
import type { OpenRepoResponse } from '@ingit/rpc-contract'

export class SessionManager {
  readonly sessions: Map<string, RepoSession> = new Map()

  async openRepo(path: string): Promise<OpenRepoResponse> {
    const absPath = resolve(path)

    // Check if we already have a session for this root path
    for (const session of this.sessions.values()) {
      if (session.rootPath === absPath) {
        return {
          repoId: session.repoId,
          rootPath: session.rootPath,
          currentWorktreePath: session.rootPath,
          head: session.head,
        }
      }
    }

    const session = await RepoSession.open(absPath)

    // Check again by resolved root path (in case the user passed a subdir)
    for (const existing of this.sessions.values()) {
      if (existing.rootPath === session.rootPath) {
        session.close()
        return {
          repoId: existing.repoId,
          rootPath: existing.rootPath,
          currentWorktreePath: existing.rootPath,
          head: existing.head,
        }
      }
    }

    this.sessions.set(session.repoId, session)

    return {
      repoId: session.repoId,
      rootPath: session.rootPath,
      currentWorktreePath: session.rootPath,
      head: session.head,
    }
  }

  getSession(repoId: string): RepoSession | undefined {
    return this.sessions.get(repoId)
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close()
    }
    this.sessions.clear()
  }
}
