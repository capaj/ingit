interface RepositoryObserver {
  getVersion: () => Promise<string>
  reload: () => Promise<boolean>
  canReload: () => boolean
  intervalMs?: number
}

/** Serial checks: unchanged refs never trigger history/status Git commands. */
export function observeRepository({ getVersion, reload, canReload, intervalMs = 2_000 }: RepositoryObserver): () => void {
  let stopped = false
  let version: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const check = async () => {
    try {
      if (!canReload()) return
      const next = await getVersion()
      if (stopped || !canReload()) return
      // Refresh on the first check too, covering commits made during opening.
      // Only acknowledge a version after a successful refresh; mutations and
      // temporary failures must not swallow an external change.
      if (next !== version && await reload()) version = next
    } catch {
      // A restarted server may have lost the session. The normal reload path
      // reopens it, and subsequent checks use the new session.
      if (!stopped && canReload()) await reload().catch(() => false)
    } finally {
      if (!stopped) timer = setTimeout(check, intervalMs)
    }
  }

  void check()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
