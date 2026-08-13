import { describe, expect, test } from 'bun:test'
import type { RefSummary } from '@ingit/rpc-contract'
import { isForcePushEligible } from './ref-actions'

function branch(overrides: Partial<RefSummary> = {}): RefSummary {
  return {
    name: 'refs/heads/main',
    shortName: 'main',
    kind: 'head',
    targetSha: 'local',
    ...overrides,
  }
}

describe('isForcePushEligible', () => {
  test('rejects an outdated local branch', () => {
    expect(isForcePushEligible(branch({ ahead: 0, behind: 3 }))).toBe(false)
  })

  test('rejects ordinary divergence without a verified rebase', () => {
    expect(isForcePushEligible(branch({ ahead: 2, behind: 3 }))).toBe(false)
  })

  test('allows a diverged branch marked by a history-rewriting rebase', () => {
    expect(isForcePushEligible(branch({ ahead: 2, behind: 3, forcePushEligible: true }))).toBe(true)
  })

  test('still rejects a marked branch that is only behind', () => {
    expect(isForcePushEligible(branch({ ahead: 0, behind: 3, forcePushEligible: true }))).toBe(false)
  })
})
