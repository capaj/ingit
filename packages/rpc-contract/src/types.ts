export type RepoId = string
export type ProjectionId = string
export type CommitSha = string

export interface OpenRepoRequest {
  path: string
}

export interface OpenRepoResponse {
  repoId: RepoId
  rootPath: string
  currentWorktreePath: string
  totalCommitCount: number
  githubUrl: string | null
  head: {
    kind: 'symbolic' | 'detached'
    refName?: string
    sha: CommitSha
  }
}

export interface RefSummary {
  name: string
  shortName: string
  kind: 'head' | 'remote' | 'tag'
  targetSha: CommitSha
  peeledSha?: CommitSha
  upstream?: string
  ahead?: number
  behind?: number
  isCurrent?: boolean
}

export interface HistoryAnchor {
  kind: 'head' | 'ref' | 'sha' | 'row' | 'mergeBase'
  value?: string
  secondaryValue?: string
}

export interface HistoryQuery {
  repoId: RepoId
  scope: {
    kind: 'all' | 'ref' | 'range' | 'path'
    value?: string
    secondaryValue?: string
  }
  anchor: HistoryAnchor
  beforeRows: number
  afterRows: number
  firstParent: boolean
  topoOrder: boolean
}

export interface CommitRow {
  row: number
  sha: CommitSha
  parentShas: CommitSha[]
  authorName: string
  authorEmail: string
  authorUnix: number
  committerUnix: number
  subject: string
  additions: number
  deletions: number
  locChanged: number
  bodyPreview?: string
  refNames: string[]
  lane: number
}

export interface EdgeSegment {
  fromRow: number
  toRow: number
  fromLane: number
  toLane: number
  kind: 'linear' | 'merge' | 'fork'
}

export interface HistoryWindowResponse {
  projectionId: ProjectionId
  rows: CommitRow[]
  edges: EdgeSegment[]
  checkpointsKnownUntilRow: number
  totalRowsKnown?: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  indexingState: 'cold' | 'warming' | 'warm'
}

export interface CommitDetailRequest {
  repoId: RepoId
  sha: CommitSha
}

export interface CommitDetailResponse {
  sha: CommitSha
  parents: CommitSha[]
  authorName: string
  authorEmail: string
  authorUnix: number
  committerName: string
  committerEmail: string
  committerUnix: number
  subject: string
  body: string
  treeSha: string
  refs: string[]
}

export interface CommitDiffRequest {
  repoId: RepoId
  sha: CommitSha
}

export interface ChangedPath {
  path: string
  oldPath?: string
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U'
}

export interface CommitDiffResponse {
  sha: CommitSha
  changedPaths: ChangedPath[]
  additions: number
  deletions: number
  patchText?: string
}

export type CommitActionKind = 'cherry-pick' | 'revert' | 'uncommit'

export interface CommitActionRequest {
  repoId: RepoId
  sha: CommitSha
  action: CommitActionKind
}

export interface CommitActionResponse {
  ok: boolean
  message: string
  headSha: CommitSha
}

export interface WorktreeStatusResponse {
  branch?: string
  headSha: CommitSha
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
}

// WebSocket event types
export type WsEvent =
  | { type: 'indexing-progress'; repoId: RepoId; rowsIndexed: number; totalEstimate?: number }
  | { type: 'ref-change'; repoId: RepoId; refs: RefSummary[] }
  | { type: 'status-change'; repoId: RepoId; status: WorktreeStatusResponse }
  | { type: 'history-update'; repoId: RepoId; projectionId: ProjectionId }

// Error response
export interface ApiError {
  code: string
  message: string
  hint?: string
}
