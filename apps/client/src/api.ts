import type {
  OpenRepoRequest,
  OpenRepoResponse,
  RefSummary,
  WorktreeStatusResponse,
  HistoryQuery,
  HistoryWindowResponse,
  CommitDetailResponse,
  CommitDiffResponse,
} from '@ingit/rpc-contract'

const BASE = ''  // same origin

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ code: 'unknown', message: res.statusText }))
    throw new Error(err.message || res.statusText)
  }
  return res.json()
}

export function openRepo(req: OpenRepoRequest) {
  return fetchJson<OpenRepoResponse>('/api/repo/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
}

export function getRefs(repoId: string) {
  return fetchJson<RefSummary[]>(`/api/repo/${repoId}/refs`)
}

export function getStatus(repoId: string) {
  return fetchJson<WorktreeStatusResponse>(`/api/repo/${repoId}/status`)
}

export function queryHistory(repoId: string, query: HistoryQuery) {
  return fetchJson<HistoryWindowResponse>(`/api/repo/${repoId}/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  })
}

export function getCommitDetail(repoId: string, sha: string) {
  return fetchJson<CommitDetailResponse>(`/api/repo/${repoId}/commit/${sha}`)
}

export function getCommitDiff(repoId: string, sha: string) {
  return fetchJson<CommitDiffResponse>(`/api/repo/${repoId}/commit/${sha}/diff`)
}
