import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { setRemoteUrl } from '../api'
import { useAppStore } from '../store'
import { redactRemoteCredentials, suggestSshUrl } from '../ssh-remote'

const buttonStyle: CSSProperties = {
  border: '1px solid #45475a', borderRadius: 6, padding: '8px 12px',
  background: '#313244', color: '#cdd6f4', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 13, fontWeight: 600, minHeight: 36,
}

export function SshConversionDialog({ onOpenSettings }: { onOpenSettings: () => void }) {
  const remote = useAppStore((state) => state.sshConversionRemote)
  const repoId = useAppStore((state) => state.repoId)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dismiss = () => useAppStore.setState({ sshConversionRemote: null })

  useEffect(() => {
    setUrl(remote ? suggestSshUrl(remote.url) : '')
    setError(null)
    setBusy(false)
    if (remote && repoId) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [remote, repoId])

  const convert = async () => {
    if (!remote || !repoId || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await setRemoteUrl(repoId, remote.name, remote.url, url.trim())
      if (useAppStore.getState().repoId === repoId && useAppStore.getState().sshConversionRemote === remote) {
        useAppStore.setState({ remotes: result.remotes, sshConversionRemote: null })
      }
    } catch (err) {
      if (useAppStore.getState().sshConversionRemote === remote) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (useAppStore.getState().sshConversionRemote === remote) setBusy(false)
    }
  }

  return (
    <dialog ref={dialogRef} className="ingit-ssh-dialog" aria-labelledby="ssh-conversion-title" aria-describedby="ssh-conversion-description" onCancel={(event) => {
      event.preventDefault()
      if (!busy) dismiss()
    }} style={{
      position: 'fixed', inset: 0, margin: 'auto', boxSizing: 'border-box',
      width: 'min(460px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
      overflowY: 'auto', border: '1px solid #45475a', borderRadius: 12, padding: 0,
      background: '#1e1e2e', color: '#cdd6f4', boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 13, lineHeight: 1.6,
    }}>
      <style>{`
        .ingit-ssh-dialog::backdrop { background: rgba(10, 10, 18, 0.72); backdrop-filter: blur(2px); }
        .ingit-ssh-dialog input:focus-visible { outline: 2px solid #89b4fa; outline-offset: 2px; }
        .ingit-ssh-dialog button:focus-visible { outline: 2px solid #89b4fa; outline-offset: 3px; }
        .ingit-ssh-dialog button:disabled { opacity: 0.5; cursor: default !important; }
        .ingit-ssh-dialog button:not(:disabled):hover { filter: brightness(1.12); }
      `}</style>
      <div style={{ padding: 24 }}>
        <h2 id="ssh-conversion-title" style={{ margin: '0 0 10px', fontSize: 18, lineHeight: 1.35, color: '#f5e0dc' }}>Use SSH for this repository?</h2>
        <p id="ssh-conversion-description" style={{ margin: 0, color: '#a6adc8' }}>
          Your default remote, <strong style={{ color: '#cdd6f4' }}>{remote?.name}</strong>, uses HTTPS.
          Switch to SSH if you’ve already added your SSH key to your Git host.
        </p>
        <div style={{ marginTop: 20, padding: '10px 12px', border: '1px solid #313244', borderRadius: 6, background: '#181825' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#a6adc8', marginBottom: 4 }}>Current HTTPS URL</div>
          <div style={{ overflowWrap: 'anywhere', fontSize: 12, fontFamily: 'monospace', color: '#bac2de' }}>{remote && redactRemoteCredentials(remote.url)}</div>
        </div>
        <form id="ssh-conversion-form" onSubmit={(event) => { event.preventDefault(); void convert() }} style={{ marginTop: 18 }}>
          <label style={{ display: 'grid', gap: 8, fontSize: 12, fontWeight: 600 }}>
            SSH URL
            <input autoFocus required value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} spellCheck={false} aria-describedby="ssh-conversion-url-help" style={{ width: '100%', boxSizing: 'border-box', minWidth: 0, padding: '10px 12px', fontFamily: 'monospace', fontSize: 13, fontWeight: 400, border: '1px solid #585b70', borderRadius: 6, background: '#11111b', color: '#cdd6f4' }} />
          </label>
          <p id="ssh-conversion-url-help" style={{ margin: '10px 0 0', fontSize: 12, color: '#a6adc8' }}>Check the address for your host. Any separate push URL will be preserved.</p>
          {error && <p role="alert" style={{ margin: '14px 0 0', padding: '10px 12px', borderRadius: 6, background: '#f38ba810', color: '#f38ba8', overflowWrap: 'anywhere' }}>{error}</p>}
        </form>
        <p style={{ margin: '18px 0 0', fontSize: 12, color: '#a6adc8' }}>Manage this prompt in <button type="button" disabled={busy} onClick={() => { dismiss(); onOpenSettings() }} style={{ border: 0, padding: 0, background: 'none', color: '#89b4fa', textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer', font: 'inherit' }}>Options → Remotes</button>.</p>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, padding: '16px 24px', borderTop: '1px solid #313244', background: '#181825' }}>
        <button type="button" disabled={busy} onClick={dismiss} style={buttonStyle}>Keep HTTPS</button>
        <button type="submit" form="ssh-conversion-form" disabled={busy || !url.trim()} style={{ ...buttonStyle, borderColor: '#89b4fa', background: '#89b4fa', color: '#11111b' }}>{busy ? 'Converting…' : 'Convert to SSH'}</button>
      </div>
    </dialog>
  )
}
