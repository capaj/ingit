import type { RefSummary } from '@ingit/rpc-contract'

/**
 * Force push is deliberately opt-in: the server marks a branch only after an
 * in-session rebase actually rewrites its history. Ahead/behind remains a
 * second guard so an outdated branch can never surface the destructive action.
 */
export function isForcePushEligible(ref: RefSummary | null | undefined): boolean {
  return ref?.kind === 'head'
    && ref.forcePushEligible === true
    && (ref.ahead ?? 0) > 0
    && (ref.behind ?? 0) > 0
}
