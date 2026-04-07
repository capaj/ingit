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
