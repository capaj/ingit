import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { setRemoteUrl } from '../api'
import { useAppStore } from '../store'
import { redactRemoteCredentials, suggestSshUrl } from '../ssh-remote'

const buttonStyle: CSSProperties = {
  border: '1px solid #45475a', borderRadius: 6, padding: '8px 12px',
  background: '#313244', color: '#cdd6f4', cursor: 'pointer', fontFamily: 'inherit',
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
    <dialog ref={dialogRef} aria-labelledby="ssh-conversion-title" onCancel={(event) => {
      event.preventDefault()
      if (!busy) dismiss()
    }} style={{ width: 'min(520px, calc(100vw - 48px))', border: '1px solid #45475a', borderRadius: 9, padding: 24, background: '#1e1e2e', color: '#cdd6f4' }}>
      <h2 id="ssh-conversion-title" style={{ marginTop: 0, fontSize: 18 }}>Use SSH for this repository?</h2>
      <p>Your default remote, <strong>{remote?.name}</strong>, uses HTTPS. You can switch it to SSH if your SSH key is configured with your Git host.</p>
      <p style={{ overflowWrap: 'anywhere', fontSize: 12, color: '#a6adc8' }}>{remote && redactRemoteCredentials(remote.url)}</p>
      <form onSubmit={(event) => { event.preventDefault(); void convert() }}>
        <label style={{ display: 'grid', gap: 8 }}>
          SSH URL
          <input autoFocus required value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} spellCheck={false} style={{ padding: 9, border: '1px solid #45475a', borderRadius: 6, background: '#11111b', color: '#cdd6f4' }} />
        </label>
        <p style={{ fontSize: 12, color: '#a6adc8' }}>Check the address for your host. A separately configured push URL is kept.</p>
        {error && <p role="alert" style={{ color: '#f38ba8' }}>{error}</p>}
        <p style={{ fontSize: 12 }}>You can turn off this prompt in <button type="button" disabled={busy} onClick={() => { dismiss(); onOpenSettings() }} style={{ border: 0, padding: 0, background: 'none', color: '#89b4fa', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Options → Remotes</button>.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" disabled={busy} onClick={dismiss} style={buttonStyle}>Keep HTTPS</button>
          <button type="submit" disabled={busy || !url.trim()} style={{ ...buttonStyle, background: '#89b4fa', color: '#11111b' }}>{busy ? 'Converting…' : 'Convert to SSH'}</button>
        </div>
      </form>
    </dialog>
  )
}
