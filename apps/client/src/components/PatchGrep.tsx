import { Fragment, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { WorktreeDiffArea } from '@ingit/rpc-contract'
import { useAppStore } from '../store'
import {
  getCommitDiff, getCommitFileDiff, getStashDiff, getStashFileDiff,
  getWorktreeChanges, getWorktreeFileDiff,
} from '../api'
import {
  loadPatchFiles,
  parsePatchLines,
  patchMatchWindows,
  searchPatches,
  type MatchRange,
  type PatchLineFilter,
  type SearchablePatch,
} from '../patch-search'
import './patch-grep.css'

type PatchScope = 'worktree' | 'staged' | 'unstaged' | 'selection'
type PatchRequest = { key: string; path: string; oldPath?: string; label: string } & (
  | { kind: 'worktree'; area: WorktreeDiffArea }
  | { kind: 'commit' | 'stash'; sha: string }
)
const EMPTY_PATCHES: SearchablePatch[] = []

export function PatchGrep() {
  const {
    repoId, worktreeChanges, selectedSha, selectedStashSha,
  } = useAppStore(useShallow((state) => ({
    repoId: state.repoId,
    worktreeChanges: state.worktreeChanges,
    selectedSha: state.selectedSha,
    selectedStashSha: state.selectedStashSha,
  })))
  const [scope, setScope] = useState<PatchScope>('worktree')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [lineFilter, setLineFilter] = useState<PatchLineFilter>('all')
  const [revision, setRevision] = useState(0)
  const sha = scope === 'selection' ? selectedStashSha ?? selectedSha : null
  const isStash = scope === 'selection' && selectedStashSha !== null
  const changes = scope === 'selection' ? null : worktreeChanges
  // Store updates invalidate a working-tree snapshot; every load reads a fresh
  // file list so changes made outside the app are included when opening it.
  const source = useMemo(
    () => ({ repoId, scope, sha, isStash, changes, revision }),
    [repoId, scope, sha, isStash, changes, revision],
  )
  const [batch, setBatch] = useState<{
    source: typeof source
    patches: SearchablePatch[]
    loading: boolean
    error?: string
  } | null>(null)

  useEffect(() => {
    const { repoId, scope, sha, isStash } = source
    if (!repoId) return
    let cancelled = false
    setBatch({ source, patches: [], loading: true })
    const load = async () => {
      try {
        let requests: PatchRequest[]
        if (scope === 'selection') {
          const diff = sha ? isStash ? await getStashDiff(repoId, sha) : await getCommitDiff(repoId, sha) : null
          requests = sha && diff ? diff.changedPaths.map((file) => ({
            ...file, key: `${sha}:${file.path}`, label: isStash ? 'Stash' : 'Commit',
            kind: isStash ? 'stash' : 'commit', sha,
          })) : []
        } else {
          const currentChanges = await getWorktreeChanges(repoId)
          const areas: WorktreeDiffArea[] = scope === 'worktree' ? ['staged', 'unstaged'] : [scope]
          requests = areas.flatMap((area) => currentChanges[area].map((file) => ({
            ...file, key: `${area}:${file.path}`, label: area === 'staged' ? 'Staged' : 'Unstaged',
            kind: 'worktree' as const, area,
          })))
        }
        if (cancelled) return
        const patches = await loadPatchFiles(requests, async (file) => {
          const metadata = { key: file.key, path: file.path, label: file.label }
          try {
            const diff = file.kind === 'worktree'
              ? await getWorktreeFileDiff(repoId, file.path, file.area, file.oldPath)
              : file.kind === 'stash'
                ? await getStashFileDiff(repoId, file.sha, file.path, file.oldPath)
                : await getCommitFileDiff(repoId, file.sha, file.path, file.oldPath)
            return { ...metadata, lines: parsePatchLines(diff.patchText), isBinary: diff.isBinary }
          } catch (err) {
            return { ...metadata, lines: [], error: err instanceof Error ? err.message : 'Failed to load patch' }
          }
        }, () => cancelled)
        if (!cancelled) setBatch({ source, patches, loading: false })
      } catch (err) {
        if (!cancelled) setBatch({ source, patches: [], loading: false, error: err instanceof Error ? err.message : 'Failed to load patch' })
      }
    }
    void load()
    return () => { cancelled = true }
  }, [source])

  const currentBatch = batch?.source === source ? batch : null
  const loading = !currentBatch || currentBatch.loading
  const patches = currentBatch?.patches ?? EMPTY_PATCHES
  const results = useMemo(
    () => searchPatches(patches, deferredQuery, { regex, caseSensitive, lineFilter }),
    [patches, deferredQuery, regex, caseSensitive, lineFilter],
  )
  const failures = patches.filter((patch) => patch.error)
  const binaryCount = patches.filter((patch) => patch.isBinary).length
  const selectionLabel = selectedStashSha
    ? `Selected stash (${selectedStashSha.slice(0, 8)})`
    : selectedSha ? `Selected commit (${selectedSha.slice(0, 8)})` : 'Selected commit or stash'

  return (
    <section className="patch-grep" aria-label="Patch grep">
      <div className="patch-grep-toolbar">
        <div className="patch-grep-heading">
          <div>
            <h1>Patch grep</h1>
            <p>Search patch lines across files, with surrounding context.</p>
          </div>
          <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading}>Refresh patch</button>
        </div>
        <div className="patch-grep-search-row">
          <input
            type="search"
            aria-label="Search patch"
            placeholder={regex ? 'Regular expression…' : 'Search the current patch…'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-invalid={!!results.error}
            aria-describedby={results.error ? 'patch-grep-error' : undefined}
            autoFocus
          />
          <select aria-label="Patch source" value={scope} onChange={(event) => setScope(event.target.value as PatchScope)}>
            <option value="worktree">Current changes</option>
            <option value="staged">Staged changes</option>
            <option value="unstaged">Unstaged changes</option>
            <option value="selection" disabled={!selectedSha && !selectedStashSha}>{selectionLabel}</option>
          </select>
        </div>
        <div className="patch-grep-options">
          <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Match case</label>
          <label title="JavaScript regular expression syntax"><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} /> Regex</label>
          <select aria-label="Patch lines to search" value={lineFilter} onChange={(event) => setLineFilter(event.target.value as PatchLineFilter)}>
            <option value="all">All patch lines</option>
            <option value="changed">Changed lines</option>
            <option value="added">Added lines</option>
            <option value="removed">Removed lines</option>
          </select>
          <span role="status" aria-live="polite">
            {loading ? 'Loading patch…' : currentBatch?.error ? 'Patch unavailable' : query !== deferredQuery ? 'Searching…' : deferredQuery && !results.error
              ? results.matchingLines === 0 ? '0 matching lines — showing full patch'
                : `${results.matchingLines} matching ${results.matchingLines === 1 ? 'line' : 'lines'} in ${results.matchingFiles} ${results.matchingFiles === 1 ? 'file patch' : 'file patches'}`
              : `${patches.length - failures.length} file ${patches.length - failures.length === 1 ? 'patch' : 'patches'} loaded`}
          </span>
        </div>
        {results.error && <p id="patch-grep-error" className="patch-grep-error" role="alert">{results.error}</p>}
        {binaryCount > 0 && <p className="patch-grep-note">{binaryCount} binary {binaryCount === 1 ? 'file' : 'files'}: only patch headers can be searched.</p>}
      </div>

      <div className="patch-grep-results">
        {currentBatch?.error && <p className="patch-grep-error" role="alert">{currentBatch.error}. Use Refresh patch to retry.</p>}
        {failures.length > 0 && (
          <div className="patch-grep-load-errors" role="alert">
            <p>Some patches could not be loaded. Use Refresh patch to retry.</p>
            {failures.map((patch) => <p key={patch.key}>{patch.path} ({patch.label}): {patch.error}</p>)}
          </div>
        )}
        {loading ? <p className="patch-grep-empty">Loading the current patch…</p>
          : results.error || currentBatch?.error ? null
          : patches.length === 0 ? <p className="patch-grep-empty">{scope === 'selection' && !selectedSha && !selectedStashSha
            ? 'Select a commit or stash in History to search its patch.' : 'No changes in this patch.'}</p>
          : !deferredQuery || results.matchingLines === 0 ? patches.filter((patch) => !patch.error).map((patch) => (
            <PatchFile key={patch.key} patch={patch} />
          ))
          : results.files.map(({ patch, matches, matchingLines }) => (
            <PatchFile key={patch.key} patch={patch} matches={matches} matchingLines={matchingLines} />
          ))}
        {results.truncated && <p className="patch-grep-note">Showing the first 500 matching lines. Narrow your search to see more specific results.</p>}
      </div>
    </section>
  )
}

function PatchFile({ patch, matches = [], matchingLines }: {
  patch: SearchablePatch
  matches?: ReturnType<typeof searchPatches>['files'][number]['matches']
  matchingLines?: number
}) {
  const fullPatch = matchingLines === undefined
  const rangesByLine = new Map(matches.map((match) => [match.index, match.ranges]))
  const windows = fullPatch
    ? [{ start: 0, end: patch.lines.length }]
    : patchMatchWindows(patch.lines.length, matches)
  return (
    <article className="patch-grep-file" aria-label={`${patch.path} (${patch.label})`}>
      <div className="patch-grep-file-heading">
        <strong>{patch.path}</strong>
        <span className="patch-grep-badge">{patch.label}</span>
        <span>{fullPatch ? `${patch.lines.length} patch lines` : `${matchingLines} matching ${matchingLines === 1 ? 'line' : 'lines'}`}</span>
      </div>
      <div className="patch-grep-code" aria-label={`${fullPatch ? 'Full patch' : 'Patch excerpts'}; old and new line numbers`}>
        {windows.map((window, windowIndex) => (
          <Fragment key={window.start}>
            {windowIndex > 0 && <div className="patch-grep-gap">···</div>}
            {patch.lines.slice(window.start, window.end).map((line, offset) => {
              const index = window.start + offset
              const ranges = rangesByLine.get(index)
              return (
                <div key={index} className={`patch-grep-line patch-grep-${line.kind}${ranges ? ' patch-grep-match' : ''}`}>
                  <span className="patch-grep-line-number" title="Old line">{line.oldLine ?? ''}</span>
                  <span className="patch-grep-line-number" title="New line">{line.newLine ?? ''}</span>
                  <code>{ranges ? <HighlightedLine text={line.text} ranges={ranges} /> : line.text}</code>
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
    </article>
  )
}

function HighlightedLine({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  const parts: ReactNode[] = []
  let cursor = 0
  for (const [index, range] of ranges.entries()) {
    parts.push(text.slice(cursor, range.start))
    parts.push(<mark key={index}>{text.slice(range.start, range.end) || '\u200b'}</mark>)
    cursor = range.end
  }
  parts.push(text.slice(cursor))
  return <>{parts}</>
}
