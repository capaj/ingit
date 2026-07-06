import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RepoSession } from './repo-session.js'
import { runGit } from './git-command.js'
import { classifyReflogMessage } from './parsers/reflog-parser.js'

let repoDir: string
let session: RepoSession
let lostSha: string
let keptSha: string

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'ingit-reflog-test-'))
  await runGit(['init', '--initial-branch=main'], repoDir)
  await runGit(['config', 'user.email', 'test@test.com'], repoDir)
  await runGit(['config', 'user.name', 'Test'], repoDir)

  await Bun.write(join(repoDir, 'file.txt'), 'one\n')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'initial'], repoDir)
  keptSha = (await runGit(['rev-parse', 'HEAD'], repoDir)).stdout.trim()

  // A commit that gets thrown away by reset --hard → only the reflog knows it
  await Bun.write(join(repoDir, 'file.txt'), 'two\n')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'doomed work'], repoDir)
  lostSha = (await runGit(['rev-parse', 'HEAD'], repoDir)).stdout.trim()

  await runGit(['reset', '--hard', 'HEAD~1'], repoDir)

  // Checkout ping-pong so the same sha appears in multiple entries
  await runGit(['checkout', '-b', 'side'], repoDir)
  await runGit(['checkout', 'main'], repoDir)

  session = await RepoSession.open(repoDir)
})

afterAll(async () => {
  session.close()
  await rm(repoDir, { recursive: true, force: true })
})

describe('classifyReflogMessage', () => {
  test('classifies common reflog subjects', () => {
    expect(classifyReflogMessage('commit: add auth form')).toBe('commit')
    expect(classifyReflogMessage('commit (amend): fix typo')).toBe('amend')
    expect(classifyReflogMessage('commit (initial): initial')).toBe('commit')
    expect(classifyReflogMessage('checkout: moving from main to feature')).toBe('checkout')
    expect(classifyReflogMessage('reset: moving to HEAD~2')).toBe('reset')
    expect(classifyReflogMessage('rebase (finish): returning to refs/heads/main')).toBe('rebase')
    expect(classifyReflogMessage('merge feature: Fast-forward')).toBe('merge')
    expect(classifyReflogMessage('cherry-pick: add thing')).toBe('cherry-pick')
    expect(classifyReflogMessage('pull: Fast-forward')).toBe('pull')
    expect(classifyReflogMessage('branch: Created from HEAD')).toBe('branch')
    expect(classifyReflogMessage('something exotic')).toBe('other')
  })
})

describe('RepoSession.getReflog', () => {
  test('returns entries newest first with kinds, selectors and old/new chaining', async () => {
    const { refName, entries } = await session.getReflog()
    expect(refName).toBe('HEAD')
    // initial commit, doomed commit, reset, checkout -b side, checkout main
    expect(entries.length).toBe(5)

    expect(entries[0].kind).toBe('checkout')
    expect(entries[1].kind).toBe('checkout')
    expect(entries[2].kind).toBe('reset')
    expect(entries[3].kind).toBe('commit')
    expect(entries[4].kind).toBe('commit')

    expect(entries[0].selector).toBe('HEAD@{0}')
    expect(entries[0].index).toBe(0)
    expect(entries[0].entryUnix).toBeGreaterThan(0)

    // Each entry's previous position is the next entry's resulting sha
    for (let i = 0; i < entries.length - 1; i++) {
      expect(entries[i].oldSha).toBe(entries[i + 1].sha)
    }
    expect(entries[entries.length - 1].oldSha).toBeNull()

    // The reset landed back on the kept commit; the doomed commit sits before it
    expect(entries[2].sha).toBe(keptSha)
    expect(entries[3].sha).toBe(lostSha)
  })

  test('flags commits unreachable from any ref as lost', async () => {
    const { entries } = await session.getReflog()
    const doomed = entries.find((entry) => entry.sha === lostSha)
    expect(doomed).toBeDefined()
    expect(doomed!.isReachable).toBe(false)

    const kept = entries.find((entry) => entry.sha === keptSha)
    expect(kept).toBeDefined()
    expect(kept!.isReachable).toBe(true)
  })

  test('annotates entries with refs currently pointing at them', async () => {
    const { entries } = await session.getReflog()
    const tip = entries.find((entry) => entry.sha === keptSha)
    expect(tip!.refNames).toContain('main')
    expect(tip!.refNames).toContain('side')
  })

  test('respects maxCount', async () => {
    const { entries } = await session.getReflog('HEAD', 2)
    expect(entries.length).toBe(2)
  })

  test('returns empty entries for a ref without a reflog', async () => {
    const { entries } = await session.getReflog('refs/heads/does-not-exist')
    expect(entries).toEqual([])
  })
})

describe('RepoSession.createBranch', () => {
  test('recovers a lost commit by creating a branch at it', async () => {
    const result = await session.createBranch('recovered-work', lostSha)
    expect(result.message).toBeTruthy()

    const { stdout } = await runGit(['rev-parse', 'recovered-work'], repoDir)
    expect(stdout.trim()).toBe(lostSha)

    // The commit is reachable again, so the reflog no longer flags it
    const { entries } = await session.getReflog()
    const recovered = entries.find((entry) => entry.sha === lostSha)
    expect(recovered!.isReachable).toBe(true)
    expect(recovered!.refNames).toContain('recovered-work')
  })
})

describe('RepoSession.createTag', () => {
  test('creates a lightweight tag at a commit', async () => {
    const result = await session.createTag('recovered-tag', keptSha)
    expect(result.message).toBeTruthy()

    const { stdout } = await runGit(['rev-parse', 'refs/tags/recovered-tag^{commit}'], repoDir)
    expect(stdout.trim()).toBe(keptSha)
  })
})
