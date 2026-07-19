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
  githubUrl: string | null
  openError: string | null

  reloadFromServer: () => Promise<void>
  openRepoByPath: (path: string) => Promise<void>
  closeRepo: () => void
  loadRecentRepos: () => Promise<void>
  loadDiscoveredRepos: (folder?: string) => Promise<void>
  openFromUrl: () => void
}

export type RepositorySliceState = Omit<
  RepositorySlice,
  | 'reloadFromServer'
  | 'openRepoByPath'
  | 'closeRepo'
  | 'loadRecentRepos'
  | 'loadDiscoveredRepos'
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
    githubUrl: null,
    openError: null,
  }
}
