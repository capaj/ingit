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
} from '@ingit/rpc-contract'
import {
  openRepo,
  getRecentRepos,
  getRefs,
  queryHistory,
  getCommitDetail,
  getCommitDiff,
  getCommitPRs,
  commitAction,
  getMergePreview as fetchMergePreview,
  mergeRef as mergeRefApi,
  rebaseRef as rebaseRefApi,
  refAction,
} from './api'

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

type CommitPRInfo = Array<{ number: number; title: string; url: string; state: string; mergedAt: string | null }>

interface AppState {
  status: AppStatus
  repoId: string | null
  repoPath: string | null
  totalCommitCount: number
  recentRepos: string[]
  refs: RefSummary[]
  historyWindow: HistoryWindowResponse | null
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
  errorDialog: { title: string; message: string } | null
  loadingMore: boolean

  // Actions
  showError: (title: string, err: unknown) => void
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
  performRefAction: (action: RefActionKind, refName: string, sha: string) => Promise<void>
  performCommitAction: (action: CommitActionKind, sha: string) => Promise<void>
  performMergeRef: (refName: string) => Promise<void>
  performRebaseRef: (refName: string) => Promise<void>
  checkoutSha: (sha: string) => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  status: 'no-repo',
  repoId: null,
  repoPath: null,
  totalCommitCount: 0,
  recentRepos: [],
  refs: [],
  historyWindow: null,
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

  showError: (title, err) => {
    const message = err instanceof Error ? err.message
      : typeof err === 'string' ? err
      : 'Unknown error'
    set({ errorDialog: { title, message } })
  },

  dismissError: () => set({ errorDialog: null }),

  openRepoByPath: async (path) => {
    set({ status: 'loading', openError: null })
    try {
      const res = await openRepo({ path })
      setRepoPathInUrl(res.rootPath)
      set({
        status: 'ready',
        repoId: res.repoId,
        repoPath: res.rootPath,
        totalCommitCount: res.totalCommitCount,
        recentRepos: prependRecentRepo(get().recentRepos, res.rootPath),
        githubUrl: res.githubUrl,
        openError: null,
        selectedRefName: null,
        mergePreview: null,
      })

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
    set({ selectedSha: sha, scrollToSha: null, scrollToKey: get().scrollToKey, commitDetail: null, commitDiff: null, commitPRs: [] })
    const { repoId, githubUrl } = get()
    if (!repoId) return
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

  performRefAction: async (action, refName, sha) => {
    const { repoPath } = get()
    let repoId = get().repoId as string
    if (!repoId || !repoPath) return
    try {
      await refAction(repoId, action, refName, sha)
    } catch (err) {
      if (isSessionError(err)) {
        const res = await openRepo({ path: repoPath })
        repoId = res.repoId
        set({ repoId })
        await refAction(repoId, action, refName, sha)
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
      return
    }

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
  },
}))
