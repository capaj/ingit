import { useReducer, useEffect, useCallback } from 'react'
import type { RefSummary, HistoryWindowResponse, CommitDetailResponse, CommitDiffResponse } from '@ingit/rpc-contract'
import { openRepo, getRefs, queryHistory, getCommitDetail, getCommitDiff } from './api'
import { RepoOpen } from './components/RepoOpen'
import { RefsSidebar } from './components/RefsSidebar'
import { GraphCanvas } from './components/GraphCanvas'
import { CommitDetail } from './components/CommitDetail'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type AppStatus = 'no-repo' | 'loading' | 'ready'

interface AppState {
  status: AppStatus
  repoId: string | null
  repoPath: string | null
  refs: RefSummary[]
  historyWindow: HistoryWindowResponse | null
  windowStartRow: number
  selectedSha: string | null
  commitDetail: CommitDetailResponse | null
  commitDiff: CommitDiffResponse | null
  openError: string | null
}

type AppAction =
  | { type: 'OPEN_START' }
  | { type: 'OPEN_SUCCESS'; repoId: string; repoPath: string }
  | { type: 'OPEN_ERROR'; message: string }
  | { type: 'SET_REFS'; refs: RefSummary[] }
  | { type: 'SET_HISTORY'; window: HistoryWindowResponse; startRow: number }
  | { type: 'SELECT_COMMIT'; sha: string }
  | { type: 'SET_COMMIT_DETAIL'; detail: CommitDetailResponse; diff: CommitDiffResponse }
  | { type: 'SCROLL_WINDOW'; startRow: number }

const initialState: AppState = {
  status: 'no-repo',
  repoId: null,
  repoPath: null,
  refs: [],
  historyWindow: null,
  windowStartRow: 0,
  selectedSha: null,
  commitDetail: null,
  commitDiff: null,
  openError: null,
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'OPEN_START':
      return { ...state, status: 'loading', openError: null }

    case 'OPEN_SUCCESS':
      return {
        ...state,
        status: 'ready',
        repoId: action.repoId,
        repoPath: action.repoPath,
        openError: null,
      }

    case 'OPEN_ERROR':
      return { ...state, status: 'no-repo', openError: action.message }

    case 'SET_REFS':
      return { ...state, refs: action.refs }

    case 'SET_HISTORY':
      return {
        ...state,
        historyWindow: action.window,
        windowStartRow: action.startRow,
      }

    case 'SELECT_COMMIT':
      return {
        ...state,
        selectedSha: action.sha,
        commitDetail: null,
        commitDiff: null,
      }

    case 'SET_COMMIT_DETAIL':
      return { ...state, commitDetail: action.detail, commitDiff: action.diff }

    case 'SCROLL_WINDOW':
      return { ...state, windowStartRow: action.startRow }

    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VISIBLE_ROWS = 50
const SCROLL_STEP = Math.floor(VISIBLE_ROWS / 2)

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)

  // ------------------------------------------------------------------
  // Load history window whenever repoId or windowStartRow changes
  // ------------------------------------------------------------------
  const loadHistory = useCallback(
    async (repoId: string, startRow: number) => {
      try {
        const result = await queryHistory(repoId, {
          repoId,
          scope: { kind: 'all' },
          anchor: { kind: 'row', value: String(startRow) },
          beforeRows: 0,
          afterRows: VISIBLE_ROWS,
          firstParent: false,
          topoOrder: true,
        })
        dispatch({ type: 'SET_HISTORY', window: result, startRow })
      } catch (err) {
        // History errors are non-fatal — graph just stays empty
        console.error('Failed to load history:', err)
      }
    },
    []
  )

  useEffect(() => {
    if (state.repoId) {
      void loadHistory(state.repoId, state.windowStartRow)
    }
  }, [state.repoId, state.windowStartRow, loadHistory])

  // ------------------------------------------------------------------
  // Load commit detail whenever selectedSha changes
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!state.repoId || !state.selectedSha) return
    const repoId = state.repoId
    const sha = state.selectedSha
    void (async () => {
      try {
        const [detail, diff] = await Promise.all([
          getCommitDetail(repoId, sha),
          getCommitDiff(repoId, sha),
        ])
        dispatch({ type: 'SET_COMMIT_DETAIL', detail, diff })
      } catch (err) {
        console.error('Failed to load commit detail:', err)
      }
    })()
  }, [state.repoId, state.selectedSha])

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------
  async function handleOpen(path: string) {
    dispatch({ type: 'OPEN_START' })
    try {
      const res = await openRepo({ path })
      dispatch({ type: 'OPEN_SUCCESS', repoId: res.repoId, repoPath: res.rootPath })
      // Load refs
      const refs = await getRefs(res.repoId)
      dispatch({ type: 'SET_REFS', refs })
    } catch (err) {
      dispatch({
        type: 'OPEN_ERROR',
        message: err instanceof Error ? err.message : 'Failed to open repository',
      })
    }
  }

  function handleSelectRef(ref: RefSummary) {
    // Jump graph to the ref's commit
    dispatch({ type: 'SELECT_COMMIT', sha: ref.targetSha })
    // Reset window to top
    if (state.repoId) {
      void loadHistory(state.repoId, 0)
    }
  }

  function handleSelectCommit(sha: string) {
    dispatch({ type: 'SELECT_COMMIT', sha })
  }

  function handleScroll(direction: 'up' | 'down') {
    const newStart = Math.max(
      0,
      state.windowStartRow + (direction === 'down' ? SCROLL_STEP : -SCROLL_STEP)
    )
    dispatch({ type: 'SCROLL_WINDOW', startRow: newStart })
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (state.status === 'no-repo') {
    return <RepoOpen onOpen={handleOpen} error={state.openError} />
  }

  if (state.status === 'loading') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          width: '100%',
          background: '#1e1e2e',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <Spinner />
        <span style={{ color: '#6c7086', fontSize: 13 }}>Opening repository…</span>
      </div>
    )
  }

  // 'ready'
  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        width: '100%',
        overflow: 'hidden',
        background: '#1e1e2e',
      }}
    >
      <RefsSidebar
        refs={state.refs}
        onSelectRef={handleSelectRef}
        selectedSha={state.selectedSha}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Repo path bar */}
        <div
          style={{
            height: 36,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            padding: '0 14px',
            borderBottom: '1px solid #313244',
            background: '#181825',
            fontSize: 12,
            color: '#6c7086',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <span style={{ color: '#45475a' }}>repo</span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: '#a6adc8',
              fontFamily: 'monospace',
            }}
          >
            {state.repoPath}
          </span>
        </div>

        {/* Graph */}
        <GraphCanvas
          window={state.historyWindow}
          selectedSha={state.selectedSha}
          onSelectCommit={handleSelectCommit}
          onScroll={handleScroll}
        />
      </div>

      <CommitDetail commit={state.commitDetail} diff={state.commitDiff} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div
      style={{
        width: 32,
        height: 32,
        border: '3px solid #313244',
        borderTopColor: '#89b4fa',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
