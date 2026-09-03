import type {
  CommitRow,
  HistoryWindowResponse,
  RefSummary,
  WorktreeChangesResponse,
  WorktreeGraphState,
} from '@ingit/rpc-contract'
import {
  buildLayout,
  COMMIT_MESSAGE_GUTTER,
  rebindLayoutRows,
  type GraphLayout,
} from './layout'
import { routeUpstreamAroundWorktree } from './worktree-lane-layout'

export interface GraphModel {
  currentBranch: string | null
  renderedRows: CommitRow[]
  layout: GraphLayout
}

export interface GraphModelCacheStats {
  requests: number
  referenceHits: number
  topologyHits: number
  builds: number
  totalBuildMs: number
}

interface TopologyCacheEntry {
  rows: CommitRow[]
  layout: GraphLayout
}

const MAX_TOPOLOGY_ENTRIES = 12
const referenceCache = new WeakMap<CommitRow[], Map<string, GraphModel>>()
const topologyCache = new Map<string, TopologyCacheEntry>()
const stats: GraphModelCacheStats = {
  requests: 0,
  referenceHits: 0,
  topologyHits: 0,
  builds: 0,
  totalBuildMs: 0,
}

function worktreeChangeCount(changes: WorktreeChangesResponse | null): number {
  return changes ? changes.staged.length + changes.unstaged.length : 0
}

function currentBranchName(refs: RefSummary[]): string | null {
  return refs.find((ref) => ref.isCurrent)?.shortName ?? null
}

function referenceVariantKey(
  currentBranch: string | null,
  dirtyWorktrees: WorktreeGraphState[],
  extraLeftGutter: number,
): string {
  const worktreeKey = dirtyWorktrees
    .map((worktree) => `${worktree.path}\u0003${worktree.branch ?? ''}\u0003${worktree.headSha}`)
    .join('\u0004')
  return `${currentBranch ?? ''}\u0000${worktreeKey}\u0000${extraLeftGutter}`
}

function graphWorktrees(
  currentWorktreePath: string | null,
  worktreeChanges: WorktreeChangesResponse | null,
  worktreeGraphStates: WorktreeGraphState[] | null,
  normalizeAcrossWorktrees: boolean,
): WorktreeGraphState[] {
  if (!normalizeAcrossWorktrees) {
    if (!worktreeChanges || worktreeChangeCount(worktreeChanges) === 0) return []
    return [{
      path: currentWorktreePath ?? '',
      headSha: worktreeChanges.headSha,
      ...(worktreeChanges.branch ? { branch: worktreeChanges.branch } : {}),
      changeCount: worktreeChangeCount(worktreeChanges),
      conflictedCount: 0,
    }]
  }

  // Null means the shared scan is still loading. Do not let only the current
  // worktree affect geometry during that window, or linked views would briefly
  // disagree again.
  if (worktreeGraphStates === null) return []

  const byPath = new Map(worktreeGraphStates.map((state) => [state.path, state]))
  if (currentWorktreePath && worktreeChanges) {
    const existing = byPath.get(currentWorktreePath)
    byPath.set(currentWorktreePath, {
      path: currentWorktreePath,
      headSha: worktreeChanges.headSha,
      ...(worktreeChanges.branch ? { branch: worktreeChanges.branch } : {}),
      changeCount: worktreeChangeCount(worktreeChanges),
      conflictedCount: existing?.conflictedCount ?? 0,
      ...(worktreeChanges.mergeHeadShas ? { mergeHeadShas: worktreeChanges.mergeHeadShas } : {}),
      ...(worktreeChanges.rebaseHeadSha ? { rebaseHeadSha: worktreeChanges.rebaseHeadSha } : {}),
    })
  }

  return [...byPath.values()]
    .filter((state) => state.changeCount > 0)
    .sort((left, right) => left.path.localeCompare(right.path))
}

function topologyKey(rows: CommitRow[], extraLeftGutter: number): string {
  let key = `${extraLeftGutter}|${rows.length}`
  for (const row of rows) {
    key += `\u0001${row.sha}\u0002${row.lane}\u0002${row.parentShas.join(',')}\u0002${row.refNames.join(',')}`
  }
  return key
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function rememberTopology(key: string, entry: TopologyCacheEntry): void {
  topologyCache.delete(key)
  topologyCache.set(key, entry)
  if (topologyCache.size > MAX_TOPOLOGY_ENTRIES) {
    const oldestKey = topologyCache.keys().next().value
    if (oldestKey !== undefined) topologyCache.delete(oldestKey)
  }
}

export function deriveGraphModel(
  historyWindow: HistoryWindowResponse | null,
  refs: RefSummary[],
  worktreeChanges: WorktreeChangesResponse | null,
  currentWorktreePath: string | null,
  worktreeGraphStates: WorktreeGraphState[] | null,
  normalizeAcrossWorktrees: boolean,
  showCommitMessages: boolean,
): GraphModel | null {
  if (!historyWindow || historyWindow.rows.length === 0) return null
  stats.requests++

  const sourceRows = historyWindow.rows
  const currentBranch = currentBranchName(refs)
  const dirtyWorktrees = graphWorktrees(
    currentWorktreePath,
    worktreeChanges,
    worktreeGraphStates,
    normalizeAcrossWorktrees,
  )
  const extraLeftGutter = showCommitMessages ? COMMIT_MESSAGE_GUTTER : 0
  const variantKey = referenceVariantKey(currentBranch, dirtyWorktrees, extraLeftGutter)
  const variants = referenceCache.get(sourceRows)
  const referenceHit = variants?.get(variantKey)
  if (referenceHit) {
    stats.referenceHits++
    return referenceHit
  }

  const renderedRows = dirtyWorktrees.reduce(
    (rows, worktree) => routeUpstreamAroundWorktree(
      rows,
      worktree.branch ?? null,
      worktree.headSha,
    ),
    sourceRows,
  )
  const key = topologyKey(renderedRows, extraLeftGutter)
  const cached = topologyCache.get(key)
  let layout: GraphLayout

  if (cached) {
    stats.topologyHits++
    layout = cached.rows === renderedRows
      ? cached.layout
      : rebindLayoutRows(cached.layout, renderedRows)
    rememberTopology(key, { rows: renderedRows, layout })
  } else {
    const startedAt = now()
    layout = buildLayout(renderedRows, extraLeftGutter)
    stats.totalBuildMs += now() - startedAt
    stats.builds++
    rememberTopology(key, { rows: renderedRows, layout })
  }

  const model = { currentBranch, renderedRows, layout }
  const nextVariants = variants ?? new Map<string, GraphModel>()
  nextVariants.set(variantKey, model)
  if (!variants) referenceCache.set(sourceRows, nextVariants)
  return model
}

export function getGraphModelCacheStats(): GraphModelCacheStats {
  return { ...stats }
}

export function resetGraphModelCacheStats(): void {
  stats.requests = 0
  stats.referenceHits = 0
  stats.topologyHits = 0
  stats.builds = 0
  stats.totalBuildMs = 0
}

declare global {
  interface Window {
    __INGIT_GRAPH_MODEL_CACHE__?: {
      snapshot: typeof getGraphModelCacheStats
      reset: typeof resetGraphModelCacheStats
    }
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__INGIT_GRAPH_MODEL_CACHE__ = {
    snapshot: getGraphModelCacheStats,
    reset: resetGraphModelCacheStats,
  }
}
