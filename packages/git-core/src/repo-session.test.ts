import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BranchCheckedOutError, RepoSession } from './repo-session.js'
import { runGit } from './git-command.js'

let repoDir: string
let session: RepoSession

beforeAll(async () => {
  // Create a temp repo with two branches
  repoDir = await mkdtemp(join(tmpdir(), 'ingit-test-'))
  await runGit(['init', '--initial-branch=main'], repoDir)
  await runGit(['config', 'user.email', 'test@test.com'], repoDir)
  await runGit(['config', 'user.name', 'Test'], repoDir)

  // Initial commit on main
  await Bun.write(join(repoDir, 'file.txt'), 'hello')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'initial'], repoDir)

  // Create dev branch with a commit
  await runGit(['checkout', '-b', 'dev'], repoDir)
  await Bun.write(join(repoDir, 'dev.txt'), 'dev file')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'dev commit'], repoDir)

  // Back to main
  await runGit(['checkout', 'main'], repoDir)

  session = await RepoSession.open(repoDir)
})

afterAll(async () => {
  session.close()
  await rm(repoDir, { recursive: true, force: true })
})

async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await runGit(['symbolic-ref', '--short', 'HEAD'], cwd)
  return stdout.trim()
}

async function currentHeadSha(cwd: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', 'HEAD'], cwd)
  return stdout.trim()
}

async function headSubject(cwd: string): Promise<string> {
  const { stdout } = await runGit(['log', '-1', '--pretty=%s'], cwd)
  return stdout.trim()
}

async function listHeadFiles(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], cwd)
  return stdout.split('\n').filter(Boolean)
}

async function workingTreeStatus(cwd: string): Promise<string> {
  const { stdout } = await runGit(['status', '--short'], cwd)
  return stdout.trim()
}

interface ActionFixture {
  repoDir: string
  devSha: string
  mainChangeSha: string
  cleanup: () => Promise<void>
}

async function createActionFixture(): Promise<ActionFixture> {
  const actionRepoDir = await mkdtemp(join(tmpdir(), 'ingit-action-test-'))
  await runGit(['init', '--initial-branch=main'], actionRepoDir)
  await runGit(['config', 'user.email', 'test@test.com'], actionRepoDir)
  await runGit(['config', 'user.name', 'Test'], actionRepoDir)

  await Bun.write(join(actionRepoDir, 'file.txt'), 'hello\n')
  await runGit(['add', '.'], actionRepoDir)
  await runGit(['commit', '-m', 'initial'], actionRepoDir)

  await runGit(['checkout', '-b', 'dev'], actionRepoDir)
  await Bun.write(join(actionRepoDir, 'dev.txt'), 'dev file\n')
  await runGit(['add', '.'], actionRepoDir)
  await runGit(['commit', '-m', 'dev commit'], actionRepoDir)
  const devSha = await currentHeadSha(actionRepoDir)

  await runGit(['checkout', 'main'], actionRepoDir)
  await Bun.write(join(actionRepoDir, 'main.txt'), 'main change\n')
  await runGit(['add', '.'], actionRepoDir)
  await runGit(['commit', '-m', 'main change'], actionRepoDir)
  const mainChangeSha = await currentHeadSha(actionRepoDir)

  return {
    repoDir: actionRepoDir,
    devSha,
    mainChangeSha,
    cleanup: async () => {
      await rm(actionRepoDir, { recursive: true, force: true })
    },
  }
}

describe('RepoSession.checkout', () => {
  test('starts on main', async () => {
    expect(await currentBranch(repoDir)).toBe('main')
  })

  test('switches to dev', async () => {
    await session.checkout('dev')
    expect(await currentBranch(repoDir)).toBe('dev')
  })

  test('switches back to main', async () => {
    await session.checkout('main')
    expect(await currentBranch(repoDir)).toBe('main')
  })

  test('getRefs reports correct isCurrent after checkout', async () => {
    await session.checkout('dev')
    const refs = await session.getRefs()
    const devRef = refs.find(r => r.shortName === 'dev')
    const mainRef = refs.find(r => r.shortName === 'main')
    expect(devRef?.isCurrent).toBe(true)
    expect(mainRef?.isCurrent).toBeUndefined()

    await session.checkout('main')
    const refs2 = await session.getRefs()
    const devRef2 = refs2.find(r => r.shortName === 'dev')
    const mainRef2 = refs2.find(r => r.shortName === 'main')
    expect(mainRef2?.isCurrent).toBe(true)
    expect(devRef2?.isCurrent).toBeUndefined()
  })

  test('lists and removes linked worktrees and reports an occupied branch before checkout', async () => {
    const worktreeParent = await mkdtemp(join(tmpdir(), 'ingit-linked-worktree-'))
    const worktreePath = join(worktreeParent, 'dev tree')

    try {
      await runGit(['worktree', 'add', worktreePath, 'dev'], repoDir)

      const worktrees = await session.getWorktrees()
      expect(worktrees).toHaveLength(2)
      expect(worktrees.find((worktree) => worktree.path === repoDir)).toMatchObject({
        branchShortName: 'main',
        isCurrent: true,
      })
      expect(worktrees.find((worktree) => worktree.path === worktreePath)).toMatchObject({
        branchRef: 'refs/heads/dev',
        branchShortName: 'dev',
        isCurrent: false,
      })

      await expect(session.checkout('dev')).rejects.toMatchObject({
        name: 'BranchCheckedOutError',
        branchRef: 'refs/heads/dev',
        worktreePath,
      } satisfies Partial<BranchCheckedOutError>)
      expect(await currentBranch(repoDir)).toBe('main')

      await expect(session.removeWorktree(repoDir)).rejects.toThrow('current worktree')
      const remainingWorktrees = await session.removeWorktree(worktreePath)
      expect(remainingWorktrees).toHaveLength(1)
      expect(remainingWorktrees[0]?.path).toBe(repoDir)
      expect(await Bun.file(join(worktreePath, 'dev.txt')).exists()).toBe(false)
    } finally {
      await runGit(['worktree', 'remove', '--force', worktreePath], repoDir, { okCodes: [128] })
      await rm(worktreeParent, { recursive: true, force: true })
    }
  })

  test('checking out a remote branch creates a local tracking branch', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-remote-'))
    const seedDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-seed-'))
    const localDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-local-'))

    try {
      await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

      await runGit(['init', '--initial-branch=main'], seedDir)
      await runGit(['config', 'user.email', 'test@test.com'], seedDir)
      await runGit(['config', 'user.name', 'Test'], seedDir)
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

      await runGit(['clone', remoteDir, localDir], tmpdir())
      await runGit(['config', 'user.email', 'test@test.com'], localDir)
      await runGit(['config', 'user.name', 'Test'], localDir)
      await Bun.write(join(localDir, 'base.txt'), 'base\nstaged before checkout\n')
      await runGit(['add', 'base.txt'], localDir)
      await Bun.write(join(localDir, 'untracked.txt'), 'untracked before checkout\n')

      const checkoutSession = await RepoSession.open(localDir)

      try {
        await checkoutSession.checkout('origin/dev')

        expect(await currentBranch(localDir)).toBe('dev')
        expect(await currentHeadSha(localDir)).toBe((await runGit(['rev-parse', 'origin/dev'], localDir)).stdout.trim())
        expect((await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], localDir)).stdout.trim()).toBe('origin/dev')
        expect(await Bun.file(join(localDir, 'base.txt')).text()).toBe('base\nstaged before checkout\n')
        expect(await Bun.file(join(localDir, 'untracked.txt')).text()).toBe('untracked before checkout\n')
        expect(await workingTreeStatus(localDir)).toContain('base.txt')
        expect((await runGit(['stash', 'list'], localDir)).stdout.trim()).toBe('')
      } finally {
        checkoutSession.close()
      }
    } finally {
      await rm(remoteDir, { recursive: true, force: true })
      await rm(seedDir, { recursive: true, force: true })
      await rm(localDir, { recursive: true, force: true })
    }
  })

  test('carries uncommitted changes across a branch switch', async () => {
    const migrateDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-migrate-'))

    try {
      await runGit(['init', '--initial-branch=main'], migrateDir)
      await runGit(['config', 'user.email', 'test@test.com'], migrateDir)
      await runGit(['config', 'user.name', 'Test'], migrateDir)

      await Bun.write(join(migrateDir, 'shared.txt'), 'base\n')
      await runGit(['add', '.'], migrateDir)
      await runGit(['commit', '-m', 'initial'], migrateDir)

      await runGit(['checkout', '-b', 'feature'], migrateDir)
      await runGit(['checkout', 'main'], migrateDir)

      await Bun.write(join(migrateDir, 'shared.txt'), 'base\nlocal edit\n')

      const migrateSession = await RepoSession.open(migrateDir)

      try {
        await migrateSession.checkout('feature')

        expect(await currentBranch(migrateDir)).toBe('feature')
        const shared = await Bun.file(join(migrateDir, 'shared.txt')).text()
        expect(shared).toBe('base\nlocal edit\n')
        expect(await workingTreeStatus(migrateDir)).toContain('shared.txt')
      } finally {
        migrateSession.close()
      }
    } finally {
      await rm(migrateDir, { recursive: true, force: true })
    }
  })

  test('carries staged changes across a local branch switch', async () => {
    const migrateDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-staged-'))

    try {
      await runGit(['init', '--initial-branch=main'], migrateDir)
      await runGit(['config', 'user.email', 'test@test.com'], migrateDir)
      await runGit(['config', 'user.name', 'Test'], migrateDir)
      await Bun.write(join(migrateDir, 'shared.txt'), 'base\n')
      await runGit(['add', '.'], migrateDir)
      await runGit(['commit', '-m', 'initial'], migrateDir)
      await runGit(['branch', 'feature'], migrateDir)

      await Bun.write(join(migrateDir, 'shared.txt'), 'base\nolder stashed edit\n')
      await runGit(['stash', 'push', '-m', 'existing user stash'], migrateDir)
      await Bun.write(join(migrateDir, 'shared.txt'), 'base\nstaged edit\n')
      await runGit(['add', 'shared.txt'], migrateDir)

      const migrateSession = await RepoSession.open(migrateDir)
      try {
        await migrateSession.checkout('feature')

        expect(await currentBranch(migrateDir)).toBe('feature')
        expect(await Bun.file(join(migrateDir, 'shared.txt')).text()).toBe('base\nstaged edit\n')
        expect(await workingTreeStatus(migrateDir)).toContain('shared.txt')
        const stashList = (await runGit(['stash', 'list'], migrateDir)).stdout.trim()
        expect(stashList).toContain('existing user stash')
        expect(stashList).not.toContain('ingit auto-stash')
      } finally {
        migrateSession.close()
      }
    } finally {
      await rm(migrateDir, { recursive: true, force: true })
    }
  })

  test('restores staged changes when checkout itself fails', async () => {
    const migrateDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-restore-'))

    try {
      await runGit(['init', '--initial-branch=main'], migrateDir)
      await runGit(['config', 'user.email', 'test@test.com'], migrateDir)
      await runGit(['config', 'user.name', 'Test'], migrateDir)
      await Bun.write(join(migrateDir, 'shared.txt'), 'base\n')
      await runGit(['add', '.'], migrateDir)
      await runGit(['commit', '-m', 'initial'], migrateDir)
      await Bun.write(join(migrateDir, 'shared.txt'), 'base\nstaged edit\n')
      await runGit(['add', 'shared.txt'], migrateDir)

      const migrateSession = await RepoSession.open(migrateDir)
      try {
        await expect(migrateSession.checkout('missing-branch')).rejects.toThrow()

        expect(await currentBranch(migrateDir)).toBe('main')
        expect(await Bun.file(join(migrateDir, 'shared.txt')).text()).toBe('base\nstaged edit\n')
        expect(await workingTreeStatus(migrateDir)).toContain('shared.txt')
        expect((await runGit(['stash', 'list'], migrateDir)).stdout.trim()).toBe('')
      } finally {
        migrateSession.close()
      }
    } finally {
      await rm(migrateDir, { recursive: true, force: true })
    }
  })

  test('keeps the temporary stash when changes conflict on the destination branch', async () => {
    const migrateDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-conflict-'))

    try {
      await runGit(['init', '--initial-branch=main'], migrateDir)
      await runGit(['config', 'user.email', 'test@test.com'], migrateDir)
      await runGit(['config', 'user.name', 'Test'], migrateDir)
      await Bun.write(join(migrateDir, 'shared.txt'), 'base\n')
      await runGit(['add', '.'], migrateDir)
      await runGit(['commit', '-m', 'initial'], migrateDir)
      await runGit(['checkout', '-b', 'feature'], migrateDir)
      await Bun.write(join(migrateDir, 'shared.txt'), 'feature edit\n')
      await runGit(['commit', '-am', 'feature edit'], migrateDir)
      await runGit(['checkout', 'main'], migrateDir)
      await Bun.write(join(migrateDir, 'shared.txt'), 'staged main edit\n')
      await runGit(['add', 'shared.txt'], migrateDir)

      const migrateSession = await RepoSession.open(migrateDir)
      try {
        await expect(migrateSession.checkout('feature')).rejects.toThrow(/remain safe in stash/)

        expect(await currentBranch(migrateDir)).toBe('feature')
        expect(await workingTreeStatus(migrateDir)).toContain('UU shared.txt')
        expect((await runGit(['stash', 'list'], migrateDir)).stdout).toContain('ingit auto-stash before checkout feature')
      } finally {
        migrateSession.close()
      }
    } finally {
      await rm(migrateDir, { recursive: true, force: true })
    }
  })

  test('checking out a remote branch moves the local branch to that remote tip', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-remote-move-'))
    const seedDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-seed-move-'))
    const upstreamDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-upstream-move-'))
    const localDir = await mkdtemp(join(tmpdir(), 'ingit-checkout-local-move-'))

    try {
      await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

      await runGit(['init', '--initial-branch=main'], seedDir)
      await runGit(['config', 'user.email', 'test@test.com'], seedDir)
      await runGit(['config', 'user.name', 'Test'], seedDir)
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

      await runGit(['clone', remoteDir, localDir], tmpdir())
      await runGit(['config', 'user.email', 'test@test.com'], localDir)
      await runGit(['config', 'user.name', 'Test'], localDir)
      await runGit(['checkout', '-b', 'dev', '--track', 'origin/dev'], localDir)
      const localDevShaBeforeCheckout = await currentHeadSha(localDir)
      await runGit(['checkout', 'main'], localDir)

      await runGit(['clone', remoteDir, upstreamDir], tmpdir())
      await runGit(['config', 'user.email', 'test@test.com'], upstreamDir)
      await runGit(['config', 'user.name', 'Test'], upstreamDir)
      await runGit(['checkout', 'dev'], upstreamDir)
      await Bun.write(join(upstreamDir, 'dev.txt'), 'dev v2\n')
      await runGit(['add', '.'], upstreamDir)
      await runGit(['commit', '-m', 'dev v2'], upstreamDir)
      await runGit(['push', 'origin', 'dev'], upstreamDir)
      const remoteDevSha = await currentHeadSha(upstreamDir)

      await runGit(['fetch', 'origin', 'dev'], localDir)

      const checkoutSession = await RepoSession.open(localDir)

      try {
        await checkoutSession.checkout('origin/dev')

        expect(await currentBranch(localDir)).toBe('dev')
        expect(await currentHeadSha(localDir)).toBe(remoteDevSha)
        expect(remoteDevSha).not.toBe(localDevShaBeforeCheckout)
        expect((await runGit(['rev-parse', 'dev'], localDir)).stdout.trim()).toBe(remoteDevSha)
      } finally {
        checkoutSession.close()
      }
    } finally {
      await rm(remoteDir, { recursive: true, force: true })
      await rm(seedDir, { recursive: true, force: true })
      await rm(upstreamDir, { recursive: true, force: true })
      await rm(localDir, { recursive: true, force: true })
    }
  })
})

describe('RepoSession.fetch', () => {
  test('fetches remotes and fast-forwards the current tracking branch', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-remote-'))
    const seedDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-seed-'))
    const upstreamDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-upstream-'))
    const localDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-local-'))

    try {
      await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

      await runGit(['init', '--initial-branch=main'], seedDir)
      await runGit(['config', 'user.email', 'test@test.com'], seedDir)
      await runGit(['config', 'user.name', 'Test'], seedDir)
      await Bun.write(join(seedDir, 'base.txt'), 'base\n')
      await runGit(['add', '.'], seedDir)
      await runGit(['commit', '-m', 'base'], seedDir)
      await runGit(['remote', 'add', 'origin', remoteDir], seedDir)
      await runGit(['push', '-u', 'origin', 'main'], seedDir)

      await runGit(['clone', remoteDir, localDir], tmpdir())
      await runGit(['config', 'user.email', 'test@test.com'], localDir)
      await runGit(['config', 'user.name', 'Test'], localDir)
      const oldLocalSha = await currentHeadSha(localDir)

      await runGit(['clone', remoteDir, upstreamDir], tmpdir())
      await runGit(['config', 'user.email', 'test@test.com'], upstreamDir)
      await runGit(['config', 'user.name', 'Test'], upstreamDir)
      await Bun.write(join(upstreamDir, 'remote.txt'), 'remote\n')
      await runGit(['add', '.'], upstreamDir)
      await runGit(['commit', '-m', 'remote update'], upstreamDir)
      await runGit(['push', 'origin', 'main'], upstreamDir)
      const remoteSha = await currentHeadSha(upstreamDir)

      const fetchSession = await RepoSession.open(localDir)
      try {
        const result = await fetchSession.fetch()

        expect(result.fastForwarded).toBe(true)
        expect(result.headSha).toBe(remoteSha)
        expect(await currentHeadSha(localDir)).toBe(remoteSha)
        expect((await runGit(['rev-parse', 'origin/main'], localDir)).stdout.trim()).toBe(remoteSha)
        expect(remoteSha).not.toBe(oldLocalSha)
      } finally {
        fetchSession.close()
      }
    } finally {
      await rm(remoteDir, { recursive: true, force: true })
      await rm(seedDir, { recursive: true, force: true })
      await rm(upstreamDir, { recursive: true, force: true })
      await rm(localDir, { recursive: true, force: true })
    }
  })

  test('keeps fetched remote refs when the current branch cannot fast-forward', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-diverged-remote-'))
    const seedDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-diverged-seed-'))
    const upstreamDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-diverged-upstream-'))
    const localDir = await mkdtemp(join(tmpdir(), 'ingit-fetch-diverged-local-'))

    try {
      await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)

      await runGit(['init', '--initial-branch=main'], seedDir)
      await runGit(['config', 'user.email', 'test@test.com'], seedDir)
      await runGit(['config', 'user.name', 'Test'], seedDir)
      await Bun.write(join(seedDir, 'base.txt'), 'base\n')
      await runGit(['add', '.'], seedDir)
      await runGit(['commit', '-m', 'base'], seedDir)
      await runGit(['remote', 'add', 'origin', remoteDir], seedDir)
      await runGit(['push', '-u', 'origin', 'main'], seedDir)

      await runGit(['clone', remoteDir, localDir], tmpdir())
      await runGit(['config', 'user.email', 'test@test.com'], localDir)
      await runGit(['config', 'user.name', 'Test'], localDir)
      await Bun.write(join(localDir, 'local.txt'), 'local\n')
      await runGit(['add', '.'], localDir)
      await runGit(['commit', '-m', 'local update'], localDir)
      const localSha = await currentHeadSha(localDir)

      await runGit(['clone', remoteDir, upstreamDir], tmpdir())
      await runGit(['config', 'user.email', 'test@test.com'], upstreamDir)
      await runGit(['config', 'user.name', 'Test'], upstreamDir)
      await Bun.write(join(upstreamDir, 'remote.txt'), 'remote\n')
      await runGit(['add', '.'], upstreamDir)
      await runGit(['commit', '-m', 'remote update'], upstreamDir)
      await runGit(['push', 'origin', 'main'], upstreamDir)
      const remoteSha = await currentHeadSha(upstreamDir)

      const fetchSession = await RepoSession.open(localDir)
      try {
        const result = await fetchSession.fetch()

        expect(result.fastForwarded).toBe(false)
        expect(result.headSha).toBe(localSha)
        expect(result.message).toContain('Fast-forward skipped')
        expect(await currentHeadSha(localDir)).toBe(localSha)
        expect((await runGit(['rev-parse', 'origin/main'], localDir)).stdout.trim()).toBe(remoteSha)
      } finally {
        fetchSession.close()
      }
    } finally {
      await rm(remoteDir, { recursive: true, force: true })
      await rm(seedDir, { recursive: true, force: true })
      await rm(upstreamDir, { recursive: true, force: true })
      await rm(localDir, { recursive: true, force: true })
    }
  })
})

describe('RepoSession.streamTopologyWithMeta', () => {
  test('reports additions and deletions separately', async () => {
    const metaRepoDir = await mkdtemp(join(tmpdir(), 'ingit-meta-test-'))

    try {
      await runGit(['init', '--initial-branch=main'], metaRepoDir)
      await runGit(['config', 'user.email', 'test@test.com'], metaRepoDir)
      await runGit(['config', 'user.name', 'Test'], metaRepoDir)

      await Bun.write(join(metaRepoDir, 'file.txt'), 'alpha\nbeta\n')
      await runGit(['add', '.'], metaRepoDir)
      await runGit(['commit', '-m', 'initial'], metaRepoDir)

      await Bun.write(join(metaRepoDir, 'file.txt'), 'alpha\ngamma\ndelta\n')
      await runGit(['add', '.'], metaRepoDir)
      await runGit(['commit', '-m', 'reshape file'], metaRepoDir)

      const metaSession = await RepoSession.open(metaRepoDir)

      try {
        const entries: Array<{ subject: string; additions: number; deletions: number; locChanged: number }> = []

        await metaSession.streamTopologyWithMeta(
          ['--max-count=1', '--parents', 'HEAD'],
          (entry) => {
            entries.push({
              subject: entry.subject,
              additions: entry.additions,
              deletions: entry.deletions,
              locChanged: entry.locChanged,
            })
          },
        )

        expect(entries).toHaveLength(1)
        expect(entries[0]).toEqual({
          subject: 'reshape file',
          additions: 2,
          deletions: 1,
          locChanged: 3,
        })
      } finally {
        metaSession.close()
      }
    } finally {
      await rm(metaRepoDir, { recursive: true, force: true })
    }
  })
})

describe('RepoSession commit file diffs', () => {
  test('loads a patch for one file changed by a commit', async () => {
    const diffRepoDir = await mkdtemp(join(tmpdir(), 'ingit-commit-diff-'))

    try {
      await runGit(['init', '--initial-branch=main'], diffRepoDir)
      await runGit(['config', 'user.email', 'test@test.com'], diffRepoDir)
      await runGit(['config', 'user.name', 'Test'], diffRepoDir)

      await Bun.write(join(diffRepoDir, 'file.txt'), 'one\n')
      await runGit(['add', '.'], diffRepoDir)
      await runGit(['commit', '-m', 'initial'], diffRepoDir)

      await Bun.write(join(diffRepoDir, 'file.txt'), 'one\ntwo\n')
      await runGit(['add', '.'], diffRepoDir)
      await runGit(['commit', '-m', 'update file'], diffRepoDir)
      const sha = await currentHeadSha(diffRepoDir)

      const diffSession = await RepoSession.open(diffRepoDir)
      try {
        const fileDiff = await diffSession.getCommitFileDiff(sha, 'file.txt')

        expect(fileDiff.sha).toBe(sha)
        expect(fileDiff.path).toBe('file.txt')
        expect(fileDiff.isBinary).toBe(false)
        expect(fileDiff.patchText).toContain('diff --git a/file.txt b/file.txt')
        expect(fileDiff.patchText).toContain('+two')
      } finally {
        diffSession.close()
      }
    } finally {
      await rm(diffRepoDir, { recursive: true, force: true })
    }
  })

  test('preserves rename headers when loading a renamed file patch', async () => {
    const renameRepoDir = await mkdtemp(join(tmpdir(), 'ingit-commit-rename-diff-'))

    try {
      await runGit(['init', '--initial-branch=main'], renameRepoDir)
      await runGit(['config', 'user.email', 'test@test.com'], renameRepoDir)
      await runGit(['config', 'user.name', 'Test'], renameRepoDir)

      await Bun.write(join(renameRepoDir, 'old-name.txt'), 'same\n')
      await runGit(['add', '.'], renameRepoDir)
      await runGit(['commit', '-m', 'initial'], renameRepoDir)

      await runGit(['mv', 'old-name.txt', 'new-name.txt'], renameRepoDir)
      await runGit(['commit', '-m', 'rename file'], renameRepoDir)
      const sha = await currentHeadSha(renameRepoDir)

      const renameSession = await RepoSession.open(renameRepoDir)
      try {
        const diff = await renameSession.getCommitDiff(sha)
        const changedPath = diff.changedPaths.find((entry) => entry.status === 'R')

        expect(changedPath).toEqual({ path: 'new-name.txt', oldPath: 'old-name.txt', status: 'R' })
        const fileDiff = await renameSession.getCommitFileDiff(sha, changedPath!.path, changedPath!.oldPath)

        expect(fileDiff.patchText).toContain('rename from old-name.txt')
        expect(fileDiff.patchText).toContain('rename to new-name.txt')
      } finally {
        renameSession.close()
      }
    } finally {
      await rm(renameRepoDir, { recursive: true, force: true })
    }
  })
})

describe('RepoSession commit actions', () => {
  test('uncommits the current head commit and keeps the change in the working tree', async () => {
    const fixture = await createActionFixture()
    const actionSession = await RepoSession.open(fixture.repoDir)

    try {
      const result = await actionSession.uncommit(fixture.mainChangeSha)

      expect(await currentBranch(fixture.repoDir)).toBe('main')
      expect(result.headSha).toBe(await currentHeadSha(fixture.repoDir))
      expect(await headSubject(fixture.repoDir)).toBe('initial')
      expect(await listHeadFiles(fixture.repoDir)).not.toContain('main.txt')
      expect(await Bun.file(join(fixture.repoDir, 'main.txt')).text()).toBe('main change\n')
      expect(await workingTreeStatus(fixture.repoDir)).toContain('?? main.txt')
    } finally {
      actionSession.close()
      await fixture.cleanup()
    }
  })

  test('cherry-picks a non-merge commit onto the current branch', async () => {
    const fixture = await createActionFixture()
    const actionSession = await RepoSession.open(fixture.repoDir)

    try {
      const result = await actionSession.cherryPick(fixture.devSha)

      expect(await currentBranch(fixture.repoDir)).toBe('main')
      expect(result.headSha).toBe(await currentHeadSha(fixture.repoDir))
      expect(result.headSha).not.toBe(fixture.devSha)
      expect(await headSubject(fixture.repoDir)).toBe('dev commit')
      expect(await listHeadFiles(fixture.repoDir)).toContain('dev.txt')
    } finally {
      actionSession.close()
      await fixture.cleanup()
    }
  })

  test('reverts a non-merge commit on the current branch', async () => {
    const fixture = await createActionFixture()
    const actionSession = await RepoSession.open(fixture.repoDir)

    try {
      const result = await actionSession.revert(fixture.mainChangeSha)

      expect(await currentBranch(fixture.repoDir)).toBe('main')
      expect(result.headSha).toBe(await currentHeadSha(fixture.repoDir))
      expect(await headSubject(fixture.repoDir)).toBe('Revert "main change"')
      expect(await listHeadFiles(fixture.repoDir)).not.toContain('main.txt')
    } finally {
      actionSession.close()
      await fixture.cleanup()
    }
  })

  test('rejects merge commits for cherry-pick and revert', async () => {
    const fixture = await createActionFixture()
    await runGit(['merge', '--no-ff', 'dev', '-m', 'merge dev'], fixture.repoDir)
    const mergeSha = await currentHeadSha(fixture.repoDir)
    const actionSession = await RepoSession.open(fixture.repoDir)

    try {
      await expect(actionSession.cherryPick(mergeSha)).rejects.toThrow('merge commits')
      await expect(actionSession.revert(mergeSha)).rejects.toThrow('merge commits')
    } finally {
      actionSession.close()
      await fixture.cleanup()
    }
  })

  test('rejects uncommit when the selected commit is not HEAD', async () => {
    const fixture = await createActionFixture()
    const actionSession = await RepoSession.open(fixture.repoDir)

    try {
      await expect(actionSession.uncommit(fixture.devSha)).rejects.toThrow('current HEAD')
    } finally {
      actionSession.close()
      await fixture.cleanup()
    }
  })
})

describe('RepoSession.push', () => {
  test('pushes a local tag to origin', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'ingit-push-tag-remote-'))
    const localDir = await mkdtemp(join(tmpdir(), 'ingit-push-tag-local-'))

    try {
      await runGit(['init', '--bare', '--initial-branch=main'], remoteDir)
      await runGit(['init', '--initial-branch=main'], localDir)
      await runGit(['config', 'user.email', 'test@test.com'], localDir)
      await runGit(['config', 'user.name', 'Test'], localDir)

      await Bun.write(join(localDir, 'file.txt'), 'tagged\n')
      await runGit(['add', '.'], localDir)
      await runGit(['commit', '-m', 'tagged commit'], localDir)
      await runGit(['remote', 'add', 'origin', remoteDir], localDir)
      await runGit(['push', '-u', 'origin', 'main'], localDir)
      const taggedSha = await currentHeadSha(localDir)

      const pushSession = await RepoSession.open(localDir)
      try {
        await pushSession.createTag('v-test', taggedSha)
        await pushSession.push('v-test')
      } finally {
        pushSession.close()
      }

      const { stdout } = await runGit(['rev-parse', 'refs/tags/v-test^{commit}'], remoteDir)
      expect(stdout.trim()).toBe(taggedSha)
    } finally {
      await rm(remoteDir, { recursive: true, force: true })
      await rm(localDir, { recursive: true, force: true })
    }
  })
})
