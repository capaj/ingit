import { useEffect, useRef } from 'react'

export interface InstallOutputDialogState {
  path: string
  command: string
  output: string
  running: boolean
  error?: string
}

export function InstallOutputDialog({
  state,
  onClose,
}: {
  state: InstallOutputDialogState | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (state) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [state])

  useEffect(() => {
    const output = outputRef.current
    if (output) output.scrollTop = output.scrollHeight
  }, [state?.output])

  const canClose = !!state && !state.running

  return (
    <>
      <style>{`.ingit-install-output-dialog::backdrop { background: rgba(10, 10, 18, 0.76); backdrop-filter: blur(2px); }`}</style>
      <dialog
        ref={dialogRef}
        className="ingit-install-output-dialog"
        aria-labelledby="install-output-dialog-title"
        onCancel={(event) => {
          if (!canClose) event.preventDefault()
          else onClose()
        }}
        onClose={() => {
          if (canClose) onClose()
        }}
        style={{
          position: 'fixed',
          inset: 0,
          margin: 'auto',
          width: 'min(680px, calc(100vw - 32px))',
          padding: 0,
          border: `1px solid ${state?.error ? '#8b3a4a' : '#45475a'}`,
          borderRadius: 9,
          background: '#1e1e2e',
          color: '#cdd6f4',
          boxShadow: '0 22px 64px rgba(0,0,0,0.62)',
        }}
      >
        {state && (
          <div style={{ display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid #313244' }}>
              <h2 id="install-output-dialog-title" style={{ margin: 0, color: '#f5e0dc', fontSize: 16 }}>
                Resolving {state.path.split('/').at(-1)}
              </h2>
              <div style={{ marginTop: 5, color: '#a6adc8', fontSize: 12 }}>
                {state.command ? `$ ${state.command}` : 'Starting package manager…'}
              </div>
            </div>
            <pre
              ref={outputRef}
              aria-live="polite"
              aria-label="Package manager output"
              style={{
                boxSizing: 'border-box',
                width: '100%',
                minHeight: 240,
                maxHeight: 'min(420px, calc(100vh - 220px))',
                margin: 0,
                padding: 16,
                overflow: 'auto',
                background: '#11111b',
                color: '#cdd6f4',
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {state.output || 'Waiting for output…'}
            </pre>
            <div
              style={{
                minHeight: 54,
                padding: '11px 16px',
                borderTop: '1px solid #313244',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span style={{ color: state.error ? '#f5a6b8' : '#a6e3a1', fontSize: 12, fontWeight: 700 }}>
                {state.running ? '● Install running…' : state.error ?? ''}
              </span>
              {!state.running && (
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    height: 30,
                    padding: '0 12px',
                    borderRadius: 6,
                    border: '1px solid #45475a',
                    background: '#181825',
                    color: '#bac2de',
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        )}
      </dialog>
    </>
  )
}
