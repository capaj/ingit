import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '@ingit/git-core'
import { listDirectory } from '../src/discover-repos.js'

const tempPaths = new Set<string>()

afterEach(async () => {
  await Promise.all([...tempPaths].map(async (path) => {
    await rm(path, { recursive: true, force: true })
    tempPaths.delete(path)
  }))
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempPaths.add(dir)
  return dir
}

describe('listDirectory', () => {
  test('returns child folders and marks git repositories', async () => {
    const root = await makeTempDir('ingit-list-directory-')
    const repoDir = join(root, 'repo')
    const plainDir = join(root, 'plain')
    const nestedFile = join(root, 'file.txt')

    await mkdir(repoDir)
    await mkdir(plainDir)
    await Bun.write(nestedFile, 'not a directory\n')
    await runGit(['init', '--initial-branch=main'], repoDir)

    const listing = await listDirectory(root)

    expect(listing.path).toBe(root)
    expect(listing.isGitRepo).toBe(false)
    expect(listing.entries).toEqual([
      { name: 'repo', path: repoDir, isGitRepo: true },
      { name: 'plain', path: plainDir, isGitRepo: false },
    ])
  })
})
