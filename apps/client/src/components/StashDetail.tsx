import { useEffect, useState } from 'react'
import type { ChangedPath, StashDiffResponse, StashSummary } from '@ingit/rpc-contract'
import { stashFileDiffKey, useAppStore } from '../store'
import { DiffView } from './DiffView'

interface StashDetailProps {
  stash: StashSummary
  diff: StashDiffResponse | null
  busy: boolean
  onApply: (stashSha: string) => Promise<boolean>
  onDrop: (stashSha: string) => Promise<boolean>
  onNavigate: (sha: string) => void
}

const STATUS_COLOR: Record<string, string> = {
  A: '#a6e3a1',
  M: '#f9e2af',
  D: '#f38ba8',
  R: '#cba6f7',
  C: '#94e2d5',
  T: '#89b4fa',
  U: '#fab387',
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function StashDetail({ stash, diff, busy, onApply, onDrop, onNavigate }: StashDetailProps) {
  const [applying, setApplying] = useState(false)
  const [dropping, setDropping] = useState(false)

  const apply = async () => {
    if (busy) return
    setApplying(true)
    try {
      await onApply(stash.sha)
    } finally {
      setApplying(false)
    }
  }

  const drop = async () => {
    if (busy) return
    const confirmed = window.confirm(
      `Drop ${stash.selector}? This permanently deletes the stashed changes.`,
    )
    if (!confirmed) return
    setDropping(true)
    try {
      await onDrop(stash.sha)
    } finally {
      setDropping(false)
    }
  }

  return (
    <div
      style={{
        width: 400,
        flexShrink: 0,
        height: '100%',
        background: '#181825',
        borderLeft: '1px solid #313244',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #313244', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 4,
              background: '#55323c',
              color: '#f5c2e7',
              fontFamily: 'monospace',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {stash.selector}
          </span>
          <span style={{ color: '#6c7086', fontFamily: 'monospace', fontSize: 10 }}>
            {stash.sha.slice(0, 10)}
          </span>
        </div>

        <p style={{ margin: '0 0 11px', color: '#cdd6f4', fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>
          {stash.message || 'Stashed changes'}
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 3, fontSize: 12 }}>
          <span style={{ minWidth: 58, color: '#6c7086' }}>Created</span>
          <span style={{ color: '#a6adc8' }}>{formatDate(stash.createdAt)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12 }}>
          <span style={{ minWidth: 58, color: '#6c7086' }}>Parent</span>
          <button
            type="button"
            onClick={() => onNavigate(stash.parentSha)}
            title={`Navigate to ${stash.parentSha}`}
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              color: '#89b4fa',
              fontFamily: 'monospace',
              fontSize: 11,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              cursor: 'pointer',
            }}
          >
            {stash.parentSha.slice(0, 12)}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy}
            style={{
              padding: '5px 11px',
              border: '1px solid #b87b89',
              borderRadius: 4,
              background: busy ? '#55323c' : '#f5c2e7',
              color: busy ? '#a77b86' : '#311f25',
              fontSize: 11,
              fontWeight: 750,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {applying ? 'Applying…' : 'Apply stash'}
          </button>
          <button
            type="button"
            onClick={() => void drop()}
            disabled={busy}
            style={{
              padding: '5px 11px',
              border: '1px solid #f38ba866',
              borderRadius: 4,
              background: '#311f25',
              color: busy ? '#8b626c' : '#f38ba8',
              fontSize: 11,
              fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {dropping ? 'Dropping…' : 'Drop stash'}
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {diff ? (
          diff.changedPaths.length > 0 ? (
            <>
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 16px 4px',
                  background: '#181825',
                  color: '#6c7086',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  zIndex: 1,
                }}
              >
                <span>Stashed files ({diff.changedPaths.length})</span>
                <span style={{ display: 'flex', gap: 10, fontSize: 10, letterSpacing: '0.04em' }}>
                  <span style={{ color: '#a6e3a1' }}>+{diff.additions}</span>
                  <span style={{ color: '#f38ba8' }}>-{diff.deletions}</span>
                </span>
              </div>
              {diff.changedPaths.map((file, index) => (
                <StashFileRow
                  key={`${file.status}:${file.oldPath ?? ''}:${file.path}:${index}`}
                  stashSha={stash.sha}
                  file={file}
                />
              ))}
            </>
          ) : (
            <div style={{ padding: 16, color: '#6c7086', fontSize: 13 }}>No changed files</div>
          )
        ) : (
          <div style={{ padding: 16, color: '#6c7086', fontSize: 12 }}>Loading stashed files…</div>
        )}
      </div>
    </div>
  )
}

function StashFileRow({ stashSha, file }: { stashSha: string; file: ChangedPath }) {
  const [expanded, setExpanded] = useState(false)
  const loadStashFileDiff = useAppStore((state) => state.loadStashFileDiff)
  const diffEntry = useAppStore((state) => state.stashFileDiffs[stashFileDiffKey(stashSha, file.path)])
  const displayPath = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  const color = STATUS_COLOR[file.status] ?? '#cdd6f4'

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next) void loadStashFileDiff(stashSha, file)
  }

  useEffect(() => {
    if (expanded && !diffEntry) void loadStashFileDiff(stashSha, file)
  }, [expanded, diffEntry, stashSha, file, loadStashFileDiff])

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 16px',
          border: 'none',
          borderBottom: '1px solid #1e1e2e',
          background: 'transparent',
          color: '#cdd6f4',
          fontFamily: 'inherit',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ width: 10, flexShrink: 0, color: '#6c7086', fontSize: 9 }}>
          {expanded ? '▼' : '▶'}
        </span>
        <span
          style={{
            width: 18,
            height: 18,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 3,
            background: `${color}33`,
            color,
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {file.status}
        </span>
        <span
          title={displayPath}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: '#a6adc8',
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          {displayPath}
        </span>
      </button>
      {expanded && diffEntry && <DiffView entry={diffEntry} path={file.path} />}
    </div>
  )
}
