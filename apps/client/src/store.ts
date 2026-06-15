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
} from '@ingit/rpc-contract'
import {
  openRepo,
  getRecentRepos,
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
  refAction,
  getReflog,
  getWorktreeChanges,
  stageAction,
  isConnectionLostError,
} from './api'

/** Optional extra button shown in the error dialog (e.g. "Force push"). */
export interface ErrorDialogAction {
  label: string
  run: () => void
}

const INITIAL_ROWS = 1000
const LOAD_MORE_ROWS = 500
const MAX_RECENT_REPOS = 12

function getRepoPathFromUrl(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith('#/repository')) return null
  const params = new URLSearchParams(hash.split('?')[1] ?? '')
  return params.get('path')
}

function setRepoPathInUrl(repoPath: string) {
  window.location.hash = `#/repository?path=${encodeURIComponent(repoPath)}`
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

interface AppState {
  status: AppStatus
  repoId: string | null
  repoPath: string | null
  totalCommitCount: number
  recentRepos: string[]
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

  // Actions
  setShowCommitMessages: (value: boolean) => void
  loadWorktreeChanges: () => Promise<void>
  selectWorktree: () => void
  runStageAction: (action: StageActionKind, paths: string[]) => Promise<void>
  showError: (title: string, err: unknown, action?: ErrorDialogAction) => void
  dismissError: () => void
  openRepoByPath: (path: string) => Promise<void>
  loadRecentRepos: () => Promise<void>
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
  checkoutSha: (sha: string) => Promise<void>
  fetchCommitCIStatusesIfNeeded: (shas: string[]) => void
  watchCommitCIStatus: (sha: string) => void
  setViewMode: (mode: ViewMode) => void
  loadReflog: () => Promise<void>
  loadMoreReflog: () => Promise<void>
  recoverBranch: (branchName: string, sha: string) => Promise<void>
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

  loadWorktreeChanges: async () => {
    const { repoId } = get()
    if (!repoId) return
    try {
      const changes = await getWorktreeChanges(repoId)
      set({ worktreeChanges: changes })
    } catch (err) {
      console.error('Failed to load worktree changes:', err)
    }
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
      set({ worktreeChanges: changes })
    } catch (err) {
      if (isSessionError(err) || isConnectionLostError(err)) {
        const res = await openRepo({ path: repoPath })
        repoId = res.repoId
        set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
        const changes = await stageAction(repoId, action, paths)
        set({ worktreeChanges: changes })
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
    const missing = shas.filter((sha) => commitCIStatus[sha] === undefined)
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
        openError: err instanceof Error ? err.message : 'Failed to open repository',
      })
    }
  },

  loadRecentRepos: async () => {
    try {
      set({ recentRepos: await getRecentRepos() })
    } catch (err) {
      console.error('Failed to load recent repositories:', err)
    }
  },

  openFromUrl: () => {
    const path = getRepoPathFromUrl()
    void get().loadRecentRepos()
    if (path) void get().openRepoByPath(path)
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
    // Reload
    const [refs, hist] = await Promise.all([
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
    void get().loadWorktreeChanges()
    if (action === 'move') {
      set({
        refs,
        historyWindow: hist,
        selectedRefName: refName,
        selectedSha: sha,
        scrollToSha: null,
        commitDetail: null,
        commitDiff: null,
        commitPRs: [],
        mergePreview: null,
      })

      Promise.all([
        getCommitDetail(repoId, sha),
        getCommitDiff(repoId, sha),
      ]).then(([detail, diff]) => {
        if (get().selectedSha === sha) {
          set({ commitDetail: detail, commitDiff: diff })
        }
      }).catch((err) => console.error('Failed to load commit detail:', err))

      if (get().githubUrl) {
        getCommitPRs(repoId, sha).then((prs: CommitPRInfo) => {
          if (get().selectedSha === sha) set({ commitPRs: prs })
        }).catch(() => {})
      }
      get().fetchCommitCIStatusesIfNeeded([sha])
      return
    }

    // A push is what triggers CI on the remote, so poll the pushed tip until
    // its check-runs appear and settle.
    if (action === 'push') get().watchCommitCIStatus(sha)
    set({ refs, historyWindow: hist, selectedRefName: null, mergePreview: null })
  },

  performCommitAction: async (action, sha) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return

    let result: { ok: boolean; message: string; headSha: string }
    try {
      result = await commitAction(repoId, action, sha)
    } catch (err) {
      if (isSessionError(err)) {
        const res = await openRepo({ path: repoPath })
        repoId = res.repoId
        set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
        result = await commitAction(repoId, action, sha)
      } else {
        throw err
      }
    }

    const [refs, hist] = await Promise.all([
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

    const nextSha = result.headSha
    const totalCommitCountDelta = action === 'uncommit' ? -1 : 1
    set((s) => ({
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

    Promise.all([
      getCommitDetail(repoId, nextSha),
      getCommitDiff(repoId, nextSha),
    ]).then(([detail, diff]) => {
      if (get().selectedSha === nextSha) {
        set({ commitDetail: detail, commitDiff: diff })
      }
    }).catch((err) => console.error('Failed to load commit detail:', err))

    if (get().githubUrl) {
      getCommitPRs(repoId, nextSha).then((prs: CommitPRInfo) => {
        if (get().selectedSha === nextSha) set({ commitPRs: prs })
      }).catch(() => {})
    }
    get().fetchCommitCIStatusesIfNeeded([nextSha])
    void get().loadWorktreeChanges()
    if (get().viewMode === 'reflog') void get().loadReflog()
  },

  performMergeRef: async (refName) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return

    let result: { ok: boolean; message: string; headSha: string }
    try {
      result = await mergeRefApi(repoId, refName)
    } catch (err) {
      if (isSessionError(err)) {
        const res = await openRepo({ path: repoPath })
        repoId = res.repoId
        set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
        result = await mergeRefApi(repoId, refName)
      } else {
        throw err
      }
    }

    const [refs, hist] = await Promise.all([
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

    const nextSha = result.headSha
    set((s) => ({
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

    Promise.all([
      getCommitDetail(repoId, nextSha),
      getCommitDiff(repoId, nextSha),
    ]).then(([detail, diff]) => {
      if (get().selectedSha === nextSha) {
        set({ commitDetail: detail, commitDiff: diff })
      }
    }).catch((err) => console.error('Failed to load commit detail:', err))

    if (get().githubUrl) {
      getCommitPRs(repoId, nextSha).then((prs: CommitPRInfo) => {
        if (get().selectedSha === nextSha) set({ commitPRs: prs })
      }).catch(() => {})
    }
    get().fetchCommitCIStatusesIfNeeded([nextSha])
    void get().loadWorktreeChanges()
  },

  performRebaseRef: async (refName) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return

    let result: { ok: boolean; message: string; headSha: string }
    try {
      result = await rebaseRefApi(repoId, refName)
    } catch (err) {
      if (isSessionError(err)) {
        const res = await openRepo({ path: repoPath })
        repoId = res.repoId
        set({ repoId, githubUrl: res.githubUrl, totalCommitCount: res.totalCommitCount })
        result = await rebaseRefApi(repoId, refName)
      } else {
        throw err
      }
    }

    const [refs, hist] = await Promise.all([
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

    const nextSha = result.headSha
    set((s) => ({
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

    Promise.all([
      getCommitDetail(repoId, nextSha),
      getCommitDiff(repoId, nextSha),
    ]).then(([detail, diff]) => {
      if (get().selectedSha === nextSha) {
        set({ commitDetail: detail, commitDiff: diff })
      }
    }).catch((err) => console.error('Failed to load commit detail:', err))

    if (get().githubUrl) {
      getCommitPRs(repoId, nextSha).then((prs: CommitPRInfo) => {
        if (get().selectedSha === nextSha) set({ commitPRs: prs })
      }).catch(() => {})
    }
    get().fetchCommitCIStatusesIfNeeded([nextSha])
    void get().loadWorktreeChanges()
  },

  checkoutSha: async (sha) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
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
    const [refs, hist] = await Promise.all([
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
    set({ refs, historyWindow: hist, selectedRefName: null, mergePreview: null })
    void get().loadWorktreeChanges()
    if (get().viewMode === 'reflog') void get().loadReflog()
  },
}))
