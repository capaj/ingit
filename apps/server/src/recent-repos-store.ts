import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_RECENT_REPOS = 100

export const DEFAULT_RECENT_REPOS_FILE = join(tmpdir(), 'ingit-recent-repos.json')

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export class RecentReposStore {
  constructor(
    private readonly filePath: string = DEFAULT_RECENT_REPOS_FILE,
  ) { }

  async list(): Promise<string[]> {
    const repos = await this.read()
    const existingRepos = (await Promise.all(
      repos.map(async (repoPath) => (await isExistingDirectory(repoPath)) ? repoPath : null),
    )).filter((repoPath): repoPath is string => repoPath !== null)

    if (existingRepos.length !== repos.length) {
      await this.write(existingRepos)
    }

    return existingRepos
  }

  async record(repoPath: string): Promise<void> {
    const repos = await this.read()
    const next = [repoPath, ...repos.filter((existingPath) => existingPath !== repoPath)]
      .slice(0, MAX_RECENT_REPOS)

    await this.write(next)
  }

  private async read(): Promise<string[]> {
    const file = Bun.file(this.filePath)

    try {
      if (!(await file.exists())) {
        return []
      }

      const parsed = await file.json()
      if (!Array.isArray(parsed)) return []
      return parsed.filter((value): value is string => typeof value === 'string')
    } catch (err) {
      console.warn(`Failed to read recent repo history from ${this.filePath}:`, err)
      return []
    }
  }

  private async write(repos: string[]): Promise<void> {
    await Bun.write(this.filePath, JSON.stringify(repos, null, 2) + '\n')
  }
}
