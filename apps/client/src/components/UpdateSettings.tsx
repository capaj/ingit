import { useEffect, useState } from 'react'
import { getAppSettings, setAutoUpdate } from '../api'

export function UpdateSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getAppSettings().then((settings) => {
      if (active) setEnabled(settings.autoUpdate)
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load update settings')
    })
    return () => { active = false }
  }, [])

  const save = async (value: boolean) => {
    setSaving(true)
    setError(null)
    try {
      const settings = await setAutoUpdate(value)
      setEnabled(settings.autoUpdate)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save update settings')
    } finally {
      setSaving(false)
    }
  }

  return <div style={{ padding: 18 }}>
    <h2 style={{ margin: '0 0 16px', fontSize: 16 }}>Updates</h2>
    <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={enabled ?? false}
        disabled={enabled === null || saving}
        onChange={(event) => { void save(event.target.checked) }}
        style={{ accentColor: '#89b4fa' }}
      />
      Install updates automatically
    </label>
    <p style={{ color: '#7f849c', fontSize: 12, lineHeight: 1.6, maxWidth: 540 }}>
      When ingit starts, check npm for a newer version and install it using the package manager
      that owns your global installation (npm, pnpm, Yarn Classic, or Bun).
    </p>
    <p style={{ color: '#7f849c', fontSize: 12 }}>
      Turn this off to manage updates yourself. Changes are saved automatically on this machine
      and take effect the next time you start ingit.
    </p>
    <div role="status" style={{ color: '#a6adc8', fontSize: 12 }}>
      {saving ? 'Saving…' : enabled === null && !error ? 'Loading…' : ''}
    </div>
    {error && <p role="alert" style={{ color: '#f38ba8', fontSize: 12 }}>{error}</p>}
  </div>
}
