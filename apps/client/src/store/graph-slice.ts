import type {
  CommitActionKind,
  CommitDetailResponse,
  CommitDiffResponse,
  HistoryWindowResponse,
  MergePreviewResponse,
  RefActionKind,
  RefSummary,
  ReflogResponse,
} from '@ingit/rpc-contract'
import type { GraphModel } from '../components/graph-canvas/graph-model'

export const REFLOG_PAGE_SIZE = 300

export type CIState = 'success' | 'pending' | 'failure' | 'error' | 'neutral' | 'none'
export type CIRunState = 'success' | 'pending' | 'failure' | 'error' | 'neutral'

export interface CIRun {
  name: string
  description?: string
  state: CIRunState
  url?: string
}

export interface CIStatusEntry {
  state: CIState | 'loading'
  runs: CIRun[]
}

export type CommitPRInfo = Array<{
  number: number
  title: string
  url: string
  state: string
  mergedAt: string | null
}>

export interface GraphSlice {
  refs: RefSummary[]
  historyWindow: HistoryWindowResponse | null
  graphModel: GraphModel | null
  reflog: ReflogResponse | null
  reflogLoading: boolean
  reflogMaxCount: number
  selectedSha: string | null
  selectedRefName: string | null
  scrollToSha: string | null
  /** Incremented to force re-scroll even when the SHA is unchanged. */
  scrollToKey: number
  commitDetail: CommitDetailResponse | null
  commitDiff: CommitDiffResponse | null
  commitPRs: CommitPRInfo
  commitAuthorAvatars: Record<string, string | null>
  mergePreview: MergePreviewResponse | null
  loadingMore: boolean
  commitCIStatus: Record<string, CIStatusEntry>
  /** Blocks node actions while an optimistic mutation is in flight. */
  pendingMutation: boolean
  /** Keeps the migrating worktree node visible and dimmed during checkout. */
  pendingCheckout: boolean
  /** Suppresses a duplicate animation when authoritative data matches a prediction. */
  graphAnimationSuppressToken: number

  selectCommit: (sha: string) => void
  selectRef: (ref: RefSummary) => void
  selectGraphRef: (refName: string) => void
  clearGraphRefSelection: () => void
  ensureMergePreview: (refName: string) => Promise<MergePreviewResponse | null>
  navigateTo: (sha: string) => Promise<void>
  requestMore: (direction: 'up' | 'down') => Promise<void>
  performRefAction: (
    action: RefActionKind,
    refName: string,
    sha: string,
    force?: boolean,
  ) => Promise<void>
  performCommitAction: (action: CommitActionKind, sha: string) => Promise<void>
  performMergeRef: (refName: string) => Promise<void>
  performRebaseRef: (refName: string) => Promise<void>
  checkoutSha: (sha: string) => Promise<void>
  fetchCommitCIStatusesIfNeeded: (shas: string[]) => void
  watchCommitCIStatus: (sha: string) => void
  loadReflog: () => Promise<void>
  loadMoreReflog: () => Promise<void>
  recoverBranch: (branchName: string, sha: string) => Promise<void>
}

export type GraphSliceState = Omit<
  GraphSlice,
  | 'selectCommit'
  | 'selectRef'
  | 'selectGraphRef'
  | 'clearGraphRefSelection'
  | 'ensureMergePreview'
  | 'navigateTo'
  | 'requestMore'
  | 'performRefAction'
  | 'performCommitAction'
  | 'performMergeRef'
  | 'performRebaseRef'
  | 'checkoutSha'
  | 'fetchCommitCIStatusesIfNeeded'
  | 'watchCommitCIStatus'
  | 'loadReflog'
  | 'loadMoreReflog'
  | 'recoverBranch'
>

export function createGraphSliceState(): GraphSliceState {
  return {
    refs: [],
    historyWindow: null,
    graphModel: null,
    reflog: null,
    reflogLoading: false,
    reflogMaxCount: REFLOG_PAGE_SIZE,
    selectedSha: null,
    selectedRefName: null,
    scrollToSha: null,
    scrollToKey: 0,
    commitDetail: null,
    commitDiff: null,
    commitPRs: [],
    commitAuthorAvatars: {},
    mergePreview: null,
    loadingMore: false,
    commitCIStatus: {},
    pendingMutation: false,
    pendingCheckout: false,
    graphAnimationSuppressToken: 0,
  }
}
