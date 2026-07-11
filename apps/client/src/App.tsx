import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from './store'
import { listDirectory as fetchDirectory } from './api'
import { RepoOpen } from './components/RepoOpen'
import { RefsSidebar } from './components/RefsSidebar'
import { GraphCanvas } from './components/GraphCanvas'
import { ReflogGraph } from './components/ReflogGraph'
import { CommitDetail } from './components/CommitDetail'
import { WorkingTreeDetail } from './components/WorkingTreeDetail'
import { ErrorDialog } from './components/ErrorDialog'
import { AgentSessions } from './components/AgentSessions'
import type { DirectoryEntry, DirectoryListing, WorktreeChangesResponse } from '@ingit/rpc-contract'

const DEFAULT_TITLE = 'ingit'
const MAX_PATH_SUGGESTIONS = 8

function pathAutocompleteQuery(rawPath: string): { folder: string; prefix: string } | null {
  if (rawPath.trim().length === 0) return null

  const separatorIndex = Math.max(rawPath.lastIndexOf('/'), rawPath.lastIndexOf('\\'))
  if (separatorIndex === -1) return { folder: '.', prefix: rawPath }

  const prefix = rawPath.slice(separatorIndex + 1)
  const separator = rawPath[separatorIndex]!
  let folder = rawPath.slice(0, separatorIndex)
  if (/^[A-Za-z]:$/.test(folder)) folder += separator
  if (!folder) folder = rawPath.startsWith('/') || rawPath.startsWith('\\') ? separator : '.'
  return { folder, prefix }
}

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
  const [repoPathInput, setRepoPathInput] = useState('')
  const [repoPathEditing, setRepoPathEditing] = useState(false)
  const [pathAutocompleteActive, setPathAutocompleteActive] = useState(false)
  const [pathSuggestionsOpen, setPathSuggestionsOpen] = useState(false)
  const [pathSuggestionsLoading, setPathSuggestionsLoading] = useState(false)
  const [pathSuggestions, setPathSuggestions] = useState<DirectoryEntry[]>([])
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0)
  const [pathSuggestionAnchor, setPathSuggestionAnchor] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const repoPathInputRef = useRef<HTMLInputElement>(null)
  const {
    status, repoPath, recentRepos, discoveredFolder, discoveredRepos, refs, historyWindow, selectedSha,
    commitDetail, commitDiff, commitPRs, commitAuthorAvatars, commitCIStatus, githubUrl, openError,
    errorDialog, dismissError, showError,
    openRepoByPath, closeRepo, openFromUrl, selectRef,
    navigateTo, checkoutSha, performRefAction,
    showCommitMessages, setShowCommitMessages, showGutterColors, setShowGutterColors,
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

  useEffect(() => {
    const handleHashChange = () => openFromUrl()
    window.addEventListener('hashchange', handleHashChange)
    openFromUrl()
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [openFromUrl])

  useEffect(() => {
    setRepoPathInput(repoPath ?? '')
    setPathAutocompleteActive(false)
    setPathSuggestionsOpen(false)
  }, [repoPath])

  useEffect(() => {
    if (!repoPathEditing || !pathAutocompleteActive) {
      setPathSuggestionsOpen(false)
      setPathSuggestionsLoading(false)
      return
    }

    const query = pathAutocompleteQuery(repoPathInput)
    if (!query) {
      setPathSuggestions([])
      setPathSuggestionsOpen(false)
      setPathSuggestionsLoading(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setPathSuggestionsLoading(true)
      fetchDirectory(query.folder)
        .then((listing: DirectoryListing) => {
          if (cancelled) return
          const prefix = query.prefix.toLowerCase()
          const entries = listing.entries
            .filter((entry) => prefix.length === 0 || entry.name.toLowerCase().startsWith(prefix))
            .slice(0, MAX_PATH_SUGGESTIONS)
          setPathSuggestions(entries)
          setHighlightedSuggestion(0)
          setPathSuggestionsOpen(entries.length > 0)
        })
        .catch(() => {
          if (cancelled) return
          setPathSuggestions([])
          setPathSuggestionsOpen(false)
        })
        .finally(() => {
          if (!cancelled) setPathSuggestionsLoading(false)
        })
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [pathAutocompleteActive, repoPathEditing, repoPathInput])

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

  const handleRepoPathSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const path = repoPathInput.trim()
    if (!path || path === repoPath) {
      setRepoPathInput(repoPath ?? '')
      setRepoPathEditing(false)
      event.currentTarget.querySelector('input')?.blur()
      return
    }
    void openRepoByPath(path)
  }

  const updatePathSuggestionAnchor = () => {
    const rect = repoPathInputRef.current?.getBoundingClientRect()
    if (rect) setPathSuggestionAnchor({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }

  const completePathSuggestion = (entry: DirectoryEntry) => {
    setRepoPathInput(entry.path)
    setPathAutocompleteActive(false)
    setPathSuggestionsOpen(false)
    setHighlightedSuggestion(0)
  }

  const showPathSuggestions = repoPathEditing
    && pathSuggestionAnchor !== null
    && (pathSuggestionsLoading || (pathSuggestionsOpen && pathSuggestions.length > 0))

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
          showGutterColors={showGutterColors}
          onShowGutterColorsChange={setShowGutterColors}
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
          <form
            onSubmit={handleRepoPathSubmit}
            style={{ display: 'flex', flex: 1, minWidth: 0 }}
          >
            <input
              ref={repoPathInputRef}
              value={repoPathInput}
              onChange={(event) => {
                setRepoPathInput(event.target.value)
                setPathAutocompleteActive(true)
                updatePathSuggestionAnchor()
              }}
              onFocus={(event) => {
                setRepoPathEditing(true)
                setPathAutocompleteActive(false)
                updatePathSuggestionAnchor()
                event.currentTarget.select()
              }}
              onBlur={() => {
                setRepoPathEditing(false)
                setPathAutocompleteActive(false)
                setPathSuggestionsOpen(false)
              }}
              onKeyDown={(event) => {
                if (pathSuggestionsOpen && pathSuggestions.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setHighlightedSuggestion((current) => (current + 1) % pathSuggestions.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setHighlightedSuggestion((current) => (
                      current - 1 + pathSuggestions.length
                    ) % pathSuggestions.length)
                    return
                  }
                  if (event.key === 'Tab' || event.key === 'Enter') {
                    event.preventDefault()
                    completePathSuggestion(pathSuggestions[highlightedSuggestion]!)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setPathAutocompleteActive(false)
                    setPathSuggestionsOpen(false)
                    return
                  }
                }
                if (event.key === 'Escape') {
                  setRepoPathInput(repoPath ?? '')
                  event.currentTarget.blur()
                }
              }}
              aria-label="Repository path"
              title="Type a repository path and press Enter to open it"
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded={showPathSuggestions}
              aria-controls="header-repo-path-suggestions"
              aria-autocomplete="list"
              style={{
                width: '100%',
                minWidth: 0,
                padding: '3px 5px',
                border: `1px solid ${repoPathEditing ? '#89b4fa88' : 'transparent'}`,
                borderRadius: 3,
                outline: 'none',
                background: repoPathEditing ? '#1e1e2e' : 'transparent',
                color: '#a6adc8',
                fontFamily: 'monospace',
                fontSize: 12,
              }}
            />
          </form>
          {showPathSuggestions && (
            <div
              id="header-repo-path-suggestions"
              role="listbox"
              style={{
                position: 'fixed',
                zIndex: 100,
                top: pathSuggestionAnchor.top,
                left: pathSuggestionAnchor.left,
                width: pathSuggestionAnchor.width,
                maxHeight: 238,
                overflowY: 'auto',
                padding: 4,
                border: '1px solid #3d4253',
                borderRadius: 5,
                background: '#181825',
                boxShadow: '0 8px 24px #00000088',
              }}
            >
              {pathSuggestionsLoading && pathSuggestions.length === 0 ? (
                <div style={{ padding: '7px 8px', color: '#7f849c', fontSize: 11 }}>
                  Loading…
                </div>
              ) : pathSuggestions.map((entry, index) => (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedSuggestion}
                  onMouseEnter={() => setHighlightedSuggestion(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    completePathSuggestion(entry)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    minWidth: 0,
                    padding: '6px 8px',
                    border: 'none',
                    borderRadius: 4,
                    background: index === highlightedSuggestion ? '#313244' : 'transparent',
                    color: '#cdd6f4',
                    fontSize: 11,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'monospace',
                    }}
                  >
                    {entry.path}
                  </span>
                  {entry.isGitRepo && (
                    <span style={{ flexShrink: 0, color: '#a6e3a1', fontSize: 10 }}>repo</span>
                  )}
                </button>
              ))}
            </div>
          )}
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
