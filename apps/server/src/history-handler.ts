import { randomBytes } from 'node:crypto'
import { Projection } from '@ingit/graph-core'
import { runGit } from '@ingit/git-core'
import type { RepoSession, RevListEntry } from '@ingit/git-core'
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
      // Cannot resolve a row anchor without a loaded projection; fall back to HEAD
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

  const { scope } = query
  switch (scope.kind) {
    case 'all':
      args.push('--all')
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
      // path filtering: start from anchorSha and filter by path
      args.push(anchorSha ?? 'HEAD', '--', scope.value ?? '')
      break
    default:
      args.push(anchorSha ?? 'HEAD')
  }

  // Include parents in output so topology edges can be computed
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

  // Create a Projection to handle lane allocation and geometry
  const projectionId = randomBytes(8).toString('hex')
  const projection = new Projection(
    projectionId,
    session.repoId,
    query.scope,
    query.topoOrder ? 'topo' : 'date',
  )

  const rawEntries: Array<{ sha: string; parentShas: string[] }> = []

  try {
    await session.streamTopology(
      revArgs,
      (entry: RevListEntry) => {
        rawEntries.push({ sha: entry.sha, parentShas: entry.parentShas })
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

  // Compute geometry for the entire loaded window (rows 0..N-1)
  const { lanes, edges } = projection.computeGeometry(0, rawEntries.length - 1)

  // Hydrate commit metadata in parallel
  const metas = await Promise.all(
    rawEntries.map((e) => session.getCommitDetail(e.sha).catch(() => null)),
  )

  const rows: CommitRow[] = rawEntries.map((entry, i) => {
    const meta = metas[i]
    return {
      row: i,
      sha: entry.sha,
      parentShas: entry.parentShas,
      authorName: meta?.authorName ?? '',
      authorEmail: meta?.authorEmail ?? '',
      authorUnix: meta?.authorUnix ?? 0,
      committerUnix: meta?.committerUnix ?? 0,
      subject: meta?.subject ?? '',
      refNames: meta?.refs ?? [],
      lane: lanes.get(entry.sha) ?? 0,
    }
  })

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
