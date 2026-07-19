import type {
  ChangedPath,
  ImageDiff,
  InProgressOperationKind,
  StageActionKind,
  StashDiffResponse,
  StashSummary,
  WorktreeChangesResponse,
  WorktreeDiffArea,
  WorktreeFile,
  WorktreeSummary,
} from '@ingit/rpc-contract'

/** Loaded (or loading / failed) patch for one worktree file, keyed `${area}:${path}`. */
export interface WorktreeDiffEntry {
  loading: boolean
  patchText?: string
  isBinary?: boolean
  imageDiff?: ImageDiff
  error?: string
}

export type CommitFileDiffEntry = WorktreeDiffEntry

export function worktreeDiffKey(area: WorktreeDiffArea, path: string): string {
  return `${area}:${path}`
}

export function commitFileDiffKey(sha: string, path: string): string {
  return `${sha}:${path}`
}

export function stashFileDiffKey(sha: string, path: string): string {
  return `${sha}:${path}`
}

export interface WorktreeSlice {
  stashes: StashSummary[]
  selectedStashSha: string | null
  stashDiff: StashDiffResponse | null
  stashFileDiffs: Record<string, WorktreeDiffEntry>
  worktrees: WorktreeSummary[]
  worktreeChanges: WorktreeChangesResponse | null
  worktreeSelected: boolean
  /** In-progress commit message; kept while the working-tree panel is hidden. */
  worktreeCommitMessage: string
  worktreeFileDiffs: Record<string, WorktreeDiffEntry>
  commitFileDiffs: Record<string, CommitFileDiffEntry>

  setWorktreeCommitMessage: (message: string) => void
  loadWorktrees: () => Promise<void>
  loadWorktreeChanges: () => Promise<void>
  /** Stash all tracked and untracked changes. */
  createStash: (message?: string) => Promise<boolean>
  /** Apply a stash while keeping it in the stash list. */
  applyStash: (stashSha: string) => Promise<boolean>
  /** Permanently remove a stash. */
  dropStash: (stashSha: string) => Promise<boolean>
  selectStash: (stashSha: string) => void
  loadStashFileDiff: (stashSha: string, file: ChangedPath) => Promise<void>
  selectWorktree: () => void
  /** Run a staging action and report whether it succeeded. */
  runStageAction: (action: StageActionKind, paths: string[]) => Promise<boolean>
  loadWorktreeFileDiff: (file: WorktreeFile, area: WorktreeDiffArea) => Promise<void>
  loadCommitFileDiff: (sha: string, file: ChangedPath) => Promise<void>
  /** Commit the index. Returns true on success (so the UI can clear the message). */
  performCommit: (message: string, noVerify: boolean, amend?: boolean) => Promise<boolean>
  abortInProgressOperation: (operation: InProgressOperationKind) => Promise<void>
  continueInProgressOperation: (operation: InProgressOperationKind) => Promise<void>
}

export type WorktreeSliceState = Omit<
  WorktreeSlice,
  | 'setWorktreeCommitMessage'
  | 'loadWorktrees'
  | 'loadWorktreeChanges'
  | 'createStash'
  | 'applyStash'
  | 'dropStash'
  | 'selectStash'
  | 'loadStashFileDiff'
  | 'selectWorktree'
  | 'runStageAction'
  | 'loadWorktreeFileDiff'
  | 'loadCommitFileDiff'
  | 'performCommit'
  | 'abortInProgressOperation'
  | 'continueInProgressOperation'
>

export function createWorktreeSliceState(): WorktreeSliceState {
  return {
    stashes: [],
    selectedStashSha: null,
    stashDiff: null,
    stashFileDiffs: {},
    worktrees: [],
    worktreeChanges: null,
    worktreeSelected: false,
    worktreeCommitMessage: '',
    worktreeFileDiffs: {},
    commitFileDiffs: {},
  }
}
