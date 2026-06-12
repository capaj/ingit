import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORPCError } from '@orpc/server'
import { runGit } from '@ingit/git-core'
import { RecentReposStore } from '../src/recent-repos-store.js'
import { SessionManager } from '../src/session-manager.js'

const tempPaths = new Set<string>()

afterEach(async () => {
  await Promise.all([...tempPaths].map(async (path) => {
    await rm(path, { recursive: true, force: true })
    tempPaths.delete(path)
  }))
})

async function makeTempDir(prefix: string): Promise<string> {
  // Resolve symlinks (macOS tmpdir lives under /var → /private/var) so the
  // paths compare equal to the canonical root paths git reports.
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  tempPaths.add(dir)
  return dir
}

async function createRepo(prefix: string): Promise<string> {
  const repoDir = await makeTempDir(prefix)
  await runGit(['init', '--initial-branch=main'], repoDir)
  await runGit(['config', 'user.email', 'test@test.com'], repoDir)
  await runGit(['config', 'user.name', 'Test'], repoDir)
  await Bun.write(join(repoDir, 'README.md'), '# test\n')
  await runGit(['add', 'README.md'], repoDir)
  await runGit(['commit', '-m', 'init'], repoDir)
  return repoDir
}

describe('SessionManager.openRepo', () => {
  test('returns a BAD_REQUEST error for a missing directory', async () => {
    const storeFile = join(await makeTempDir('ingit-session-store-'), 'recent-repos.json')
    const manager = new SessionManager(new RecentReposStore(storeFile))
    const missingPath = join(await makeTempDir('ingit-missing-parent-'), 'does-not-exist')

    await expect(manager.openRepo(missingPath)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: `No such directory: ${missingPath}`,
    } satisfies Partial<ORPCError<'BAD_REQUEST', unknown>>)
  })

  test('records opened repos by canonical root path and keeps the newest first', async () => {
    const storeDir = await makeTempDir('ingit-session-store-')
    const storeFile = join(storeDir, 'recent-repos.json')
    const manager = new SessionManager(new RecentReposStore(storeFile))

    const firstRepo = await createRepo('ingit-session-first-')
    const nestedDir = join(firstRepo, 'packages', 'feature')
    await mkdir(nestedDir, { recursive: true })
    const secondRepo = await createRepo('ingit-session-second-')

    await manager.openRepo(firstRepo)
    await manager.openRepo(nestedDir)
    await manager.openRepo(secondRepo)

    expect(await manager.getRecentRepos()).toEqual([secondRepo, firstRepo])
  })
})
