import type { CommitDetailResponse, CommitDiffResponse, ChangedPath } from '@ingit/rpc-contract'

interface CommitDetailProps {
  commit: CommitDetailResponse | null
  diff: CommitDiffResponse | null
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

export function CommitDetail({ commit, diff }: CommitDetailProps) {
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
            fontFamily: 'monospace',
            fontSize: 11,
            color: '#89b4fa',
            marginBottom: 8,
            letterSpacing: '0.04em',
          }}
        >
          {shortSha}
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
        {(commit.committerName !== commit.authorName ||
          commit.committerUnix !== commit.authorUnix) && (
          <>
            <MetaRow label="Committer" value={`${commit.committerName} <${commit.committerEmail}>`} />
            <MetaRow label="Commit date" value={formatDate(commit.committerUnix)} />
          </>
        )}
        {commit.parents.length > 0 && (
          <MetaRow
            label="Parents"
            value={commit.parents.map((p) => p.slice(0, 8)).join(' ')}
            mono
          />
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
              Changed files ({diff.changedPaths.length})
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
