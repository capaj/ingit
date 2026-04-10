import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RepoSession } from './repo-session.js'
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
