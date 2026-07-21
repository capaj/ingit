import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { CommitDetailResponse, CommitDiffResponse, ChangedPath } from '@ingit/rpc-contract'
import { commitFileDiffKey, useAppStore } from '../store'
import { DiffView } from './DiffView'

interface PRInfo {
  number: number
  title: string
  url: string
  state: string
  mergedAt: string | null
}

type CIRunState = 'success' | 'pending' | 'failure' | 'error' | 'neutral'
type CIStatusState = CIRunState | 'none' | 'loading'

interface CIRun {
  name: string
  description?: string
  state: CIRunState
  url?: string
}

interface CommitDetailProps {
  commit: CommitDetailResponse | null
  diff: CommitDiffResponse | null
  branchName?: string | null
  prs?: PRInfo[]
  authorAvatarUrl?: string | null
  ciState?: CIStatusState
  ciRuns?: CIRun[]
  githubUrl?: string | null
  onCheckout?: (sha: string) => void
  onNavigate?: (sha: string) => void
}

const CI_STATE_COLOR: Record<CIRunState, string> = {
  success: '#a6e3a1',
  failure: '#f38ba8',
  error: '#f38ba8',
  pending: '#f9e2af',
  neutral: '#6c7086',
}

const CI_STATE_ICON: Record<CIRunState, string> = {
  success: '✓',
  failure: '✗',
  error: '✗',
  pending: '◔',
  neutral: '–',
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

const STATUS_LABEL: Record<string, string> = {
  A: 'A',
  M: 'M',
  D: 'D',
  R: 'R',
  C: 'C',
  T: 'T',
  U: 'U',
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

export function CommitDetail({ commit, diff, branchName, prs, authorAvatarUrl, ciState, ciRuns, githubUrl, onCheckout, onNavigate }: CommitDetailProps) {
  if (!commit) {
    return null
  }

  const shortSha = commit.sha.slice(0, 12)

  return (
    <div
      data-testid="commit-detail"
      style={{
        position: 'absolute',
        right: 0,
        bottom: 0,
        zIndex: 40,
        width: 400,
        height: 'fit-content',
        maxHeight: '100%',
        background: '#181825',
        borderLeft: '1px solid #313244',
        borderTop: '1px solid #313244',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 16px 12px',
          borderBottom: '1px solid #313244',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#89b4fa', letterSpacing: '0.04em' }}>
            {shortSha}
          </span>
          {onNavigate && (
            <SmallButton label="Navigate to" onClick={() => onNavigate(commit.sha)} />
          )}
          {onCheckout && (
            <SmallButton label="Checkout" onClick={() => onCheckout(commit.sha)} />
          )}
        </div>
        <p
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: '#cdd6f4',
            lineHeight: 1.4,
            margin: 0,
            marginBottom: 10,
          }}
        >
          {commit.subject}
        </p>

        <MetaRow
          label="Author"
          value={`${commit.authorName} <${commit.authorEmail}>`}
          leading={<AuthorAvatar name={commit.authorName} url={authorAvatarUrl} />}
        />
        <MetaRow label="Date" value={formatDate(commit.authorUnix)} />
        {branchName && <MetaRow label="Branch" value={branchName} />}
        {(commit.committerName !== commit.authorName ||
          commit.committerUnix !== commit.authorUnix) && (
            <>
              <MetaRow label="Committer" value={`${commit.committerName} <${commit.committerEmail}>`} />
              <MetaRow label="Commit date" value={formatDate(commit.committerUnix)} />
            </>
          )}
        {commit.parents.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 3, fontSize: 12 }}>
            <span style={{ color: '#6c7086', minWidth: 76, flexShrink: 0 }}>Parents</span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {commit.parents.map((p) => (
                <span
                  key={p}
                  onClick={() => onNavigate?.(p)}
                  style={{
                    fontFamily: 'monospace',
                    color: '#89b4fa',
                    cursor: onNavigate ? 'pointer' : 'default',
                    textDecoration: onNavigate ? 'underline' : 'none',
                  }}
                >
                  {p.slice(0, 8)}
                </span>
              ))}
            </span>
          </div>
        )}

        {/* Merge info */}
        {commit.parents.length > 1 && (
          <div style={{ fontSize: 12, color: '#a6adc8', marginBottom: 3 }}>
            <span style={{ color: '#6c7086' }}>Merge: </span>
            merged into{' '}
            <span
              onClick={() => onNavigate?.(commit.parents[0])}
              style={{ color: '#89b4fa', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'monospace' }}
            >{commit.parents[0].slice(0, 8)}</span>
            {' '}from{' '}
            <span
              onClick={() => onNavigate?.(commit.parents[1])}
              style={{ color: '#a6e3a1', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'monospace' }}
            >{commit.parents[1].slice(0, 8)}</span>
          </div>
        )}

        {/* PR links */}
        {prs && prs.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 6, marginBottom: 4 }}>
            <span style={{ color: '#6c7086', fontSize: 12, marginRight: 4 }}>
              {prs.length === 1 ? 'Pull request' : 'Pull requests'}
            </span>
            {prs.map(pr => (
              <a
                key={pr.number}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open pull request #${pr.number}: ${pr.title}`}
                title={`Open pull request #${pr.number}: ${pr.title}`}
                style={{
                  color: pr.mergedAt ? '#a6e3a1' : '#89b4fa',
                  fontSize: 12,
                  textDecoration: 'underline',
                }}
              >
                PR #{pr.number} ↗{pr.title ? `: ${pr.title.length > 40 ? `${pr.title.slice(0, 40)}…` : pr.title}` : ''}
              </a>
            ))}
          </div>
        )}

        {/* GitHub commit link */}
        {githubUrl && commit.isPushed && (
          <div style={{ marginTop: 4, marginBottom: 4, display: 'flex', gap: 12 }}>
            <a
              href={`${githubUrl}/commit/${commit.sha}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: '#6c7086', textDecoration: 'underline' }}
            >
              View on GitHub
            </a>
            <a
              href={`${githubUrl}/commit/${commit.sha}/checks`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: '#6c7086', textDecoration: 'underline' }}
            >
              CI runs
            </a>
          </div>
        )}

        {/* Per-check CI status */}
        {ciState === 'loading' && (
          <div style={{ marginTop: 8 }}>
            <CILoadingRow />
          </div>
        )}
        {ciRuns && ciRuns.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {ciRuns.map((run, i) => (
              <CIRunRow key={`${run.name}-${i}`} run={run} />
            ))}
          </div>
        )}

        {commit.refs.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {commit.refs.map((r) => (
              <span
                key={r}
                style={{
                  background: '#313244',
                  color: '#89b4fa',
                  fontSize: 11,
                  borderRadius: 4,
                  padding: '2px 6px',
                  fontWeight: 500,
                }}
              >
                {r}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      {commit.body && (
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid #313244',
            flexShrink: 0,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          <pre
            style={{
              fontSize: 12,
              color: '#a6adc8',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {commit.body}
          </pre>
        </div>
      )}

      {/* Changed files */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        {diff && diff.changedPaths.length > 0 ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 16px 4px',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: '#6c7086',
                textTransform: 'uppercase',
                position: 'sticky',
                top: 0,
                background: '#181825',
              }}
            >
              <span>Changed files ({diff.changedPaths.length})</span>
              <span style={{ display: 'flex', gap: 10, fontSize: 10, letterSpacing: '0.04em' }}>
                <span style={{ color: '#a6e3a1' }}>+{diff.additions}</span>
                <span style={{ color: '#f38ba8' }}>-{diff.deletions}</span>
              </span>
            </div>
            {diff.changedPaths.map((cp, i) => (
              <FileRow key={`${cp.status}:${cp.oldPath ?? ''}:${cp.path}:${i}`} sha={commit.sha} cp={cp} />
            ))}
          </>
        ) : diff ? (
          <div
            style={{
              padding: '16px',
              fontSize: 13,
              color: '#45475a',
            }}
          >
            No changed files
          </div>
        ) : null}
      </div>
    </div>
  )
}

function MetaRow({
  label,
  value,
  mono,
  leading,
}: {
  label: string
  value: string
  mono?: boolean
  leading?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: leading ? 'center' : undefined, gap: 8, marginBottom: 3, fontSize: 12 }}>
      <span style={{ color: '#6c7086', minWidth: 76, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          minWidth: 0,
          color: '#a6adc8',
          fontFamily: mono ? 'monospace' : 'inherit',
        }}
      >
        {leading}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
      </span>
    </div>
  )
}

function AuthorAvatar({ name, url }: { name: string; url?: string | null }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [url])

  const sharedStyle: CSSProperties = {
    width: 24,
    height: 24,
    borderRadius: '50%',
    flexShrink: 0,
  }

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={`${name} avatar`}
        width={24}
        height={24}
        onError={() => setFailed(true)}
        style={{ ...sharedStyle, display: 'block', objectFit: 'cover', background: '#313244' }}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      style={{
        ...sharedStyle,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#313244',
        color: '#cdd6f4',
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function FileRow({ sha, cp }: { sha: string; cp: ChangedPath }) {
  const [expanded, setExpanded] = useState(false)
  const loadCommitFileDiff = useAppStore((s) => s.loadCommitFileDiff)
  const diffEntry = useAppStore((s) => s.commitFileDiffs[commitFileDiffKey(sha, cp.path)])
  const color = STATUS_COLOR[cp.status] ?? '#cdd6f4'
  const label = STATUS_LABEL[cp.status] ?? cp.status
  const displayPath = cp.oldPath ? `${cp.oldPath} → ${cp.path}` : cp.path
  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next) void loadCommitFileDiff(sha, cp)
  }

  useEffect(() => {
    if (expanded && !diffEntry) void loadCommitFileDiff(sha, cp)
  }, [expanded, diffEntry, sha, cp, loadCommitFileDiff])

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 16px',
          fontSize: 12,
          color: '#cdd6f4',
          borderBottom: '1px solid #1e1e2e',
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
          style={{
            flexShrink: 0,
            width: 18,
            height: 18,
            borderRadius: 3,
            background: color + '33',
            color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {label}
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'monospace',
            fontSize: 12,
            color: '#a6adc8',
          }}
          title={displayPath}
        >
          {displayPath}
        </span>
      </div>
      {expanded && diffEntry && <DiffView entry={diffEntry} path={cp.path} />}
    </div>
  )
}

function CIRunRow({ run }: { run: CIRun }) {
  const color = CI_STATE_COLOR[run.state]
  const icon = CI_STATE_ICON[run.state]
  const content = (
    <>
      <span style={{ color, fontSize: 12, fontWeight: 700, width: 12, textAlign: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{
        color: '#cdd6f4',
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        maxWidth: '55%',
      }}>
        {run.name}
      </span>
      {run.description && (
        <span style={{
          color: '#6c7086',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}>
          {run.description}
        </span>
      )}
    </>
  )

  const sharedStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    padding: '2px 0',
    textDecoration: 'none',
  }

  if (run.url) {
    return (
      <a href={run.url} target="_blank" rel="noopener noreferrer" style={sharedStyle} title={run.description ?? run.name}>
        {content}
      </a>
    )
  }
  return <div style={sharedStyle} title={run.description ?? run.name}>{content}</div>
}

function CILoadingRow() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        padding: '2px 0',
        color: '#6c7086',
      }}
      title="Loading CI status"
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          border: '2px solid #45475a',
          borderTopColor: '#89b4fa',
          flexShrink: 0,
          animation: 'ci-spin 0.8s linear infinite',
        }}
      />
      <span style={{ color: '#cdd6f4', fontWeight: 500 }}>CI status</span>
      <span>Loading...</span>
      <style>{`@keyframes ci-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function SmallButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        background: '#313244',
        border: '1px solid #45475a',
        borderRadius: 4,
        color: '#cdd6f4',
        fontSize: 11,
        padding: '2px 8px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#45475a' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#313244' }}
    >
      {label}
    </button>
  )
}
