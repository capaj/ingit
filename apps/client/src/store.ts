import { create } from 'zustand'
import type {
  RefSummary,
  HistoryWindowResponse,
  CommitDetailResponse,
  CommitDiffResponse,
  CommitActionKind,
  CommitRow,
  MergePreviewResponse,
  RefActionKind,
  ReflogResponse,
  WorktreeChangesResponse,
  StageActionKind,
  WorktreeFile,
  WorktreeDiffArea,
  InProgressOperationKind,
} from '@ingit/rpc-contract'
import {
  openRepo,
  getRecentRepos,
  discoverRepos,
  getRefs,
  queryHistory,
  getCommitDetail,
  getCommitDiff,
  getCommitPRs,
  getCommitCIStatuses,
  commitAction,
  getMergePreview as fetchMergePreview,
  mergeRef as mergeRefApi,
  rebaseRef as rebaseRefApi,
  abortOperation as abortOperationApi,
  refAction,
  getReflog,
  getWorktreeChanges,
  stageAction,
  getWorktreeFileDiff,
  commitStaged,
  isConnectionLostError,
} from './api'
import {
  predictCheckout,
  predictMoveRef,
  predictUncommit,
  predictAppendOnHead,
  predictMerge,
  predictRebase,
  type OptimisticGraph,
} from './optimistic-graph'

/** Optional extra button shown in the error dialog (e.g. "Force push"). */
export interface ErrorDialogAction {
  label: string
  run: () => void
}

const INITIAL_ROWS = 1000
const LOAD_MORE_ROWS = 500
const MAX_RECENT_REPOS = 12

// Optimistic mutations assume success and animate immediately. If the server
// hasn't confirmed within this window we treat it as a failure and roll the
// graph back to where it started (per product intent: a timeout is a failure).
const MUTATION_TIMEOUT_MS = 30_000
const SERVER_COMMIT_TIMEOUT_MS = 120_000
// The server lets `git commit` hooks run for 120s, then still returns the
// resulting HEAD and worktree state. Keep the client wait slightly longer so a
// successful long-running hook is not reported as a failed optimistic mutation.
const COMMIT_MUTATION_TIMEOUT_MS = SERVER_COMMIT_TIMEOUT_MS + 10_000

class MutationTimeoutError extends Error {
  constructor() {
    super('The operation timed out')
    this.name = 'MutationTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MutationTimeoutError()), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

function isSyntheticCommitSha(sha: string): boolean {
  return sha.startsWith('optimistic-') || sha.startsWith('preview:')
}

function conflictedFileCount(changes: WorktreeChangesResponse): number {
  return new Set(changes.unstaged.filter((file) => file.status === 'U').map((file) => file.path)).size
}

function worktreeFileCount(changes: WorktreeChangesResponse): number {
  return changes.staged.length + changes.unstaged.length
}

// The slice of state an optimistic mutation touches, captured before applying
// the prediction so a failure (or timeout) can restore the original layout.
interface OptimisticSnapshot {
  refs: RefSummary[]
  historyWindow: HistoryWindowResponse | null
  selectedSha: string | null
  selectedRefName: string | null
  scrollToSha: string | null
  totalCommitCount: number
  mergePreview: MergePreviewResponse | null
  // Captured so a failed mutation restores the previously-open detail panel
  // (the optimistic apply clears these for the predicted selection).
  commitDetail: CommitDetailResponse | null
  commitDiff: CommitDiffResponse | null
  commitPRs: CommitPRInfo
}

type StoreSetter = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void
type StoreGetter = () => AppState

// Apply a history-rewriting prediction (commit action / merge / rebase): show
// the predicted layout, select + scroll to the predicted new HEAD, and take the
// pending lock. With no prediction we still take the lock to block further
// actions while the server works.
function applyOptimisticRewrite(
  set: StoreSetter,
  snapshot: OptimisticSnapshot,
  predicted: OptimisticGraph | null,
) {
  if (!predicted) {
    set({ pendingMutation: true })
    return
  }
  set((s) => ({
    pendingMutation: true,
    refs: predicted.refs,
    historyWindow: optimisticHistoryWindow(snapshot.historyWindow, predicted.rows),
    selectedSha: predicted.headSha,
    selectedRefName: null,
    scrollToSha: predicted.headSha,
    scrollToKey: s.scrollToKey + 1,
    commitDetail: null,
    commitDiff: null,
    commitPRs: [],
    mergePreview: null,
  }))
}

function captureSnapshot(s: AppState): OptimisticSnapshot {
  return {
    refs: s.refs,
    historyWindow: s.historyWindow,
    selectedSha: s.selectedSha,
    selectedRefName: s.selectedRefName,
    scrollToSha: s.scrollToSha,
    totalCommitCount: s.totalCommitCount,
    mergePreview: s.mergePreview,
    commitDetail: s.commitDetail,
    commitDiff: s.commitDiff,
    commitPRs: s.commitPRs,
  }
}

// Swap the predicted rows into the loaded window, preserving the rest of the
// response (edges are recomputed client-side from rows, so they can stay).
function optimisticHistoryWindow(
  base: HistoryWindowResponse | null,
  rows: CommitRow[],
): HistoryWindowResponse | null {
  if (!base) return null
  return {
    ...base,
    rows,
    totalRowsKnown: rows.length,
    checkpointsKnownUntilRow: Math.max(0, rows.length - 1),
  }
}

// Authoritative reload run after a mutation lands (mirrors the initial query).
function fetchRefsAndHistory(repoId: string): Promise<[RefSummary[], HistoryWindowResponse]> {
  return Promise.all([
    getRefs(repoId),
    queryHistory(repoId, {
      repoId,
      scope: { kind: 'all' },
      anchor: { kind: 'head' },
      beforeRows: 0,
      afterRows: INITIAL_ROWS,
      firstParent: false,
      topoOrder: true,
    }),
  ])
}

function fetchRepositoryState(repoId: string): Promise<[RefSummary[], HistoryWindowResponse, WorktreeChangesResponse]> {
  return Promise.all([
    getRefs(repoId),
    queryHistory(repoId, {
      repoId,
      scope: { kind: 'all' },
      anchor: { kind: 'head' },
      beforeRows: 0,
      afterRows: INITIAL_ROWS,
      firstParent: false,
      topoOrder: true,
    }),
    getWorktreeChanges(repoId),
  ])
}

// Load detail / diff / PRs / CI for the commit a mutation left selected. Each
// result is dropped if the selection moved on before it arrived.
function loadSelectedCommitExtras(repoId: string, sha: string) {
  Promise.all([getCommitDetail(repoId, sha), getCommitDiff(repoId, sha)])
    .then(([detail, diff]) => {
      if (useAppStore.getState().selectedSha === sha) {
        useAppStore.setState({ commitDetail: detail, commitDiff: diff })
      }
    })
    .catch((err) => console.error('Failed to load commit detail:', err))

  if (useAppStore.getState().githubUrl) {
    getCommitPRs(repoId, sha)
      .then((prs: CommitPRInfo) => {
        if (useAppStore.getState().selectedSha === sha) useAppStore.setState({ commitPRs: prs })
      })
      .catch(() => {})
  }
  useAppStore.getState().fetchCommitCIStatusesIfNeeded([sha])
}

function fetchVisibleTipSha(refs: RefSummary[]): string | null {
  const current = refs.find((ref) => ref.kind === 'head' && ref.isCurrent)
  if (!current) return null

  if (current.upstream) {
    const upstream = refs.find((ref) => ref.kind === 'remote' && ref.name === current.upstream)
    if (upstream) return upstream.peeledSha ?? upstream.targetSha
  }

  return current.peeledSha ?? current.targetSha
}

function historyContainsSha(hist: HistoryWindowResponse, sha: string): boolean {
  return hist.rows.some((row) => row.sha === sha)
}

function getRepoPathFromUrl(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith('#/repository')) return null
  const params = new URLSearchParams(hash.split('?')[1] ?? '')
  return params.get('path')
}

function setRepoPathInUrl(repoPath: string) {
  window.location.hash = `#/repository?path=${encodeURIComponent(repoPath)}`
}

function clearRepoPathInUrl() {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
}

function isSessionError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No session found')
}

function mergeHistory(
  prev: HistoryWindowResponse | null,
  incoming: HistoryWindowResponse,
): HistoryWindowResponse {
  if (!prev) return incoming
  const existingShas = new Set(prev.rows.map(r => r.sha))
  const newRows = incoming.rows.filter(r => !existingShas.has(r.sha))
  if (newRows.length === 0) return prev
  return {
    ...incoming,
    rows: [...prev.rows, ...newRows],
    edges: [...prev.edges, ...incoming.edges],
    hasMoreBefore: prev.hasMoreBefore,
  }
}

function prependRecentRepo(recentRepos: string[], repoPath: string): string[] {
  return [repoPath, ...recentRepos.filter((existingPath) => existingPath !== repoPath)]
    .slice(0, MAX_RECENT_REPOS)
}

export type AppStatus = 'no-repo' | 'loading' | 'ready'
export type ViewMode = 'history' | 'reflog'

const REFLOG_PAGE_SIZE = 300

export type CIState = 'success' | 'pending' | 'failure' | 'error' | 'neutral' | 'none'
export type CIRunState = 'success' | 'pending' | 'failure' | 'error' | 'neutral'
export interface CIRun {
  name: string
  description?: string
  state: CIRunState
  url?: string
}
export interface CIStatusEntry {
  state: CIState | 'loading'
  runs: CIRun[]
}

type CommitPRInfo = Array<{ number: number; title: string; url: string; state: string; mergedAt: string | null }>

/** Loaded (or loading / failed) patch for one worktree file, keyed `${area}:${path}`. */
export interface WorktreeDiffEntry {
  loading: boolean
  patchText?: string
  isBinary?: boolean
  error?: string
}

export function worktreeDiffKey(area: WorktreeDiffArea, path: string): string {
  return `${area}:${path}`
}

interface AppState {
  status: AppStatus
  repoId: string | null
  repoPath: string | null
  totalCommitCount: number
  recentRepos: string[]
  discoveredFolder: string | null
  discoveredRepos: string[]
  refs: RefSummary[]
  historyWindow: HistoryWindowResponse | null
  viewMode: ViewMode
  reflog: ReflogResponse | null
  reflogLoading: boolean
  reflogMaxCount: number
  selectedSha: string | null
  selectedRefName: string | null
  scrollToSha: string | null
  scrollToKey: number  // incremented to force re-scroll even for same SHA
  commitDetail: CommitDetailResponse | null
  commitDiff: CommitDiffResponse | null
  commitPRs: CommitPRInfo
  mergePreview: MergePreviewResponse | null
  githubUrl: string | null
  openError: string | null
  errorDialog: { title: string; message: string; action?: ErrorDialogAction } | null
  loadingMore: boolean
  commitCIStatus: Record<string, CIStatusEntry>
  showCommitMessages: boolean
  worktreeChanges: WorktreeChangesResponse | null
  worktreeSelected: boolean
  worktreeFileDiffs: Record<string, WorktreeDiffEntry>
  // True while an optimistic mutation is in flight. Blocks further node actions
  // until the current one is confirmed (or rolled back).
  pendingMutation: boolean
  // Bumped when the store reconciles an optimistic prediction with the server's
  // authoritative result. GraphCanvas watches it to swap to the real layout
  // *without* re-animating (the predicted nodes are already in place).
  graphAnimationSuppressToken: number

  // Actions
  setShowCommitMessages: (value: boolean) => void
  reloadFromServer: () => Promise<void>
  loadWorktreeChanges: () => Promise<void>
  selectWorktree: () => void
  runStageAction: (action: StageActionKind, paths: string[]) => Promise<void>
  loadWorktreeFileDiff: (file: WorktreeFile, area: WorktreeDiffArea) => Promise<void>
  /** Commit the index. Returns true on success (so the UI can clear the message). */
  performCommit: (message: string, noVerify: boolean) => Promise<boolean>
  showError: (title: string, err: unknown, action?: ErrorDialogAction) => void
  dismissError: () => void
  openRepoByPath: (path: string) => Promise<void>
  closeRepo: () => void
  loadRecentRepos: () => Promise<void>
  loadDiscoveredRepos: (folder?: string) => Promise<void>
  openFromUrl: () => void
  selectCommit: (sha: string) => void
  selectRef: (ref: RefSummary) => void
  selectGraphRef: (refName: string) => void
  clearGraphRefSelection: () => void
  ensureMergePreview: (refName: string) => Promise<MergePreviewResponse | null>
  navigateTo: (sha: string) => Promise<void>
  requestMore: (direction: 'up' | 'down') => Promise<void>
  performRefAction: (action: RefActionKind, refName: string, sha: string, force?: boolean) => Promise<void>
  performCommitAction: (action: CommitActionKind, sha: string) => Promise<void>
  performMergeRef: (refName: string) => Promise<void>
  performRebaseRef: (refName: string) => Promise<void>
  abortInProgressOperation: (operation: InProgressOperationKind) => Promise<void>
  checkoutSha: (sha: string) => Promise<void>
  fetchCommitCIStatusesIfNeeded: (shas: string[]) => void
  watchCommitCIStatus: (sha: string) => void
  setViewMode: (mode: ViewMode) => void
  loadReflog: () => Promise<void>
  loadMoreReflog: () => Promise<void>
  recoverBranch: (branchName: string, sha: string) => Promise<void>
}

async function openRepoByPathImpl(
  path: string,
  set: StoreSetter,
  get: StoreGetter,
  options: { showOpenError: boolean },
): Promise<void> {
  set({ status: 'loading', openError: null })
  try {
    const res = await openRepo({ path })
    setRepoPathInUrl(res.rootPath)
    // Drop any CI watches/poller left over from a previously open repo.
    ciWatch.clear()
    stopCIPolling()
    set({
      status: 'ready',
      repoId: res.repoId,
      repoPath: res.rootPath,
      totalCommitCount: res.totalCommitCount,
      recentRepos: prependRecentRepo(get().recentRepos, res.rootPath),
      githubUrl: res.githubUrl,
      commitCIStatus: {},
      openError: null,
      selectedRefName: null,
      mergePreview: null,
      worktreeChanges: null,
      worktreeSelected: false,
      worktreeFileDiffs: {},
      reflog: null,
      reflogMaxCount: REFLOG_PAGE_SIZE,
    })
    if (get().viewMode === 'reflog') void get().loadReflog()
    void get().loadWorktreeChanges()

    const [refs, hist] = await Promise.all([
      getRefs(res.repoId),
      queryHistory(res.repoId, {
        repoId: res.repoId,
        scope: { kind: 'all' },
        anchor: { kind: 'head' },
        beforeRows: 0,
        afterRows: INITIAL_ROWS,
        firstParent: false,
        topoOrder: true,
      }),
    ])
    set({ refs, historyWindow: hist })
  } catch (err) {
    let recentRepos = get().recentRepos
    try {
      recentRepos = await getRecentRepos()
    } catch (historyErr) {
      console.error('Failed to load recent repositories:', historyErr)
    }

    set({
      status: 'no-repo',
      recentRepos,
      openError: options.showOpenError
        ? err instanceof Error ? err.message : 'Failed to open repository'
        : null,
    })
  }
}

// --- CI status polling -----------------------------------------------------
// GitHub doesn't register a commit's check-runs the instant a push lands, so a
// freshly pushed commit first reads as `none`. We re-fetch watched commits (and
// any commit whose CI is still in progress) on an interval so the runs show up —
// and tick to completion — without a manual refresh.
const CI_POLL_INTERVAL_MS = 10_000
// Give up chasing a pushed commit after this long if no CI ever shows up, so a
// branch without workflows doesn't poll forever.
const CI_POLL_MAX_MS = 10 * 60_000
const CI_SETTLED = new Set<CIState | 'loading'>(['success', 'failure', 'neutral'])

const ciWatch = new Map<string, number>() // sha -> deadline (epoch ms)
let ciPollTimer: ReturnType<typeof setInterval> | null = null

function stopCIPolling() {
  if (ciPollTimer !== null) {
    clearInterval(ciPollTimer)
    ciPollTimer = null
  }
}

function startCIPolling() {
  if (ciPollTimer === null) ciPollTimer = setInterval(ciPollTick, CI_POLL_INTERVAL_MS)
}

// Re-fetch the given commits and fold the results into the store. Unlike
// `fetchCommitCIStatusesIfNeeded`, this always hits the server (no skip for
// already-known SHAs) and never flashes a `loading` state, so a background poll
// updates the dots in place without flicker.
function fetchCIStatusesInto(shas: string[]) {
  const { repoId } = useAppStore.getState()
  if (!repoId || shas.length === 0) return
  getCommitCIStatuses(repoId, shas)
    .then((res: Record<string, { state: CIState; runs: CIRun[] }>) => {
      // Drop the results if the user switched repos mid-flight.
      if (useAppStore.getState().repoId !== repoId) return
      useAppStore.setState((s) => {
        const next = { ...s.commitCIStatus }
        for (const sha of shas) {
          const entry = res[sha]
          next[sha] = entry ? { state: entry.state, runs: entry.runs ?? [] } : { state: 'none', runs: [] }
        }
        return { commitCIStatus: next }
      })
    })
    .catch((err: unknown) => console.warn('[CI] poll fetch failed', err))
}

function ciPollTick() {
  const { repoId, commitCIStatus } = useAppStore.getState()
  if (!repoId) { stopCIPolling(); return }

  const now = Date.now()
  const toPoll = new Set<string>()
  for (const [sha, deadline] of ciWatch) {
    const state = commitCIStatus[sha]?.state
    // Stop watching once CI has settled or the chase window has elapsed.
    if (now > deadline || (state !== undefined && CI_SETTLED.has(state))) ciWatch.delete(sha)
    else toPoll.add(sha)
  }
  // Keep any in-progress CI fresh until it settles, even if not explicitly watched.
  for (const [sha, entry] of Object.entries(commitCIStatus)) {
    if (entry.state === 'pending') toPoll.add(sha)
  }

  if (toPoll.size === 0) { stopCIPolling(); return }
  fetchCIStatusesInto([...toPoll])
}

export const useAppStore = create<AppState>((set, get) => ({
  status: 'no-repo',
  repoId: null,
  repoPath: null,
  totalCommitCount: 0,
  recentRepos: [],
  discoveredFolder: null,
  discoveredRepos: [],
  refs: [],
  historyWindow: null,
  viewMode: 'history',
  reflog: null,
  reflogLoading: false,
  reflogMaxCount: REFLOG_PAGE_SIZE,
  selectedSha: null,
  selectedRefName: null,
  scrollToSha: null,
  scrollToKey: 0,
  commitDetail: null,
  commitDiff: null,
  commitPRs: [],
  mergePreview: null,
  githubUrl: null,
  openError: null,
  errorDialog: null,
  loadingMore: false,
  commitCIStatus: {},
  worktreeChanges: null,
  worktreeSelected: false,
  worktreeFileDiffs: {},
  pendingMutation: false,
  graphAnimationSuppressToken: 0,
  showCommitMessages: (() => {
    try {
      const stored = localStorage.getItem('showCommitMessages')
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  })(),

  setShowCommitMessages: (value) => {
    try { localStorage.setItem('showCommitMessages', String(value)) } catch {}
    set({ showCommitMessages: value })
  },

  reloadFromServer: async () => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    try {
      let refs: RefSummary[]
      let hist: HistoryWindowResponse
      let changes: WorktreeChangesResponse
      try {
        [refs, hist, changes] = await fetchRepositoryState(repoId)
      } catch (err) {
        if (isSessionError(err) || isConnectionLostError(err)) {
          const res = await openRepo({ path: repoPath })
          repoId = res.repoId
          set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
          const fresh = await fetchRepositoryState(repoId)
          refs = fresh[0]
          hist = fresh[1]
          changes = fresh[2]
        } else {
          throw err
        }
      }

      set((s) => ({
        refs,
        historyWindow: hist,
        totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
        mergePreview: null,
        worktreeChanges: changes,
        worktreeFileDiffs: {},
        worktreeSelected: conflictedFileCount(changes) > 0
          ? true
          : worktreeFileCount(changes) > 0
            ? s.worktreeSelected
            : false,
      }))
      if (get().viewMode === 'reflog') void get().loadReflog()
    } catch (err) {
      console.error('Failed to reload repository state:', err)
    }
  },

  loadWorktreeChanges: async () => {
    const { repoId } = get()
    if (!repoId) return
    try {
      const changes = await getWorktreeChanges(repoId)
      // Cached patches may be stale relative to the fresh file list.
      set((s) => ({
        worktreeChanges: changes,
        worktreeFileDiffs: {},
        worktreeSelected: conflictedFileCount(changes) > 0
          ? true
          : worktreeFileCount(changes) > 0
            ? s.worktreeSelected
            : false,
      }))
    } catch (err) {
      console.error('Failed to load worktree changes:', err)
    }
  },

  loadWorktreeFileDiff: async (file, area) => {
    const { repoId } = get()
    if (!repoId) return
    const key = worktreeDiffKey(area, file.path)
    const existing = get().worktreeFileDiffs[key]
    if (existing && (existing.loading || existing.patchText !== undefined)) return
    set((s) => ({ worktreeFileDiffs: { ...s.worktreeFileDiffs, [key]: { loading: true } } }))
    try {
      const res = await getWorktreeFileDiff(repoId, file.path, area, file.oldPath)
      set((s) => ({
        worktreeFileDiffs: {
          ...s.worktreeFileDiffs,
          [key]: { loading: false, patchText: res.patchText, isBinary: res.isBinary },
        },
      }))
    } catch (err) {
      set((s) => ({
        worktreeFileDiffs: {
          ...s.worktreeFileDiffs,
          [key]: { loading: false, error: err instanceof Error ? err.message : 'Failed to load diff' },
        },
      }))
    }
  },

  performCommit: async (message, noVerify) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return false
    if (get().pendingMutation) return false

    const snapshot = captureSnapshot(get())
    const rows = snapshot.historyWindow?.rows ?? []
    // Predict the new tip so the graph animates immediately. Unlike other
    // rewrites we keep the worktree panel selected — the user may want to
    // stage and commit more.
    const predicted = predictAppendOnHead(rows, snapshot.refs, message.split('\n')[0], 'commit')
    if (predicted) {
      set({
        pendingMutation: true,
        refs: predicted.refs,
        historyWindow: optimisticHistoryWindow(snapshot.historyWindow, predicted.rows),
      })
    } else {
      set({ pendingMutation: true })
    }

    let result: { ok: boolean; headSha: string; changes: WorktreeChangesResponse }
    try {
      result = await withTimeout((async () => {
        try {
          return await commitStaged(repoId, message, noVerify)
        } catch (err) {
          // A lost session means the server restarted and the old call never
          // ran, so the retry cannot double-commit.
          if (isSessionError(err)) {
            const res = await openRepo({ path: repoPath })
            repoId = res.repoId
            set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
            return await commitStaged(repoId, message, noVerify)
          }
          throw err
        }
      })(), COMMIT_MUTATION_TIMEOUT_MS)
    } catch (err) {
      set({ ...snapshot, pendingMutation: false })
      get().showError('Commit failed', err)
      return false
    }

    const [refs, hist] = await fetchRefsAndHistory(repoId)
    set((s) => ({
      pendingMutation: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      totalCommitCount: Math.max(s.totalCommitCount + 1, hist.rows.length),
      worktreeChanges: result.changes,
      worktreeFileDiffs: {},
    }))
    if (get().viewMode === 'reflog') void get().loadReflog()
    return true
  },

  selectWorktree: () => {
    set({
      worktreeSelected: true,
      selectedSha: null,
      selectedRefName: null,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
    })
    void get().loadWorktreeChanges()
  },

  runStageAction: async (action, paths) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    try {
      const changes = await stageAction(repoId, action, paths)
      // A file's diff moves between the staged/unstaged areas, so drop the cache.
      set({ worktreeChanges: changes, worktreeFileDiffs: {} })
    } catch (err) {
      if (isSessionError(err) || isConnectionLostError(err)) {
        const res = await openRepo({ path: repoPath })
        repoId = res.repoId
        set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
        const changes = await stageAction(repoId, action, paths)
        set({ worktreeChanges: changes, worktreeFileDiffs: {} })
      } else {
        get().showError('Staging action failed', err)
      }
    }
  },

  setViewMode: (mode) => {
    set({ viewMode: mode })
    if (mode === 'reflog' && !get().reflog) {
      void get().loadReflog()
    }
  },

  loadReflog: async () => {
    const { repoPath, reflogMaxCount } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    set({ reflogLoading: true })
    try {
      let result: ReflogResponse
      try {
        result = await getReflog(repoId, 'HEAD', reflogMaxCount)
      } catch (err) {
        // Reflog reads are idempotent — safe to retry after reconnect
        if (isSessionError(err) || isConnectionLostError(err)) {
          const res = await openRepo({ path: repoPath })
          repoId = res.repoId
          set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
          result = await getReflog(repoId, 'HEAD', reflogMaxCount)
        } else {
          throw err
        }
      }
      set({ reflog: result })
    } catch (err) {
      console.error('Failed to load reflog:', err)
      get().showError('Failed to load reflog', err)
    } finally {
      set({ reflogLoading: false })
    }
  },

  loadMoreReflog: async () => {
    if (get().reflogLoading) return
    set({ reflogMaxCount: get().reflogMaxCount + REFLOG_PAGE_SIZE })
    await get().loadReflog()
  },

  recoverBranch: async (branchName, sha) => {
    await get().performRefAction('create', branchName, sha)
    set({ selectedSha: sha })
    void get().loadReflog()
  },

  fetchCommitCIStatusesIfNeeded: (shas) => {
    const { repoId, commitCIStatus } = get()
    if (!repoId) return
    const missing = shas.filter((sha) => !isSyntheticCommitSha(sha) && commitCIStatus[sha] === undefined)
    if (missing.length === 0) return

    set((s) => {
      const next = { ...s.commitCIStatus }
      for (const sha of missing) next[sha] = { state: 'loading', runs: [] }
      return { commitCIStatus: next }
    })

    getCommitCIStatuses(repoId, missing)
      .then((res: Record<string, { state: CIState; runs: CIRun[] }>) => {
        set((s) => {
          const next = { ...s.commitCIStatus }
          for (const sha of missing) {
            const entry = res[sha]
            next[sha] = entry
              ? { state: entry.state, runs: entry.runs ?? [] }
              : { state: 'none', runs: [] }
          }
          return { commitCIStatus: next }
        })
      })
      .catch((err: unknown) => {
        console.warn('[CI] batch fetch failed', err)
        set((s) => {
          const next = { ...s.commitCIStatus }
          for (const sha of missing) next[sha] = { state: 'none', runs: [] }
          return { commitCIStatus: next }
        })
      })
  },

  watchCommitCIStatus: (sha) => {
    ciWatch.set(sha, Date.now() + CI_POLL_MAX_MS)
    // Re-fetch right away so a stale `none` from before the push is replaced as
    // soon as GitHub registers the run, then keep polling on the interval.
    fetchCIStatusesInto([sha])
    startCIPolling()
  },

  showError: (title, err, action) => {
    const message = err instanceof Error ? err.message
      : typeof err === 'string' ? err
      : 'Unknown error'
    set({ errorDialog: { title, message, action } })
  },

  dismissError: () => set({ errorDialog: null }),

  openRepoByPath: async (path) => {
    await openRepoByPathImpl(path, set, get, { showOpenError: true })
  },

  closeRepo: () => {
    ciWatch.clear()
    stopCIPolling()
    clearRepoPathInUrl()
    set({
      status: 'no-repo',
      repoId: null,
      repoPath: null,
      totalCommitCount: 0,
      refs: [],
      historyWindow: null,
      selectedSha: null,
      selectedRefName: null,
      scrollToSha: null,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
      githubUrl: null,
      openError: null,
      loadingMore: false,
      commitCIStatus: {},
      worktreeChanges: null,
      worktreeSelected: false,
      worktreeFileDiffs: {},
      pendingMutation: false,
      reflog: null,
      reflogLoading: false,
      reflogMaxCount: REFLOG_PAGE_SIZE,
      viewMode: 'history',
    })
  },

  loadRecentRepos: async () => {
    try {
      set({ recentRepos: await getRecentRepos() })
    } catch (err) {
      console.error('Failed to load recent repositories:', err)
    }
  },

  loadDiscoveredRepos: async (folder) => {
    try {
      const { folder: scanned, repos } = await discoverRepos(folder)
      set({ discoveredFolder: scanned, discoveredRepos: repos })
    } catch (err) {
      console.error('Failed to discover repositories:', err)
    }
  },

  openFromUrl: () => {
    const path = getRepoPathFromUrl()
    void get().loadRecentRepos()
    void get().loadDiscoveredRepos()
    if (path) void get().openRepoByPath(path)
    else void openRepoByPathImpl('.', set, get, { showOpenError: false })
  },

  selectCommit: (sha) => {
    set({ selectedSha: sha, worktreeSelected: false, scrollToSha: null, scrollToKey: get().scrollToKey, commitDetail: null, commitDiff: null, commitPRs: [] })
    const { repoId, githubUrl } = get()
    if (!repoId) return
    get().fetchCommitCIStatusesIfNeeded([sha])
    Promise.all([
      getCommitDetail(repoId, sha),
      getCommitDiff(repoId, sha),
    ]).then(([detail, diff]) => {
      if (get().selectedSha === sha) {
        set({ commitDetail: detail, commitDiff: diff })
      }
    }).catch((err) => console.error('Failed to load commit detail:', err))

    // Load PR data in parallel (non-blocking) if this is a GitHub repo
    if (githubUrl) {
      getCommitPRs(repoId, sha).then((prs: CommitPRInfo) => {
        if (get().selectedSha === sha) set({ commitPRs: prs })
      }).catch(() => {})
    }
  },

  selectRef: (ref) => {
    get().selectCommit(ref.targetSha)
  },

  selectGraphRef: (refName) => {
    const { repoId } = get()
    set({
      selectedSha: null,
      worktreeSelected: false,
      selectedRefName: refName,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
    })
    if (!repoId) return

    fetchMergePreview(repoId, refName).then((preview: MergePreviewResponse) => {
      if (get().selectedRefName === refName) {
        set({ mergePreview: preview })
      }
    }).catch(() => {})
  },

  clearGraphRefSelection: () => {
    set({
      selectedSha: null,
      worktreeSelected: false,
      selectedRefName: null,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
    })
  },

  ensureMergePreview: async (refName) => {
    const { repoId, mergePreview } = get()
    if (!repoId) return null
    if (mergePreview?.sourceRefName === refName) return mergePreview

    const preview = await fetchMergePreview(repoId, refName)
    if (get().selectedRefName === refName) {
      set({ mergePreview: preview })
    }
    return preview
  },

  navigateTo: async (sha) => {
    const { historyWindow, repoId } = get()
    const loaded = historyWindow?.rows.some(r => r.sha === sha)
    if (loaded) {
      set((s) => ({ selectedSha: sha, scrollToSha: sha, scrollToKey: s.scrollToKey + 1, commitDetail: null, commitDiff: null }))
    } else if (repoId) {
      // Load enough history from --all to include the target SHA.
      // We progressively increase the window until we find it.
      let found = false
      let rowCount = get().historyWindow?.rows.length ?? INITIAL_ROWS
      for (let attempt = 0; attempt < 3 && !found; attempt++) {
        rowCount = Math.min(rowCount * 3, 10000)
        try {
          const result = await queryHistory(repoId, {
            repoId,
            scope: { kind: 'all' },
            anchor: { kind: 'head' },
            beforeRows: 0,
            afterRows: rowCount,
            firstParent: false,
            topoOrder: true,
          })
          found = result.rows.some((r: CommitRow) => r.sha === sha || r.sha.startsWith(sha))
          set((s) => ({
            historyWindow: found ? result : mergeHistory(s.historyWindow, result),
            selectedSha: sha,
            scrollToSha: found ? sha : null,
            scrollToKey: found ? s.scrollToKey + 1 : s.scrollToKey,
            commitDetail: null,
            commitDiff: null,
          }))
          if (!found && !result.hasMoreAfter) break // no more history
        } catch (err) {
          console.error('Failed to load history for navigation:', err)
          break
        }
      }
      if (!found) {
        console.warn(`Commit ${sha} not found in reachable history`)
      }
    }
    // Also load detail
    const { repoId: rid } = get()
    if (rid) {
      get().fetchCommitCIStatusesIfNeeded([sha])
      Promise.all([
        getCommitDetail(rid, sha),
        getCommitDiff(rid, sha),
      ]).then(([detail, diff]) => {
        if (get().selectedSha === sha) set({ commitDetail: detail, commitDiff: diff })
      }).catch(() => {})
    }
  },

  requestMore: async (direction) => {
    const { repoId, historyWindow, loadingMore } = get()
    if (!repoId || !historyWindow || loadingMore) return
    if (direction === 'down' && !historyWindow.hasMoreAfter) return

    set({ loadingMore: true })
    const rows = historyWindow.rows
    const lastRow = rows[rows.length - 1]

    try {
      const result = await queryHistory(repoId, {
        repoId,
        scope: { kind: 'all' },
        anchor: { kind: 'sha', value: lastRow.sha },
        beforeRows: 0,
        afterRows: LOAD_MORE_ROWS,
        firstParent: false,
        topoOrder: true,
      })
      set((s) => ({ historyWindow: mergeHistory(s.historyWindow, result) }))
    } catch (err) {
      console.error('Failed to load more history:', err)
    } finally {
      set({ loadingMore: false })
    }
  },

  performRefAction: async (action, refName, sha, force) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    const snapshot = captureSnapshot(get())
    const rows = snapshot.historyWindow?.rows ?? []

    // Predict the layout for the actions that change it so the graph animates
    // on click. Checkout only shifts the center lane; move/reset relocate a
    // branch label (and HEAD, if it's the current branch).
    let predicted: OptimisticGraph | null = null
    if (action === 'checkout') {
      predicted = predictCheckout(rows, snapshot.refs, refName, sha)
    } else if (action === 'move' || action === 'reset') {
      predicted = predictMoveRef(rows, snapshot.refs, refName, sha)
    }

    if (predicted) {
      set({
        pendingMutation: true,
        refs: predicted.refs,
        historyWindow: optimisticHistoryWindow(snapshot.historyWindow, predicted.rows),
        mergePreview: null,
        ...(action === 'move'
          ? {
              selectedRefName: refName,
              selectedSha: sha,
              scrollToSha: null,
              commitDetail: null,
              commitDiff: null,
              commitPRs: [],
            }
          : { selectedRefName: null }),
      })
    } else {
      set({ pendingMutation: true })
    }

    try {
      await withTimeout((async () => {
        try {
          await refAction(repoId, action, refName, sha, force)
        } catch (err) {
          // Ref actions are idempotent, so they are also safe to retry after
          // the connection dropped mid-call (e.g. dev server restart).
          if (isSessionError(err) || isConnectionLostError(err)) {
            const res = await openRepo({ path: repoPath })
            repoId = res.repoId
            set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
            await refAction(repoId, action, refName, sha, force)
          } else {
            throw err
          }
        }
      })(), MUTATION_TIMEOUT_MS)
    } catch (err) {
      set({ ...snapshot, pendingMutation: false })
      throw err
    }

    // Reconcile against the authoritative reload. Suppress the relayout
    // animation only when we already animated to a prediction.
    const [refs, hist] = await fetchRefsAndHistory(repoId)
    void get().loadWorktreeChanges()
    if (action === 'fetch') {
      const targetSha = fetchVisibleTipSha(refs)
      const visibleTargetSha = targetSha && historyContainsSha(hist, targetSha) ? targetSha : null
      set((s) => ({
        pendingMutation: false,
        refs,
        historyWindow: hist,
        totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
        selectedSha: visibleTargetSha ?? s.selectedSha,
        selectedRefName: null,
        scrollToSha: visibleTargetSha ?? s.scrollToSha,
        scrollToKey: visibleTargetSha ? s.scrollToKey + 1 : s.scrollToKey,
        commitDetail: visibleTargetSha ? null : s.commitDetail,
        commitDiff: visibleTargetSha ? null : s.commitDiff,
        commitPRs: visibleTargetSha ? [] : s.commitPRs,
        mergePreview: null,
      }))
      if (visibleTargetSha) loadSelectedCommitExtras(repoId, visibleTargetSha)
      if (get().viewMode === 'reflog') void get().loadReflog()
      return
    }
    if (action === 'move') {
      set((s) => ({
        pendingMutation: false,
        graphAnimationSuppressToken: predicted
          ? s.graphAnimationSuppressToken + 1
          : s.graphAnimationSuppressToken,
        refs,
        historyWindow: hist,
        selectedRefName: refName,
        selectedSha: sha,
        scrollToSha: null,
        commitDetail: null,
        commitDiff: null,
        commitPRs: [],
        mergePreview: null,
      }))
      loadSelectedCommitExtras(repoId, sha)
      return
    }

    // A push is what triggers CI on the remote, so poll the pushed tip until
    // its check-runs appear and settle.
    if (action === 'push') get().watchCommitCIStatus(sha)
    if (action === 'create' || action === 'create-tag') {
      set((s) => ({
        pendingMutation: false,
        graphAnimationSuppressToken: predicted
          ? s.graphAnimationSuppressToken + 1
          : s.graphAnimationSuppressToken,
        refs,
        historyWindow: hist,
        selectedRefName: refName,
        selectedSha: sha,
        scrollToSha: null,
        commitDetail: null,
        commitDiff: null,
        commitPRs: [],
        mergePreview: null,
      }))
      loadSelectedCommitExtras(repoId, sha)
      return
    }
    set((s) => ({
      pendingMutation: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      selectedRefName: null,
      mergePreview: null,
    }))
  },

  performCommitAction: async (action, sha) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    const snapshot = captureSnapshot(get())
    const rows = snapshot.historyWindow?.rows ?? []

    // Predict: uncommit drops the tip; cherry-pick/revert append a fresh commit
    // (placeholder sha, swapped for the real one on reconcile).
    let predicted: OptimisticGraph | null = null
    if (action === 'uncommit') {
      predicted = predictUncommit(rows, snapshot.refs, sha)
    } else {
      const original = rows.find((r) => r.sha === sha)
      const subject =
        action === 'revert'
          ? `Revert "${original?.subject ?? sha.slice(0, 8)}"`
          : (original?.subject ?? sha.slice(0, 8))
      predicted = predictAppendOnHead(rows, snapshot.refs, subject, action)
    }
    applyOptimisticRewrite(set, snapshot, predicted)

    let result: { ok: boolean; message: string; headSha: string }
    try {
      result = await withTimeout((async () => {
        try {
          return await commitAction(repoId, action, sha)
        } catch (err) {
          if (isSessionError(err)) {
            const res = await openRepo({ path: repoPath })
            repoId = res.repoId
            set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
            return await commitAction(repoId, action, sha)
          }
          throw err
        }
      })(), MUTATION_TIMEOUT_MS)
    } catch (err) {
      set({ ...snapshot, pendingMutation: false })
      throw err
    }

    const [refs, hist] = await fetchRefsAndHistory(repoId)
    const nextSha = result.headSha
    const totalCommitCountDelta = action === 'uncommit' ? -1 : 1
    set((s) => ({
      pendingMutation: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      totalCommitCount: Math.max(s.totalCommitCount + totalCommitCountDelta, hist.rows.length),
      selectedSha: nextSha,
      selectedRefName: null,
      scrollToSha: nextSha,
      scrollToKey: s.scrollToKey + 1,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
    }))

    loadSelectedCommitExtras(repoId, nextSha)
    void get().loadWorktreeChanges()
    if (get().viewMode === 'reflog') void get().loadReflog()
  },

  performMergeRef: async (refName) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    const snapshot = captureSnapshot(get())
    const predicted = predictMerge(snapshot.historyWindow?.rows ?? [], snapshot.refs, refName)
    applyOptimisticRewrite(set, snapshot, predicted)

    let result: { ok: boolean; message: string; headSha: string }
    try {
      result = await withTimeout((async () => {
        try {
          return await mergeRefApi(repoId, refName)
        } catch (err) {
          if (isSessionError(err)) {
            const res = await openRepo({ path: repoPath })
            repoId = res.repoId
            set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
            return await mergeRefApi(repoId, refName)
          }
          throw err
        }
      })(), MUTATION_TIMEOUT_MS)
    } catch (err) {
      let changes: WorktreeChangesResponse | null = null
      try {
        changes = await getWorktreeChanges(repoId)
      } catch (changesErr) {
        console.error('Failed to load worktree after failed merge:', changesErr)
      }
      set({
        ...snapshot,
        pendingMutation: false,
        ...(changes
          ? {
              worktreeChanges: changes,
              worktreeFileDiffs: {},
              worktreeSelected: conflictedFileCount(changes) > 0,
            }
          : {}),
      })
      throw err
    }

    const [refs, hist] = await fetchRefsAndHistory(repoId)
    const nextSha = result.headSha
    set((s) => ({
      pendingMutation: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      totalCommitCount: Math.max(s.totalCommitCount + 1, hist.rows.length),
      selectedSha: nextSha,
      selectedRefName: null,
      scrollToSha: nextSha,
      scrollToKey: s.scrollToKey + 1,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
    }))

    loadSelectedCommitExtras(repoId, nextSha)
    void get().loadWorktreeChanges()
  },

  performRebaseRef: async (refName) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    const snapshot = captureSnapshot(get())
    const predicted = predictRebase(snapshot.historyWindow?.rows ?? [], snapshot.refs, refName)
    applyOptimisticRewrite(set, snapshot, predicted)

    let result: { ok: boolean; message: string; headSha: string }
    try {
      result = await withTimeout((async () => {
        try {
          return await rebaseRefApi(repoId, refName)
        } catch (err) {
          if (isSessionError(err)) {
            const res = await openRepo({ path: repoPath })
            repoId = res.repoId
            set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
            return await rebaseRefApi(repoId, refName)
          }
          throw err
        }
      })(), MUTATION_TIMEOUT_MS)
    } catch (err) {
      let refs: RefSummary[] | null = null
      let hist: HistoryWindowResponse | null = null
      let changes: WorktreeChangesResponse | null = null
      try {
        [refs, hist, changes] = await Promise.all([
          getRefs(repoId),
          queryHistory(repoId, {
            repoId,
            scope: { kind: 'all' },
            anchor: { kind: 'head' },
            beforeRows: 0,
            afterRows: INITIAL_ROWS,
            firstParent: false,
            topoOrder: true,
          }),
          getWorktreeChanges(repoId),
        ])
      } catch (reloadErr) {
        console.error('Failed to load graph after failed rebase:', reloadErr)
      }
      set((s) => {
        if (!refs || !hist) {
          return {
            ...snapshot,
            pendingMutation: false,
            ...(changes
              ? {
                  worktreeChanges: changes,
                  worktreeFileDiffs: {},
                  worktreeSelected: conflictedFileCount(changes) > 0,
                }
              : {}),
          }
        }

        return {
          pendingMutation: false,
          refs,
          historyWindow: hist,
          totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
          selectedSha: null,
          selectedRefName: null,
          scrollToSha: changes?.headSha ?? null,
          scrollToKey: changes ? s.scrollToKey + 1 : s.scrollToKey,
          commitDetail: null,
          commitDiff: null,
          commitPRs: [],
          mergePreview: null,
          worktreeChanges: changes,
          worktreeFileDiffs: {},
          worktreeSelected: changes ? conflictedFileCount(changes) > 0 : s.worktreeSelected,
        }
      })
      throw err
    }

    const [refs, hist] = await fetchRefsAndHistory(repoId)
    const nextSha = result.headSha
    set((s) => ({
      pendingMutation: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
      selectedSha: nextSha,
      selectedRefName: null,
      scrollToSha: nextSha,
      scrollToKey: s.scrollToKey + 1,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
    }))

    loadSelectedCommitExtras(repoId, nextSha)
    void get().loadWorktreeChanges()
  },

  abortInProgressOperation: async (operation) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    set({ pendingMutation: true })
    try {
      let result: { ok: boolean; message: string; headSha: string; changes: WorktreeChangesResponse }
      try {
        result = await abortOperationApi(repoId, operation)
      } catch (err) {
        if (isSessionError(err)) {
          const res = await openRepo({ path: repoPath })
          repoId = res.repoId
          set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
          result = await abortOperationApi(repoId, operation)
        } else {
          throw err
        }
      }

      const [refs, hist] = await fetchRefsAndHistory(repoId)
      const nextSha = result.headSha
      set((s) => ({
        pendingMutation: false,
        refs,
        historyWindow: hist,
        totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
        selectedSha: nextSha,
        selectedRefName: null,
        scrollToSha: nextSha,
        scrollToKey: s.scrollToKey + 1,
        commitDetail: null,
        commitDiff: null,
        commitPRs: [],
        mergePreview: null,
        worktreeChanges: result.changes,
        worktreeFileDiffs: {},
        worktreeSelected: worktreeFileCount(result.changes) > 0,
      }))
      loadSelectedCommitExtras(repoId, nextSha)
      if (get().viewMode === 'reflog') void get().loadReflog()
    } catch (err) {
      set({ pendingMutation: false })
      get().showError(`Abort ${operation} failed`, err)
    }
  },

  checkoutSha: async (sha) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    const snapshot = captureSnapshot(get())
    // Detached checkout of a bare commit: no branch becomes current.
    const predicted = predictCheckout(snapshot.historyWindow?.rows ?? [], snapshot.refs, null, sha)
    if (predicted) {
      set({
        pendingMutation: true,
        refs: predicted.refs,
        historyWindow: optimisticHistoryWindow(snapshot.historyWindow, predicted.rows),
        selectedRefName: null,
        mergePreview: null,
      })
    } else {
      set({ pendingMutation: true })
    }

    try {
      await withTimeout((async () => {
        try {
          await refAction(repoId, 'checkout', sha, sha)
        } catch (err) {
          if (isSessionError(err)) {
            const res = await openRepo({ path: repoPath })
            repoId = res.repoId
            set({ repoId })
            await refAction(repoId, 'checkout', sha, sha)
          } else {
            throw err
          }
        }
      })(), MUTATION_TIMEOUT_MS)
    } catch (err) {
      set({ ...snapshot, pendingMutation: false })
      throw err
    }

    const [refs, hist] = await fetchRefsAndHistory(repoId)
    set((s) => ({
      pendingMutation: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      selectedRefName: null,
      mergePreview: null,
    }))
    void get().loadWorktreeChanges()
    if (get().viewMode === 'reflog') void get().loadReflog()
  },
}))
