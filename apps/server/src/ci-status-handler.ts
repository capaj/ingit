import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type CIState = 'success' | 'pending' | 'failure' | 'error' | 'neutral' | 'none'
export type CIRunState = 'success' | 'pending' | 'failure' | 'error' | 'neutral'
export type CIRun = {
  name: string
  description?: string
  state: CIRunState
  url?: string
}

// Minimal shape consumed by aggregateCIState. The full GitHub API response
// adds many more fields (see CheckRunApi / CommitStatusApi below) but those
// aren't needed for aggregation.
type CheckRun = { status: string; conclusion: string | null }
type CombinedStatus = { state: string; statuses?: unknown[] }

type CheckRunApi = CheckRun & {
  name: string
  html_url?: string
  output?: { title?: string | null; summary?: string | null }
  app?: { name?: string; slug?: string }
  check_suite?: { id?: number }
  started_at?: string | null
  completed_at?: string | null
}
type CheckRunsResponse = { check_runs?: CheckRunApi[] }
type CommitStatusApi = {
  context: string
  state: string
  description?: string | null
  target_url?: string | null
}
// A check run only carries the job name (e.g. "build") plus its app
// ("GitHub Actions"). The workflow name ("CI") and trigger ("push") that
// GitHub shows live on the workflow run, which we join to the check run via the
// shared check_suite id.
type WorkflowRunApi = {
  name?: string | null
  event?: string | null
  check_suite_id?: number
}
type WorkflowRunsResponse = { workflow_runs?: WorkflowRunApi[] }
type WorkflowInfo = { name?: string; event?: string }
type FetchJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string }

// Only cache states that are terminal — i.e. won't change on the next poll.
// `pending` might resolve later; `error` is usually a transient network or
// auth hiccup and should be retried. `none` is deliberately excluded: GitHub
// doesn't register a commit's check-runs the instant a push lands, so a
// freshly pushed commit first reads as `none` and then flips to `pending`
// seconds later. Caching `none` would pin that first read forever and the CI
// runs would never show up without a manual refresh.
const TERMINAL_STATES: ReadonlySet<CIState> = new Set(['success', 'failure', 'neutral'])

const CACHE_DIR = join(tmpdir(), 'ingit')
// Bump the version suffix when the cached `runs` shape/labels change so stale
// entries (e.g. the pre-workflow-name labels) are dropped instead of served.
const CACHE_FILE = join(CACHE_DIR, 'ci-status-cache-v2.json')

type CacheEntry = { state: CIState; runs: CIRun[] }
type CacheMap = Record<string, CacheEntry>

let cachePromise: Promise<CacheMap> | null = null
let writeChain: Promise<void> = Promise.resolve()

function isValidCacheEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (typeof entry.state !== 'string') return false
  if (!Array.isArray(entry.runs)) return false
  return entry.runs.every((run) => {
    if (!run || typeof run !== 'object') return false
    const r = run as Record<string, unknown>
    return typeof r.name === 'string' && typeof r.state === 'string'
  })
}

function loadCache(): Promise<CacheMap> {
  if (cachePromise) return cachePromise
  cachePromise = (async () => {
    try {
      const raw = await readFile(CACHE_FILE, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') {
        // Drop entries that don't match the current shape — tolerates older
        // cache layouts without requiring a manual wipe.
        const clean: CacheMap = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (isValidCacheEntry(value)) clean[key] = value
        }
        return clean
      }
    } catch {
      // Missing or corrupted cache — start fresh.
    }
    return {}
  })()
  return cachePromise
}

async function persistCache(cache: CacheMap): Promise<void> {
  // Serialise writes so concurrent terminal results don't race on the file.
  writeChain = writeChain.then(async () => {
    await mkdir(CACHE_DIR, { recursive: true })
    // Atomic write: tmp file + rename, so a crash mid-write never leaves
    // a half-written JSON that corrupts future reads.
    const tmpPath = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmpPath, JSON.stringify(cache))
    await rename(tmpPath, CACHE_FILE)
  }).catch((err) => {
    console.warn('[CI] failed to persist cache:', err instanceof Error ? err.message : err)
  })
  return writeChain
}

function cacheKey(ownerRepo: string, sha: string): string {
  return `${ownerRepo}@${sha}`
}

export async function resetCIStatusCacheForTests(): Promise<void> {
  cachePromise = Promise.resolve({})
  writeChain = Promise.resolve()
  try {
    await writeFile(CACHE_FILE, '{}')
  } catch {
    // Ignore — file may not exist yet.
  }
}

let githubTokenPromise: Promise<string | null> | null = null
let warnedMissingGithubToken = false

// Some systems (including Node's npm-global install of the abandoned
// `node-gh` package) put a broken `gh` shim on PATH ahead of the real
// GitHub CLI at /usr/bin/gh. Always prefer the standard system paths so
// we spawn the official binary.
async function resolveGhBinary(): Promise<string | null> {
  const candidates = ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh']
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path
  }
  // Last resort: PATH lookup. Skip entries that live inside node_modules,
  // which is where the broken shim tends to land.
  const fromPath = Bun.which('gh')
  if (fromPath && !fromPath.includes('node_modules')) return fromPath
  return null
}

export function resolveGithubToken(): Promise<string | null> {
  if (githubTokenPromise) return githubTokenPromise
  const tokenFromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (tokenFromEnv) return Promise.resolve(tokenFromEnv)

  const nextTokenPromise = (async () => {
    try {
      const gh = await resolveGhBinary()
      if (!gh) return null
      const proc = Bun.spawn([gh, 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
      const exit = await proc.exited
      if (exit !== 0) return null
      const token = (await new Response(proc.stdout).text()).trim()
      return token || null
    } catch {
      return null
    }
  })()

  githubTokenPromise = nextTokenPromise.then((token) => {
    if (!token) githubTokenPromise = null
    return token
  })
  return githubTokenPromise
}

export function resetGithubTokenCacheForTests(): void {
  githubTokenPromise = null
  warnedMissingGithubToken = false
}

export function extractOwnerRepoFromGithubUrl(githubUrl: string): string | null {
  const trimmed = githubUrl.trim()
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:[?#].*)?$/)
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`

  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`

  return null
}

export function aggregateCIState(runs: CheckRun[], combined: CombinedStatus | null): CIState {
  const hasChecks = runs.length > 0
  const hasStatuses = (combined?.statuses?.length ?? 0) > 0
  if (!hasChecks && !hasStatuses) return 'none'

  let anyPending = false
  let anyFailure = false
  let anySuccess = false
  let anyNeutral = false

  for (const run of runs) {
    if (run.status !== 'completed') { anyPending = true; continue }
    switch (run.conclusion) {
      case 'success': anySuccess = true; break
      case 'failure':
      case 'timed_out':
      case 'cancelled':
      case 'action_required':
      case 'startup_failure':
        anyFailure = true; break
      case 'neutral':
      case 'skipped':
      case 'stale':
        anyNeutral = true; break
      default: anyNeutral = true
    }
  }

  if (combined) {
    switch (combined.state) {
      case 'success': anySuccess = true; break
      case 'pending': anyPending = true; break
      case 'failure':
      case 'error': anyFailure = true; break
    }
  }

  if (anyFailure) return 'failure'
  if (anyPending) return 'pending'
  if (anySuccess) return 'success'
  if (anyNeutral) return 'neutral'
  return 'none'
}

async function fetchJson<T>(path: string, token: string | null): Promise<FetchJsonResult<T>> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ingit',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`https://api.github.com/${path}`, { headers })
    if (!res.ok) {
      let message = res.statusText
      try {
        const body = await res.json() as { message?: string }
        message = body.message ?? message
      } catch {
        // Keep the HTTP status text when GitHub does not return JSON.
      }
      return { ok: false, status: res.status, message }
    }
    return { ok: true, data: await res.json() as T }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : 'Failed to fetch GitHub API',
    }
  }
}

function checkRunToCIRun(run: CheckRunApi, workflowBySuite: Map<number, WorkflowInfo>): CIRun {
  let state: CIRunState
  if (run.status !== 'completed') {
    state = 'pending'
  } else {
    switch (run.conclusion) {
      case 'success': state = 'success'; break
      case 'failure':
      case 'timed_out':
      case 'cancelled':
      case 'action_required':
      case 'startup_failure':
        state = 'failure'; break
      case 'neutral':
      case 'skipped':
      case 'stale':
      case null:
        state = 'neutral'; break
      default: state = 'neutral'
    }
  }

  // Prefer GitHub's own label: "<workflow> / <job> (<event>)", e.g.
  // "CI / build (push)". This is what disambiguates two "deploy" jobs that come
  // from different workflows. Fall back to the app name when the check run
  // isn't backed by a workflow run (third-party checks, or the Actions API was
  // unreadable).
  const workflow = run.check_suite?.id !== undefined ? workflowBySuite.get(run.check_suite.id) : undefined
  let displayName: string
  if (workflow?.name) {
    displayName = `${workflow.name} / ${run.name}`
    if (workflow.event) displayName += ` (${workflow.event})`
  } else {
    const appName = run.app?.name ?? run.app?.slug
    displayName = appName && !run.name.toLowerCase().includes(appName.toLowerCase())
      ? `${appName} / ${run.name}`
      : run.name
  }

  let description: string | undefined
  if (run.output?.title) {
    description = run.output.title
  } else if (run.status !== 'completed') {
    description = run.status.replace(/_/g, ' ')
  } else if (run.conclusion) {
    description = run.conclusion.replace(/_/g, ' ')
  }

  return { name: displayName, description, state, url: run.html_url }
}

function commitStatusToCIRun(status: CommitStatusApi): CIRun {
  const state: CIRunState = (() => {
    switch (status.state) {
      case 'success': return 'success'
      case 'pending': return 'pending'
      case 'failure': return 'failure'
      case 'error': return 'error'
      default: return 'neutral'
    }
  })()
  return {
    name: status.context,
    description: status.description ?? undefined,
    state,
    url: status.target_url ?? undefined,
  }
}

export async function fetchCommitCIStatus(ownerRepo: string, sha: string): Promise<{ state: CIState; runs: CIRun[] }> {
  const key = cacheKey(ownerRepo, sha)
  const cache = await loadCache()
  const cached = cache[key]
  if (cached) return cached

  try {
    const token = await resolveGithubToken()
    if (!token && !warnedMissingGithubToken) {
      warnedMissingGithubToken = true
      console.warn('[CI] No GitHub token available; private repository CI will not be readable')
    }

    const [checks, combined, workflows] = await Promise.all([
      fetchJson<CheckRunsResponse>(`repos/${ownerRepo}/commits/${sha}/check-runs?per_page=100`, token),
      fetchJson<CombinedStatus & { statuses?: CommitStatusApi[] }>(`repos/${ownerRepo}/commits/${sha}/status`, token),
      // Supplementary: maps each check suite to its workflow name + trigger so
      // we can label runs the way GitHub does. A failure here is non-fatal — we
      // just fall back to the app name.
      fetchJson<WorkflowRunsResponse>(`repos/${ownerRepo}/actions/runs?head_sha=${sha}&per_page=100`, token),
    ])

    if (!checks.ok && !combined.ok) {
      console.warn('[CI] GitHub CI lookup failed', {
        ownerRepo,
        sha: sha.slice(0, 12),
        checkRuns: `${checks.status} ${checks.message}`,
        status: `${combined.status} ${combined.message}`,
      })
      return { state: 'error', runs: [] }
    }

    const checkRuns = checks.ok ? checks.data.check_runs ?? [] : []
    const combinedStatuses = combined.ok ? combined.data.statuses ?? [] : []

    const workflowBySuite = new Map<number, WorkflowInfo>()
    if (workflows.ok) {
      for (const run of workflows.data.workflow_runs ?? []) {
        if (typeof run.check_suite_id === 'number') {
          workflowBySuite.set(run.check_suite_id, {
            name: run.name ?? undefined,
            event: run.event ?? undefined,
          })
        }
      }
    }

    const runs: CIRun[] = [
      ...checkRuns.map((run) => checkRunToCIRun(run, workflowBySuite)),
      ...combinedStatuses.map(commitStatusToCIRun),
    ]

    const result: { state: CIState; runs: CIRun[] } = {
      state: aggregateCIState(checkRuns, combined.ok ? combined.data : null),
      runs,
    }

    if (TERMINAL_STATES.has(result.state)) {
      cache[key] = result
      void persistCache(cache)
    }

    return result
  } catch (err) {
    console.warn('[CI] Unexpected CI lookup failure', {
      ownerRepo,
      sha: sha.slice(0, 12),
      error: err instanceof Error ? err.message : String(err),
    })
    return { state: 'error', runs: [] }
  }
}
