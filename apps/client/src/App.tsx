import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from './store'
import { RepoOpen } from './components/RepoOpen'
import { RefsSidebar } from './components/RefsSidebar'
import { GraphCanvas } from './components/GraphCanvas'
import { ReflogGraph } from './components/ReflogGraph'
import { CommitDetail } from './components/CommitDetail'
import { WorkingTreeDetail } from './components/WorkingTreeDetail'
import { ErrorDialog } from './components/ErrorDialog'
import { AgentSessions } from './components/AgentSessions'
import type { WorktreeChangesResponse } from '@ingit/rpc-contract'

const DEFAULT_TITLE = 'ingit'

function pathBaseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]+/)
  return parts.at(-1) || path
}

function uncommittedFileCount(changes: WorktreeChangesResponse | null): number {
  if (!changes) return 0
  const paths = new Set<string>()
  for (const file of changes.staged) paths.add(file.path)
  for (const file of changes.unstaged) paths.add(file.path)
  return paths.size
}

export function App() {
  const [refsSidebarOpen, setRefsSidebarOpen] = useState(false)
  const [fetching, setFetching] = useState(false)
  const {
    status, repoPath, recentRepos, discoveredFolder, discoveredRepos, refs, historyWindow, selectedSha,
    commitDetail, commitDiff, commitPRs, commitAuthorAvatars, commitCIStatus, githubUrl, openError,
    errorDialog, dismissError, showError,
    openRepoByPath, closeRepo, openFromUrl, selectRef,
    navigateTo, checkoutSha, performRefAction,
    showCommitMessages, setShowCommitMessages,
    viewMode, setViewMode,
    worktreeSelected,
    worktreeChanges,
    reloadFromServer,
  } = useAppStore()

  const handleFetch = async () => {
    if (fetching) return
    setFetching(true)
    // refName/sha are ignored server-side for fetch; it fetches all remotes
    // and performRefAction reloads refs + history so new commits show up.
    try { await performRefAction('fetch', '', '') }
    catch (err) { showError('Fetch failed', err) }
    finally { setFetching(false) }
  }

  const selectedCIStatus = selectedSha ? commitCIStatus[selectedSha] : undefined
  const selectedCIRuns = selectedCIStatus?.runs ?? []

  useEffect(() => { openFromUrl() }, [openFromUrl])

  useEffect(() => {
    if (status !== 'ready' || !repoPath) {
      document.title = DEFAULT_TITLE
      return
    }

    document.title = `${pathBaseName(repoPath)} (${uncommittedFileCount(worktreeChanges)})`
  }, [status, repoPath, worktreeChanges])

  useEffect(() => {
    let awayAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null

    const markAway = () => {
      awayAt = Date.now()
    }

    const reloadIfAwayLongEnough = () => {
      if (document.visibilityState === 'hidden') return
      if (awayAt !== null && Date.now() - awayAt > 30_000) {
        void reloadFromServer()
      }
      awayAt = null
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markAway()
      else reloadIfAwayLongEnough()
    }

    window.addEventListener('blur', markAway)
    window.addEventListener('focus', reloadIfAwayLongEnough)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('blur', markAway)
      window.removeEventListener('focus', reloadIfAwayLongEnough)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [reloadFromServer])

  // Find branch name for selected commit by tracing first-parent from branch tips
  const selectedBranchName = useMemo(() => {
    if (!selectedSha || !historyWindow) return null
    const rows = historyWindow.rows
    const shaToRow = new Map(rows.map(r => [r.sha, r]))

    for (const row of rows) {
      if (row.refNames.length === 0) continue
      // Pick best ref: prefer local over remote, skip bare names
      const local = row.refNames.find(r => !r.includes('/'))
      const remote = row.refNames.find(r => r.includes('/') && r !== 'origin' && r !== 'HEAD')
      const refName = local ?? remote
      if (!refName) continue

      // Walk first-parent chain to see if selectedSha is on this branch
      let sha: string | undefined = row.sha
      const visited = new Set<string>()
      while (sha && !visited.has(sha)) {
        if (sha === selectedSha) return refName
        visited.add(sha)
        const r = shaToRow.get(sha)
        if (!r || r.parentShas.length === 0) break
        sha = r.parentShas[0]
      }
    }
    return null
  }, [selectedSha, historyWindow])

  if (status === 'no-repo') {
    return (
      <>
        <RepoOpen
          onOpen={openRepoByPath}
          error={openError}
          recentRepos={recentRepos}
          discoveredFolder={discoveredFolder}
          discoveredRepos={discoveredRepos}
        />
        <ErrorDialog error={errorDialog} onDismiss={dismissError} />
      </>
    )
  }

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', background: '#1e1e2e', flexDirection: 'column', gap: 16 }}>
        <Spinner />
        <span style={{ color: '#6c7086', fontSize: 13 }}>Opening repository…</span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden', background: '#1e1e2e' }}>
      {refsSidebarOpen && (
        <RefsSidebar
          refs={refs}
          onSelectRef={selectRef}
          selectedSha={selectedSha}
          onClose={() => setRefsSidebarOpen(false)}
        />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 14px', borderBottom: '1px solid #313244', background: '#181825', fontSize: 12, color: '#6c7086', gap: 8, overflow: 'hidden' }}>
          {!refsSidebarOpen && (
            <button
              onClick={() => setRefsSidebarOpen(true)}
              title="Show refs"
              aria-label="Show refs"
              style={{
                width: 24,
                height: 20,
                flexShrink: 0,
                padding: 0,
                borderRadius: 3,
                border: '1px solid #313244',
                background: '#1e1e2e',
                color: '#6c7086',
                fontSize: 13,
                lineHeight: '18px',
                cursor: 'pointer',
              }}
            >
              ☰
            </button>
          )}
          {viewMode === 'history' && (
            <button
              onClick={() => setShowCommitMessages(!showCommitMessages)}
              style={{
                flexShrink: 0,
                padding: '4px 10px',
                borderRadius: 4,
                border: `1px solid ${showCommitMessages ? '#89b4fa55' : '#313244'}`,
                background: showCommitMessages ? '#89b4fa20' : 'transparent',
                color: showCommitMessages ? '#89b4fa' : '#6c7086',
                fontSize: 11,
                cursor: 'pointer',
              }}
              title={showCommitMessages ? 'Hide commit messages' : 'Show commit messages'}
            >
              {showCommitMessages ? 'Hide messages' : 'Show messages'}
            </button>
          )}
          <div style={{ flexShrink: 0, display: 'flex', borderRadius: 4, border: '1px solid #313244', overflow: 'hidden' }}>
            <button
              onClick={() => setViewMode('history')}
              style={{
                padding: '4px 10px',
                border: 'none',
                background: viewMode === 'history' ? '#89b4fa20' : 'transparent',
                color: viewMode === 'history' ? '#89b4fa' : '#6c7086',
                fontSize: 11,
                cursor: 'pointer',
              }}
              title="Branch history graph"
            >
              History
            </button>
            <button
              onClick={() => setViewMode('reflog')}
              style={{
                padding: '4px 10px',
                border: 'none',
                borderLeft: '1px solid #313244',
                background: viewMode === 'reflog' ? '#f9e2af20' : 'transparent',
                color: viewMode === 'reflog' ? '#f9e2af' : '#6c7086',
                fontSize: 11,
                cursor: 'pointer',
              }}
              title="Reflog time machine — recover lost commits and see where HEAD has been"
            >
              Time Machine
            </button>
          </div>
          <span style={{ color: '#45475a', marginLeft: 8 }}>repo</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#a6adc8', fontFamily: 'monospace', flex: 1 }}>
            {repoPath}
          </span>
          <AgentSessions />
          <button
            onClick={handleFetch}
            disabled={fetching}
            title="Fetch all remotes"
            aria-label="Fetch all remotes"
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid #313244',
              background: 'transparent',
              color: fetching ? '#45475a' : '#6c7086',
              fontSize: 11,
              cursor: fetching ? 'default' : 'pointer',
            }}
          >
            <span style={{ display: 'inline-block', animation: fetching ? 'spin 0.7s linear infinite' : 'none' }}>⟳</span>
            {fetching ? 'Fetching…' : 'Fetch'}
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </button>
          <button
            onClick={closeRepo}
            title="Close repository"
            aria-label="Close repository"
            style={{
              flexShrink: 0,
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid #313244',
              background: 'transparent',
              color: '#6c7086',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        {viewMode === 'reflog' ? <ReflogGraph /> : <GraphCanvas />}
      </div>

      {worktreeSelected ? (
        <WorkingTreeDetail />
      ) : (
        <CommitDetail
          commit={commitDetail}
          diff={commitDiff}
          branchName={selectedBranchName}
          prs={commitPRs}
          authorAvatarUrl={commitDetail ? commitAuthorAvatars[commitDetail.sha] : undefined}
          ciState={selectedCIStatus?.state}
          ciRuns={selectedCIRuns}
          githubUrl={githubUrl}
          onNavigate={navigateTo}
          onCheckout={async (sha) => {
            try { await checkoutSha(sha) }
            catch (err) { showError('Checkout failed', err) }
          }}
        />
      )}

      <ErrorDialog error={errorDialog} onDismiss={dismissError} />
    </div>
  )
}

function Spinner() {
  return (
    <div style={{ width: 32, height: 32, border: '3px solid #313244', borderTopColor: '#89b4fa', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
