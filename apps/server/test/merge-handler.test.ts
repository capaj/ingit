import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoSession, runGit } from '@ingit/git-core'
import { getMergePreview } from '../src/merge-handler.js'

const repoDirs = new Set<string>()

afterEach(async () => {
  await Promise.all([...repoDirs].map(async (repoDir) => {
    await rm(repoDir, { recursive: true, force: true })
    repoDirs.delete(repoDir)
  }))
})

async function createPreviewFixture() {
  const repoDir = await mkdtemp(join(tmpdir(), 'ingit-merge-preview-'))
  repoDirs.add(repoDir)

  await runGit(['init', '--initial-branch=main'], repoDir)
  await runGit(['config', 'user.email', 'test@test.com'], repoDir)
  await runGit(['config', 'user.name', 'Test'], repoDir)

  await Bun.write(join(repoDir, 'base.txt'), 'base\n')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'base'], repoDir)

  await runGit(['branch', 'old'], repoDir)

  await runGit(['checkout', '-b', 'feature'], repoDir)
  await Bun.write(join(repoDir, 'feature.txt'), 'feature\n')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'feature'], repoDir)
  const featureSha = (await runGit(['rev-parse', 'HEAD'], repoDir)).stdout.trim()

  await runGit(['checkout', 'main'], repoDir)
  await Bun.write(join(repoDir, 'main.txt'), 'main\n')
  await runGit(['add', '.'], repoDir)
  await runGit(['commit', '-m', 'main'], repoDir)
  const mainHeadSha = (await runGit(['rev-parse', 'HEAD'], repoDir)).stdout.trim()

  return { repoDir, featureSha, mainHeadSha }
}

describe('getMergePreview', () => {
  test('reports mergeable refs with target/source metadata', async () => {
    const fixture = await createPreviewFixture()
    const session = await RepoSession.open(fixture.repoDir)

    try {
      const preview = await getMergePreview(session, 'feature')

      expect(preview).toEqual({
        mergeable: true,
        sourceRefName: 'feature',
        sourceSha: fixture.featureSha,
        targetRefName: 'main',
        targetSha: fixture.mainHeadSha,
        requiresFetch: false,
      })
    } finally {
      session.close()
    }
  })

  test('reports the current branch as non-mergeable', async () => {
    const fixture = await createPreviewFixture()
    const session = await RepoSession.open(fixture.repoDir)

    try {
      const preview = await getMergePreview(session, 'main')

      expect(preview.mergeable).toBe(false)
      expect(preview.reason).toBe('current-branch')
      expect(preview.targetRefName).toBe('main')
      expect(preview.targetSha).toBe(fixture.mainHeadSha)
    } finally {
      session.close()
    }
  })

  test('reports already-contained branches as up-to-date', async () => {
    const fixture = await createPreviewFixture()
    const session = await RepoSession.open(fixture.repoDir)

    try {
      const preview = await getMergePreview(session, 'old')

      expect(preview.mergeable).toBe(false)
      expect(preview.reason).toBe('up-to-date')
      expect(preview.targetRefName).toBe('main')
      expect(preview.targetSha).toBe(fixture.mainHeadSha)
    } finally {
      session.close()
    }
  })

  test('rejects merge preview when HEAD is detached', async () => {
    const fixture = await createPreviewFixture()
    await runGit(['checkout', fixture.mainHeadSha], fixture.repoDir)
    const session = await RepoSession.open(fixture.repoDir)

    try {
      const preview = await getMergePreview(session, 'feature')

      expect(preview.mergeable).toBe(false)
      expect(preview.reason).toBe('detached-head')
      expect(preview.sourceRefName).toBe('feature')
      expect(preview.targetSha).toBe(fixture.mainHeadSha)
    } finally {
      session.close()
    }
  })
})
