import { useEffect, useState } from 'react'

export interface ErrorDialogState {
  title: string
  message: string
}

interface ErrorDialogProps {
  error: ErrorDialogState | null
  onDismiss: () => void
}

export function ErrorDialog({ error, onDismiss }: ErrorDialogProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!error) return
    setCopied(false)
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [error, onDismiss])

  if (!error) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(error.message)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore clipboard failures — nothing actionable
    }
  }

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17, 17, 27, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="error-dialog-title"
        style={{
          background: '#1e1e2e',
          border: '1px solid #45475a',
          borderRadius: 8,
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5)',
          maxWidth: 760,
          width: '100%',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid #313244',
          background: '#181825',
        }}>
          <span id="error-dialog-title" style={{ fontSize: 14, fontWeight: 600, color: '#f38ba8' }}>
            {error.title}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#6c7086',
              fontSize: 20,
              lineHeight: 1,
              cursor: 'pointer',
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        <pre style={{
          margin: 0,
          padding: '16px 18px',
          overflow: 'auto',
          flex: 1,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12.5,
          lineHeight: 1.5,
          color: '#cdd6f4',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
        }}>
          {error.message}
        </pre>

        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '12px 18px',
          borderTop: '1px solid #313244',
          background: '#181825',
        }}>
          <button
            type="button"
            onClick={handleCopy}
            style={{
              background: '#313244',
              color: '#cdd6f4',
              border: '1px solid #45475a',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            style={{
              background: '#89b4fa',
              color: '#1e1e2e',
              border: 'none',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
