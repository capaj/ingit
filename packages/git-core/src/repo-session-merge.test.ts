import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoSession } from './repo-session.js'
import { runGit } from './git-command.js'

const tempDirs = new Set<string>()

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true })
    tempDirs.delete(dir)
  }))
})

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

async function initRepo(repoDir: string) {
  await runGit(['init', '--initial-branch=main'], repoDir)
  await runGit(['config', 'user.email', 'test@test.com'], repoDir)
  await runGit(['config', 'user.name', 'Test'], repoDir)
}

async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await runGit(['symbolic-ref', '--short', 'HEAD'], cwd)
  return stdout.trim()
}

async function currentHeadSha(cwd: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', 'HEAD'], cwd)
  return stdout.trim()
}

async function headParents(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(['show', '-s', '--format=%P', 'HEAD'], cwd)
  return stdout.trim().split(/\s+/).filter(Boolean)
}

async function headSubject(cwd: string): Promise<string> {
  const { stdout } = await runGit(['log', '-1', '--pretty=%s'], cwd)
  return stdout.trim()
}

async function branchSha(cwd: string, ref: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', ref], cwd)
  return stdout.trim()
}

describe('RepoSession.mergeRef', () => {
  test('merges a local branch into the current branch with a merge commit', async () => {
    const repoDir = await makeTempDir('ingit-merge-local-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await runGit(['checkout', '-b', 'dev'], repoDir)
    await Bun.write(join(repoDir, 'dev.txt'), 'dev\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'dev'], repoDir)
    const devSha = await currentHeadSha(repoDir)

    await runGit(['checkout', 'main'], repoDir)
    await Bun.write(join(repoDir, 'main.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main'], repoDir)
    const mainHeadBeforeMerge = await currentHeadSha(repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      const result = await session.mergeRef('dev')

      expect(await currentBranch(repoDir)).toBe('main')
      expect(result.headSha).toBe(await currentHeadSha(repoDir))
      expect(result.headSha).not.toBe(mainHeadBeforeMerge)
      expect(result.headSha).not.toBe(devSha)
      expect(await headParents(repoDir)).toEqual([mainHeadBeforeMerge, devSha])
      expect(await Bun.file(join(repoDir, 'dev.txt')).text()).toBe('dev\n')
    } finally {
      session.close()
    }
  })

  test('fetches a remote-tracking branch before merging it', async () => {
    const remoteDir = await makeTempDir('ingit-merge-remote-')
    await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

    const seedDir = await makeTempDir('ingit-merge-seed-')
    await initRepo(seedDir)
    await Bun.write(join(seedDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], seedDir)
    await runGit(['commit', '-m', 'base'], seedDir)
    await runGit(['remote', 'add', 'origin', remoteDir], seedDir)
    await runGit(['push', '-u', 'origin', 'main'], seedDir)

    await runGit(['checkout', '-b', 'dev'], seedDir)
    await Bun.write(join(seedDir, 'dev.txt'), 'dev v1\n')
    await runGit(['add', '.'], seedDir)
    await runGit(['commit', '-m', 'dev v1'], seedDir)
    await runGit(['push', '-u', 'origin', 'dev'], seedDir)

    const localDir = await makeTempDir('ingit-merge-local-clone-')
    await runGit(['clone', remoteDir, localDir], tmpdir())
    await runGit(['config', 'user.email', 'test@test.com'], localDir)
    await runGit(['config', 'user.name', 'Test'], localDir)

    const staleRemoteSha = (await runGit(['rev-parse', 'origin/dev'], localDir)).stdout.trim()
    const mainHeadBeforeMerge = await currentHeadSha(localDir)

    const upstreamDir = await makeTempDir('ingit-merge-upstream-')
    await runGit(['clone', remoteDir, upstreamDir], tmpdir())
    await runGit(['config', 'user.email', 'test@test.com'], upstreamDir)
    await runGit(['config', 'user.name', 'Test'], upstreamDir)
    await runGit(['checkout', 'dev'], upstreamDir)
    await Bun.write(join(upstreamDir, 'dev.txt'), 'dev v2\n')
    await runGit(['add', '.'], upstreamDir)
    await runGit(['commit', '-m', 'dev v2'], upstreamDir)
    await runGit(['push', 'origin', 'dev'], upstreamDir)
    const latestRemoteSha = await currentHeadSha(upstreamDir)

    const session = await RepoSession.open(localDir)

    try {
      const result = await session.mergeRef('origin/dev')

      expect(await currentBranch(localDir)).toBe('main')
      expect(result.headSha).toBe(await currentHeadSha(localDir))
      expect(await runGit(['rev-parse', 'origin/dev'], localDir).then((res) => res.stdout.trim())).toBe(latestRemoteSha)
      expect(await headParents(localDir)).toEqual([mainHeadBeforeMerge, latestRemoteSha])
      expect(latestRemoteSha).not.toBe(staleRemoteSha)
    } finally {
      session.close()
    }
  })

  test('reports MERGE_HEAD and conflicted files after a merge conflict', async () => {
    const repoDir = await makeTempDir('ingit-merge-conflict-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await runGit(['checkout', '-b', 'dev'], repoDir)
    await Bun.write(join(repoDir, 'shared.txt'), 'dev\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'dev changes shared'], repoDir)
    const devSha = await currentHeadSha(repoDir)

    await runGit(['checkout', 'main'], repoDir)
    await Bun.write(join(repoDir, 'shared.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main changes shared'], repoDir)
    const mainHeadBeforeMerge = await currentHeadSha(repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.mergeRef('dev')).rejects.toThrow(/CONFLICT|Automatic merge failed/)

      const changes = await session.getWorktreeChanges()
      expect(changes.headSha).toBe(mainHeadBeforeMerge)
      expect(changes.mergeHeadShas).toEqual([devSha])
      expect(changes.unstaged).toContainEqual({ path: 'shared.txt', status: 'U' })
    } finally {
      session.close()
    }
  })

  test('aborts a conflicted merge', async () => {
    const repoDir = await makeTempDir('ingit-merge-abort-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await runGit(['checkout', '-b', 'dev'], repoDir)
    await Bun.write(join(repoDir, 'shared.txt'), 'dev\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'dev changes shared'], repoDir)

    await runGit(['checkout', 'main'], repoDir)
    await Bun.write(join(repoDir, 'shared.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main changes shared'], repoDir)
    const mainHeadBeforeMerge = await currentHeadSha(repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.mergeRef('dev')).rejects.toThrow(/CONFLICT|Automatic merge failed/)

      const result = await session.abortOperation('merge')

      expect(result.headSha).toBe(mainHeadBeforeMerge)
      expect(result.changes.mergeHeadShas).toBeUndefined()
      expect(result.changes.rebaseHeadSha).toBeUndefined()
      expect(result.changes.staged).toEqual([])
      expect(result.changes.unstaged).toEqual([])
      expect(await currentHeadSha(repoDir)).toBe(mainHeadBeforeMerge)
      expect(await Bun.file(join(repoDir, 'shared.txt')).text()).toBe('main\n')
    } finally {
      session.close()
    }
  })
})

describe('RepoSession.moveBranch', () => {
  test('moves a non-current local branch to the selected commit', async () => {
    const repoDir = await makeTempDir('ingit-move-branch-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)
    const baseSha = await currentHeadSha(repoDir)

    await Bun.write(join(repoDir, 'main.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main'], repoDir)

    await runGit(['checkout', '-b', 'dev'], repoDir)
    await Bun.write(join(repoDir, 'dev.txt'), 'dev\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'dev'], repoDir)

    await runGit(['checkout', 'main'], repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      const result = await session.moveBranch('dev', baseSha)

      expect(result.message).toContain('Moved dev')
      expect(await currentBranch(repoDir)).toBe('main')
      expect(await branchSha(repoDir, 'dev')).toBe(baseSha)
    } finally {
      session.close()
    }
  })

  test('rejects moving the checked out branch', async () => {
    const repoDir = await makeTempDir('ingit-move-current-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.moveBranch('main', 'HEAD')).rejects.toThrow('checked out branch')
    } finally {
      session.close()
    }
  })
})

describe('RepoSession.rebaseRef', () => {
  test('rebases the current branch onto another local branch tip', async () => {
    const repoDir = await makeTempDir('ingit-rebase-local-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await Bun.write(join(repoDir, 'main.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main'], repoDir)
    const mainSha = await currentHeadSha(repoDir)

    await runGit(['checkout', '-b', 'feature', 'HEAD~1'], repoDir)
    await Bun.write(join(repoDir, 'feature.txt'), 'feature\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'feature'], repoDir)
    const featureShaBeforeRebase = await currentHeadSha(repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      const result = await session.rebaseRef('main')

      expect(await currentBranch(repoDir)).toBe('feature')
      expect(result.headSha).toBe(await currentHeadSha(repoDir))
      expect(result.headSha).not.toBe(featureShaBeforeRebase)
      expect(await headParents(repoDir)).toEqual([mainSha])
      expect(await branchSha(repoDir, 'main')).toBe(mainSha)
      expect(await Bun.file(join(repoDir, 'feature.txt')).text()).toBe('feature\n')
    } finally {
      session.close()
    }
  })

  test('preserves uncommitted changes while rebasing', async () => {
    const repoDir = await makeTempDir('ingit-rebase-autostash-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'base.txt'), 'base\n')
    await Bun.write(join(repoDir, 'tracked.txt'), 'tracked\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await Bun.write(join(repoDir, 'main.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main'], repoDir)
    const mainSha = await currentHeadSha(repoDir)

    await runGit(['checkout', '-b', 'feature', 'HEAD~1'], repoDir)
    await Bun.write(join(repoDir, 'feature.txt'), 'feature\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'feature'], repoDir)

    await Bun.write(join(repoDir, 'tracked.txt'), 'tracked\nwork in progress\n')

    const session = await RepoSession.open(repoDir)

    try {
      const result = await session.rebaseRef('main')

      expect(result.headSha).toBe(await currentHeadSha(repoDir))
      expect(await headParents(repoDir)).toEqual([mainSha])
      expect(await Bun.file(join(repoDir, 'tracked.txt')).text()).toBe('tracked\nwork in progress\n')
      expect((await runGit(['diff', '--name-only'], repoDir)).stdout.trim()).toBe('tracked.txt')
      expect((await runGit(['stash', 'list'], repoDir)).stdout.trim()).toBe('')
    } finally {
      session.close()
    }
  })

  test('fetches a remote-tracking branch before rebasing onto it', async () => {
    const remoteDir = await makeTempDir('ingit-rebase-remote-')
    await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

    const seedDir = await makeTempDir('ingit-rebase-seed-')
    await initRepo(seedDir)
    await Bun.write(join(seedDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], seedDir)
    await runGit(['commit', '-m', 'base'], seedDir)
    await runGit(['remote', 'add', 'origin', remoteDir], seedDir)
    await runGit(['push', '-u', 'origin', 'main'], seedDir)

    const localDir = await makeTempDir('ingit-rebase-local-clone-')
    await runGit(['clone', remoteDir, localDir], tmpdir())
    await runGit(['config', 'user.email', 'test@test.com'], localDir)
    await runGit(['config', 'user.name', 'Test'], localDir)

    await runGit(['checkout', '-b', 'feature'], localDir)
    await Bun.write(join(localDir, 'feature.txt'), 'feature\n')
    await runGit(['add', '.'], localDir)
    await runGit(['commit', '-m', 'feature'], localDir)

    const staleRemoteSha = await branchSha(localDir, 'origin/main')

    const upstreamDir = await makeTempDir('ingit-rebase-upstream-')
    await runGit(['clone', remoteDir, upstreamDir], tmpdir())
    await runGit(['config', 'user.email', 'test@test.com'], upstreamDir)
    await runGit(['config', 'user.name', 'Test'], upstreamDir)
    await Bun.write(join(upstreamDir, 'upstream.txt'), 'upstream\n')
    await runGit(['add', '.'], upstreamDir)
    await runGit(['commit', '-m', 'upstream'], upstreamDir)
    await runGit(['push', 'origin', 'main'], upstreamDir)
    const latestRemoteSha = await currentHeadSha(upstreamDir)

    const session = await RepoSession.open(localDir)

    try {
      const result = await session.rebaseRef('origin/main')

      expect(await currentBranch(localDir)).toBe('feature')
      expect(result.headSha).toBe(await currentHeadSha(localDir))
      expect(await branchSha(localDir, 'origin/main')).toBe(latestRemoteSha)
      expect(latestRemoteSha).not.toBe(staleRemoteSha)
      expect(await headParents(localDir)).toEqual([latestRemoteSha])
    } finally {
      session.close()
    }
  })

  test('reports REBASE_HEAD after a rebase conflict and keeps applied commits on HEAD', async () => {
    const repoDir = await makeTempDir('ingit-rebase-conflict-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main changes shared'], repoDir)
    const mainSha = await currentHeadSha(repoDir)

    await runGit(['checkout', '-b', 'feature', 'HEAD~1'], repoDir)
    await Bun.write(join(repoDir, 'clean.txt'), 'clean\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'feature clean'], repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'feature\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'feature conflicts shared'], repoDir)
    const conflictSha = await currentHeadSha(repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.rebaseRef('main')).rejects.toThrow(/CONFLICT|could not apply|Resolve all conflicts/)

      const changes = await session.getWorktreeChanges()
      expect(changes.rebaseHeadSha).toBe(conflictSha)
      expect(changes.unstaged).toContainEqual({ path: 'shared.txt', status: 'U' })
      expect(await headSubject(repoDir)).toBe('feature clean')
      expect(await headParents(repoDir)).toEqual([mainSha])
    } finally {
      session.close()
    }
  })

  test('aborts a conflicted rebase', async () => {
    const repoDir = await makeTempDir('ingit-rebase-abort-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'base\n')
    await Bun.write(join(repoDir, 'wip.txt'), 'saved\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main changes shared'], repoDir)

    await runGit(['checkout', '-b', 'feature', 'HEAD~1'], repoDir)
    await Bun.write(join(repoDir, 'clean.txt'), 'clean\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'feature clean'], repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'feature\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'feature conflicts shared'], repoDir)
    const featureHeadBeforeRebase = await currentHeadSha(repoDir)

    await Bun.write(join(repoDir, 'wip.txt'), 'saved\nuncommitted work\n')

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.rebaseRef('main')).rejects.toThrow(/CONFLICT|could not apply|Resolve all conflicts/)

      const result = await session.abortOperation('rebase')

      expect(result.headSha).toBe(featureHeadBeforeRebase)
      expect(result.changes.mergeHeadShas).toBeUndefined()
      expect(result.changes.rebaseHeadSha).toBeUndefined()
      expect(result.changes.staged).toEqual([])
      expect(result.changes.unstaged).toContainEqual({ path: 'wip.txt', status: 'M' })
      expect(await currentBranch(repoDir)).toBe('feature')
      expect(await currentHeadSha(repoDir)).toBe(featureHeadBeforeRebase)
      expect(await headSubject(repoDir)).toBe('feature conflicts shared')
      expect(await Bun.file(join(repoDir, 'shared.txt')).text()).toBe('feature\n')
      expect(await Bun.file(join(repoDir, 'wip.txt')).text()).toBe('saved\nuncommitted work\n')
      expect((await runGit(['stash', 'list'], repoDir)).stdout.trim()).toBe('')
    } finally {
      session.close()
    }
  })

  test('continues a conflicted rebase after the conflict is resolved and staged', async () => {
    const repoDir = await makeTempDir('ingit-rebase-continue-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main changes shared'], repoDir)
    const mainSha = await currentHeadSha(repoDir)

    await runGit(['checkout', '-b', 'feature', 'HEAD~1'], repoDir)
    await Bun.write(join(repoDir, 'shared.txt'), 'feature\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'feature conflicts shared'], repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.rebaseRef('main')).rejects.toThrow(/CONFLICT|could not apply|Resolve all conflicts/)

      // Continuing with the conflict still unresolved must fail loudly.
      await expect(session.continueOperation('rebase')).rejects.toThrow(/unmerged|conflict|resolve/i)

      await Bun.write(join(repoDir, 'shared.txt'), 'resolved\n')
      await runGit(['add', 'shared.txt'], repoDir)

      const result = await session.continueOperation('rebase')

      expect(await currentBranch(repoDir)).toBe('feature')
      expect(result.headSha).toBe(await currentHeadSha(repoDir))
      expect(result.changes.rebaseHeadSha).toBeUndefined()
      expect(result.changes.mergeHeadShas).toBeUndefined()
      expect(result.changes.staged).toEqual([])
      expect(result.changes.unstaged).toEqual([])
      expect(await headSubject(repoDir)).toBe('feature conflicts shared')
      expect(await headParents(repoDir)).toEqual([mainSha])
      expect(await Bun.file(join(repoDir, 'shared.txt')).text()).toBe('resolved\n')
    } finally {
      session.close()
    }
  })

  test('continues a conflicted merge after the conflict is resolved and staged', async () => {
    const repoDir = await makeTempDir('ingit-merge-continue-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'shared.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    await runGit(['checkout', '-b', 'dev'], repoDir)
    await Bun.write(join(repoDir, 'shared.txt'), 'dev\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'dev changes shared'], repoDir)
    const devSha = await currentHeadSha(repoDir)

    await runGit(['checkout', 'main'], repoDir)
    await Bun.write(join(repoDir, 'shared.txt'), 'main\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'main changes shared'], repoDir)
    const mainSha = await currentHeadSha(repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.mergeRef('dev')).rejects.toThrow(/CONFLICT|Automatic merge failed/)

      await Bun.write(join(repoDir, 'shared.txt'), 'resolved\n')
      await runGit(['add', 'shared.txt'], repoDir)

      const result = await session.continueOperation('merge')

      expect(await currentBranch(repoDir)).toBe('main')
      expect(result.headSha).toBe(await currentHeadSha(repoDir))
      expect(result.changes.mergeHeadShas).toBeUndefined()
      expect(result.changes.staged).toEqual([])
      expect(result.changes.unstaged).toEqual([])
      expect(await headParents(repoDir)).toEqual([mainSha, devSha])
      expect(await Bun.file(join(repoDir, 'shared.txt')).text()).toBe('resolved\n')
    } finally {
      session.close()
    }
  })

  test('rebases onto the current branch as a no-op', async () => {
    const repoDir = await makeTempDir('ingit-rebase-current-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)
    const headBeforeRebase = await currentHeadSha(repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      const result = await session.rebaseRef('main')

      expect(await currentBranch(repoDir)).toBe('main')
      expect(result.headSha).toBe(headBeforeRebase)
      expect(await currentHeadSha(repoDir)).toBe(headBeforeRebase)
    } finally {
      session.close()
    }
  })
})

describe('RepoSession.resetBranch', () => {
  test('resets the current branch back to its upstream remote', async () => {
    const remoteDir = await makeTempDir('ingit-reset-remote-')
    await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

    const seedDir = await makeTempDir('ingit-reset-seed-')
    await initRepo(seedDir)
    await Bun.write(join(seedDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], seedDir)
    await runGit(['commit', '-m', 'base'], seedDir)
    await runGit(['remote', 'add', 'origin', remoteDir], seedDir)
    await runGit(['push', '-u', 'origin', 'main'], seedDir)
    const remoteMainSha = await currentHeadSha(seedDir)

    const localDir = await makeTempDir('ingit-reset-local-')
    await runGit(['clone', remoteDir, localDir], tmpdir())
    await runGit(['config', 'user.email', 'test@test.com'], localDir)
    await runGit(['config', 'user.name', 'Test'], localDir)
    await Bun.write(join(localDir, 'local.txt'), 'local\n')
    await runGit(['add', '.'], localDir)
    await runGit(['commit', '-m', 'local main commit'], localDir)

    const session = await RepoSession.open(localDir)

    try {
      const result = await session.resetBranch('main')

      expect(result.headSha).toBe(await currentHeadSha(localDir))
      expect(await currentBranch(localDir)).toBe('main')
      expect(await currentHeadSha(localDir)).toBe(remoteMainSha)
      expect(await Bun.file(join(localDir, 'local.txt')).exists()).toBe(false)
    } finally {
      session.close()
    }
  })

  test('moves a non-current branch back to its upstream remote tip', async () => {
    const remoteDir = await makeTempDir('ingit-reset-branch-remote-')
    await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

    const seedDir = await makeTempDir('ingit-reset-branch-seed-')
    await initRepo(seedDir)
    await Bun.write(join(seedDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], seedDir)
    await runGit(['commit', '-m', 'base'], seedDir)
    await runGit(['remote', 'add', 'origin', remoteDir], seedDir)
    await runGit(['push', '-u', 'origin', 'main'], seedDir)

    await runGit(['checkout', '-b', 'dev'], seedDir)
    await Bun.write(join(seedDir, 'dev.txt'), 'dev\n')
    await runGit(['add', '.'], seedDir)
    await runGit(['commit', '-m', 'dev'], seedDir)
    await runGit(['push', '-u', 'origin', 'dev'], seedDir)
    const remoteDevSha = await currentHeadSha(seedDir)

    const localDir = await makeTempDir('ingit-reset-branch-local-')
    await runGit(['clone', remoteDir, localDir], tmpdir())
    await runGit(['config', 'user.email', 'test@test.com'], localDir)
    await runGit(['config', 'user.name', 'Test'], localDir)
    await runGit(['checkout', '-b', 'dev', '--track', 'origin/dev'], localDir)
    await Bun.write(join(localDir, 'dev-local.txt'), 'ahead\n')
    await runGit(['add', '.'], localDir)
    await runGit(['commit', '-m', 'local dev commit'], localDir)
    await runGit(['checkout', 'main'], localDir)

    const session = await RepoSession.open(localDir)

    try {
      const result = await session.resetBranch('dev')

      expect(result.message).toContain('dev')
      expect(await currentBranch(localDir)).toBe('main')
      expect(await branchSha(localDir, 'dev')).toBe(remoteDevSha)
    } finally {
      session.close()
    }
  })

  test('rejects resetting a branch without a remote tracking ref', async () => {
    const repoDir = await makeTempDir('ingit-reset-no-remote-')
    await initRepo(repoDir)

    await Bun.write(join(repoDir, 'base.txt'), 'base\n')
    await runGit(['add', '.'], repoDir)
    await runGit(['commit', '-m', 'base'], repoDir)

    const session = await RepoSession.open(repoDir)

    try {
      await expect(session.resetBranch('main')).rejects.toThrow('No remote tracking ref found')
    } finally {
      session.close()
    }
  })
})
