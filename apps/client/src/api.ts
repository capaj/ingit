import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { HistoryQuery } from '@ingit/rpc-contract'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null
let ws: WebSocket | null = null

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/rpc`
}

function ensureClient() {
  if (client && ws && ws.readyState <= WebSocket.OPEN) return client

  ws = new WebSocket(getWsUrl())
  const link = new RPCLink({ websocket: ws })
  client = createORPCClient(link)
  return client
}

export function openRepo(req: { path: string }) {
  return ensureClient().openRepo(req)
}

export function getRefs(repoId: string) {
  return ensureClient().getRefs({ repoId })
}

export function getStatus(repoId: string) {
  return ensureClient().getStatus({ repoId })
}

export function queryHistory(_repoId: string, query: HistoryQuery) {
  return ensureClient().queryHistory(query)
}

export function getCommitDetail(repoId: string, sha: string) {
  return ensureClient().getCommitDetail({ repoId, sha })
}

export function getCommitDiff(repoId: string, sha: string) {
  return ensureClient().getCommitDiff({ repoId, sha })
}

export function getCommitPRs(repoId: string, sha: string) {
  return ensureClient().getCommitPRs({ repoId, sha })
}

export function commitAction(repoId: string, action: 'cherry-pick' | 'revert' | 'uncommit', sha: string) {
  return ensureClient().commitAction({ repoId, action, sha })
}

export function refAction(repoId: string, action: 'checkout' | 'push' | 'fetch' | 'delete', refName: string, sha: string) {
  return ensureClient().refAction({ repoId, action, refName, sha })
}
