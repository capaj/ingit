const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8488
const PORT_SEARCH_ATTEMPTS = 20
const PROBE_TIMEOUT_MS = 500

function connectHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '::1'
  return host
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function serverUrl(host = DEFAULT_HOST, port = DEFAULT_PORT): string {
  return `http://${hostForUrl(connectHost(host))}:${port}`
}

export function repositoryUrl(baseUrl: string, repoPath: string): string {
  return `${baseUrl}/#/repository?path=${encodeURIComponent(repoPath)}`
}

async function isIngitServer(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/__ingit/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return false

    const body = await response.text()
    if (response.headers.get('content-type')?.includes('application/json')) {
      const data = JSON.parse(body) as { name?: unknown }
      return data.name === 'ingit'
    }

    // Older ingit versions serve the SPA for unknown paths. Its injected
    // session marker lets a newly-upgraded CLI reuse that running instance.
    return body.includes('window.__INGIT_SESSION_TOKEN__')
  } catch {
    return false
  }
}

export async function findRunningIngit(
  host = DEFAULT_HOST,
  startPort = DEFAULT_PORT,
): Promise<string | null> {
  const candidates = Array.from(
    { length: PORT_SEARCH_ATTEMPTS + 1 },
    (_, offset) => serverUrl(host, startPort + offset),
  )
  const matches = await Promise.all(candidates.map(isIngitServer))
  return candidates[matches.findIndex(Boolean)] ?? null
}
