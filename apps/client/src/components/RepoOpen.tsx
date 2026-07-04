import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { DirectoryEntry, DirectoryListing } from '@ingit/rpc-contract'
import { listDirectory as fetchDirectory } from '../api'
import {
  useAgentSessions,
  groupAgentSessionsByCwd,
  agentSessionKindLabel,
} from '../useAgentSessions'
import { AgentIcon } from './AgentIcon'

const MAX_PATH_SUGGESTIONS = 8

interface RepoOpenProps {
  onOpen: (path: string) => void
  error?: string | null
  recentRepos: string[]
  discoveredFolder?: string | null
  discoveredRepos?: string[]
}

interface DirectoryNodeState {
  listing?: DirectoryListing
  expanded: boolean
  loading: boolean
  error?: string
}

interface PathBreadcrumb {
  label: string
  path: string
}

function getRepoLabel(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? path
}

function rowId(path: string): string {
  return path.replace(/[^a-z0-9_-]/gi, '_')
}

function pathAutocompleteQuery(rawPath: string): { folder: string; prefix: string } | null {
  if (rawPath.trim().length === 0) return null

  const slash = rawPath.lastIndexOf('/')
  const backslash = rawPath.lastIndexOf('\\')
  const separatorIndex = Math.max(slash, backslash)

  if (separatorIndex === -1) return { folder: '.', prefix: rawPath }

  const prefix = rawPath.slice(separatorIndex + 1)
  let folder = rawPath.slice(0, separatorIndex)
  if (!folder) folder = rawPath.startsWith('/') ? '/' : '.'
  return { folder, prefix }
}

function getPathBreadcrumbs(rawPath: string): PathBreadcrumb[] {
  const path = rawPath.replace(/[\\/]+$/, '') || rawPath
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'

  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const drive = path.slice(0, 2)
    const root = `${drive}${separator}`
    const crumbs: PathBreadcrumb[] = [{ label: root, path: root }]
    let current = root

    for (const part of path.slice(3).split(/[\\/]+/).filter(Boolean)) {
      current = current.endsWith(separator) ? `${current}${part}` : `${current}${separator}${part}`
      crumbs.push({ label: part, path: current })
    }

    return crumbs
  }

  if (path.startsWith('/') || path.startsWith('\\')) {
    const crumbs: PathBreadcrumb[] = [{ label: '/', path: '/' }]
    let current = ''

    for (const part of path.split(/[\\/]+/).filter(Boolean)) {
      current = `${current}/${part}`
      crumbs.push({ label: part, path: current })
    }

    return crumbs
  }

  let current = ''
  return path.split(/[\\/]+/).filter(Boolean).map((part) => {
    current = current ? `${current}${separator}${part}` : part
    return { label: part, path: current }
  })
}

export function RepoOpen({ onOpen, error, recentRepos, discoveredFolder, discoveredRepos = [] }: RepoOpenProps) {
  const { sessions: agentSessions, focusingPid, focus: focusAgentSession } = useAgentSessions()
  const [path, setPath] = useState('')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Record<string, DirectoryNodeState>>({})
  const [pathInputFocused, setPathInputFocused] = useState(false)
  const [pathSuggestionsOpen, setPathSuggestionsOpen] = useState(false)
  const [pathSuggestionsLoading, setPathSuggestionsLoading] = useState(false)
  const [pathSuggestions, setPathSuggestions] = useState<DirectoryEntry[]>([])
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0)

  const loadDirectory = useCallback(async (folder?: string, options?: { makeRoot?: boolean }) => {
    if (folder) {
      setNodes((current) => ({
        ...current,
        [folder]: {
          ...current[folder],
          expanded: true,
          loading: true,
          error: undefined,
        },
      }))
    }

    try {
      const listing = await fetchDirectory(folder) as DirectoryListing
      setNodes((current) => ({
        ...current,
        [listing.path]: {
          listing,
          expanded: true,
          loading: false,
          error: listing.error,
        },
      }))
      if (!folder || options?.makeRoot) setRootPath(listing.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to read directory'
      if (folder) {
        setNodes((current) => ({
          ...current,
          [folder]: {
            ...current[folder],
            expanded: true,
            loading: false,
            error: message,
          },
        }))
      }
    }
  }, [])

  useEffect(() => {
    void loadDirectory(undefined, { makeRoot: true })
  }, [loadDirectory])

  useEffect(() => {
    if (!pathInputFocused) {
      setPathSuggestionsOpen(false)
      setPathSuggestionsLoading(false)
      return
    }

    const query = pathAutocompleteQuery(path)
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
          setPathSuggestionsOpen(pathInputFocused && entries.length > 0)
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
  }, [path, pathInputFocused])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = path.trim()
    if (trimmed) onOpen(trimmed)
  }

  function completePathSuggestion(entry: DirectoryEntry) {
    setPath(entry.path)
    setPathSuggestionsOpen(false)
    setHighlightedSuggestion(0)
  }

  function handlePathKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!pathSuggestionsOpen || pathSuggestions.length === 0) {
      if (e.key === 'Escape') setPathSuggestionsOpen(false)
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedSuggestion((current) => (current + 1) % pathSuggestions.length)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedSuggestion((current) => (current - 1 + pathSuggestions.length) % pathSuggestions.length)
      return
    }

    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      completePathSuggestion(pathSuggestions[highlightedSuggestion])
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      setPathSuggestionsOpen(false)
    }
  }

  function toggleDirectory(entry: DirectoryEntry) {
    const current = nodes[entry.path]
    if (current?.expanded) {
      setNodes((state) => ({
        ...state,
        [entry.path]: { ...current, expanded: false },
      }))
      return
    }

    if (current?.listing) {
      setNodes((state) => ({
        ...state,
        [entry.path]: { ...current, expanded: true },
      }))
      return
    }

    void loadDirectory(entry.path)
  }

  function renderRows(parentPath: string, depth: number): React.ReactNode {
    const node = nodes[parentPath]
    const entries = node?.listing?.entries ?? []

    if (node?.error) {
      return (
        <div className="repo-open-tree-empty" style={{ paddingLeft: 34 + depth * 18 }}>
          {node.error}
        </div>
      )
    }

    if (!node?.loading && entries.length === 0) {
      return (
        <div className="repo-open-tree-empty" style={{ paddingLeft: 34 + depth * 18 }}>
          No folders
        </div>
      )
    }

    return entries.map((entry) => {
      const child = nodes[entry.path]
      const expanded = child?.expanded ?? false
      const loading = child?.loading ?? false

      return (
        <div key={entry.path}>
          <div
            className={`repo-open-tree-row${entry.isGitRepo ? ' repo-open-tree-row-repo' : ''}`}
            onClick={() => setPath(entry.path)}
            onDoubleClick={() => {
              if (entry.isGitRepo) onOpen(entry.path)
            }}
            style={{ paddingLeft: 10 + depth * 18 }}
          >
            <button
              type="button"
              className="repo-open-expand"
              onClick={(e) => {
                e.stopPropagation()
                toggleDirectory(entry)
              }}
              aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
              aria-controls={`folder-${rowId(entry.path)}`}
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {loading ? '...' : expanded ? '-' : '+'}
            </button>
            <span className="repo-open-folder-name">{entry.name}</span>
            {entry.isGitRepo && <span className="repo-open-repo-badge">repo</span>}
            {entry.isGitRepo && (
              <button
                type="button"
                className="repo-open-row-action"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(entry.path)
                }}
              >
                Open
              </button>
            )}
          </div>

          {expanded && (
            <div id={`folder-${rowId(entry.path)}`}>
              {child?.loading
                ? <div className="repo-open-tree-empty" style={{ paddingLeft: 34 + (depth + 1) * 18 }}>Loading...</div>
                : renderRows(entry.path, depth + 1)}
            </div>
          )}
        </div>
      )
    })
  }

  const agentGroups = groupAgentSessionsByCwd(
    agentSessions.filter((s) => s.gitRoot !== null),
    (s) => s.gitRoot!,
  )
  const root = rootPath ? nodes[rootPath]?.listing : null
  const rootLoading = !rootPath || nodes[rootPath]?.loading
  const showPathSuggestions = pathInputFocused
    && (pathSuggestionsLoading || (pathSuggestionsOpen && pathSuggestions.length > 0))

  return (
    <div className="repo-open-page">
      <style>{`
        .repo-open-page {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          width: 100%;
          background: #171820;
          color: #d7dae5;
          padding: 24px;
          box-sizing: border-box;
        }

        .repo-open-shell {
          width: min(1360px, 100%);
          height: min(760px, 100%);
          min-height: 520px;
          background: #222430;
          border: 1px solid #343847;
          border-radius: 8px;
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.32);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .repo-open-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 20px;
          border-bottom: 1px solid #343847;
          background: #1d1f29;
        }

        .repo-open-title {
          margin: 0;
          font-size: 18px;
          line-height: 1.2;
          font-weight: 650;
          color: #eef0f6;
        }

        .repo-open-form {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: min(520px, 58%);
        }

        .repo-open-input-wrap {
          position: relative;
          flex: 1;
          min-width: 0;
        }

        .repo-open-input {
          flex: 1;
          min-width: 0;
          width: 100%;
          height: 32px;
          background: #171820;
          border: 1px solid #3d4253;
          border-radius: 5px;
          color: #eef0f6;
          font-size: 13px;
          padding: 0 10px;
          outline: none;
          font-family: inherit;
        }

        .repo-open-input:focus {
          border-color: #6ea8fe;
        }

        .repo-open-path-suggestions {
          position: absolute;
          z-index: 20;
          top: calc(100% + 6px);
          left: 0;
          right: 0;
          max-height: 238px;
          overflow: auto;
          overscroll-behavior: contain;
          padding: 5px;
          border: 1px solid #3d4253;
          border-radius: 6px;
          background: #171820;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.36);
        }

        .repo-open-path-suggestion {
          width: 100%;
          min-width: 0;
          min-height: 34px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: #d7dae5;
          font: inherit;
          text-align: left;
          cursor: pointer;
        }

        .repo-open-path-suggestion-active,
        .repo-open-path-suggestion:hover {
          background: #2a2e3b;
        }

        .repo-open-path-suggestion-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .repo-open-path-suggestion-name,
        .repo-open-path-suggestion-path {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .repo-open-path-suggestion-name {
          color: #eef0f6;
          font-size: 13px;
          font-weight: 650;
        }

        .repo-open-path-suggestion-path {
          color: #8f96a8;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }

        .repo-open-path-suggestions-loading {
          min-height: 30px;
          display: flex;
          align-items: center;
          padding: 0 8px;
          color: #8f96a8;
          font-size: 12px;
        }

        .repo-open-button,
        .repo-open-row-action,
        .repo-open-root-action,
        .repo-open-root-nav {
          border: 1px solid #4a5366;
          border-radius: 5px;
          background: #2b3140;
          color: #f1f3f8;
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }

        .repo-open-button {
          height: 32px;
          padding: 0 14px;
          font-weight: 650;
        }

        .repo-open-button:disabled {
          cursor: default;
          color: #777d8e;
          background: #242733;
          border-color: #343847;
        }

        .repo-open-body {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 460px;
        }

        .repo-open-explorer {
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border-right: 1px solid #343847;
        }

        .repo-open-explorer-head {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 44px;
          padding: 0 12px;
          border-bottom: 1px solid #343847;
          background: #20232d;
        }

        .repo-open-root-nav {
          width: 30px;
          height: 26px;
          padding: 0;
        }

        .repo-open-root-nav:disabled {
          cursor: default;
          color: #5f6575;
          border-color: #343847;
          background: #222430;
        }

        .repo-open-root-path {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 2px;
          overflow: auto hidden;
          scrollbar-width: none;
          white-space: nowrap;
          font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          color: #aeb5c6;
        }

        .repo-open-root-path::-webkit-scrollbar {
          display: none;
        }

        .repo-open-root-crumb {
          flex: 0 0 auto;
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          border: 1px solid transparent;
          border-radius: 4px;
          background: transparent;
          color: #aeb5c6;
          font: inherit;
          padding: 3px 5px;
          cursor: pointer;
        }

        .repo-open-root-crumb:hover {
          border-color: #3d4253;
          background: #2a2e3b;
          color: #eef0f6;
        }

        .repo-open-root-separator {
          flex: 0 0 auto;
          color: #596072;
          font-size: 11px;
        }

        .repo-open-root-action {
          height: 26px;
          padding: 0 10px;
          color: #b7f0c0;
          border-color: #3f7350;
          background: #213229;
        }

        .repo-open-tree {
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: auto;
          overscroll-behavior: contain;
          padding: 8px 0;
        }

        .repo-open-tree-row {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 30px;
          padding-top: 0;
          padding-right: 10px;
          padding-bottom: 0;
          color: #c7ccd8;
          cursor: default;
          box-sizing: border-box;
        }

        .repo-open-tree-row:hover {
          background: #2a2e3b;
        }

        .repo-open-tree-row-repo {
          color: #eef0f6;
        }

        .repo-open-expand {
          width: 20px;
          height: 20px;
          flex: 0 0 20px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid transparent;
          border-radius: 4px;
          background: transparent;
          color: #8f96a8;
          font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          cursor: pointer;
        }

        .repo-open-expand:hover {
          border-color: #3d4253;
          background: #20232d;
          color: #d7dae5;
        }

        .repo-open-folder-name {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
        }

        .repo-open-repo-badge {
          flex: 0 0 auto;
          border: 1px solid #3f7350;
          border-radius: 4px;
          padding: 2px 6px;
          color: #b7f0c0;
          background: #213229;
          font-size: 11px;
          line-height: 1;
        }

        .repo-open-row-action {
          height: 24px;
          padding: 0 9px;
          color: #eef0f6;
        }

        .repo-open-tree-empty {
          min-height: 28px;
          display: flex;
          align-items: center;
          color: #777d8e;
          font-size: 12px;
          box-sizing: border-box;
        }

        .repo-open-side {
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 18px;
          padding: 16px;
          overflow: auto;
        }

        .repo-open-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .repo-open-section-title {
          color: #8f96a8;
          font-size: 12px;
          font-weight: 650;
        }

        .repo-open-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .repo-open-list-button {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 3px;
          min-width: 0;
          border: 1px solid #343847;
          border-radius: 6px;
          background: #1d1f29;
          color: #d7dae5;
          cursor: pointer;
          padding: 9px 10px;
          text-align: left;
          font: inherit;
        }

        .repo-open-list-button:hover {
          border-color: #4a5366;
          background: #242835;
        }

        .repo-open-list-name {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 650;
        }

        .repo-open-list-path,
        .repo-open-folder-caption {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          color: #8f96a8;
        }

        .repo-open-claude-row {
          position: relative;
          padding-right: 62px;
        }

        .repo-open-agent-name {
          display: inline-flex;
          align-items: center;
          gap: 7px;
        }

        .repo-open-claude-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-top: 3px;
          min-width: 0;
          max-width: 100%;
          align-self: stretch;
        }

        .repo-open-claude-chip {
          border: 1px solid #3d4253;
          border-radius: 4px;
          background: #20232d;
          color: #aeb5c6;
          padding: 2px 7px;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          cursor: pointer;
          min-width: 0;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .repo-open-claude-chip:hover:not(:disabled) {
          border-color: #6ea8fe;
          color: #eef0f6;
          background: #262c3c;
        }

        .repo-open-claude-chip-busy {
          border-color: #d8b45a;
          color: #ecd08a;
          animation: repo-open-chip-pulse 1.2s ease-in-out infinite;
        }

        @keyframes repo-open-chip-pulse {
          50% { opacity: 0.55; }
        }

        .repo-open-claude-chip:disabled {
          cursor: default;
          color: #5f6575;
          border-color: #2c2f3b;
        }

        .repo-open-claude-open {
          position: absolute;
          top: 50%;
          right: 10px;
          transform: translateY(-50%);
          height: 24px;
        }

        .repo-open-error {
          margin: 0;
          color: #ff9ca8;
          font-size: 12px;
          line-height: 1.4;
        }

        @media (max-width: 760px) {
          .repo-open-page {
            padding: 12px;
          }

          .repo-open-shell {
            height: 100%;
            min-height: 0;
          }

          .repo-open-header {
            align-items: stretch;
            flex-direction: column;
          }

          .repo-open-form {
            min-width: 0;
            width: 100%;
          }

          .repo-open-body {
            grid-template-columns: 1fr;
          }

          .repo-open-explorer {
            min-height: 340px;
            border-right: none;
            border-bottom: 1px solid #343847;
          }
        }
      `}</style>

      <div className="repo-open-shell">
        <div className="repo-open-header">
          <h1 className="repo-open-title">Open repository</h1>

          <form onSubmit={handleSubmit} className="repo-open-form">
            <div className="repo-open-input-wrap">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onFocus={() => {
                  setPathInputFocused(true)
                  if (pathSuggestions.length > 0) setPathSuggestionsOpen(true)
                }}
                onBlur={() => {
                  setPathInputFocused(false)
                  setPathSuggestionsOpen(false)
                }}
                onKeyDown={handlePathKeyDown}
                placeholder="/home/user/my-project"
                className="repo-open-input"
                autoComplete="off"
                role="combobox"
                aria-expanded={showPathSuggestions}
                aria-controls="repo-open-path-suggestions"
                aria-autocomplete="list"
              />

              {showPathSuggestions && (
                <div
                  id="repo-open-path-suggestions"
                  className="repo-open-path-suggestions"
                  role="listbox"
                >
                  {pathSuggestionsLoading && pathSuggestions.length === 0 ? (
                    <div className="repo-open-path-suggestions-loading">Loading...</div>
                  ) : pathSuggestions.map((entry, index) => (
                    <button
                      key={entry.path}
                      type="button"
                      role="option"
                      aria-selected={index === highlightedSuggestion}
                      className={`repo-open-path-suggestion${index === highlightedSuggestion ? ' repo-open-path-suggestion-active' : ''}`}
                      onMouseEnter={() => setHighlightedSuggestion(index)}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        completePathSuggestion(entry)
                      }}
                    >
                      <span className="repo-open-path-suggestion-main">
                        <span className="repo-open-path-suggestion-name">{entry.name}</span>
                        <span className="repo-open-path-suggestion-path">{entry.path}</span>
                      </span>
                      {entry.isGitRepo && <span className="repo-open-repo-badge">repo</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="submit" disabled={!path.trim()} className="repo-open-button">
              Open
            </button>
          </form>
        </div>

        <div className="repo-open-body">
          <section className="repo-open-explorer" aria-label="Folder tree">
            <div className="repo-open-explorer-head">
              <button
                type="button"
                className="repo-open-root-nav"
                disabled={!root?.parentPath}
                onClick={() => {
                  if (root?.parentPath) void loadDirectory(root.parentPath, { makeRoot: true })
                }}
                title="Parent folder"
                aria-label="Parent folder"
              >
                ..
              </button>
              <div className="repo-open-root-path">
                {root
                  ? getPathBreadcrumbs(root.path).map((crumb, index, crumbs) => (
                    <span key={crumb.path} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                      {index > 0 && !/^(\/|[A-Za-z]:[\\/])$/.test(crumbs[index - 1].label) && (
                        <span className="repo-open-root-separator">/</span>
                      )}
                      <button
                        type="button"
                        className="repo-open-root-crumb"
                        onClick={() => void loadDirectory(crumb.path, { makeRoot: true })}
                        title={crumb.path}
                      >
                        {crumb.label}
                      </button>
                    </span>
                  ))
                  : 'Loading...'}
              </div>
              {root?.isGitRepo && (
                <button type="button" className="repo-open-root-action" onClick={() => onOpen(root.path)}>
                  Open
                </button>
              )}
            </div>

            <div className="repo-open-tree">
              {rootLoading && (
                <div className="repo-open-tree-empty" style={{ paddingLeft: 16 }}>
                  Loading...
                </div>
              )}
              {rootPath && !rootLoading && renderRows(rootPath, 0)}
            </div>
          </section>

          <aside className="repo-open-side">
            {error && <p className="repo-open-error">{error}</p>}

            {agentGroups.length > 0 && (
              <section className="repo-open-section">
                <div className="repo-open-section-title">Running agent sessions</div>
                <div className="repo-open-list">
                  {agentGroups.map((group) => (
                    <div key={group.cwd} className="repo-open-list-button repo-open-claude-row">
                      <span className="repo-open-list-name repo-open-agent-name">
                        {[...new Set(group.sessions.map((s) => s.agent))].map((agent) => (
                          <AgentIcon
                            key={agent}
                            agent={agent}
                            size={14}
                            busy={group.sessions.some((s) => s.agent === agent && s.busy)}
                          />
                        ))}
                        {getRepoLabel(group.cwd)}
                      </span>
                      <span className="repo-open-list-path">{group.cwd}</span>
                      <span className="repo-open-claude-chips">
                        {group.sessions.map((session) => (
                          <button
                            key={session.pid}
                            type="button"
                            className={`repo-open-claude-chip${session.busy ? ' repo-open-claude-chip-busy' : ''}`}
                            disabled={!session.focusable || focusingPid !== null}
                            title={session.focusable
                              ? `Focus this session's window — ${agentSessionKindLabel(session)} (pid ${session.pid})`
                              : `${agentSessionKindLabel(session)} (pid ${session.pid}) — window focus unavailable for this session`}
                            onClick={() => void focusAgentSession(session)}
                          >
                            {focusingPid === session.pid
                              ? 'focusing…'
                              : `${session.title ?? `${session.agent === 'codex' ? 'codex ' : ''}${agentSessionKindLabel(session)}`}${session.count > 1 ? ` ×${session.count}` : ''}`}
                          </button>
                        ))}
                      </span>
                      <button
                        type="button"
                        className="repo-open-row-action repo-open-claude-open"
                        onClick={() => onOpen(group.cwd)}
                      >
                        Open
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {recentRepos.length > 0 && (
              <section className="repo-open-section">
                <div className="repo-open-section-title">Recent repositories</div>
                <div className="repo-open-list">
                  {recentRepos.map((repoPath) => (
                    <button
                      key={repoPath}
                      type="button"
                      onClick={() => onOpen(repoPath)}
                      className="repo-open-list-button"
                    >
                      <span className="repo-open-list-name">{getRepoLabel(repoPath)}</span>
                      <span className="repo-open-list-path">{repoPath}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {discoveredRepos.length > 0 && (
              <section className="repo-open-section">
                <div className="repo-open-section-title">Repositories</div>
                {discoveredFolder && <div className="repo-open-folder-caption">{discoveredFolder}</div>}
                <div className="repo-open-list">
                  {discoveredRepos.map((repoPath) => (
                    <button
                      key={repoPath}
                      type="button"
                      onClick={() => onOpen(repoPath)}
                      className="repo-open-list-button"
                    >
                      <span className="repo-open-list-name">{getRepoLabel(repoPath)}</span>
                      <span className="repo-open-list-path">{repoPath}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}
