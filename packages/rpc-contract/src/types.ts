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

export type RecentReposResponse = string[]

export interface DirectoryEntry {
  name: string
  path: string
  isGitRepo: boolean
}

export interface DirectoryListing {
  path: string
  parentPath: string | null
  isGitRepo: boolean
  entries: DirectoryEntry[]
  error?: string
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
  isPushed: boolean
}

export interface CommitAuthorResponse {
  avatarUrl: string | null
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

export interface CommitFileDiffRequest {
  repoId: RepoId
  sha: CommitSha
  path: string
  oldPath?: string
}

export interface CommitFileDiffResponse {
  sha: CommitSha
  path: string
  patchText: string
  isBinary: boolean
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

export interface MergePreviewRequest {
  repoId: RepoId
  refName: string
}

export interface MergePreviewResponse {
  mergeable: boolean
  reason?: 'current-branch' | 'detached-head' | 'up-to-date' | 'missing-ref'
  sourceRefName: string
  sourceSha?: CommitSha
  targetRefName?: string
  targetSha?: CommitSha
  requiresFetch: boolean
}

export interface MergeRefRequest {
  repoId: RepoId
  refName: string
}

export interface MergeRefResponse {
  ok: boolean
  message: string
  headSha: CommitSha
}

export interface RebaseRefRequest {
  repoId: RepoId
  refName: string
}

export interface RebaseRefResponse {
  ok: boolean
  message: string
  headSha: CommitSha
}

export type InProgressOperationKind = 'merge' | 'rebase'

export interface AbortOperationRequest {
  repoId: RepoId
  operation: InProgressOperationKind
}

export interface AbortOperationResponse {
  ok: boolean
  message: string
  headSha: CommitSha
  changes: WorktreeChangesResponse
}

export interface ContinueOperationRequest {
  repoId: RepoId
  operation: InProgressOperationKind
}

export interface ContinueOperationResponse {
  ok: boolean
  message: string
  headSha: CommitSha
  changes: WorktreeChangesResponse
}

export type RefActionKind = 'checkout' | 'push' | 'fetch' | 'delete' | 'move' | 'reset' | 'create' | 'create-tag'

export type ReflogEntryKind =
  | 'commit' | 'amend' | 'checkout' | 'reset' | 'rebase' | 'merge'
  | 'cherry-pick' | 'revert' | 'pull' | 'branch' | 'clone' | 'other'

export interface ReflogEntry {
  index: number
  /** Display selector like "HEAD@{3}" */
  selector: string
  /** Where the ref pointed AFTER this operation */
  sha: CommitSha
  /** Where the ref pointed BEFORE this operation (null for the oldest entry) */
  oldSha: CommitSha | null
  kind: ReflogEntryKind
  /** Raw reflog subject, e.g. "reset: moving to HEAD~2" */
  message: string
  /** Commit subject of `sha` */
  subject: string
  authorName: string
  authorEmail: string
  committerUnix: number
  /** When the reflog entry was recorded */
  entryUnix: number
  /** Reachable from any branch/tag/remote or current HEAD */
  isReachable: boolean
  /** Refs currently pointing at `sha` */
  refNames: string[]
}

export interface ReflogResponse {
  refName: string
  entries: ReflogEntry[]
}

export interface WorktreeStatusResponse {
  branch?: string
  headSha: CommitSha
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
}

export type WorktreeFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface WorktreeFile {
  path: string
  /** Original path for renames/copies. */
  oldPath?: string
  status: WorktreeFileStatus
}

export interface WorktreeChangesResponse {
  branch?: string
  headSha: CommitSha
  /** Commit(s) being merged while Git is in MERGE_HEAD state. */
  mergeHeadShas?: CommitSha[]
  /** Commit being replayed while Git is stopped in a conflicted rebase. */
  rebaseHeadSha?: CommitSha
  /** Files (or file portions) staged in the index. */
  staged: WorktreeFile[]
  /** Unstaged worktree changes, including untracked (`?`) and conflicted (`U`). */
  unstaged: WorktreeFile[]
}

export type StageActionKind = 'stage' | 'unstage' | 'stage-all' | 'unstage-all'

export type WorktreeDiffArea = 'staged' | 'unstaged'

export interface WorktreeFileDiffResponse {
  path: string
  area: WorktreeDiffArea
  patchText: string
  isBinary: boolean
}

export interface CommitRequest {
  repoId: RepoId
  message: string
  noVerify?: boolean
}

export interface CommitResponse {
  ok: boolean
  headSha: CommitSha
  changes: WorktreeChangesResponse
}

export interface StageActionRequest {
  repoId: RepoId
  action: StageActionKind
  paths: string[]
}

export type AgentSessionKind = 'terminal' | 'ide' | 'background'
export type AgentName = 'claude' | 'codex'

export interface AgentSession {
  pid: number
  /** Which coding agent this session runs. */
  agent: AgentName
  kind: AgentSessionKind
  /** Working directory of the claude process (usually the repo it works in). */
  cwd: string
  /** Root of the git repository containing cwd, or null when outside any repo. */
  gitRoot: string | null
  /** Controlling terminal (e.g. /dev/pts/12) for terminal sessions. */
  tty: string | null
  /** IDE hosting the session ('vscode', 'cursor', ...) for ide sessions. */
  ide: string | null
  /** Whether focusAgentSession can bring this session's window to front. */
  focusable: boolean
  /**
   * True when the session looks actively working (inference streaming / tool
   * running), false when idle, null before enough CPU samples exist.
   */
  busy: boolean | null
  /** Conversation title (what the agent shows in its terminal tab), if known. */
  title: string | null
}

export interface FocusCapabilities {
  displayServer: string
  canFocusTerminals: boolean
  canInstallWindowCalls: boolean
}

export interface AgentSessionsResponse {
  sessions: AgentSession[]
  capabilities: FocusCapabilities
}

export interface FocusAgentSessionResponse {
  ok: boolean
  method?: string
  error?: string
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
