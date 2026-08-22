const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8449
const PORT_SEARCH_ATTEMPTS = 20
const PROBE_TIMEOUT_MS = 500
const SHUTDOWN_TIMEOUT_MS = 3_000

export interface RunningIngit {
  url: string
  /** Missing on ingit releases from before versioned health checks. */
  version?: string
  /** Missing on ingit releases from before versioned health checks. */
  pid?: number
}

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

async function probeIngit(baseUrl: string): Promise<RunningIngit | null> {
  try {
    const response = await fetch(`${baseUrl}/__ingit/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return null

    const body = await response.text()
    if (response.headers.get('content-type')?.includes('application/json')) {
      const data = JSON.parse(body) as { name?: unknown; version?: unknown; pid?: unknown }
      if (data.name !== 'ingit') return null
      return {
        url: baseUrl,
        ...(typeof data.version === 'string' ? { version: data.version } : {}),
        ...(Number.isSafeInteger(data.pid) && Number(data.pid) > 0 ? { pid: Number(data.pid) } : {}),
      }
    }

    // Older ingit versions serve the SPA for unknown paths. Its injected
    // session marker lets a newly-upgraded CLI recognize and replace it.
    return body.includes('window.__INGIT_SESSION_TOKEN__') ? { url: baseUrl } : null
  } catch {
    return null
  }
}

export async function inspectRunningIngit(
  host = DEFAULT_HOST,
  startPort = DEFAULT_PORT,
): Promise<RunningIngit | null> {
  const candidates = Array.from(
    { length: PORT_SEARCH_ATTEMPTS + 1 },
    (_, offset) => serverUrl(host, startPort + offset),
  )
  const matches = await Promise.all(candidates.map(probeIngit))
  return matches.find((match) => match !== null) ?? null
}

/** Kept as the URL-only API for callers that do not need process metadata. */
export async function findRunningIngit(
  host = DEFAULT_HOST,
  startPort = DEFAULT_PORT,
): Promise<string | null> {
  return (await inspectRunningIngit(host, startPort))?.url ?? null
}

interface ParsedVersion {
  core: [number, number, number]
  prerelease: string[] | null
}

function parseVersion(version: string): ParsedVersion | null {
  const match = version.trim().match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  )
  if (!match) return null
  const core = match.slice(1, 4).map(Number) as [number, number, number]
  if (core.some((part) => !Number.isSafeInteger(part))) return null
  return { core, prerelease: match[4]?.split('.') ?? null }
}

/** Compare semantic versions, returning null when either value is invalid. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null

  for (let i = 0; i < a.core.length; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0
    return a.prerelease === null ? 1 : -1
  }

  const count = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < count; i++) {
    const aPart = a.prerelease[i]
    const bPart = b.prerelease[i]
    if (aPart === undefined || bPart === undefined) {
      if (aPart === bPart) return 0
      return aPart === undefined ? -1 : 1
    }
    if (aPart === bPart) continue
    const aNumeric = /^\d+$/.test(aPart)
    const bNumeric = /^\d+$/.test(bPart)
    if (aNumeric && bNumeric) return Number(aPart) < Number(bPart) ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return aPart < bPart ? -1 : 1
  }
  return 0
}

export function runningIngitNeedsRestart(runningVersion: string | undefined, installedVersion: string): boolean {
  // A missing version identifies the legacy health response shipped before
  // this restart handshake, and is therefore necessarily older.
  if (runningVersion === undefined) return true
  return compareVersions(runningVersion, installedVersion) === -1
}

async function commandOutput(command: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output
  } catch {
    return null
  }
}

function parsePids(output: string, pattern = /\d+/g): number[] {
  return [...new Set(
    [...output.matchAll(pattern)]
      .map((match) => Number(match[1] ?? match[0]))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  )]
}

async function listeningPids(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const output = await commandOutput('netstat.exe', ['-ano', '-p', 'tcp'])
    if (output === null) return []
    const pids: number[] = []
    for (const line of output.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 5 || fields[0]?.toUpperCase() !== 'TCP') continue
      if (fields[3]?.toUpperCase() !== 'LISTENING' || !fields[1]?.endsWith(`:${port}`)) continue
      const pid = Number(fields[4])
      if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid)
    }
    return [...new Set(pids)]
  }

  for (const command of ['/usr/sbin/lsof', 'lsof']) {
    const lsof = await commandOutput(command, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    const lsofPids = lsof === null ? [] : parsePids(lsof)
    if (lsofPids.length > 0) return lsofPids
  }
  if (process.platform === 'darwin') return []

  const ss = await commandOutput('ss', ['-H', '-ltnp', 'sport', '=', `:${port}`])
  const ssPids = ss === null ? [] : parsePids(ss, /pid=(\d+)/g)
  if (ssPids.length > 0) return ssPids

  const fuser = await commandOutput('fuser', ['-n', 'tcp', String(port)])
  return fuser === null ? [] : parsePids(fuser)
}

async function waitUntilStopped(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeIngit(url) === null) return true
    await Bun.sleep(50)
  }
  return false
}

/** Stop a verified local ingit listener so the installed CLI can replace it. */
export async function stopRunningIngit(running: RunningIngit): Promise<void> {
  const port = Number(new URL(running.url).port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Cannot determine the port of the running ingit server at ${running.url}`)
  }

  // Resolve the listening process independently before sending a signal. This
  // prevents a spoofed health response from making the CLI kill an unrelated PID.
  const owners = await listeningPids(port)
  const pid = running.pid === undefined
    ? (owners.length === 1 ? owners[0] : undefined)
    : (owners.includes(running.pid) ? running.pid : undefined)
  if (pid === undefined || pid === process.pid) {
    throw new Error(`Cannot safely identify the running ingit process on port ${port}`)
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return
    throw error
  }
  if (await waitUntilStopped(running.url, SHUTDOWN_TIMEOUT_MS)) return

  process.kill(pid, 'SIGKILL')
  if (!await waitUntilStopped(running.url, 1_000)) {
    throw new Error(`Timed out stopping ingit process ${pid} on port ${port}`)
  }
}
