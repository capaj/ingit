import { useEffect, useMemo, useState } from 'react'
import { highlightText } from '@speed-highlight/core'
import type { ShjLanguage } from '@speed-highlight/core'
import type { InProgressOperationKind, WorktreeFile, WorktreeDiffArea } from '@ingit/rpc-contract'
import { useAppStore, worktreeDiffKey } from '../store'
import type { WorktreeDiffEntry } from '../store'
import { RefActionButton } from './graph-canvas/ActionButtons'

const STATUS_COLOR: Record<string, string> = {
  A: '#a6e3a1',
  M: '#f9e2af',
  D: '#f38ba8',
  R: '#cba6f7',
  C: '#94e2d5',
  T: '#89b4fa',
  U: '#fab387',
  '?': '#94e2d5',
}

const STATUS_TITLE: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflicted',
  '?': 'Untracked',
}

// Skip syntax highlighting for gigantic patches — parsing tens of thousands of
// lines through the highlighter would just freeze the panel.
const HIGHLIGHT_MAX_LINES = 50_000

// File extension -> @speed-highlight/core language id.
const EXT_LANG: Record<string, ShjLanguage> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', rs: 'rs', go: 'go', java: 'java', lua: 'lua', pl: 'pl',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c',
  css: 'css', scss: 'css', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  json: 'json', md: 'md', markdown: 'md',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', dockerfile: 'docker', makefile: 'make',
}

function languageForPath(path: string): ShjLanguage {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'dockerfile') return 'docker'
  if (base === 'makefile') return 'make'
  const ext = base.slice(base.lastIndexOf('.') + 1)
  return EXT_LANG[ext] ?? 'plain'
}

// Colors for @speed-highlight token classes, matching the app's palette.
const SYNTAX_CSS = `
.wt-diff .shj-syn-cmnt { color: #6c7086; font-style: italic; }
.wt-diff .shj-syn-kwd { color: #cba6f7; }
.wt-diff .shj-syn-num { color: #fab387; }
.wt-diff .shj-syn-bool { color: #fab387; }
.wt-diff .shj-syn-str { color: #a6e3a1; }
.wt-diff .shj-syn-func { color: #89b4fa; }
.wt-diff .shj-syn-class { color: #f9e2af; }
.wt-diff .shj-syn-section { color: #94e2d5; }
.wt-diff .shj-syn-oper { color: #94e2d5; }
.wt-diff .shj-syn-var { color: #cdd6f4; }
.wt-diff .shj-syn-esc { color: #f5c2e7; }
.wt-diff .shj-syn-err { color: #f38ba8; }
`

type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx'

interface DiffLine {
  kind: DiffLineKind
  /** Line content without the leading +/-/space marker. */
  content: string
  marker: string
}

// Turn a raw git patch into displayable lines: drop the per-file header
// (diff --git / index / --- / +++ / mode lines), keep hunks and content.
function parsePatch(patchText: string): DiffLine[] {
  const out: DiffLine[] = []
  let inHunk = false
  for (const line of patchText.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      out.push({ kind: 'hunk', content: line, marker: '' })
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) out.push({ kind: 'add', content: line.slice(1), marker: '+' })
    else if (line.startsWith('-')) out.push({ kind: 'del', content: line.slice(1), marker: '-' })
    else if (line.startsWith(' ') || line === '') out.push({ kind: 'ctx', content: line.slice(1), marker: ' ' })
    else if (line.startsWith('\\')) out.push({ kind: 'ctx', content: line, marker: '' })
  }
  return out
}

const LINE_BG: Record<DiffLineKind, string> = {
  add: '#a6e3a114',
  del: '#f38ba814',
  hunk: 'transparent',
  ctx: 'transparent',
}

const MARKER_COLOR: Record<DiffLineKind, string> = {
  add: '#a6e3a1',
  del: '#f38ba8',
  hunk: '#89b4fa',
  ctx: '#45475a',
}

function DiffView({ entry, path }: { entry: WorktreeDiffEntry; path: string }) {
  const lines = useMemo(
    () => (entry.patchText ? parsePatch(entry.patchText) : []),
    [entry.patchText],
  )
  const lang = useMemo(() => languageForPath(path), [path])
  const shouldHighlight = lang !== 'plain' && lines.length <= HIGHLIGHT_MAX_LINES
  // Highlighted HTML per line (index-aligned with `lines`), null until ready.
  const [highlighted, setHighlighted] = useState<(string | null)[] | null>(null)

  useEffect(() => {
    setHighlighted(null)
    if (!shouldHighlight || lines.length === 0) return
    let cancelled = false
    Promise.all(
      lines.map((l) =>
        l.kind === 'hunk' || l.content.length === 0
          ? Promise.resolve(null)
          : highlightText(l.content, lang, false).catch(() => null),
      ),
    ).then((html) => {
      if (!cancelled) setHighlighted(html)
    })
    return () => { cancelled = true }
  }, [lines, lang, shouldHighlight])

  if (entry.loading) {
    return <DiffNote text="Loading diff…" />
  }
  if (entry.error) {
    return <DiffNote text={entry.error} color="#f38ba8" />
  }
  if (entry.isBinary) {
    return <DiffNote text="Binary file" />
  }
  if (lines.length === 0) {
    return <DiffNote text="No textual changes" />
  }

  return (
    <div
      className="wt-diff"
      style={{
        margin: '2px 0 6px 24px',
        border: '1px solid #313244',
        borderRadius: 6,
        background: '#11111b',
        overflow: 'auto',
        maxHeight: 420,
        fontSize: 11,
        fontFamily: 'monospace',
        lineHeight: 1.5,
      }}
    >
      <style>{SYNTAX_CSS}</style>
      <div style={{ minWidth: 'fit-content' }}>
        {lines.map((line, i) => {
          const html = highlighted?.[i] ?? null
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                background: LINE_BG[line.kind],
                color: line.kind === 'hunk' ? '#89b4fa' : '#cdd6f4',
                whiteSpace: 'pre',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 16,
                  textAlign: 'center',
                  color: MARKER_COLOR[line.kind],
                  userSelect: 'none',
                }}
              >
                {line.marker}
              </span>
              {html !== null ? (
                <span dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <span>{line.content}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DiffNote({ text, color }: { text: string; color?: string }) {
  return (
    <div
      style={{
        margin: '2px 0 6px 24px',
        padding: '6px 10px',
        fontSize: 11,
        color: color ?? '#6c7086',
        border: '1px solid #313244',
        borderRadius: 6,
        background: '#11111b',
      }}
    >
      {text}
    </div>
  )
}

function FileRow({
  file,
  area,
  actionLabel,
  onAction,
}: {
  file: WorktreeFile
  area: WorktreeDiffArea
  actionLabel: string
  onAction: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const loadWorktreeFileDiff = useAppStore((s) => s.loadWorktreeFileDiff)
  const diffEntry = useAppStore((s) => s.worktreeFileDiffs[worktreeDiffKey(area, file.path)])

  const slash = file.path.lastIndexOf('/')
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path
  const color = STATUS_COLOR[file.status] ?? '#cdd6f4'

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next) void loadWorktreeFileDiff(file, area)
  }

  // The cache is cleared whenever the worktree changes; re-fetch an expanded
  // diff so it doesn't get stuck on a stale/empty entry.
  useEffect(() => {
    if (expanded && !diffEntry) void loadWorktreeFileDiff(file, area)
  }, [expanded, diffEntry, file, area, loadWorktreeFileDiff])

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 6px',
          borderRadius: 6,
          cursor: 'pointer',
        }}
        onClick={toggle}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#1e1e2e' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      >
        <span
          style={{
            flexShrink: 0,
            width: 10,
            fontSize: 9,
            color: '#6c7086',
            userSelect: 'none',
          }}
        >
          {expanded ? '▼' : '▶'}
        </span>
        <span
          title={STATUS_TITLE[file.status] ?? file.status}
          style={{
            flexShrink: 0,
            width: 16,
            height: 16,
            borderRadius: 3,
            background: color + '22',
            color,
            fontSize: 10,
            fontWeight: 700,
            fontFamily: 'monospace',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {file.status}
        </span>
        <span
          title={file.path}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            fontFamily: 'monospace',
            direction: 'rtl',
            textAlign: 'left',
          }}
        >
          <span style={{ color: '#6c7086' }}>{dir}</span>
          <span style={{ color: '#cdd6f4' }}>{base}</span>
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <RefActionButton label={actionLabel} tone="neutral" size="compact" variant="ghost" onClick={onAction} />
        </span>
      </div>
      {expanded && diffEntry && <DiffView entry={diffEntry} path={file.path} />}
    </div>
  )
}

function Section({
  title,
  files,
  area,
  bulkLabel,
  onBulk,
  rowActionLabel,
  onRowAction,
}: {
  title: string
  files: WorktreeFile[]
  area: WorktreeDiffArea
  bulkLabel: string
  onBulk: () => void
  rowActionLabel: string
  onRowAction: (file: WorktreeFile) => void
}) {
  if (files.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px 4px' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#a6adc8' }}>
          {title} <span style={{ color: '#6c7086' }}>({files.length})</span>
        </span>
        <RefActionButton label={bulkLabel} tone="neutral" size="compact" variant="ghost" onClick={onBulk} />
      </div>
      {files.map((file) => (
        <FileRow
          key={`${file.status}:${file.path}`}
          file={file}
          area={area}
          actionLabel={rowActionLabel}
          onAction={() => onRowAction(file)}
        />
      ))}
    </div>
  )
}

function CommitBox({ stagedCount }: { stagedCount: number }) {
  const performCommit = useAppStore((s) => s.performCommit)
  const pendingMutation = useAppStore((s) => s.pendingMutation)
  const [message, setMessage] = useState('')
  const [noVerify, setNoVerify] = useState(() => {
    try { return localStorage.getItem('commitNoVerify') === 'true' } catch { return false }
  })

  const toggleNoVerify = (value: boolean) => {
    try { localStorage.setItem('commitNoVerify', String(value)) } catch { /* ignore */ }
    setNoVerify(value)
  }

  const canCommit = stagedCount > 0 && message.trim().length > 0 && !pendingMutation

  const submit = async () => {
    if (!canCommit) return
    const ok = await performCommit(message.trim(), noVerify)
    if (ok) setMessage('')
  }

  return (
    <div style={{ borderTop: '1px solid #313244', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={stagedCount > 0 ? 'Commit message' : 'Stage files to commit'}
        rows={3}
        style={{
          resize: 'vertical',
          minHeight: 54,
          background: '#11111b',
          border: '1px solid #313244',
          borderRadius: 6,
          color: '#cdd6f4',
          fontSize: 12,
          fontFamily: 'inherit',
          padding: '8px 10px',
          outline: 'none',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = '#89b4fa' }}
        onBlur={(e) => { e.currentTarget.style.borderColor = '#313244' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <label
          title="Commit with --no-verify (skips pre-commit and commit-msg hooks)"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#a6adc8', cursor: 'pointer', userSelect: 'none' }}
        >
          <input
            type="checkbox"
            checked={noVerify}
            onChange={(e) => toggleNoVerify(e.target.checked)}
            style={{ accentColor: '#fab387', cursor: 'pointer' }}
          />
          Skip git hooks
        </label>
        <button
          onClick={() => void submit()}
          disabled={!canCommit}
          style={{
            background: canCommit ? '#a6e3a1' : '#313244',
            color: canCommit ? '#11111b' : '#6c7086',
            border: 'none',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            padding: '6px 14px',
            cursor: canCommit ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >
          {pendingMutation
            ? 'Committing…'
            : `Commit${stagedCount > 0 ? ` (${stagedCount})` : ''}`}
        </button>
      </div>
    </div>
  )
}

function OperationBanner({
  operation,
  conflictedCount,
}: {
  operation: InProgressOperationKind
  conflictedCount: number
}) {
  const abortInProgressOperation = useAppStore((s) => s.abortInProgressOperation)
  const pendingMutation = useAppStore((s) => s.pendingMutation)
  const label = operation === 'rebase' ? 'Rebase' : 'Merge'
  const title = conflictedCount > 0 ? `${label} conflict` : `${label} in progress`
  const detail = conflictedCount > 0
    ? `${conflictedCount} conflicted file${conflictedCount === 1 ? '' : 's'}`
    : 'Git is waiting for this operation to finish.'

  return (
    <div
      style={{
        border: '1px solid #8b3a4a',
        background: '#5c243033',
        borderRadius: 7,
        padding: '10px 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: '#f5a6b8', fontSize: 13, fontWeight: 700 }}>{title}</span>
        <span style={{ color: '#a6adc8', fontSize: 11 }}>{detail}</span>
      </div>
      <RefActionButton
        label={pendingMutation ? 'Aborting…' : `Abort ${label}`}
        tone="danger"
        onClick={() => void abortInProgressOperation(operation)}
        disabled={pendingMutation}
      />
    </div>
  )
}

export function WorkingTreeDetail() {
  const changes = useAppStore((s) => s.worktreeChanges)
  const runStageAction = useAppStore((s) => s.runStageAction)

  const staged = changes?.staged ?? []
  const unstaged = changes?.unstaged ?? []
  const total = staged.length + unstaged.length
  const operation: InProgressOperationKind | null = changes?.mergeHeadShas?.length
    ? 'merge'
    : changes?.rebaseHeadSha
      ? 'rebase'
      : null
  const conflictedCount = useMemo(
    () => new Set(unstaged.filter((file) => file.status === 'U').map((file) => file.path)).size,
    [unstaged],
  )

  return (
    <div
      style={{
        width: 480,
        flexShrink: 0,
        height: '100%',
        borderLeft: '1px solid #313244',
        background: '#181825',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #313244' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#cdd6f4' }}>Working tree</span>
          {changes?.branch && (
            <span style={{ fontSize: 12, color: '#89b4fa', fontFamily: 'monospace' }}>⎇ {changes.branch}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#6c7086', marginTop: 2 }}>
          {total === 0 ? 'No changes' : `${total} changed file${total === 1 ? '' : 's'}`}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {operation && <OperationBanner operation={operation} conflictedCount={conflictedCount} />}
        {total === 0 ? (
          <div style={{ color: '#45475a', fontSize: 13, textAlign: 'center', marginTop: 28 }}>
            Working tree clean
          </div>
        ) : (
          <>
            <Section
              title="Staged"
              files={staged}
              area="staged"
              bulkLabel="Unstage all"
              onBulk={() => runStageAction('unstage-all', [])}
              rowActionLabel="Unstage"
              onRowAction={(file) => runStageAction('unstage', [file.path])}
            />
            <Section
              title="Changes"
              files={unstaged}
              area="unstaged"
              bulkLabel="Stage all"
              onBulk={() => runStageAction('stage-all', [])}
              rowActionLabel="Stage"
              onRowAction={(file) => runStageAction('stage', [file.path])}
            />
          </>
        )}
      </div>

      <CommitBox stagedCount={staged.length} />
    </div>
  )
}
