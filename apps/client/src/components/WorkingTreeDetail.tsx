import { useEffect, useMemo, useRef, useState } from 'react'
import type { InProgressOperationKind, WorktreeFile, WorktreeDiffArea } from '@ingit/rpc-contract'
import { useAppStore, worktreeDiffKey } from '../store'
import { getCommitDetail } from '../api'
import { RefActionButton } from './graph-canvas/ActionButtons'
import { DiffView } from './DiffView'

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
  rowActionLabel: string | ((file: WorktreeFile) => string)
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
          actionLabel={typeof rowActionLabel === 'function' ? rowActionLabel(file) : rowActionLabel}
          onAction={() => onRowAction(file)}
        />
      ))}
    </div>
  )
}

function CommitBox({
  stagedCount,
  headSha,
  branch,
  amendable,
}: {
  stagedCount: number
  headSha?: string
  branch?: string
  amendable: boolean
}) {
  const performCommit = useAppStore((s) => s.performCommit)
  const performRefAction = useAppStore((s) => s.performRefAction)
  const runStageAction = useAppStore((s) => s.runStageAction)
  const showError = useAppStore((s) => s.showError)
  const pendingMutation = useAppStore((s) => s.pendingMutation)
  const repoId = useAppStore((s) => s.repoId)
  const [message, setMessage] = useState('')
  const [noVerify, setNoVerify] = useState(() => {
    try { return localStorage.getItem('commitNoVerify') === 'true' } catch { return false }
  })
  const [amend, setAmend] = useState(false)
  const [amendStaging, setAmendStaging] = useState(false)
  const [submitAction, setSubmitAction] = useState<'commit' | 'commit-and-push'>(() => {
    try {
      return localStorage.getItem('commitSubmitAction') === 'commit-and-push'
        ? 'commit-and-push'
        : 'commit'
    } catch {
      return 'commit'
    }
  })
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [pushingAfterCommit, setPushingAfterCommit] = useState(false)
  const actionControlRef = useRef<HTMLDivElement>(null)
  // The previous message we auto-filled, so unchecking Amend can clear it back
  // out without discarding text the user typed themselves.
  const [prefilled, setPrefilled] = useState('')

  // An in-progress merge/rebase (or no HEAD yet) can't be amended.
  const amending = amend && amendable

  useEffect(() => {
    if (!actionMenuOpen) return

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!actionControlRef.current?.contains(event.target as Node)) setActionMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [actionMenuOpen])

  const toggleNoVerify = (value: boolean) => {
    try { localStorage.setItem('commitNoVerify', String(value)) } catch { /* ignore */ }
    setNoVerify(value)
  }

  const toggleAmend = async (value: boolean) => {
    setAmend(value)
    if (value) {
      setAmendStaging(true)
      const staged = await runStageAction('stage-all', [])
      setAmendStaging(false)
      if (!staged) {
        setAmend(false)
        return
      }

      // Prefill with the previous commit's full message so the user edits it in
      // place instead of retyping. Skip if they've already written something.
      if (message.trim().length === 0 && repoId && headSha) {
        try {
          const detail = await getCommitDetail(repoId, headSha)
          const full = detail.body ? `${detail.subject}\n\n${detail.body}` : detail.subject
          setMessage((cur) => (cur.trim().length === 0 ? full : cur))
          setPrefilled(full)
        } catch { /* ignore — the user can type the message */ }
      }
    } else if (message === prefilled) {
      setMessage('')
      setPrefilled('')
    }
  }

  const canCommit = stagedCount > 0
    && message.trim().length > 0
    && !amendStaging
    && !pendingMutation
  const canSubmit = canCommit && (submitAction === 'commit' || !!branch)

  const chooseSubmitAction = (action: 'commit' | 'commit-and-push') => {
    try { localStorage.setItem('commitSubmitAction', action) } catch { /* ignore */ }
    setSubmitAction(action)
    setActionMenuOpen(false)
  }

  const submit = async () => {
    if (!canSubmit) return
    const ok = await performCommit(message.trim(), noVerify, amending)
    if (!ok) return

    setMessage('')
    setPrefilled('')
    setAmend(false)
    if (submitAction !== 'commit-and-push' || !branch) return

    const committedState = useAppStore.getState()
    const currentRef = committedState.refs.find((ref) => ref.kind === 'head' && ref.isCurrent)
    const refName = currentRef?.shortName ?? branch
    const sha = currentRef?.targetSha ?? committedState.worktreeChanges?.headSha ?? headSha
    if (!sha) {
      showError('Push failed', 'Could not determine the committed revision to push')
      return
    }

    setPushingAfterCommit(true)
    try {
      await performRefAction('push', refName, sha)
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'CONFLICT') {
        showError('Push rejected', err, {
          label: 'Force push',
          run: () => {
            performRefAction('push', refName, sha, true)
              .catch((forceErr) => showError('Force push failed', forceErr))
          },
        })
      } else {
        showError('Push failed', err)
      }
    } finally {
      setPushingAfterCommit(false)
    }
  }

  const buttonLabel = amendStaging
    ? 'Staging…'
    : pushingAfterCommit
    ? 'Pushing…'
    : pendingMutation
    ? (amending ? 'Amending…' : 'Committing…')
    : `${amending ? 'Amend' : 'Commit'}${submitAction === 'commit-and-push' ? ' & push' : ''}${stagedCount > 0 ? ` (${stagedCount})` : ''}`

  return (
    <div style={{ borderBottom: '1px solid #313244', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={amending ? 'Amend commit message' : stagedCount > 0 ? 'Commit message' : 'Stage files to commit'}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          {amendable && (
            <label
              title="Replace the previous commit (git commit --amend) instead of creating a new one"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#a6adc8', cursor: 'pointer', userSelect: 'none' }}
            >
              <input
                type="checkbox"
                checked={amend}
                disabled={amendStaging}
                onChange={(e) => void toggleAmend(e.target.checked)}
                style={{ accentColor: '#cba6f7', cursor: amendStaging ? 'default' : 'pointer' }}
              />
              Amend
            </label>
          )}
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
        </div>
        <div
          ref={actionControlRef}
          style={{
            display: 'flex',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            title={submitAction === 'commit-and-push' && !branch ? 'Check out a branch before committing and pushing' : undefined}
            style={{
              background: canSubmit ? '#a6e3a1' : '#313244',
              color: canSubmit ? '#11111b' : '#6c7086',
              border: 'none',
              borderRadius: '6px 0 0 6px',
              fontSize: 12,
              fontWeight: 700,
              padding: '6px 12px 6px 14px',
              cursor: canSubmit ? 'pointer' : 'default',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            {buttonLabel}
          </button>
          <button
            type="button"
            aria-label="Choose commit action"
            aria-haspopup="menu"
            aria-expanded={actionMenuOpen}
            disabled={amendStaging || pendingMutation || pushingAfterCommit}
            onClick={() => setActionMenuOpen((open) => !open)}
            style={{
              width: 28,
              background: canCommit ? '#a6e3a1' : '#313244',
              color: canCommit ? '#11111b' : '#6c7086',
              border: 'none',
              borderLeft: `1px solid ${canCommit ? '#11111b33' : '#45475a'}`,
              borderRadius: '0 6px 6px 0',
              cursor: amendStaging || pendingMutation || pushingAfterCommit ? 'default' : 'pointer',
              fontFamily: 'inherit',
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            ▼
          </button>
          {actionMenuOpen && (
            <div
              role="menu"
              aria-label="Commit action"
              style={{
                position: 'absolute',
                right: 0,
                bottom: 'calc(100% + 6px)',
                zIndex: 50,
                minWidth: 154,
                padding: 4,
                border: '1px solid #45475a',
                borderRadius: 7,
                background: '#1e1e2e',
                boxShadow: '0 8px 24px #00000066',
              }}
            >
              {([
                ['commit', 'Commit'],
                ['commit-and-push', 'Commit & push'],
              ] as const).map(([action, label]) => (
                <button
                  key={action}
                  type="button"
                  role="menuitemradio"
                  aria-checked={submitAction === action}
                  onClick={() => chooseSubmitAction(action)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 9px',
                    border: 'none',
                    borderRadius: 5,
                    background: submitAction === action ? '#313244' : 'transparent',
                    color: '#cdd6f4',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 12,
                    textAlign: 'left',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ width: 12, color: '#a6e3a1' }}>{submitAction === action ? '✓' : ''}</span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
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
  const continueInProgressOperation = useAppStore((s) => s.continueInProgressOperation)
  const pendingMutation = useAppStore((s) => s.pendingMutation)
  const label = operation === 'rebase' ? 'Rebase' : 'Merge'
  const title = conflictedCount > 0 ? `${label} conflict` : `${label} in progress`
  const detail = conflictedCount > 0
    ? `${conflictedCount} conflicted file${conflictedCount === 1 ? '' : 's'} — resolve and stage them, then continue`
    : `All conflicts resolved — continue the ${operation} to finish.`
  const canContinue = !pendingMutation && conflictedCount === 0

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span title={canContinue ? undefined : conflictedCount > 0 ? 'Stage all conflicted files first' : undefined}>
          <RefActionButton
            label={pendingMutation ? 'Working…' : `Continue ${label}`}
            tone="success"
            onClick={() => void continueInProgressOperation(operation)}
            disabled={!canContinue}
          />
        </span>
        <RefActionButton
          label={pendingMutation ? 'Aborting…' : `Abort ${label}`}
          tone="danger"
          onClick={() => void abortInProgressOperation(operation)}
          disabled={pendingMutation}
        />
      </div>
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

      <CommitBox
        stagedCount={staged.length}
        headSha={changes?.headSha}
        branch={changes?.branch}
        amendable={!operation && !!changes?.headSha}
      />

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
              rowActionLabel={(file) => (file.status === 'U' ? 'Mark resolved' : 'Stage')}
              onRowAction={(file) => runStageAction('stage', [file.path])}
            />
          </>
        )}
      </div>
    </div>
  )
}
