import { randomBytes } from 'node:crypto'
import { Projection } from '@ingit/graph-core'
import { runGit } from '@ingit/git-core'
import type { RepoSession, RevListEntryWithMeta } from '@ingit/git-core'
import type {
  HistoryQuery,
  HistoryWindowResponse,
  CommitRow,
} from '@ingit/rpc-contract'

async function resolveAnchorSha(
  session: RepoSession,
  query: HistoryQuery,
): Promise<string | null> {
  const { anchor } = query
  switch (anchor.kind) {
    case 'head':
      return session.head.sha
    case 'ref': {
      if (!anchor.value) return session.head.sha
      try {
        const { stdout } = await runGit(['rev-parse', anchor.value], session.rootPath)
        return stdout.trim()
      } catch {
        return null
      }
    }
    case 'sha':
      return anchor.value ?? null
    case 'row':
      return session.head.sha
    case 'mergeBase': {
      if (!anchor.value || !anchor.secondaryValue) return session.head.sha
      try {
        const { stdout } = await runGit(
          ['merge-base', anchor.value, anchor.secondaryValue],
          session.rootPath,
        )
        return stdout.trim()
      } catch {
        return session.head.sha
      }
    }
    default:
      return session.head.sha
  }
}

function buildRevListArgs(query: HistoryQuery, anchorSha: string | null): string[] {
  const args: string[] = []

  if (query.firstParent) args.push('--first-parent')
  if (query.topoOrder) args.push('--topo-order')

  const { scope, anchor } = query

  // If anchor is a specific SHA, start from that SHA (not --all)
  // so we get commits around that point in history
  if (anchor.kind === 'sha' && anchor.value) {
    args.push(anchor.value)
  } else {
    switch (scope.kind) {
      case 'all':
        args.push('--exclude=refs/stash', '--all')
        break
      case 'ref':
        args.push(scope.value ?? (anchorSha ?? 'HEAD'))
        break
      case 'range':
        if (scope.value && scope.secondaryValue) {
          args.push(`${scope.value}..${scope.secondaryValue}`)
        } else {
          args.push(scope.value ?? (anchorSha ?? 'HEAD'))
        }
        break
      case 'path':
        args.push(anchorSha ?? 'HEAD', '--', scope.value ?? '')
        break
      default:
        args.push(anchorSha ?? 'HEAD')
    }
  }

  args.push('--parents')

  const total = query.beforeRows + query.afterRows
  args.push(`--max-count=${total}`)

  return args
}

export async function handleHistoryQuery(
  session: RepoSession,
  query: HistoryQuery,
): Promise<HistoryWindowResponse> {
  const total = query.beforeRows + query.afterRows
  const anchorSha = await resolveAnchorSha(session, query)
  const revArgs = buildRevListArgs(query, anchorSha)

  const projectionId = randomBytes(8).toString('hex')
  const projection = new Projection(
    projectionId,
    session.repoId,
    query.scope,
    query.topoOrder ? 'topo' : 'date',
  )

  // Single git rev-list call gets topology + metadata (author, subject) together.
  // No separate cat-file hydration needed for the graph view.
  const rawEntries: RevListEntryWithMeta[] = []

  try {
    await session.streamTopologyWithMeta(
      revArgs,
      (entry: RevListEntryWithMeta) => {
        rawEntries.push(entry)
      },
    )
  } catch (err) {
    console.error('rev-list streaming error:', err)
    return {
      projectionId,
      rows: [],
      edges: [],
      checkpointsKnownUntilRow: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      indexingState: 'cold',
    }
  }

  if (rawEntries.length === 0) {
    return {
      projectionId,
      rows: [],
      edges: [],
      checkpointsKnownUntilRow: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      indexingState: 'cold',
    }
  }

  projection.appendEntries(rawEntries)
  const { lanes, edges } = projection.computeGeometry(0, rawEntries.length - 1)

  // Build sha → ref names map from refs
  const refs = await session.getRefs()
  const shaToRefs = new Map<string, string[]>()
  for (const ref of refs) {
    const sha = ref.peeledSha ?? ref.targetSha
    const existing = shaToRefs.get(sha)
    if (existing) {
      existing.push(ref.shortName)
    } else {
      shaToRefs.set(sha, [ref.shortName])
    }
  }

  const rows: CommitRow[] = rawEntries.map((entry, i) => ({
    row: i,
    sha: entry.sha,
    parentShas: entry.parentShas,
    authorName: entry.authorName,
    authorEmail: entry.authorEmail,
    authorUnix: entry.authorUnix,
    committerUnix: entry.committerUnix,
    subject: entry.subject,
    refNames: shaToRefs.get(entry.sha) ?? [],
    lane: lanes.get(entry.sha) ?? 0,
  }))

  return {
    projectionId,
    rows,
    edges,
    checkpointsKnownUntilRow: rows.length - 1,
    totalRowsKnown: rows.length,
    hasMoreBefore: false,
    hasMoreAfter: rawEntries.length >= total,
    indexingState: 'warm',
  }
}
