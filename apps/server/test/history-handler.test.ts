import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoSession, runGit } from '@ingit/git-core'
import { handleHistoryQuery } from '../src/history-handler.js'

const repoDirs = new Set<string>()

afterEach(async () => {
  await Promise.all([...repoDirs].map(async (repoDir) => {
    await rm(repoDir, { recursive: true, force: true })
    repoDirs.delete(repoDir)
  }))
})

async function runGitWithEnv(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: null,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])

  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr.trim()}`)
  }
}

async function commitFile(
  repoDir: string,
  path: string,
  content: string,
  message: string,
  isoDate: string,
): Promise<void> {
  await Bun.write(join(repoDir, path), content)
  await runGit(['add', path], repoDir)
  await runGitWithEnv(
    ['commit', '-m', message],
    repoDir,
    {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    },
  )
}

async function createOrderingFixture(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), 'ingit-history-order-'))
  repoDirs.add(repoDir)

  await runGit(['init', '--initial-branch=main'], repoDir)
  await runGit(['config', 'user.email', 'test@test.com'], repoDir)
  await runGit(['config', 'user.name', 'Test'], repoDir)

  await commitFile(repoDir, 'base.txt', 'base\n', 'base', '2026-04-01T10:00:00+00:00')
  await runGit(['branch', 'side'], repoDir)

  await commitFile(repoDir, 'main.txt', 'main older\n', 'main-older', '2026-04-03T10:00:00+00:00')
  await commitFile(repoDir, 'head.txt', 'main newer\n', 'main-newer-head', '2026-04-10T10:00:00+00:00')

  await runGit(['checkout', 'side'], repoDir)
  await commitFile(repoDir, 'side.txt', 'side between\n', 'side-between', '2026-04-09T10:00:00+00:00')
  await runGit(['checkout', 'main'], repoDir)

  return repoDir
}

describe('handleHistoryQuery ordering', () => {
  test('keeps newer side-branch commits above older mainline commits', async () => {
    const repoDir = await createOrderingFixture()
    const session = await RepoSession.open(repoDir)

    try {
      const history = await handleHistoryQuery(session, {
        repoId: session.repoId,
        scope: { kind: 'all' },
        anchor: { kind: 'head' },
        beforeRows: 0,
        afterRows: 10,
        firstParent: false,
        topoOrder: true,
      })

      expect(history.rows.map((row) => row.subject)).toEqual([
        'main-newer-head',
        'side-between',
        'main-older',
        'base',
      ])

      const committerTimes = history.rows.map((row) => row.committerUnix)
      expect(committerTimes).toEqual([...committerTimes].sort((a, b) => b - a))
    } finally {
      session.close()
    }
  })

  test('includes detached HEAD commits in all-history scope', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'ingit-history-detached-head-'))
    repoDirs.add(repoDir)

    await runGit(['init', '--initial-branch=main'], repoDir)
    await runGit(['config', 'user.email', 'test@test.com'], repoDir)
    await runGit(['config', 'user.name', 'Test'], repoDir)

    await commitFile(repoDir, 'base.txt', 'base\n', 'base', '2026-04-01T10:00:00+00:00')
    await runGit(['checkout', '--detach', 'HEAD'], repoDir)
    await commitFile(repoDir, 'detached.txt', 'detached\n', 'detached-head', '2026-04-02T10:00:00+00:00')

    const session = await RepoSession.open(repoDir)

    try {
      const history = await handleHistoryQuery(session, {
        repoId: session.repoId,
        scope: { kind: 'all' },
        anchor: { kind: 'head' },
        beforeRows: 0,
        afterRows: 10,
        firstParent: false,
        topoOrder: true,
      })

      expect(history.rows.map((row) => row.subject)).toContain('detached-head')
    } finally {
      session.close()
    }
  })
})
