import { useCallback, useEffect, useState } from 'react'
import type { AgentSession, FocusCapabilities } from '@ingit/rpc-contract'
import { listAgentSessions, focusAgentSession, installWindowCalls } from './api'
import { useAppStore } from './store'

const POLL_INTERVAL_MS = 5_000

export interface DedupedAgentSession extends AgentSession {
  count: number
}

/**
 * IDE sessions of one agent in the same workspace all resolve to the same
 * window (focused via the workspace folder), so collapse them into one row
 * with a count.
 */
export function dedupeAgentSessions(sessions: AgentSession[]): DedupedAgentSession[] {
  const deduped: DedupedAgentSession[] = []
  const ideGroups = new Map<string, DedupedAgentSession>()
  for (const s of sessions) {
    if (s.kind !== 'ide') {
      deduped.push({ ...s, count: 1 })
      continue
    }
    const key = `${s.agent}\0${s.ide}\0${s.cwd}`
    const existing = ideGroups.get(key)
    if (existing) existing.count += 1
    else {
      const group = { ...s, count: 1 }
      ideGroups.set(key, group)
      deduped.push(group)
    }
  }
  return deduped
}

export interface AgentSessionGroup {
  cwd: string
  sessions: DedupedAgentSession[]
}

/**
 * One group per directory, preserving the incoming session order. `getKey`
 * picks the grouping directory (defaults to cwd; pass the git root to merge
 * sessions running in subdirectories of the same repo).
 */
export function groupAgentSessionsByCwd(
  sessions: AgentSession[],
  getKey: (s: AgentSession) => string = (s) => s.cwd,
): AgentSessionGroup[] {
  const groups = new Map<string, AgentSessionGroup>()
  for (const session of dedupeAgentSessions(sessions)) {
    const key = getKey(session)
    let group = groups.get(key)
    if (!group) {
      group = { cwd: key, sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  return [...groups.values()]
}

export function agentSessionKindLabel(session: AgentSession): string {
  if (session.kind === 'ide') return session.ide ?? 'ide'
  if (session.kind === 'terminal') return session.tty?.replace('/dev/', '') ?? 'terminal'
  return 'background'
}

export function useAgentSessions() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [capabilities, setCapabilities] = useState<FocusCapabilities | null>(null)
  const [focusingPid, setFocusingPid] = useState<number | null>(null)
  const [installing, setInstalling] = useState(false)
  const showError = useAppStore((s) => s.showError)

  const refresh = useCallback(async () => {
    const res = await listAgentSessions()
    setSessions(res.sessions)
    setCapabilities(res.capabilities)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      listAgentSessions()
        .then((res: { sessions: AgentSession[]; capabilities: FocusCapabilities }) => {
          if (cancelled) return
          setSessions(res.sessions)
          setCapabilities(res.capabilities)
        })
        .catch(() => {}) // transient (e.g. dev-server restart) — keep last list
    }
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const focus = useCallback(async (session: AgentSession): Promise<boolean> => {
    setFocusingPid(session.pid)
    try {
      const res = await focusAgentSession(session.pid, session.cwd)
      if (!res.ok) {
        showError('Could not focus agent session', res.error ?? 'Unknown error')
        return false
      }
      return true
    } catch (err) {
      showError('Could not focus agent session', err)
      return false
    } finally {
      setFocusingPid(null)
    }
  }, [showError])

  const install = useCallback(async () => {
    setInstalling(true)
    try {
      const res = await installWindowCalls()
      if (!res.ok) {
        showError('Extension install failed', res.error ?? 'Unknown error')
        return
      }
      // Re-list so terminal sessions flip to focusable right away.
      await refresh().catch(() => {})
    } catch (err) {
      showError('Extension install failed', err)
    } finally {
      setInstalling(false)
    }
  }, [refresh, showError])

  const canInstallWindowCalls =
    capabilities?.canInstallWindowCalls === true
    && !capabilities.canFocusTerminals
    && sessions.some((s) => s.kind === 'terminal')

  return { sessions, capabilities, focusingPid, installing, focus, install, canInstallWindowCalls }
}
