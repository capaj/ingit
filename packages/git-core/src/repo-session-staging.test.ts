import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RepoSession } from './repo-session.js'
import { runGit } from './git-command.js'

let repoDir: string
let session: RepoSession

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'ingit-staging-test-'))
  await runGit(['init', '--initial-branch=main'], repoDir)
  await runGit(['config', 'user.email', 'test@test.com'], repoDir)
  await runGit(['config', 'user.name', 'Test'], repoDir)

  await Bun.write(join(repoDir, 'file.txt'), 'hello\n')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'initial'], repoDir)

  session = await RepoSession.open(repoDir)
})

afterEach(async () => {
  session.close()
  await rm(repoDir, { recursive: true, force: true })
})

function paths(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort()
}

describe('RepoSession staging', () => {
  test('stages and unstages a modified file plus an untracked file', async () => {
    // Modify a tracked file and add a brand new one.
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nworld\n')
    await Bun.write(join(repoDir, 'new.txt'), 'fresh\n')

    // Initially both changes are unstaged; the index is clean.
    const before = await session.getWorktreeChanges()
    expect(before.branch).toBe('main')
    expect(before.staged).toEqual([])
    expect(paths(before.unstaged)).toEqual(['file.txt', 'new.txt'])
    expect(before.unstaged.find((f) => f.path === 'file.txt')?.status).toBe('M')
    expect(before.unstaged.find((f) => f.path === 'new.txt')?.status).toBe('?')

    // Stage both files.
    const afterStage = await session.stageFiles(['file.txt', 'new.txt'])
    expect(paths(afterStage.staged)).toEqual(['file.txt', 'new.txt'])
    expect(afterStage.unstaged).toEqual([])
    // Cross-check against the real index.
    const indexFiles = (await runGit(['diff', '--cached', '--name-only'], repoDir)).stdout.trim().split('\n').sort()
    expect(indexFiles).toEqual(['file.txt', 'new.txt'])

    // Unstage just one of them.
    const afterUnstage = await session.unstageFiles(['file.txt'])
    expect(paths(afterUnstage.staged)).toEqual(['new.txt'])
    expect(paths(afterUnstage.unstaged)).toEqual(['file.txt'])
  })

  test('stage-all then unstage-all round-trips the whole worktree', async () => {
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nedited\n')
    await Bun.write(join(repoDir, 'another.txt'), 'another\n')

    const staged = await session.stageAll()
    expect(paths(staged.staged)).toEqual(['another.txt', 'file.txt'])
    expect(staged.unstaged).toEqual([])

    const unstaged = await session.unstageAll()
    expect(unstaged.staged).toEqual([])
    expect(paths(unstaged.unstaged)).toEqual(['another.txt', 'file.txt'])
  })
})
