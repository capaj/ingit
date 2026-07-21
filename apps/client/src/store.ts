import { create } from 'zustand'
import type {
  RefSummary,
  HistoryWindowResponse,
  CommitDetailResponse,
  CommitAuthorResponse,
  CommitDiffResponse,
  CommitRow,
  MergePreviewResponse,
  ReflogResponse,
  WorktreeChangesResponse,
  WorktreeSummary,
  StashSummary,
  StashDiffResponse,
} from '@ingit/rpc-contract'
import {
  openRepo,
  getRecentRepos,
  discoverRepos,
  getRefs,
  getWorktrees,
  removeWorktree as removeWorktreeApi,
  queryHistory,
  getCommitDetail,
  getCommitAuthor,
  getCommitDiff,
  getCommitPRs,
  getCommitCIStatuses,
  commitAction,
  getMergePreview as fetchMergePreview,
  mergeRef as mergeRefApi,
  rebaseRef as rebaseRefApi,
  abortOperation as abortOperationApi,
  continueOperation as continueOperationApi,
  refAction,
  getReflog,
  getWorktreeChanges,
  getStashes,
  getStashDiff,
  getStashFileDiff,
  createStash as createStashApi,
  applyStash as applyStashApi,
  dropStash as dropStashApi,
  stageAction,
  getWorktreeFileDiff,
  getCommitFileDiff,
  commitStaged,
  isConnectionLostError,
} from './api'
import {
  predictCheckout,
  predictMoveRef,
  predictUncommit,
  predictAppendOnHead,
  predictAmendHead,
  predictWorktreeAfterCheckout,
  predictWorktreeAfterCommit,
  predictMerge,
  predictRebase,
  type OptimisticGraph,
} from './optimistic-graph'
import { mergeHistory } from './history-pagination'
import { recordStorePublication } from './performance-metrics'
import { deriveGraphModel } from './components/graph-canvas/graph-model'
import {
  createRepositorySliceState,
  type RepositorySlice,
} from './store/repository-slice'
import {
  createGraphSliceState,
  REFLOG_PAGE_SIZE,
  type CIRun,
  type CIState,
  type CommitPRInfo,
  type GraphSlice,
} from './store/graph-slice'
import {
  commitFileDiffKey,
  createWorktreeSliceState,
  stashFileDiffKey,
  worktreeDiffKey,
  type CommitFileDiffEntry,
  type WorktreeSlice,
} from './store/worktree-slice'
import {
  createUiSliceState,
  type ErrorDialogAction,
  type UiSlice,
} from './store/ui-slice'

export type { AppStatus } from './store/repository-slice'
export type {
  CIRun,
  CIRunState,
  CIState,
  CIStatusEntry,
} from './store/graph-slice'
export type {
  CommitFileDiffEntry,
  WorktreeDiffEntry,
} from './store/worktree-slice'
export type { ErrorDialogAction, ViewMode } from './store/ui-slice'
export {
  commitFileDiffKey,
  stashFileDiffKey,
  worktreeDiffKey,
}

export type AppState = RepositorySlice & GraphSlice & WorktreeSlice & UiSlice

// Repository switches only need enough recent history to fill the viewport.
// The graph requests deeper pages as the user approaches them, avoiding a
// potentially multi-second `git log --numstat` before the first useful paint.
const INITIAL_VISIBLE_ROWS = 100
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
  worktreeChanges: WorktreeChangesResponse | null
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
  commitFileDiffs: Record<string, CommitFileDiffEntry>
}

type StoreSetter = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void
type StoreGetter = () => AppState

// Apply a history-rewriting prediction (commit action / merge / rebase): show
// the predicted layout, focus either the requested ref or the predicted new
// HEAD, scroll to the new HEAD, and take the pending lock. With no prediction
// we still take the lock to block further actions while the server works.
function applyOptimisticRewrite(
  set: StoreSetter,
  snapshot: OptimisticSnapshot,
  predicted: OptimisticGraph | null,
  focusRefName?: string,
) {
  if (!predicted) {
    set({
      pendingMutation: true,
      ...(focusRefName
        ? {
            selectedSha: null,
            selectedRefName: focusRefName,
            commitDetail: null,
            commitDiff: null,
            commitPRs: [],
            commitFileDiffs: {},
            mergePreview: null,
          }
        : {}),
    })
    return
  }
  set((s) => ({
    pendingMutation: true,
    refs: predicted.refs,
    historyWindow: optimisticHistoryWindow(snapshot.historyWindow, predicted.rows),
    selectedSha: focusRefName ? null : predicted.headSha,
    selectedRefName: focusRefName ?? null,
    scrollToSha: predicted.headSha,
    scrollToKey: s.scrollToKey + 1,
    commitDetail: null,
    commitDiff: null,
    commitPRs: [],
    commitFileDiffs: {},
    mergePreview: null,
  }))
}

function captureSnapshot(s: AppState): OptimisticSnapshot {
  return {
    refs: s.refs,
    historyWindow: s.historyWindow,
    worktreeChanges: s.worktreeChanges,
    selectedSha: s.selectedSha,
    selectedRefName: s.selectedRefName,
    scrollToSha: s.scrollToSha,
    totalCommitCount: s.totalCommitCount,
    mergePreview: s.mergePreview,
    commitDetail: s.commitDetail,
    commitDiff: s.commitDiff,
    commitPRs: s.commitPRs,
    commitFileDiffs: s.commitFileDiffs,
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

async function fetchCheckoutState(repoId: string): Promise<[
  RefSummary[],
  HistoryWindowResponse,
  WorktreeChangesResponse,
  WorktreeSummary[],
]> {
  const [[refs, history], changes, worktrees] = await Promise.all([
    fetchRefsAndHistory(repoId),
    getWorktreeChanges(repoId),
    getWorktrees(repoId),
  ])
  return [refs, history, changes, worktrees]
}

function fetchRepositoryState(repoId: string): Promise<[
  RefSummary[],
  HistoryWindowResponse,
  WorktreeChangesResponse,
  WorktreeSummary[],
  StashSummary[],
]> {
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
    getWorktrees(repoId),
    getStashes(repoId),
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
    loadCommitAuthor(repoId, sha)
    getCommitPRs(repoId, sha)
      .then((prs: CommitPRInfo) => {
        if (useAppStore.getState().selectedSha === sha) useAppStore.setState({ commitPRs: prs })
      })
      .catch(() => {})
  }
  useAppStore.getState().fetchCommitCIStatusesIfNeeded([sha])
}

function loadCommitAuthor(repoId: string, sha: string) {
  const state = useAppStore.getState()
  if (!state.githubUrl || sha in state.commitAuthorAvatars) return

  getCommitAuthor(repoId, sha)
    .then(({ avatarUrl }: CommitAuthorResponse) => {
      if (useAppStore.getState().repoId !== repoId) return
      useAppStore.setState((current) => ({
        commitAuthorAvatars: { ...current.commitAuthorAvatars, [sha]: avatarUrl },
      }))
    })
    .catch(() => {})
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

// Late async responses from an earlier repository switch must never replace a
// newer switch. Incremented for every open attempt and when the repo is closed.
let repoOpenRequestId = 0

function isSessionError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No session found')
}

function prependRecentRepo(recentRepos: string[], repoPath: string): string[] {
  return [repoPath, ...recentRepos.filter((existingPath) => existingPath !== repoPath)]
    .slice(0, MAX_RECENT_REPOS)
}

async function openRepoByPathImpl(
  path: string,
  set: StoreSetter,
  get: StoreGetter,
  options: { showOpenError: boolean },
): Promise<void> {
  const requestId = ++repoOpenRequestId
  set({
    status: 'loading',
    repoId: null,
    repoPath: null,
    currentWorktreePath: null,
    totalCommitCount: 0,
    refs: [],
    stashes: [],
    selectedStashSha: null,
    stashDiff: null,
    stashFileDiffs: {},
    worktrees: [],
    historyWindow: null,
    selectedSha: null,
    selectedRefName: null,
    scrollToSha: null,
    commitDetail: null,
    commitDiff: null,
    commitPRs: [],
    commitAuthorAvatars: {},
    commitCIStatus: {},
    mergePreview: null,
    githubUrl: null,
    openError: null,
    loadingMore: false,
    worktreeChanges: null,
    worktreeSelected: false,
    worktreeCommitMessage: '',
    worktreeFileDiffs: {},
    commitFileDiffs: {},
    reflog: null,
    reflogLoading: false,
    pendingMutation: false,
    pendingCheckout: false,
  })
  try {
    const res = await openRepo({ path })
    if (requestId !== repoOpenRequestId) return

    const [refs, hist, worktrees, stashes] = await Promise.all([
      getRefs(res.repoId),
      queryHistory(res.repoId, {
        repoId: res.repoId,
        scope: { kind: 'all' },
        anchor: { kind: 'head' },
        beforeRows: 0,
        afterRows: INITIAL_VISIBLE_ROWS,
        firstParent: false,
        topoOrder: true,
      }),
      getWorktrees(res.repoId),
      getStashes(res.repoId),
    ])
    if (requestId !== repoOpenRequestId) return

    const currentHeadSha = refs.find((ref: RefSummary) => ref.isCurrent)?.targetSha ?? res.head.sha

    setRepoPathInUrl(res.currentWorktreePath)
    // Drop any CI watches/poller left over from a previously open repo.
    ciWatch.clear()
    stopCIPolling()
    set((s) => ({
      status: 'ready',
      repoId: res.repoId,
      repoPath: res.currentWorktreePath,
      currentWorktreePath: res.currentWorktreePath,
      totalCommitCount: Math.max(res.totalCommitCount, hist.rows.length),
      recentRepos: prependRecentRepo(get().recentRepos, res.currentWorktreePath),
      githubUrl: res.githubUrl,
      refs,
      stashes,
      worktrees,
      historyWindow: hist,
      commitAuthorAvatars: {},
      commitCIStatus: {},
      openError: null,
      selectedRefName: null,
      // `--all` history starts at the newest ref, which may be well above a
      // local branch that is behind its upstream. Focus the actual checkout so
      // HEAD — and the worktree node that floats directly above it — opens in
      // the viewport.
      scrollToSha: currentHeadSha,
      scrollToKey: s.scrollToKey + 1,
      mergePreview: null,
      worktreeChanges: null,
      worktreeSelected: false,
      worktreeFileDiffs: {},
      commitFileDiffs: {},
      reflog: null,
      reflogMaxCount: REFLOG_PAGE_SIZE,
    }))
    if (get().viewMode === 'reflog') void get().loadReflog()
    // Worktree status can be slow in large repositories and is independent of
    // painting recent history, so let it fill in after the graph is visible.
    void get().loadWorktreeChanges()
  } catch (err) {
    if (requestId !== repoOpenRequestId) return
    let recentRepos = get().recentRepos
    try {
      recentRepos = await getRecentRepos()
    } catch (historyErr) {
      console.error('Failed to load recent repositories:', historyErr)
    }
    if (requestId !== repoOpenRequestId) return

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

const GRAPH_MODEL_INPUT_KEYS = new Set<keyof AppState>([
  'historyWindow',
  'refs',
  'worktreeChanges',
  'showCommitMessages',
])

function updatesGraphModel(partial: Partial<AppState>): boolean {
  return Object.keys(partial).some((key) => GRAPH_MODEL_INPUT_KEYS.has(key as keyof AppState))
}

export const useAppStore = create<AppState>((baseSet, get) => {
  // Keep cross-domain actions in one bounded store so checkout can still
  // publish one atomic snapshot. Every graph-input publication derives the
  // render model here, before React subscribers run.
  const set: StoreSetter = (update) => {
    baseSet((state) => {
      const partial = typeof update === 'function' ? update(state) : update
      const graphInputsChanged = updatesGraphModel(partial)
      recordStorePublication(graphInputsChanged)
      if (!graphInputsChanged) return partial

      const nextState = { ...state, ...partial }
      return {
        ...partial,
        graphModel: deriveGraphModel(
          nextState.historyWindow,
          nextState.refs,
          nextState.worktreeChanges,
          nextState.showCommitMessages,
        ),
      }
    })
  }

  return {
    ...createRepositorySliceState(),
    ...createGraphSliceState(),
    ...createWorktreeSliceState(),
    ...createUiSliceState(),

  setShowCommitMessages: (value) => {
    try { localStorage.setItem('showCommitMessages', String(value)) } catch {}
    set({ showCommitMessages: value })
  },

  setShowGutterColors: (value) => {
    try { localStorage.setItem('showGutterColors', String(value)) } catch {}
    set({ showGutterColors: value })
  },

  setWorktreeCommitMessage: (message) => set({ worktreeCommitMessage: message }),

  reloadFromServer: async () => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    try {
      let refs: RefSummary[]
      let hist: HistoryWindowResponse
      let changes: WorktreeChangesResponse
      let worktrees: WorktreeSummary[]
      let stashes: StashSummary[]
      try {
        [refs, hist, changes, worktrees, stashes] = await fetchRepositoryState(repoId)
      } catch (err) {
        if (isSessionError(err) || isConnectionLostError(err)) {
          const res = await openRepo({ path: repoPath })
          repoId = res.repoId
          set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
          const fresh = await fetchRepositoryState(repoId)
          refs = fresh[0]
          hist = fresh[1]
          changes = fresh[2]
          worktrees = fresh[3]
          stashes = fresh[4]
        } else {
          throw err
        }
      }

      set((s) => ({
        refs,
        stashes,
        selectedStashSha: s.selectedStashSha && stashes.some((stash) => stash.sha === s.selectedStashSha)
          ? s.selectedStashSha
          : null,
        stashDiff: s.selectedStashSha && stashes.some((stash) => stash.sha === s.selectedStashSha)
          ? s.stashDiff
          : null,
        stashFileDiffs: s.selectedStashSha && stashes.some((stash) => stash.sha === s.selectedStashSha)
          ? s.stashFileDiffs
          : {},
        worktrees,
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

  loadWorktrees: async () => {
    const { repoId } = get()
    if (!repoId) return
    try {
      const worktrees = await getWorktrees(repoId)
      if (get().repoId === repoId) set({ worktrees })
    } catch (err) {
      console.error('Failed to load linked worktrees:', err)
    }
  },

  removeWorktree: async (path) => {
    const { repoId } = get()
    if (!repoId) return false
    try {
      const result = await removeWorktreeApi(repoId, path)
      if (get().repoId === repoId) set({ worktrees: result.worktrees })
      return true
    } catch (err) {
      get().showError('Remove worktree failed', err)
      return false
    }
  },

  loadWorktreeChanges: async () => {
    const { repoId } = get()
    if (!repoId) return
    try {
      const changes = await getWorktreeChanges(repoId)
      if (get().repoId !== repoId) return
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

  createStash: async (message) => {
    const { repoId } = get()
    if (!repoId || get().pendingMutation) return false

    set({ pendingMutation: true })
    try {
      const result = await withTimeout(
        createStashApi(repoId, message?.trim() || undefined),
        MUTATION_TIMEOUT_MS,
      )
      if (get().repoId !== repoId) return false
      set((s) => ({
        pendingMutation: false,
        stashes: result.stashes,
        worktreeChanges: result.changes,
        worktreeFileDiffs: {},
        worktreeSelected: worktreeFileCount(result.changes) > 0
          ? s.worktreeSelected
          : false,
      }))
      return true
    } catch (err) {
      if (get().repoId === repoId) set({ pendingMutation: false })
      get().showError('Stash failed', err)
      return false
    }
  },

  applyStash: async (stashSha) => {
    const { repoId } = get()
    if (!repoId || get().pendingMutation) return false

    set({ pendingMutation: true })
    try {
      const result = await withTimeout(applyStashApi(repoId, stashSha), MUTATION_TIMEOUT_MS)
      if (get().repoId !== repoId) return false
      set({
        pendingMutation: false,
        stashes: result.stashes,
        selectedStashSha: null,
        stashDiff: null,
        stashFileDiffs: {},
        worktreeChanges: result.changes,
        worktreeFileDiffs: {},
        worktreeSelected: worktreeFileCount(result.changes) > 0,
      })
      return true
    } catch (err) {
      // A conflicted `stash apply` can update the index and worktree even
      // though Git exits non-zero. Refresh both panels before surfacing it.
      try {
        const [stashes, changes] = await Promise.all([
          getStashes(repoId),
          getWorktreeChanges(repoId),
        ])
        if (get().repoId === repoId) {
          set({
            pendingMutation: false,
            stashes,
            selectedStashSha: null,
            stashDiff: null,
            stashFileDiffs: {},
            worktreeChanges: changes,
            worktreeFileDiffs: {},
            worktreeSelected: worktreeFileCount(changes) > 0,
          })
        }
      } catch {
        if (get().repoId === repoId) set({ pendingMutation: false })
      }
      get().showError('Apply stash failed', err)
      return false
    }
  },

  dropStash: async (stashSha) => {
    const { repoId } = get()
    if (!repoId || get().pendingMutation) return false

    set({ pendingMutation: true })
    try {
      const result = await withTimeout(dropStashApi(repoId, stashSha), MUTATION_TIMEOUT_MS)
      if (get().repoId !== repoId) return false
      set((s) => ({
        pendingMutation: false,
        stashes: result.stashes,
        worktreeChanges: result.changes,
        selectedStashSha: s.selectedStashSha === stashSha ? null : s.selectedStashSha,
        stashDiff: s.selectedStashSha === stashSha ? null : s.stashDiff,
        stashFileDiffs: s.selectedStashSha === stashSha ? {} : s.stashFileDiffs,
      }))
      return true
    } catch (err) {
      if (get().repoId === repoId) set({ pendingMutation: false })
      get().showError('Drop stash failed', err)
      return false
    }
  },

  selectStash: (stashSha) => {
    const { repoId } = get()
    set({
      selectedStashSha: stashSha,
      stashDiff: null,
      stashFileDiffs: {},
      worktreeSelected: false,
      selectedSha: null,
      selectedRefName: null,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      commitFileDiffs: {},
      mergePreview: null,
    })
    if (!repoId) return

    getStashDiff(repoId, stashSha).then((diff: StashDiffResponse) => {
      if (get().repoId === repoId && get().selectedStashSha === stashSha) {
        set({ stashDiff: diff })
      }
    }).catch((err: unknown) => {
      if (get().repoId === repoId && get().selectedStashSha === stashSha) {
        get().showError('Load stash details failed', err)
      }
    })
  },

  loadStashFileDiff: async (stashSha, file) => {
    const { repoId } = get()
    if (!repoId) return
    const key = stashFileDiffKey(stashSha, file.path)
    const existing = get().stashFileDiffs[key]
    if (existing && (existing.loading || existing.patchText !== undefined)) return
    set((s) => ({ stashFileDiffs: { ...s.stashFileDiffs, [key]: { loading: true } } }))
    try {
      const res = await getStashFileDiff(repoId, stashSha, file.path, file.oldPath)
      if (get().repoId !== repoId || get().selectedStashSha !== stashSha) return
      set((s) => ({
        stashFileDiffs: {
          ...s.stashFileDiffs,
          [key]: {
            loading: false,
            patchText: res.patchText,
            isBinary: res.isBinary,
            imageDiff: res.imageDiff,
          },
        },
      }))
    } catch (err) {
      if (get().repoId !== repoId || get().selectedStashSha !== stashSha) return
      set((s) => ({
        stashFileDiffs: {
          ...s.stashFileDiffs,
          [key]: {
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load diff',
          },
        },
      }))
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
          [key]: {
            loading: false,
            patchText: res.patchText,
            isBinary: res.isBinary,
            imageDiff: res.imageDiff,
          },
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

  loadCommitFileDiff: async (sha, file) => {
    const { repoId } = get()
    if (!repoId) return
    const key = commitFileDiffKey(sha, file.path)
    const existing = get().commitFileDiffs[key]
    if (existing && (existing.loading || existing.patchText !== undefined)) return
    set((s) => ({ commitFileDiffs: { ...s.commitFileDiffs, [key]: { loading: true } } }))
    try {
      const res = await getCommitFileDiff(repoId, sha, file.path, file.oldPath)
      set((s) => ({
        commitFileDiffs: {
          ...s.commitFileDiffs,
          [key]: {
            loading: false,
            patchText: res.patchText,
            isBinary: res.isBinary,
            imageDiff: res.imageDiff,
          },
        },
      }))
    } catch (err) {
      set((s) => ({
        commitFileDiffs: {
          ...s.commitFileDiffs,
          [key]: { loading: false, error: err instanceof Error ? err.message : 'Failed to load diff' },
        },
      }))
    }
  },

  performCommit: async (message, noVerify, amend = false) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return false
    if (get().pendingMutation) return false

    const snapshot = captureSnapshot(get())
    const rows = snapshot.historyWindow?.rows ?? []
    // Predict the new tip so the graph animates immediately. Unlike other
    // rewrites we keep the worktree panel selected — the user may want to
    // stage and commit more. Amend replaces the tip in place; a plain commit
    // appends a fresh one.
    const subject = message.split('\n')[0]
    const predicted = amend
      ? predictAmendHead(rows, snapshot.refs, subject)
      : predictAppendOnHead(rows, snapshot.refs, subject, 'commit')
    const worktreeChangesBeforeCommit = get().worktreeChanges
    const worktreeFileDiffsBeforeCommit = get().worktreeFileDiffs
    const optimisticWorktreeChanges = worktreeChangesBeforeCommit
      ? predictWorktreeAfterCommit(
          worktreeChangesBeforeCommit,
          predicted?.headSha ?? worktreeChangesBeforeCommit.headSha,
        )
      : null
    if (predicted) {
      set({
        pendingMutation: true,
        refs: predicted.refs,
        historyWindow: optimisticHistoryWindow(snapshot.historyWindow, predicted.rows),
        worktreeChanges: optimisticWorktreeChanges,
        worktreeFileDiffs: {},
      })
    } else {
      set({
        pendingMutation: true,
        worktreeChanges: optimisticWorktreeChanges,
        worktreeFileDiffs: {},
      })
    }

    let result: { ok: boolean; headSha: string; changes: WorktreeChangesResponse }
    try {
      result = await withTimeout((async () => {
        try {
          return await commitStaged(repoId, message, noVerify, amend)
        } catch (err) {
          // A lost session means the server restarted and the old call never
          // ran, so the retry cannot double-commit.
          if (isSessionError(err)) {
            const res = await openRepo({ path: repoPath })
            repoId = res.repoId
            set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
            return await commitStaged(repoId, message, noVerify, amend)
          }
          throw err
        }
      })(), COMMIT_MUTATION_TIMEOUT_MS)
    } catch (err) {
      set({
        ...snapshot,
        pendingMutation: false,
        worktreeChanges: worktreeChangesBeforeCommit,
        worktreeFileDiffs: worktreeFileDiffsBeforeCommit,
      })
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
      // Amend rewrites the tip rather than adding a commit — the count is unchanged.
      totalCommitCount: amend
        ? Math.max(s.totalCommitCount, hist.rows.length)
        : Math.max(s.totalCommitCount + 1, hist.rows.length),
      worktreeChanges: result.changes,
      worktreeFileDiffs: {},
    }))
    if (get().viewMode === 'reflog') void get().loadReflog()
    return true
  },

  selectWorktree: () => {
    set({
      worktreeSelected: true,
      selectedStashSha: null,
      stashDiff: null,
      stashFileDiffs: {},
      selectedSha: null,
      selectedRefName: null,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      mergePreview: null,
      commitFileDiffs: {},
    })
    void get().loadWorktreeChanges()
  },

  runStageAction: async (action, paths) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return false
    try {
      let changes: WorktreeChangesResponse
      try {
        changes = await stageAction(repoId, action, paths)
      } catch (err) {
        if (!isSessionError(err) && !isConnectionLostError(err)) throw err

        const res = await openRepo({ path: repoPath })
        repoId = res.repoId
        set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
        changes = await stageAction(repoId, action, paths)
      }

      // A file's diff may move between areas or disappear, so drop the cache.
      set({ worktreeChanges: changes, worktreeFileDiffs: {} })
      return true
    } catch (err) {
      get().showError(action.startsWith('discard') ? 'Discard changes failed' : 'Staging action failed', err)
      return false
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
    repoOpenRequestId += 1
    ciWatch.clear()
    stopCIPolling()
    clearRepoPathInUrl()
    set({
      status: 'no-repo',
      repoId: null,
      repoPath: null,
      currentWorktreePath: null,
      totalCommitCount: 0,
      refs: [],
      stashes: [],
      selectedStashSha: null,
      stashDiff: null,
      stashFileDiffs: {},
      worktrees: [],
      historyWindow: null,
      selectedSha: null,
      selectedRefName: null,
      scrollToSha: null,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      commitAuthorAvatars: {},
      mergePreview: null,
      githubUrl: null,
      openError: null,
      loadingMore: false,
      commitCIStatus: {},
      worktreeChanges: null,
      worktreeSelected: false,
      worktreeCommitMessage: '',
      worktreeFileDiffs: {},
      commitFileDiffs: {},
      pendingMutation: false,
      pendingCheckout: false,
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
    // Setting the canonical repository hash after opening can itself dispatch
    // `hashchange`. Do not tear down and reopen the graph we just loaded.
    if (path && path === get().repoPath) return
    if (path) void get().openRepoByPath(path)
    else void openRepoByPathImpl('.', set, get, { showOpenError: false })
  },

  selectCommit: (sha) => {
    set({
      selectedSha: sha,
      selectedStashSha: null,
      stashDiff: null,
      stashFileDiffs: {},
      worktreeSelected: false,
      scrollToSha: null,
      scrollToKey: get().scrollToKey,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      commitFileDiffs: {},
    })
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
      loadCommitAuthor(repoId, sha)
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
      selectedStashSha: null,
      stashDiff: null,
      stashFileDiffs: {},
      worktreeSelected: false,
      selectedRefName: refName,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      commitFileDiffs: {},
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
      selectedStashSha: null,
      stashDiff: null,
      stashFileDiffs: {},
      worktreeSelected: false,
      selectedRefName: null,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      commitFileDiffs: {},
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
      set((s) => ({
        viewMode: 'history',
        selectedSha: sha,
        selectedStashSha: null,
        stashDiff: null,
        stashFileDiffs: {},
        selectedRefName: null,
        worktreeSelected: false,
        scrollToSha: sha,
        scrollToKey: s.scrollToKey + 1,
        commitDetail: null,
        commitDiff: null,
        commitPRs: [],
        commitFileDiffs: {},
        mergePreview: null,
      }))
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
            viewMode: 'history',
            historyWindow: found ? result : mergeHistory(s.historyWindow, result),
            selectedSha: sha,
            selectedStashSha: null,
            stashDiff: null,
            stashFileDiffs: {},
            selectedRefName: null,
            worktreeSelected: false,
            scrollToSha: found ? sha : null,
            scrollToKey: found ? s.scrollToKey + 1 : s.scrollToKey,
            commitDetail: null,
            commitDiff: null,
            commitPRs: [],
            commitFileDiffs: {},
            mergePreview: null,
          }))
          if (!found && !result.hasMoreAfter) break // no more history
        } catch (err) {
          console.error('Failed to load history for navigation:', err)
          break
        }
      }

      // A stash can outlive a branch rewrite, leaving its parent unreachable
      // from --all once refs/stash is excluded from the normal graph. Anchor a
      // temporary history projection directly at the commit in that case.
      if (!found) {
        try {
          const result = await queryHistory(repoId, {
            repoId,
            scope: { kind: 'all' },
            anchor: { kind: 'sha', value: sha },
            beforeRows: 0,
            afterRows: INITIAL_ROWS,
            firstParent: false,
            topoOrder: true,
          })
          found = result.rows.some((row: CommitRow) => row.sha === sha || row.sha.startsWith(sha))
          if (found) {
            set((s) => ({
              viewMode: 'history',
              historyWindow: result,
              selectedSha: sha,
              selectedStashSha: null,
              stashDiff: null,
              stashFileDiffs: {},
              selectedRefName: null,
              worktreeSelected: false,
              scrollToSha: sha,
              scrollToKey: s.scrollToKey + 1,
              commitDetail: null,
              commitDiff: null,
              commitPRs: [],
              commitFileDiffs: {},
              mergePreview: null,
            }))
          }
        } catch (err) {
          console.error('Failed to load history anchored at commit:', err)
        }
      }
      if (!found) {
        console.warn(`Commit ${sha} not found in history`)
      }
    }
    // Also load detail
    const { repoId: rid } = get()
    if (rid) {
      get().fetchCommitCIStatusesIfNeeded([sha])
      loadCommitAuthor(rid, sha)
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
    try {
      const result = await queryHistory(repoId, {
        repoId,
        scope: { kind: 'all' },
        anchor: { kind: 'head' },
        beforeRows: 0,
        afterRows: historyWindow.rows.length + LOAD_MORE_ROWS,
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

    const predictedCheckoutBranch = action === 'checkout'
      ? predicted?.refs.find((ref) => ref.kind === 'head' && ref.isCurrent)?.shortName ?? null
      : null
    const predictedWorktreeChanges = action === 'checkout' && snapshot.worktreeChanges
      ? predictWorktreeAfterCheckout(snapshot.worktreeChanges, sha, predictedCheckoutBranch)
      : snapshot.worktreeChanges

    if (predicted) {
      set({
        pendingMutation: true,
        ...(action === 'checkout'
          ? {
              pendingCheckout: true,
              worktreeChanges: predictedWorktreeChanges,
            }
          : {}),
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
              commitFileDiffs: {},
            }
          : { selectedRefName: null }),
      })
    } else {
      set({
        pendingMutation: true,
        ...(action === 'checkout'
          ? {
              pendingCheckout: true,
              worktreeChanges: predictedWorktreeChanges,
            }
          : {}),
      })
    }

    try {
      await withTimeout((async () => {
        try {
          await refAction(repoId, action, refName, sha, force)
        } catch (err) {
          // Most ref actions are safe to retry after the connection dropped.
          // Checkout may be between its temporary stash and restore phases,
          // so retrying could strand that stash; reconcile filesystem state
          // in the outer catch instead.
          if (action !== 'checkout' && (isSessionError(err) || isConnectionLostError(err))) {
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
      if (action === 'checkout') {
        try {
          // Checkout can succeed before the temporary stash conflicts while
          // being restored. Reconcile the real branch/worktree instead of
          // rolling the optimistic graph back to a branch Git already left.
          if (isSessionError(err) || isConnectionLostError(err)) {
            const reopened = await openRepo({ path: repoPath })
            repoId = reopened.repoId
            set({
              repoId,
              githubUrl: reopened.githubUrl,
              totalCommitCount: reopened.totalCommitCount,
            })
          }
          const [refs, hist, changes, worktrees, stashes] = await fetchRepositoryState(repoId)
          const previousCurrent = snapshot.refs.find((ref) => ref.kind === 'head' && ref.isCurrent)
          const current = refs.find((ref) => ref.kind === 'head' && ref.isCurrent)
          const moved = current?.shortName !== previousCurrent?.shortName
            || current?.targetSha !== previousCurrent?.targetSha
          const currentSha = current?.targetSha ?? changes.headSha

          set((s) => ({
            ...(moved
              ? {
                  selectedSha: currentSha,
                  selectedRefName: null,
                  scrollToSha: currentSha,
                  scrollToKey: s.scrollToKey + 1,
                  commitDetail: null,
                  commitDiff: null,
                  commitPRs: [],
                  commitFileDiffs: {},
                  mergePreview: null,
                }
              : snapshot),
            pendingMutation: false,
            pendingCheckout: false,
            refs,
            stashes,
            worktrees,
            historyWindow: hist,
            totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
            worktreeChanges: changes,
            worktreeFileDiffs: {},
            worktreeSelected: worktreeFileCount(changes) > 0
              ? moved || s.worktreeSelected
              : false,
          }))
          if (moved) loadSelectedCommitExtras(repoId, currentSha)
        } catch {
          set({ ...snapshot, pendingMutation: false, pendingCheckout: false })
        }
      } else {
        set({ ...snapshot, pendingMutation: false })
      }
      throw err
    }

    // Checkout completion used to publish refs/history, worktree changes, and
    // worktree metadata as three independent async updates. Await them together
    // and publish one authoritative snapshot so React only reconciles the graph
    // once while its optimistic animation is still running.
    if (action === 'checkout') {
      const [refs, hist, changes, worktrees] = await fetchCheckoutState(repoId)
      set((s) => ({
        pendingMutation: false,
        pendingCheckout: false,
        graphAnimationSuppressToken: predicted
          ? s.graphAnimationSuppressToken + 1
          : s.graphAnimationSuppressToken,
        refs,
        historyWindow: hist,
        totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
        worktreeChanges: changes,
        worktreeFileDiffs: {},
        worktreeSelected: conflictedFileCount(changes) > 0
          ? true
          : worktreeFileCount(changes) > 0
            ? s.worktreeSelected
            : false,
        worktrees,
        selectedRefName: null,
        mergePreview: null,
      }))
      if (get().viewMode === 'reflog') void get().loadReflog()
      return
    }

    // Reconcile against the authoritative reload. Suppress the relayout
    // animation only when we already animated to a prediction.
    const [refs, hist] = await fetchRefsAndHistory(repoId)
    void get().loadWorktreeChanges()
    void get().loadWorktrees()
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
        commitFileDiffs: visibleTargetSha ? {} : s.commitFileDiffs,
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
        commitFileDiffs: {},
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
        commitFileDiffs: {},
        mergePreview: null,
      }))
      loadSelectedCommitExtras(repoId, sha)
      return
    }
    set((s) => ({
      pendingMutation: false,
      pendingCheckout: false,
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
      commitFileDiffs: {},
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
    const currentBranchName = snapshot.refs.find(
      (ref) => ref.kind === 'head' && ref.isCurrent,
    )?.shortName
    applyOptimisticRewrite(set, snapshot, predicted, currentBranchName)

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
    const reconciledBranchName = refs.find(
      (ref) => ref.kind === 'head' && ref.isCurrent,
    )?.shortName ?? currentBranchName
    set((s) => ({
      pendingMutation: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      totalCommitCount: Math.max(s.totalCommitCount + 1, hist.rows.length),
      selectedSha: reconciledBranchName ? null : nextSha,
      selectedRefName: reconciledBranchName ?? null,
      scrollToSha: nextSha,
      scrollToKey: s.scrollToKey + 1,
      commitDetail: null,
      commitDiff: null,
      commitPRs: [],
      commitFileDiffs: {},
      mergePreview: null,
    }))

    if (!reconciledBranchName) loadSelectedCommitExtras(repoId, nextSha)
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
          commitFileDiffs: {},
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
      commitFileDiffs: {},
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
        commitFileDiffs: {},
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

  continueInProgressOperation: async (operation) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    if (get().pendingMutation) return

    set({ pendingMutation: true })
    try {
      let result: { ok: boolean; message: string; headSha: string; changes: WorktreeChangesResponse }
      try {
        result = await continueOperationApi(repoId, operation)
      } catch (err) {
        if (isSessionError(err)) {
          const res = await openRepo({ path: repoPath })
          repoId = res.repoId
          set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
          result = await continueOperationApi(repoId, operation)
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
        commitFileDiffs: {},
        mergePreview: null,
        worktreeChanges: result.changes,
        worktreeFileDiffs: {},
        worktreeSelected: worktreeFileCount(result.changes) > 0,
      }))
      loadSelectedCommitExtras(repoId, nextSha)
      if (get().viewMode === 'reflog') void get().loadReflog()
    } catch (err) {
      // The continue may have advanced the operation before failing (e.g.
      // stopped on the next conflicted commit), so refresh state either way.
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
        console.error('Failed to reload state after failed continue:', reloadErr)
      }
      set((s) => ({
        pendingMutation: false,
        ...(refs && hist
          ? {
              refs,
              historyWindow: hist,
              totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
            }
          : {}),
        ...(changes
          ? {
              worktreeChanges: changes,
              worktreeFileDiffs: {},
              worktreeSelected: conflictedFileCount(changes) > 0 || s.worktreeSelected,
            }
          : {}),
      }))
      get().showError(`Continue ${operation} failed`, err)
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
    const predictedWorktreeChanges = snapshot.worktreeChanges
      ? predictWorktreeAfterCheckout(snapshot.worktreeChanges, sha, null)
      : null
    if (predicted) {
      set({
        pendingMutation: true,
        pendingCheckout: true,
        refs: predicted.refs,
        historyWindow: optimisticHistoryWindow(snapshot.historyWindow, predicted.rows),
        worktreeChanges: predictedWorktreeChanges,
        selectedRefName: null,
        mergePreview: null,
      })
    } else {
      set({
        pendingMutation: true,
        pendingCheckout: true,
        worktreeChanges: predictedWorktreeChanges,
      })
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
      set({ ...snapshot, pendingMutation: false, pendingCheckout: false })
      throw err
    }

    const [refs, hist, changes, worktrees] = await fetchCheckoutState(repoId)
    set((s) => ({
      pendingMutation: false,
      pendingCheckout: false,
      graphAnimationSuppressToken: predicted
        ? s.graphAnimationSuppressToken + 1
        : s.graphAnimationSuppressToken,
      refs,
      historyWindow: hist,
      totalCommitCount: Math.max(s.totalCommitCount, hist.rows.length),
      worktreeChanges: changes,
      worktreeFileDiffs: {},
      worktreeSelected: conflictedFileCount(changes) > 0
        ? true
        : worktreeFileCount(changes) > 0
          ? s.worktreeSelected
          : false,
      worktrees,
      selectedRefName: null,
      mergePreview: null,
    }))
    if (get().viewMode === 'reflog') void get().loadReflog()
  },
  }
})
