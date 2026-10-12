import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentName } from '@ingit/rpc-contract'
import { getAppSettings, getInstalledCommitMessageAgents, setCommitMessageAgent } from '../api'

function useCommitMessagePreference(suggestInstalledAgent = false) {
  const [agent, setAgent] = useState<AgentName | null | undefined>(undefined)
  const [suggestedAgent, setSuggestedAgent] = useState<AgentName | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setError(null)
    setAgent(undefined)
    setSuggestedAgent(null)
    getAppSettings().then(async (settings) => {
      if (suggestInstalledAgent && settings.commitMessageAgent === null) {
        // A suggestion still requires explicit confirmation. Detection failures,
        // neither installed, or both installed leave the choice empty.
        const agents = await getInstalledCommitMessageAgents().catch(() => [])
        if (!active) return
        setSuggestedAgent(agents.length === 1 ? agents[0]! : null)
      }
      if (active) setAgent(settings.commitMessageAgent)
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load commit message settings')
    })
    return () => { active = false }
  }, [attempt, suggestInstalledAgent])

  const save = async (value: AgentName) => {
    setSaving(true)
    setError(null)
    try {
      const settings = await setCommitMessageAgent(value)
      setAgent(settings.commitMessageAgent)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save commit message settings')
    } finally {
      setSaving(false)
    }
  }

  return { agent, suggestedAgent, error, saving, save, retry: () => setAttempt((value) => value + 1) }
}

function AgentChoice({
  initialAgent, saving, onSave, firstRun = false,
}: {
  initialAgent: AgentName | null
  saving: boolean
  onSave: (agent: AgentName) => Promise<void>
  firstRun?: boolean
}) {
  const [choice, setChoice] = useState(initialAgent)
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (choice && !saving) void onSave(choice) }}>
      <fieldset disabled={saving} style={{ padding: 0, margin: '0 0 18px', border: 'none' }}>
        <legend style={{ marginBottom: 14, color: '#a6adc8', fontSize: 13 }}>
          Which CLI should generate your commit messages?
        </legend>
        {(['claude', 'codex'] as const).map((agent) => (
          <label key={agent} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 10px', marginBottom: 8, border: `1px solid ${choice === agent ? '#89b4fa' : '#45475a'}`, borderRadius: 6, background: '#181825', cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" name="commit-message-agent" value={agent} checked={choice === agent} onChange={() => setChoice(agent)} style={{ accentColor: '#89b4fa' }} />
            {agent === 'claude' ? 'Claude Code' : 'Codex CLI'}
          </label>
        ))}
      </fieldset>
      <p style={{ color: '#7f849c', fontSize: 12, lineHeight: 1.6 }}>
        The selected CLI must be installed and signed in on this machine. It inspects staged changes,
        or all changed files when nothing is staged, and fills in a message for you to review.
      </p>
      <button type="submit" disabled={!choice || saving} style={{ padding: '8px 14px', border: 'none', borderRadius: 6, background: choice && !saving ? '#a6e3a1' : '#313244', color: choice && !saving ? '#11111b' : '#6c7086', fontFamily: 'inherit', fontWeight: 700, cursor: choice && !saving ? 'pointer' : 'default' }}>
        {saving ? 'Saving…' : firstRun ? 'Save and continue' : 'Save preference'}
      </button>
    </form>
  )
}

function PreferenceError({ error, retry }: { error: string | null; retry?: () => void }) {
  if (!error) return null
  return <div style={{ marginTop: 14, fontSize: 12 }}>
    <p role="alert" style={{ color: '#f38ba8' }}>{error}</p>
    {retry && <button type="button" onClick={retry}>Retry</button>}
  </div>
}

/** Gate the application until this server machine has a persisted choice. */
export function CommitMessageSetup({ children }: { children: ReactNode }) {
  const { agent, suggestedAgent, error, saving, save, retry } = useCommitMessagePreference(true)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const ready = agent === 'claude' || agent === 'codex'
  useEffect(() => {
    const dialog = dialogRef.current
    if (!ready && dialog && !dialog.open) dialog.showModal()
  }, [ready])

  if (ready) return children
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="commit-message-setup-title"
      onCancel={(event) => event.preventDefault()}
      onClose={() => { if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal() }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() } }}
      style={{ width: 'min(440px, calc(100vw - 32px))', padding: 24, margin: 'auto', border: '1px solid #45475a', borderRadius: 8, background: '#1e1e2e', color: '#cdd6f4', fontFamily: 'system-ui, sans-serif' }}
    >
      <style>{`dialog[aria-labelledby="commit-message-setup-title"]::backdrop { background: #10101ae6; }`}</style>
      <h1 id="commit-message-setup-title" style={{ margin: '0 0 12px', fontSize: 18 }}>Choose your commit message agent</h1>
      <p style={{ color: '#a6adc8', fontSize: 13, lineHeight: 1.6 }}>Choose once for this machine. You can change it later in Settings → Commit messages.</p>
      {agent === undefined
        ? !error && <p role="status">Loading preferences…</p>
        : <AgentChoice initialAgent={suggestedAgent} saving={saving} onSave={save} firstRun />}
      <PreferenceError error={error} retry={agent === undefined ? retry : undefined} />
    </dialog>
  )
}

export function CommitMessageSettings() {
  const { agent, error, saving, save, retry } = useCommitMessagePreference()
  return <div style={{ padding: 18, maxWidth: 580 }}>
    <h2 style={{ margin: '0 0 16px', fontSize: 16 }}>Commit messages</h2>
    <p style={{ color: '#a6adc8', fontSize: 12, lineHeight: 1.6 }}>Used when you click Commit with an empty message. Your preference applies across repositories on this machine.</p>
    {agent === undefined
      ? !error && <p role="status">Loading preferences…</p>
      : <AgentChoice initialAgent={agent} saving={saving} onSave={save} />}
    <PreferenceError error={error} retry={agent === undefined ? retry : undefined} />
  </div>
}
