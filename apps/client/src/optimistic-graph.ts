// Optimistic graph prediction.
//
// Mutations (checkout / rebase / merge / commit actions) used to wait for the
// server roundtrip before the graph re-laid-out, which read as a ~1s freeze on
// click. To make them feel instant we predict the post-mutation layout on the
// client the moment the user clicks, animate to it, and only correct course if
// the server disagrees (or fails).
//
// Lane assignment is shared, isomorphic code (`@ingit/graph-core`) — the very
// same allocator the server runs — so a prediction matches the authoritative
// result closely. Rewrites (rebase/merge/cherry-pick/revert) mint new SHAs on
// the server that we can't know ahead of time, so we keep the *old* SHAs as
// placeholders; the store jumps (without animating) to the real rows once they
// arrive, and since predicted node positions line up, the swap is invisible.
//
// Every predictor returns `null` when it can't safely predict (e.g. the commits
// involved aren't in the loaded window). Callers fall back to the plain
// server-driven path in that case.

import { Projection } from '@ingit/graph-core'
import type { CommitRow, RefSummary } from '@ingit/rpc-contract'

export interface OptimisticGraph {
  rows: CommitRow[]
  refs: RefSummary[]
  /** New HEAD sha after the mutation (the commit to select / scroll to). */
  headSha: string | null
}

interface RowMeta {
  authorName: string
  authorEmail: string
  authorUnix: number
  committerUnix: number
  subject: string
  additions: number
  deletions: number
  locChanged: number
  bodyPreview?: string
}

interface SynthEntry {
  sha: string
  parentShas: string[]
  meta: RowMeta
}

let optimisticShaCounter = 0
function mintPlaceholderSha(prefix: string): string {
  optimisticShaCounter += 1
  return `optimistic-${prefix}-${Date.now().toString(36)}-${optimisticShaCounter}`
}

function metaOf(row: CommitRow): RowMeta {
  return {
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    authorUnix: row.authorUnix,
    committerUnix: row.committerUnix,
    subject: row.subject,
    additions: row.additions,
    deletions: row.deletions,
    locChanged: row.locChanged,
    bodyPreview: row.bodyPreview,
  }
}

function currentBranchRef(refs: RefSummary[]): RefSummary | null {
  return refs.find((ref) => ref.kind === 'head' && ref.isCurrent) ?? null
}

function findRefByShortName(refs: RefSummary[], shortName: string): RefSummary | null {
  return refs.find((ref) => ref.shortName === shortName) ?? null
}

function refTipSha(ref: RefSummary): string {
  return ref.peeledSha ?? ref.targetSha
}

/** Walk all parents (full ancestry) within the loaded rows, including `start`. */
function ancestorsWithin(start: string, parentMap: Map<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const sha = stack.pop()!
    if (seen.has(sha)) continue
    seen.add(sha)
    const parents = parentMap.get(sha)
    if (!parents) continue
    for (const p of parents) if (!seen.has(p)) stack.push(p)
  }
  return seen
}

// Mirrors the server's row → CommitRow assembly: run the shared lane allocator
// over the (possibly transformed) topology, then label commits from the
// (possibly transformed) refs exactly as `history-handler` does.
function assembleRows(
  ordered: SynthEntry[],
  refs: RefSummary[],
  centerLineSha: string | null,
): CommitRow[] {
  const projection = new Projection('optimistic', 'optimistic', { kind: 'all' }, 'date')
  projection.appendEntries(ordered.map((e) => ({ sha: e.sha, parentShas: e.parentShas })))
  const { lanes } = projection.computeGeometry(
    0,
    ordered.length - 1,
    undefined,
    centerLineSha ?? undefined,
  )

  const shaToRefs = new Map<string, string[]>()
  for (const ref of refs) {
    const sha = refTipSha(ref)
    const existing = shaToRefs.get(sha)
    if (existing) existing.push(ref.shortName)
    else shaToRefs.set(sha, [ref.shortName])
  }

  return ordered.map((entry, i) => ({
    row: i,
    sha: entry.sha,
    parentShas: entry.parentShas,
    authorName: entry.meta.authorName,
    authorEmail: entry.meta.authorEmail,
    authorUnix: entry.meta.authorUnix,
    committerUnix: entry.meta.committerUnix,
    subject: entry.meta.subject,
    additions: entry.meta.additions,
    deletions: entry.meta.deletions,
    locChanged: entry.meta.locChanged,
    bodyPreview: entry.meta.bodyPreview,
    refNames: shaToRefs.get(entry.sha) ?? [],
    lane: lanes.get(entry.sha) ?? 0,
  }))
}

function baseEntries(rows: CommitRow[]): SynthEntry[] {
  return rows.map((row) => ({ sha: row.sha, parentShas: row.parentShas, meta: metaOf(row) }))
}

/** Set exactly one local head ref current (or none, for a detached checkout). */
function withCurrentBranch(refs: RefSummary[], currentShortName: string | null): RefSummary[] {
  return refs.map((ref) => {
    if (ref.kind !== 'head') return ref
    const shouldBeCurrent = currentShortName !== null && ref.shortName === currentShortName
    if (!!ref.isCurrent === shouldBeCurrent) return ref
    return { ...ref, isCurrent: shouldBeCurrent }
  })
}

/** Repoint a head ref to a different commit (branch move / reset / advance). */
function withRefTarget(refs: RefSummary[], shortName: string, targetSha: string): RefSummary[] {
  return refs.map((ref) =>
    ref.kind === 'head' && ref.shortName === shortName
      ? { ...ref, targetSha, peeledSha: undefined }
      : ref,
  )
}

// ---------------------------------------------------------------------------
// Predictors
// ---------------------------------------------------------------------------

/**
 * Checkout: HEAD moves to `headSha`; the topology is unchanged. Only the
 * center lane (and `isCurrent`) shifts, which animates the highlight/lane.
 * `branchShortName` is null for a detached checkout of a bare commit.
 */
export function predictCheckout(
  rows: CommitRow[],
  refs: RefSummary[],
  branchShortName: string | null,
  headSha: string,
): OptimisticGraph | null {
  if (rows.length === 0) return null
  const nextRefs = withCurrentBranch(refs, branchShortName)
  return { rows: assembleRows(baseEntries(rows), nextRefs, headSha), refs: nextRefs, headSha }
}

/**
 * Move / reset a branch to `toSha`. Topology is unchanged; the branch label
 * relocates and, if it's the current branch, HEAD and the center lane follow.
 */
export function predictMoveRef(
  rows: CommitRow[],
  refs: RefSummary[],
  refName: string,
  toSha: string,
): OptimisticGraph | null {
  if (rows.length === 0) return null
  const moved = findRefByShortName(refs, refName)
  if (!moved || moved.kind !== 'head') return null

  const nextRefs = withRefTarget(refs, refName, toSha)
  const current = currentBranchRef(nextRefs)
  const headSha = current ? current.targetSha : null
  return { rows: assembleRows(baseEntries(rows), nextRefs, headSha), refs: nextRefs, headSha }
}

/**
 * Uncommit: drop the current tip, moving HEAD to its first parent. If another
 * ref still pins the dropped commit it stays as a dangling tip; otherwise it
 * leaves the graph entirely (matching `rev-list --all`).
 */
export function predictUncommit(
  rows: CommitRow[],
  refs: RefSummary[],
  sha: string,
): OptimisticGraph | null {
  const current = currentBranchRef(refs)
  if (!current) return null
  const target = rows.find((r) => r.sha === sha)
  if (!target) return null
  const parentSha = target.parentShas[0]
  if (!parentSha) return null

  const pinnedElsewhere = refs.some(
    (ref) => ref !== current && refTipSha(ref) === sha && ref.shortName !== current.shortName,
  )

  let ordered = baseEntries(rows)
  if (!pinnedElsewhere) ordered = ordered.filter((e) => e.sha !== sha)

  const nextRefs = withRefTarget(refs, current.shortName, parentSha)
  return { rows: assembleRows(ordered, nextRefs, parentSha), refs: nextRefs, headSha: parentSha }
}

/**
 * Append a fresh commit on top of HEAD — the shape of both cherry-pick and
 * revert. The new SHA is a placeholder; the store swaps in the real one on
 * reconcile.
 */
export function predictAppendOnHead(
  rows: CommitRow[],
  refs: RefSummary[],
  subject: string,
  prefix: string,
): OptimisticGraph | null {
  const current = currentBranchRef(refs)
  if (!current) return null
  const headSha = current.targetSha
  if (!rows.some((r) => r.sha === headSha)) return null

  const now = Math.floor(Date.now() / 1000)
  const newSha = mintPlaceholderSha(prefix)
  const newEntry: SynthEntry = {
    sha: newSha,
    parentShas: [headSha],
    meta: {
      authorName: '',
      authorEmail: '',
      authorUnix: now,
      committerUnix: now,
      subject,
      additions: 0,
      deletions: 0,
      locChanged: 0,
    },
  }

  const ordered = [newEntry, ...baseEntries(rows)]
  const nextRefs = withRefTarget(refs, current.shortName, newSha)
  return { rows: assembleRows(ordered, nextRefs, newSha), refs: nextRefs, headSha: newSha }
}

/**
 * Amend HEAD: replace the current tip with a new commit sharing its parents but
 * a fresh SHA and message. Staged changes fold in on reconcile; the graph only
 * needs HEAD (and its branch) re-pointed without gaining a row. If another ref
 * still pins the old tip it stays behind as a sibling; otherwise it is replaced.
 */
export function predictAmendHead(
  rows: CommitRow[],
  refs: RefSummary[],
  subject: string,
): OptimisticGraph | null {
  const current = currentBranchRef(refs)
  if (!current) return null
  const headSha = current.targetSha
  const target = rows.find((r) => r.sha === headSha)
  if (!target) return null

  const newSha = mintPlaceholderSha('amend')
  const newEntry: SynthEntry = {
    sha: newSha,
    parentShas: target.parentShas,
    meta: { ...metaOf(target), subject },
  }

  const pinnedElsewhere = refs.some(
    (ref) => ref !== current && ref.shortName !== current.shortName && refTipSha(ref) === headSha,
  )
  const ordered = pinnedElsewhere
    ? [newEntry, ...baseEntries(rows)]
    : baseEntries(rows).map((e) => (e.sha === headSha ? newEntry : e))

  const nextRefs = withRefTarget(refs, current.shortName, newSha)
  return { rows: assembleRows(ordered, nextRefs, newSha), refs: nextRefs, headSha: newSha }
}

/**
 * Merge `sourceRefName` into the current branch. Fast-forwards when HEAD is an
 * ancestor of the source; otherwise mints a placeholder merge commit with the
 * two tips as parents.
 */
export function predictMerge(
  rows: CommitRow[],
  refs: RefSummary[],
  sourceRefName: string,
): OptimisticGraph | null {
  const current = currentBranchRef(refs)
  if (!current) return null
  const source = findRefByShortName(refs, sourceRefName)
  if (!source) return null

  const headSha = current.targetSha
  const sourceSha = refTipSha(source)
  if (!rows.some((r) => r.sha === headSha)) return null

  const parentMap = new Map(rows.map((r) => [r.sha, r.parentShas]))
  const sourceAncestors = ancestorsWithin(sourceSha, parentMap)

  // Already up to date: HEAD already contains the source — a real merge is a
  // no-op, so don't predict a spurious merge commit.
  if (ancestorsWithin(headSha, parentMap).has(sourceSha)) return null

  // Fast-forward: HEAD already contained in the source line.
  if (sourceAncestors.has(headSha)) {
    if (!rows.some((r) => r.sha === sourceSha)) return null
    const nextRefs = withRefTarget(refs, current.shortName, sourceSha)
    return { rows: assembleRows(baseEntries(rows), nextRefs, sourceSha), refs: nextRefs, headSha: sourceSha }
  }

  // True merge needs both parents present to lay out the new node's edges.
  if (!rows.some((r) => r.sha === sourceSha)) return null

  const now = Math.floor(Date.now() / 1000)
  const mergeSha = mintPlaceholderSha('merge')
  const mergeEntry: SynthEntry = {
    sha: mergeSha,
    parentShas: [headSha, sourceSha],
    meta: {
      authorName: '',
      authorEmail: '',
      authorUnix: now,
      committerUnix: now,
      subject: `Merge ${sourceRefName}`,
      additions: 0,
      deletions: 0,
      locChanged: 0,
    },
  }

  const ordered = [mergeEntry, ...baseEntries(rows)]
  const nextRefs = withRefTarget(refs, current.shortName, mergeSha)
  return { rows: assembleRows(ordered, nextRefs, mergeSha), refs: nextRefs, headSha: mergeSha }
}

/**
 * Rebase the current branch onto `ontoRefName`: relocate HEAD's unique commits
 * to sit on top of the target tip, keeping their (old) SHAs as placeholders.
 * Bails on merge commits in the replayed range (too ambiguous to predict).
 */
export function predictRebase(
  rows: CommitRow[],
  refs: RefSummary[],
  ontoRefName: string,
): OptimisticGraph | null {
  const current = currentBranchRef(refs)
  if (!current) return null
  const onto = findRefByShortName(refs, ontoRefName)
  if (!onto) return null

  const headSha = current.targetSha
  const ontoSha = refTipSha(onto)
  if (!rows.some((r) => r.sha === headSha) || !rows.some((r) => r.sha === ontoSha)) return null

  const parentMap = new Map(rows.map((r) => [r.sha, r.parentShas]))
  const headAncestors = ancestorsWithin(headSha, parentMap)
  const ontoAncestors = ancestorsWithin(ontoSha, parentMap)

  // HEAD already on the target line — rebase fast-forwards onto the target tip.
  if (ontoAncestors.has(headSha)) {
    const nextRefs = withRefTarget(refs, current.shortName, ontoSha)
    return { rows: assembleRows(baseEntries(rows), nextRefs, ontoSha), refs: nextRefs, headSha: ontoSha }
  }

  // Commits unique to HEAD (newest-first), in their current display order.
  const replayed = rows.filter((r) => headAncestors.has(r.sha) && !ontoAncestors.has(r.sha))
  if (replayed.length === 0) return null
  // Replaying merge commits is too ambiguous to predict reliably.
  if (replayed.some((r) => r.parentShas.length > 1)) return null

  const replayedShas = new Set(replayed.map((r) => r.sha))
  const oldestReplayed = replayed[replayed.length - 1]

  // Pull the replayed block out before rebuilding it with its new parent.
  const remaining = baseEntries(rows).filter((e) => !replayedShas.has(e.sha))
  if (!remaining.some((e) => e.sha === ontoSha)) return null

  const rewrittenAt = Math.floor(Date.now() / 1000)
  const replayedEntries: SynthEntry[] = replayed.map((r) => ({
    sha: r.sha,
    // The oldest replayed commit reparents onto the target tip; the rest keep
    // pointing at the next (preserved) replayed commit.
    parentShas: r.sha === oldestReplayed.sha ? [ontoSha] : r.parentShas,
    // Git gives rebased commits fresh committer dates. The server's date-ordered
    // history consequently puts this rewritten block ahead of unrelated tips.
    meta: { ...metaOf(r), committerUnix: rewrittenAt },
  }))

  const ordered = [
    ...replayedEntries,
    ...remaining,
  ]

  // HEAD sha is unchanged (placeholder), so the current branch label stays put.
  const nextRefs = refs.slice()
  return { rows: assembleRows(ordered, nextRefs, headSha), refs: nextRefs, headSha }
}
