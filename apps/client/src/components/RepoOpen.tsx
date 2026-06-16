import { useState, type FormEvent } from 'react'

interface RepoOpenProps {
  onOpen: (path: string) => void
  error?: string | null
  recentRepos: string[]
  discoveredFolder?: string | null
  discoveredRepos?: string[]
}

function getRepoLabel(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function RepoOpen({ onOpen, error, recentRepos, discoveredFolder, discoveredRepos = [] }: RepoOpenProps) {
  const [path, setPath] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = path.trim()
    if (trimmed) onOpen(trimmed)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        width: '100%',
        background: '#1e1e2e',
      }}
    >
      <div
        style={{
          background: '#313244',
          borderRadius: 12,
          padding: '40px 48px',
          minWidth: 420,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: '#cdd6f4',
            letterSpacing: '-0.02em',
          }}
        >
          Open repository
        </h1>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ fontSize: 13, color: '#a6adc8' }}>
            Repository path
          </label>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/user/my-project"
            autoFocus
            style={{
              background: '#1e1e2e',
              border: '1px solid #45475a',
              borderRadius: 6,
              color: '#cdd6f4',
              fontSize: 14,
              padding: '9px 12px',
              outline: 'none',
              fontFamily: 'inherit',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = '#89b4fa'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = '#45475a'
            }}
          />

          {error && (
            <p style={{ fontSize: 13, color: '#f38ba8', margin: 0 }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={!path.trim()}
            style={{
              marginTop: 4,
              background: '#89b4fa',
              color: '#1e1e2e',
              border: 'none',
              borderRadius: 6,
              padding: '9px 0',
              fontSize: 14,
              fontWeight: 600,
              cursor: path.trim() ? 'pointer' : 'not-allowed',
              opacity: path.trim() ? 1 : 0.5,
              fontFamily: 'inherit',
              transition: 'opacity 0.15s',
            }}
          >
            Open
          </button>
        </form>

        {recentRepos.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#a6adc8' }}>Recent repositories</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
              {recentRepos.map((repoPath) => (
                <button
                  key={repoPath}
                  type="button"
                  onClick={() => onOpen(repoPath)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    background: '#1e1e2e',
                    border: '1px solid #45475a',
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: '#cdd6f4',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{getRepoLabel(repoPath)}</span>
                  <span style={{ fontSize: 12, color: '#a6adc8', fontFamily: 'monospace' }}>{repoPath}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {discoveredRepos.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#a6adc8' }}>
              Repositories in <span style={{ fontFamily: 'monospace', color: '#cdd6f4' }}>{discoveredFolder}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
              {discoveredRepos.map((repoPath) => (
                <button
                  key={repoPath}
                  type="button"
                  onClick={() => onOpen(repoPath)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    background: '#1e1e2e',
                    border: '1px solid #45475a',
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: '#cdd6f4',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{getRepoLabel(repoPath)}</span>
                  <span style={{ fontSize: 12, color: '#a6adc8', fontFamily: 'monospace' }}>{repoPath}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
