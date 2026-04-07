import { useEffect, useMemo } from 'react'
import { useAppStore } from './store'
import { RepoOpen } from './components/RepoOpen'
import { RefsSidebar } from './components/RefsSidebar'
import { GraphCanvas } from './components/GraphCanvas'
import { CommitDetail } from './components/CommitDetail'

export function App() {
  const {
    status, repoPath, totalCommitCount, refs, historyWindow, selectedSha, scrollToSha, scrollToKey,
    commitDetail, commitDiff, commitPRs, githubUrl, openError,
    openRepoByPath, openFromUrl, selectCommit, selectRef,
    navigateTo, requestMore, performRefAction, checkoutSha,
  } = useAppStore()

  useEffect(() => { openFromUrl() }, [openFromUrl])

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

  const currentBranch = useMemo(() => {
    const current = refs.find(r => r.isCurrent)
    return current?.shortName ?? null
  }, [refs])

  if (status === 'no-repo') {
    return <RepoOpen onOpen={openRepoByPath} error={openError} />
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
      <RefsSidebar refs={refs} onSelectRef={selectRef} selectedSha={selectedSha} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 14px', borderBottom: '1px solid #313244', background: '#181825', fontSize: 12, color: '#6c7086', gap: 8, overflow: 'hidden' }}>
          <span style={{ color: '#45475a' }}>repo</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#a6adc8', fontFamily: 'monospace' }}>
            {repoPath}
          </span>
        </div>

        <GraphCanvas
          window={historyWindow}
          totalCommitCount={totalCommitCount}
          selectedSha={selectedSha}
          scrollToSha={scrollToSha}
          scrollToKey={scrollToKey}
          currentBranch={currentBranch}
          onSelectCommit={selectCommit}
          onRequestMore={requestMore}
          onRefAction={async (action, refName, sha) => {
            try {
              await performRefAction(action as 'checkout' | 'push' | 'fetch' | 'delete', refName, sha)
            } catch (err) {
              alert(err instanceof Error ? err.message : 'Action failed')
            }
          }}
        />
      </div>

      <CommitDetail
        commit={commitDetail}
        diff={commitDiff}
        branchName={selectedBranchName}
        prs={commitPRs}
        githubUrl={githubUrl}
        onNavigate={navigateTo}
        onCheckout={async (sha) => {
          try { await checkoutSha(sha) }
          catch (err) { alert(err instanceof Error ? err.message : 'Checkout failed') }
        }}
      />
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
