import type { GithubForkSuggestion, RemoteSummary } from '@ingit/rpc-contract'

export type AppStatus = 'no-repo' | 'loading' | 'ready'

export interface RepositorySlice {
  status: AppStatus
  repoId: string | null
  repoPath: string | null
  currentWorktreePath: string | null
  totalCommitCount: number
  recentRepos: string[]
  discoveredFolder: string | null
  discoveredRepos: string[]
  remotes: RemoteSummary[]
  selectedRemoteName: string | null
  githubForkSuggestion: GithubForkSuggestion | null
  githubUrl: string | null
  openError: string | null

  reloadFromServer: () => Promise<void>
  openRepoByPath: (path: string) => Promise<void>
  closeRepo: () => void
  loadRecentRepos: () => Promise<void>
  loadDiscoveredRepos: (folder?: string) => Promise<void>
  selectRemote: (name: string) => Promise<void>
  addRemote: (name: string, url: string) => Promise<boolean>
  removeRemote: (name: string) => Promise<boolean>
  openFromUrl: () => void
}

export type RepositorySliceState = Omit<
  RepositorySlice,
  | 'reloadFromServer'
  | 'openRepoByPath'
  | 'closeRepo'
  | 'loadRecentRepos'
  | 'loadDiscoveredRepos'
  | 'selectRemote'
  | 'addRemote'
  | 'removeRemote'
  | 'openFromUrl'
>

export function createRepositorySliceState(): RepositorySliceState {
  return {
    status: 'no-repo',
    repoId: null,
    repoPath: null,
    currentWorktreePath: null,
    totalCommitCount: 0,
    recentRepos: [],
    discoveredFolder: null,
    discoveredRepos: [],
    remotes: [],
    selectedRemoteName: null,
    githubForkSuggestion: null,
    githubUrl: null,
    openError: null,
  }
}
