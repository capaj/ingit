import { create } from 'zustand'
import type { RefSummary, HistoryWindowResponse, CommitDetailResponse, CommitDiffResponse } from '@ingit/rpc-contract'
import { openRepo, getRefs, queryHistory, getCommitDetail, getCommitDiff, getCommitPRs, refAction } from './api'

const INITIAL_ROWS = 1000
const LOAD_MORE_ROWS = 500

function getRepoPathFromUrl(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith('#/repository')) return null
  const params = new URLSearchParams(hash.split('?')[1] ?? '')
  return params.get('path')
}

function setRepoPathInUrl(repoPath: string) {
  window.location.hash = `#/repository?path=${encodeURIComponent(repoPath)}`
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

export type AppStatus = 'no-repo' | 'loading' | 'ready'

interface AppState {
  status: AppStatus
  repoId: string | null
  repoPath: string | null
  totalCommitCount: number
  refs: RefSummary[]
  historyWindow: HistoryWindowResponse | null
  selectedSha: string | null
  scrollToSha: string | null
  scrollToKey: number  // incremented to force re-scroll even for same SHA
  commitDetail: CommitDetailResponse | null
  commitDiff: CommitDiffResponse | null
  commitPRs: Array<{ number: number; title: string; url: string; state: string; mergedAt: string | null }>
  githubUrl: string | null
  openError: string | null
  loadingMore: boolean

  // Actions
  openRepoByPath: (path: string) => Promise<void>
  openFromUrl: () => void
  selectCommit: (sha: string) => void
  selectRef: (ref: RefSummary) => void
  navigateTo: (sha: string) => Promise<void>
  requestMore: (direction: 'up' | 'down') => Promise<void>
  performRefAction: (action: 'checkout' | 'push' | 'fetch' | 'delete', refName: string, sha: string) => Promise<void>
  checkoutSha: (sha: string) => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  status: 'no-repo',
  repoId: null,
  repoPath: null,
  totalCommitCount: 0,
  refs: [],
  historyWindow: null,
  selectedSha: null,
  scrollToSha: null,
  scrollToKey: 0,
  commitDetail: null,
  commitDiff: null,
  commitPRs: [],
  githubUrl: null,
  openError: null,
  loadingMore: false,

  openRepoByPath: async (path) => {
    set({ status: 'loading', openError: null })
    try {
      const res = await openRepo({ path })
      setRepoPathInUrl(res.rootPath)
      set({ status: 'ready', repoId: res.repoId, repoPath: res.rootPath, totalCommitCount: res.totalCommitCount, githubUrl: res.githubUrl, openError: null })

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
      set({
        status: 'no-repo',
        openError: err instanceof Error ? err.message : 'Failed to open repository',
      })
    }
  },

  openFromUrl: () => {
    const path = getRepoPathFromUrl()
    if (path) get().openRepoByPath(path)
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
      getCommitPRs(repoId, sha).then((prs) => {
        if (get().selectedSha === sha) set({ commitPRs: prs })
      }).catch(() => {})
    }
  },

  selectRef: (ref) => {
    get().selectCommit(ref.targetSha)
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
          found = result.rows.some(r => r.sha === sha || r.sha.startsWith(sha))
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
    const { repoId } = get()
    if (!repoId) return
    await refAction(repoId, action, refName, sha)
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
    set({ refs, historyWindow: hist })
  },

  checkoutSha: async (sha) => {
    const { repoId } = get()
    if (!repoId) return
    await refAction(repoId, 'checkout', sha, sha)
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
    set({ refs, historyWindow: hist })
  },
}))
