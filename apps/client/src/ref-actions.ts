import type { RefSummary } from '@ingit/rpc-contract'

/**
 * Force push is deliberately opt-in: the server marks a branch after it
 * verifies a history-rewriting rebase or sees a non-fast-forward rejection.
 * Ahead/behind remains a second guard for surfacing it as a direct ref action;
 * the rejection dialog handles the just-failed push separately.
 */
export function isForcePushEligible(ref: RefSummary | null | undefined): boolean {
  return ref?.kind === 'head'
    && ref.forcePushEligible === true
    && (ref.ahead ?? 0) > 0
    && (ref.behind ?? 0) > 0
}

/** Match only the typed non-fast-forward error emitted by the push endpoint. */
export function isNonFastForwardPushError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || (err as { code?: unknown }).code !== 'CONFLICT') {
    return false
  }
  const data = (err as { data?: unknown }).data
  return !!data
    && typeof data === 'object'
    && (data as { reason?: unknown }).reason === 'non-fast-forward'
}
