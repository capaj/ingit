import { describe, expect, test } from 'bun:test'
import {
  aggregateCIState,
  extractOwnerRepoFromGithubUrl,
  fetchCommitCIStatus,
  resetGithubTokenCacheForTests,
  resetCIStatusCacheForTests,
  resolveGithubToken,
} from '../src/ci-status-handler.js'

describe('extractOwnerRepoFromGithubUrl', () => {
  test('parses standard https url', () => {
    expect(extractOwnerRepoFromGithubUrl('https://github.com/oven-sh/bun')).toBe('oven-sh/bun')
  })

  test('strips git suffixes from GitHub urls', () => {
    expect(extractOwnerRepoFromGithubUrl('https://github.com/oven-sh/bun.git')).toBe('oven-sh/bun')
    expect(extractOwnerRepoFromGithubUrl('git@github.com:oven-sh/bun.git')).toBe('oven-sh/bun')
  })

  test('returns null for non-github urls', () => {
    expect(extractOwnerRepoFromGithubUrl('https://gitlab.com/foo/bar')).toBeNull()
  })
})

describe('aggregateCIState', () => {
  test('returns none when there are no runs or statuses', () => {
    expect(aggregateCIState([], null)).toBe('none')
    expect(aggregateCIState([], { state: 'pending', statuses: [] })).toBe('none')
  })

  test('failure trumps success/pending/neutral', () => {
    expect(aggregateCIState(
      [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
        { status: 'queued', conclusion: null },
      ],
      null,
    )).toBe('failure')
  })

  test('pending trumps success when no failures', () => {
    expect(aggregateCIState(
      [
        { status: 'completed', conclusion: 'success' },
        { status: 'queued', conclusion: null },
      ],
      null,
    )).toBe('pending')
  })

  test('all-success runs aggregate to success', () => {
    expect(aggregateCIState(
      [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ],
      null,
    )).toBe('success')
  })

  test('folds combined-status state into aggregation', () => {
    expect(aggregateCIState([], { state: 'success', statuses: [{}] })).toBe('success')
    expect(aggregateCIState([], { state: 'failure', statuses: [{}] })).toBe('failure')
  })
})

describe('resolveGithubToken (e2e)', () => {
  test('returns a token via gh CLI', async () => {
    resetGithubTokenCacheForTests()
    const token = await resolveGithubToken()
    expect(token).not.toBeNull()
    expect(token!.length).toBeGreaterThan(20)
    expect(token!).toMatch(/^(gho_|ghp_|github_pat_|ghu_|ghs_)/)
  })
})

describe('fetchCommitCIStatus (e2e)', () => {
  test('returns a valid state for a real commit on a public repo with CI', async () => {
    // A commit on oven-sh/bun that has check-runs. We assert the state is one
    // of the valid values and that the call actually reaches GitHub — both the
    // token plumbing and REST path are exercised.
    resetGithubTokenCacheForTests()
    const result = await fetchCommitCIStatus('oven-sh/bun', 'f8ae8edf05b5294c22795d654444699632f01597')
    expect(['success', 'pending', 'failure', 'error', 'neutral', 'none']).toContain(result.state)
    // The commit has real check-runs (verified via `gh api` when this test
    // was written), so if the whole plumbing works we should get *something*
    // other than 'none'. A 'none' here means token/fetch/parse silently
    // fell through — the exact failure mode we wrote this test to catch.
    expect(result.state).not.toBe('none')
  }, 15_000)

  test('returns error when both GitHub endpoints fail (nonexistent repo)', async () => {
    const result = await fetchCommitCIStatus(
      'definitely-not-a-real-owner-xyz/definitely-not-a-real-repo-xyz',
      'f8ae8edf05b5294c22795d654444699632f01597',
    )
    expect(result.state).toBe('error')
  }, 15_000)

  test('caches terminal states across calls (second call does not hit network)', async () => {
    await resetCIStatusCacheForTests()
    resetGithubTokenCacheForTests()

    const first = await fetchCommitCIStatus('oven-sh/bun', 'f8ae8edf05b5294c22795d654444699632f01597')
    expect(first.state).not.toBe('none')
    expect(first.state).not.toBe('error')

    // Replace fetch with a spy that throws — if the cache is working,
    // fetchCommitCIStatus must not call it.
    const originalFetch = globalThis.fetch
    let fetchCalled = false
    globalThis.fetch = (() => {
      fetchCalled = true
      throw new Error('fetch should not be called when cache hits')
    }) as typeof fetch

    try {
      const second = await fetchCommitCIStatus('oven-sh/bun', 'f8ae8edf05b5294c22795d654444699632f01597')
      expect(fetchCalled).toBe(false)
      expect(second).toEqual(first)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 15_000)
})
