import type { WorktreeFile } from '@ingit/rpc-contract'
import { useAppStore } from '../store'
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

function FileRow({
  file,
  actionLabel,
  onAction,
}: {
  file: WorktreeFile
  actionLabel: string
  onAction: () => void
}) {
  const slash = file.path.lastIndexOf('/')
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path
  const color = STATUS_COLOR[file.status] ?? '#cdd6f4'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 6px',
        borderRadius: 6,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#1e1e2e' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
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
      <RefActionButton label={actionLabel} tone="neutral" size="compact" variant="ghost" onClick={onAction} />
    </div>
  )
}

function Section({
  title,
  files,
  bulkLabel,
  onBulk,
  rowActionLabel,
  onRowAction,
}: {
  title: string
  files: WorktreeFile[]
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
          actionLabel={rowActionLabel}
          onAction={() => onRowAction(file)}
        />
      ))}
    </div>
  )
}

export function WorkingTreeDetail() {
  const changes = useAppStore((s) => s.worktreeChanges)
  const runStageAction = useAppStore((s) => s.runStageAction)

  const staged = changes?.staged ?? []
  const unstaged = changes?.unstaged ?? []
  const total = staged.length + unstaged.length

  return (
    <div
      style={{
        width: 400,
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
        {total === 0 ? (
          <div style={{ color: '#45475a', fontSize: 13, textAlign: 'center', marginTop: 28 }}>
            Working tree clean
          </div>
        ) : (
          <>
            <Section
              title="Staged"
              files={staged}
              bulkLabel="Unstage all"
              onBulk={() => runStageAction('unstage-all', [])}
              rowActionLabel="Unstage"
              onRowAction={(file) => runStageAction('unstage', [file.path])}
            />
            <Section
              title="Changes"
              files={unstaged}
              bulkLabel="Stage all"
              onBulk={() => runStageAction('stage-all', [])}
              rowActionLabel="Stage"
              onRowAction={(file) => runStageAction('stage', [file.path])}
            />
          </>
        )}
      </div>
    </div>
  )
}
