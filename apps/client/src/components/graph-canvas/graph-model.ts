import type {
  CommitRow,
  HistoryWindowResponse,
  RefSummary,
  WorktreeChangesResponse,
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
  hasWorktreeChanges: boolean,
  extraLeftGutter: number,
): string {
  return `${currentBranch ?? ''}\u0000${hasWorktreeChanges ? 1 : 0}\u0000${extraLeftGutter}`
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
  showCommitMessages: boolean,
): GraphModel | null {
  if (!historyWindow || historyWindow.rows.length === 0) return null
  stats.requests++

  const sourceRows = historyWindow.rows
  const currentBranch = currentBranchName(refs)
  const hasWorktreeChanges = worktreeChangeCount(worktreeChanges) > 0
  const extraLeftGutter = showCommitMessages ? COMMIT_MESSAGE_GUTTER : 0
  const variantKey = referenceVariantKey(currentBranch, hasWorktreeChanges, extraLeftGutter)
  const variants = referenceCache.get(sourceRows)
  const referenceHit = variants?.get(variantKey)
  if (referenceHit) {
    stats.referenceHits++
    return referenceHit
  }

  const renderedRows = hasWorktreeChanges
    ? routeUpstreamAroundWorktree(sourceRows, currentBranch)
    : sourceRows
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
