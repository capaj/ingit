import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RepoSession, runGit } from '@ingit/git-core'
import { readRepositoryVersion } from '../src/repository-version'
import { handleHistoryQuery } from '../src/history-handler'

let root: string
let repo: string
let gitDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ingit-observe-'))
  repo = join(root, 'repo')
  await runGit(['init', '--initial-branch=main', repo], root)
  await runGit(['config', 'user.email', 'test@example.com'], repo)
  await runGit(['config', 'user.name', 'Test'], repo)
  await runGit(['commit', '--allow-empty', '-m', 'initial'], repo)
  gitDir = join(repo, '.git')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('external commits and amends change the version and appear in an existing session', async () => {
  const session = await RepoSession.open(repo)
  try {
    const before = await readRepositoryVersion(gitDir)
    await runGit(['commit', '--allow-empty', '-m', 'external'], repo)
    const committed = await readRepositoryVersion(gitDir)
    expect(committed).not.toBe(before)
    await runGit(['commit', '--amend', '--allow-empty', '-m', 'amended'], repo)
    expect(await readRepositoryVersion(gitDir)).not.toBe(committed)
    const history = await handleHistoryQuery(session, {
      repoId: session.repoId, scope: { kind: 'all' }, anchor: { kind: 'head' },
      beforeRows: 0, afterRows: 100, firstParent: false, topoOrder: true,
    })
    expect(history.rows[0]?.subject).toBe('amended')
    expect(history.rows).toHaveLength(2)
  } finally {
    session.close()
  }
})

test('unchanged refs, working files, index writes, and lock files do not trigger refreshes', async () => {
  const before = await readRepositoryVersion(gitDir)
  expect(await readRepositoryVersion(gitDir)).toBe(before)
  await writeFile(join(repo, 'file.txt'), 'uncommitted')
  await runGit(['add', '.'], repo)
  await writeFile(join(gitDir, 'refs', 'heads', 'main.lock'), 'temporary')
  expect(await readRepositoryVersion(gitDir)).toBe(before)
})

test('detects nested branch creation, packed refs, and deletion', async () => {
  const initial = await readRepositoryVersion(gitDir)
  await runGit(['branch', 'feature/nested'], repo)
  const created = await readRepositoryVersion(gitDir)
  expect(created).not.toBe(initial)
  await runGit(['pack-refs', '--all'], repo)
  const packed = await readRepositoryVersion(gitDir)
  expect(packed).not.toBe(created)
  await runGit(['branch', '-D', 'feature/nested'], repo)
  expect(await readRepositoryVersion(gitDir)).not.toBe(packed)
})

test('observes shared refs and detached HEAD commits from linked worktrees', async () => {
  const linked = join(root, 'linked')
  await runGit(['worktree', 'add', '-b', 'feature', linked], repo)
  const linkedGitDir = resolve(linked, (await runGit(['rev-parse', '--git-dir'], linked)).stdout.trim())
  const mainBefore = await readRepositoryVersion(gitDir)
  const linkedBefore = await readRepositoryVersion(linkedGitDir)
  await runGit(['commit', '--allow-empty', '-m', 'main external'], repo)
  expect(await readRepositoryVersion(linkedGitDir)).not.toBe(linkedBefore)
  await runGit(['checkout', '--detach'], linked)
  const detachedBefore = await readRepositoryVersion(gitDir)
  expect(detachedBefore).not.toBe(mainBefore)
  await runGit(['commit', '--allow-empty', '-m', 'detached external'], linked)
  expect(await readRepositoryVersion(gitDir)).not.toBe(detachedBefore)
})
