import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { HistoryQuery, StageActionKind } from '@ingit/rpc-contract'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null
let ws: WebSocket | null = null

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/rpc`
}

function ensureClient() {
  if (client && ws && ws.readyState <= WebSocket.OPEN) return client

  const socket = new WebSocket(getWsUrl())
  socket.addEventListener('close', () => {
    // Drop the cached client so the next call reconnects instead of
    // sending into a dead socket.
    if (ws === socket) {
      ws = null
      client = null
    }
  })
  ws = socket
  const link = new RPCLink({ websocket: socket })
  client = createORPCClient(link)
  return client
}

// oRPC rejects in-flight calls with an AsyncIdQueue error when the
// underlying WebSocket closes (e.g. the dev server restarted mid-call).
export function isConnectionLostError(err: unknown): boolean {
  return err instanceof Error
    && /AsyncIdQueue|closed or aborted|WebSocket/i.test(err.message)
}

export function openRepo(req: { path: string }) {
  return ensureClient().openRepo(req)
}

export function getRecentRepos() {
  return ensureClient().getRecentRepos({})
}

export function getRefs(repoId: string) {
  return ensureClient().getRefs({ repoId })
}

export function getStatus(repoId: string) {
  return ensureClient().getStatus({ repoId })
}

export function getWorktreeChanges(repoId: string) {
  return ensureClient().getWorktreeChanges({ repoId })
}

export function stageAction(repoId: string, action: StageActionKind, paths: string[]) {
  return ensureClient().stageAction({ repoId, action, paths })
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

export function getCommitCIStatus(repoId: string, sha: string) {
  return ensureClient().getCommitCIStatus({ repoId, sha })
}

export function getCommitCIStatuses(repoId: string, shas: string[]) {
  return ensureClient().getCommitCIStatuses({ repoId, shas })
}

export function commitAction(repoId: string, action: 'cherry-pick' | 'revert' | 'uncommit', sha: string) {
  return ensureClient().commitAction({ repoId, action, sha })
}

export function getMergePreview(repoId: string, refName: string) {
  return ensureClient().getMergePreview({ repoId, refName })
}

export function mergeRef(repoId: string, refName: string) {
  return ensureClient().mergeRef({ repoId, refName })
}

export function rebaseRef(repoId: string, refName: string) {
  return ensureClient().rebaseRef({ repoId, refName })
}

export function refAction(repoId: string, action: 'checkout' | 'push' | 'fetch' | 'delete' | 'move' | 'reset' | 'create', refName: string, sha: string) {
  return ensureClient().refAction({ repoId, action, refName, sha })
}

export function getReflog(repoId: string, ref?: string, maxCount?: number) {
  return ensureClient().getReflog({ repoId, ref, maxCount })
}
