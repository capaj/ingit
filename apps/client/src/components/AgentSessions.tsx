import { useEffect, useRef, useState } from 'react'
import type { AgentSession } from '@ingit/rpc-contract'
import { useAppStore } from '../store'
import {
  useAgentSessions,
  dedupeAgentSessions,
  agentSessionKindLabel,
} from '../useAgentSessions'
import { AgentIcon } from './AgentIcon'

function dirName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function pillLabel(sessions: AgentSession[]): string {
  const agents = new Set(sessions.map((s) => s.agent))
  const base = agents.size > 1
    ? `Agents ×${sessions.length}`
    : `${sessions[0]!.agent[0]!.toUpperCase()}${sessions[0]!.agent.slice(1)} ×${sessions.length}`
  const working = sessions.filter((s) => s.busy).length
  return working > 0 ? `${base} · ${working} working` : base
}

export function AgentSessions() {
  const { sessions, capabilities, focusingPid, installing, focus, install, canInstallWindowCalls } =
    useAgentSessions()
  const [open, setOpen] = useState(false)
  // Sessions outside the open repo hide behind a collapse until requested.
  // Remembered across dropdown reopens and page reloads.
  const [showAll, setShowAllState] = useState(() => {
    try { return localStorage.getItem('agentSessionsShowAll') === 'true' } catch { return false }
  })
  const setShowAll = (value: boolean) => {
    try { localStorage.setItem('agentSessionsShowAll', String(value)) } catch {}
    setShowAllState(value)
  }
  // Viewport anchor for the dropdown. The header bar clips overflow, so the
  // menu renders position:fixed and needs the pill's rect to attach to.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const repoPath = useAppStore((s) => s.repoPath)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close the dropdown on any outside click.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const handleFocus = async (session: AgentSession) => {
    if (await focus(session)) setOpen(false)
  }

  if (sessions.length === 0) return null

  const deduped = dedupeAgentSessions(sessions)

  // Sessions working in the currently open repo (including its subdirectories).
  const inThisRepo = repoPath
    ? deduped.filter((s) => s.gitRoot === repoPath || s.cwd === repoPath)
    : []
  const elsewhere = deduped.filter((s) => !inThisRepo.includes(s))
  // With no repo open there's nothing to scope to — show everything.
  const visible = repoPath === null || showAll ? [...inThisRepo, ...elsewhere] : inThisRepo
  const hiddenCount = repoPath !== null && !showAll ? elsewhere.length : 0

  const handlePillClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    setOpen((v) => !v)
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={handlePillClick}
        title={`${sessions.length} agent session${sessions.length === 1 ? '' : 's'} running`}
        aria-label="Agent sessions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 10px',
          borderRadius: 4,
          border: `1px solid ${inThisRepo.length > 0 ? '#a6e3a155' : '#313244'}`,
          background: inThisRepo.length > 0 ? '#a6e3a115' : 'transparent',
          color: inThisRepo.length > 0 ? '#a6e3a1' : '#6c7086',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        {[...new Set(sessions.map((s) => s.agent))].map((agent) => (
          <AgentIcon
            key={agent}
            agent={agent}
            size={12}
            busy={sessions.some((s) => s.agent === agent && s.busy)}
          />
        ))}
        {pillLabel(sessions)}
      </button>

      {open && anchor && (
        <div
          style={{
            position: 'fixed',
            top: anchor.top,
            right: anchor.right,
            minWidth: 280,
            maxWidth: 400,
            maxHeight: 320,
            overflowY: 'auto',
            background: '#181825',
            border: '1px solid #313244',
            borderRadius: 6,
            boxShadow: '0 8px 24px #00000088',
            zIndex: 100,
            padding: 4,
          }}
        >
          {canInstallWindowCalls && (
            <div style={{ padding: '8px 8px 10px', borderBottom: '1px solid #313244', marginBottom: 4 }}>
              <div style={{ color: '#a6adc8', fontSize: 11, marginBottom: 6, lineHeight: 1.4 }}>
                Focusing terminal windows needs the “Window Calls” GNOME&nbsp;Shell extension.
              </div>
              <button
                onClick={() => void install()}
                disabled={installing}
                style={{
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: '1px solid #89b4fa55',
                  background: '#89b4fa20',
                  color: installing ? '#45475a' : '#89b4fa',
                  fontSize: 11,
                  cursor: installing ? 'default' : 'pointer',
                }}
              >
                {installing ? 'Waiting for GNOME confirmation…' : 'Install extension'}
              </button>
            </div>
          )}
          {visible.length === 0 && (
            <div style={{ padding: '8px', color: '#585b70', fontSize: 11 }}>
              No agents running in this repository
            </div>
          )}
          {visible.map((session) => {
            const current = repoPath !== null && session.cwd === repoPath
            const disabled = !session.focusable
            return (
              <button
                key={session.pid}
                onClick={() => !disabled && void handleFocus(session)}
                disabled={disabled || focusingPid !== null}
                title={
                  disabled
                    ? session.kind === 'terminal'
                      ? capabilities?.displayServer === 'wayland'
                        ? "Can't focus terminal windows on Wayland — install the 'Window Calls' GNOME Shell extension"
                        : "Can't focus terminal windows — install wmctrl"
                      : 'This session has no window to focus'
                    : `${session.cwd} · ${agentSessionKindLabel(session)} (pid ${session.pid})`
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 8px',
                  border: 'none',
                  borderRadius: 4,
                  background: 'transparent',
                  color: disabled ? '#45475a' : '#a6adc8',
                  fontSize: 11,
                  textAlign: 'left',
                  cursor: disabled ? 'default' : 'pointer',
                  opacity: focusingPid !== null && focusingPid !== session.pid ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = '#31324466' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ flexShrink: 0, display: 'inline-flex', opacity: disabled ? 0.4 : 1 }}>
                  <AgentIcon agent={session.agent} size={13} busy={session.busy ?? false} />
                </span>
                <span style={{ flexShrink: 0, fontFamily: 'monospace' }}>
                  {dirName(session.cwd)}{session.count > 1 ? ` ×${session.count}` : ''}
                </span>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    color: '#7f849c',
                    textAlign: 'right',
                  }}
                >
                  {session.title ?? agentSessionKindLabel(session)}
                </span>
                {session.busy && (
                  <span style={{ flexShrink: 0, color: '#f9e2af', fontSize: 10 }}>working</span>
                )}
                {current && (
                  <span style={{ flexShrink: 0, color: '#a6e3a1', fontSize: 10 }}>this repo</span>
                )}
                {focusingPid === session.pid && (
                  <span style={{ flexShrink: 0, color: '#89b4fa', fontSize: 10 }}>focusing…</span>
                )}
              </button>
            )
          })}
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 8px',
                marginTop: visible.length > 0 ? 2 : 0,
                border: 'none',
                borderTop: visible.length > 0 ? '1px solid #313244' : 'none',
                background: 'transparent',
                color: '#6c7086',
                fontSize: 11,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              ▸ Show {hiddenCount} agent{hiddenCount === 1 ? '' : 's'} in other repositories
            </button>
          )}
          {repoPath !== null && showAll && elsewhere.length > 0 && (
            <button
              onClick={() => setShowAll(false)}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 8px',
                border: 'none',
                borderTop: '1px solid #313244',
                background: 'transparent',
                color: '#6c7086',
                fontSize: 11,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              ▾ Hide agents in other repositories
            </button>
          )}
        </div>
      )}
    </div>
  )
}
