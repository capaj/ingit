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

describe('RepoSession stashes', () => {
  test('stashes tracked and untracked files and safely applies them again', async () => {
    const parentSha = (await runGit(['rev-parse', 'HEAD'], repoDir)).stdout.trim()
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nstashed edit\n')
    await Bun.write(join(repoDir, 'untracked.txt'), 'new work\n')

    const created = await session.stash('pause this work')

    expect(created.changes.staged).toEqual([])
    expect(created.changes.unstaged).toEqual([])
    expect(created.stashes).toHaveLength(1)
    expect(created.stashes[0]).toMatchObject({
      selector: 'stash@{0}',
      parentSha,
    })
    expect(created.stashes[0]?.message).toContain('pause this work')

    const stash = created.stashes[0]!
    const diff = await session.getStashDiff(stash.sha)
    expect(diff.changedPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'file.txt', status: 'M' }),
      expect.objectContaining({ path: 'untracked.txt', status: 'A' }),
    ]))
    expect(diff.additions).toBe(2)
    expect(diff.deletions).toBe(0)

    const trackedPatch = await session.getStashFileDiff(stash.sha, 'file.txt')
    expect(trackedPatch.patchText).toContain('+stashed edit')
    const untrackedPatch = await session.getStashFileDiff(stash.sha, 'untracked.txt')
    expect(untrackedPatch.patchText).toContain('+new work')

    const applied = await session.applyStash(stash.sha)

    // Apply intentionally keeps the stash, so a conflict can never discard it.
    expect(applied.stashes.map((entry) => entry.sha)).toContain(stash.sha)
    expect(paths(applied.changes.unstaged)).toEqual(['file.txt', 'untracked.txt'])
    expect(await Bun.file(join(repoDir, 'file.txt')).text()).toBe('hello\nstashed edit\n')
    expect(await Bun.file(join(repoDir, 'untracked.txt')).text()).toBe('new work\n')

    const dropped = await session.dropStash(stash.sha)
    expect(dropped.stashes).toEqual([])
    expect((await runGit(['stash', 'list'], repoDir)).stdout.trim()).toBe('')
  })
})

describe('RepoSession worktree file diffs', () => {
  test('unstaged diff of a modified tracked file', async () => {
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nworld\n')

    const diff = await session.getWorktreeFileDiff('file.txt', 'unstaged')
    expect(diff.isBinary).toBe(false)
    expect(diff.patchText).toContain('+world')
    expect(diff.patchText).not.toContain('-hello')
  })

  test('unstaged diff of an untracked file synthesizes an all-added patch', async () => {
    await Bun.write(join(repoDir, 'new.txt'), 'fresh\nlines\n')

    const diff = await session.getWorktreeFileDiff('new.txt', 'unstaged')
    expect(diff.patchText).toContain('+fresh')
    expect(diff.patchText).toContain('+lines')
  })

  test('staged diff only shows what is in the index', async () => {
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nstaged\n')
    await session.stageFiles(['file.txt'])
    // Further worktree-only edit must not appear in the staged diff.
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nstaged\nunstaged\n')

    const staged = await session.getWorktreeFileDiff('file.txt', 'staged')
    expect(staged.patchText).toContain('+staged')
    expect(staged.patchText).not.toContain('+unstaged')

    const unstaged = await session.getWorktreeFileDiff('file.txt', 'unstaged')
    expect(unstaged.patchText).toContain('+unstaged')
    expect(unstaged.patchText).not.toContain('+staged')
  })

  test('binary file is flagged', async () => {
    await Bun.write(join(repoDir, 'blob.bin'), new Uint8Array([0, 1, 2, 0, 255]))

    const diff = await session.getWorktreeFileDiff('blob.bin', 'unstaged')
    expect(diff.isBinary).toBe(true)
  })
})

describe('RepoSession commit', () => {
  test('commits the index and returns the new head plus fresh changes', async () => {
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nworld\n')
    await Bun.write(join(repoDir, 'other.txt'), 'other\n')
    await session.stageFiles(['file.txt'])

    const before = (await runGit(['rev-parse', 'HEAD'], repoDir)).stdout.trim()
    const result = await session.commit('add world line')

    expect(result.headSha).not.toBe(before)
    const subject = (await runGit(['log', '-1', '--format=%s'], repoDir)).stdout.trim()
    expect(subject).toBe('add world line')
    // Only the staged file was committed; the untracked one is still pending.
    expect(result.changes.staged).toEqual([])
    expect(paths(result.changes.unstaged)).toEqual(['other.txt'])
  })

  test('fails with the hook output when a pre-commit hook rejects', async () => {
    const hookPath = join(repoDir, '.git', 'hooks', 'pre-commit')
    await Bun.write(hookPath, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n')
    await Bun.$`chmod +x ${hookPath}`.quiet()

    await Bun.write(join(repoDir, 'file.txt'), 'hello\nblocked\n')
    await session.stageFiles(['file.txt'])

    await expect(session.commit('should be blocked')).rejects.toThrow(/lint failed/)
  })

  test('noVerify skips a failing pre-commit hook', async () => {
    const hookPath = join(repoDir, '.git', 'hooks', 'pre-commit')
    await Bun.write(hookPath, '#!/bin/sh\nexit 1\n')
    await Bun.$`chmod +x ${hookPath}`.quiet()

    await Bun.write(join(repoDir, 'file.txt'), 'hello\nskipped hook\n')
    await session.stageFiles(['file.txt'])

    const result = await session.commit('bypass hooks', { noVerify: true })
    const subject = (await runGit(['log', '-1', '--format=%s'], repoDir)).stdout.trim()
    expect(subject).toBe('bypass hooks')
    expect(result.changes.staged).toEqual([])
    expect(result.changes.unstaged).toEqual([])
  })

  test('committing an empty index fails with a readable error', async () => {
    await expect(session.commit('nothing here')).rejects.toThrow(/nothing|clean/i)
  })

  test('amend rewrites the previous commit message without adding a commit', async () => {
    const before = (await runGit(['rev-parse', 'HEAD'], repoDir)).stdout.trim()
    const countBefore = Number((await runGit(['rev-list', '--count', 'HEAD'], repoDir)).stdout.trim())

    const result = await session.commit('reworded initial', { amend: true })

    expect(result.headSha).not.toBe(before)
    const subject = (await runGit(['log', '-1', '--format=%s'], repoDir)).stdout.trim()
    expect(subject).toBe('reworded initial')
    const countAfter = Number((await runGit(['rev-list', '--count', 'HEAD'], repoDir)).stdout.trim())
    expect(countAfter).toBe(countBefore)
  })

  test('amend folds staged changes into the previous commit', async () => {
    const countBefore = Number((await runGit(['rev-list', '--count', 'HEAD'], repoDir)).stdout.trim())
    await Bun.write(join(repoDir, 'file.txt'), 'hello\nworld\n')
    await session.stageFiles(['file.txt'])

    const result = await session.commit('initial with world', { amend: true })

    expect(result.changes.staged).toEqual([])
    const countAfter = Number((await runGit(['rev-list', '--count', 'HEAD'], repoDir)).stdout.trim())
    expect(countAfter).toBe(countBefore)
    const committed = (await runGit(['show', 'HEAD:file.txt'], repoDir)).stdout
    expect(committed).toBe('hello\nworld\n')
  })
})
