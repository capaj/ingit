import type { CommitDetailResponse, CommitDiffResponse, ChangedPath } from '@ingit/rpc-contract'

interface PRInfo {
  number: number
  title: string
  url: string
  state: string
  mergedAt: string | null
}

interface CommitDetailProps {
  commit: CommitDetailResponse | null
  diff: CommitDiffResponse | null
  branchName?: string | null
  prs?: PRInfo[]
  githubUrl?: string | null
  onCheckout?: (sha: string) => void
  onNavigate?: (sha: string) => void
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

export function CommitDetail({ commit, diff, branchName, prs, githubUrl, onCheckout, onNavigate }: CommitDetailProps) {
  if (!commit) {
    return (
      <div
        style={{
          width: 400,
          flexShrink: 0,
          height: '100%',
          background: '#181825',
          borderLeft: '1px solid #313244',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#45475a',
          fontSize: 13,
        }}
      >
        Select a commit
      </div>
    )
  }

  const shortSha = commit.sha.slice(0, 12)

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

        <MetaRow label="Author" value={`${commit.authorName} <${commit.authorEmail}>`} />
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
          <div style={{ marginTop: 6, marginBottom: 4 }}>
            {prs.map(pr => (
              <a
                key={pr.number}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: pr.mergedAt ? '#a6e3a120' : '#89b4fa20',
                  border: `1px solid ${pr.mergedAt ? '#a6e3a160' : '#89b4fa60'}`,
                  color: pr.mergedAt ? '#a6e3a1' : '#89b4fa',
                  fontSize: 11,
                  fontWeight: 600,
                  textDecoration: 'none',
                  marginRight: 4,
                }}
              >
                PR #{pr.number}: {pr.title.length > 40 ? pr.title.slice(0, 40) + '…' : pr.title}
              </a>
            ))}
          </div>
        )}

        {/* GitHub commit link */}
        {githubUrl && (
          <div style={{ marginTop: 4, marginBottom: 4 }}>
            <a
              href={`${githubUrl}/commit/${commit.sha}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: '#6c7086', textDecoration: 'underline' }}
            >
              View on GitHub
            </a>
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
      <div style={{ flex: 1, overflowY: 'auto' }}>
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
              <FileRow key={i} cp={cp} />
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
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 3, fontSize: 12 }}>
      <span style={{ color: '#6c7086', minWidth: 76, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: '#a6adc8',
          fontFamily: mono ? 'monospace' : 'inherit',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  )
}

function FileRow({ cp }: { cp: ChangedPath }) {
  const color = STATUS_COLOR[cp.status] ?? '#cdd6f4'
  const label = STATUS_LABEL[cp.status] ?? cp.status
  const displayPath = cp.oldPath ? `${cp.oldPath} → ${cp.path}` : cp.path

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 16px',
        fontSize: 12,
        color: '#cdd6f4',
        borderBottom: '1px solid #1e1e2e',
      }}
    >
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
