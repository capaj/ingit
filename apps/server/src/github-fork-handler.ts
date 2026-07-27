import type { GithubForkSuggestion, RemoteSummary } from '@ingit/rpc-contract'
import { extractOwnerRepoFromGithubUrl, resolveGithubToken } from './ci-status-handler.js'

const VIEWER_FORKS_QUERY = `
  query ViewerForks($cursor: String) {
    viewer {
      login
      repositories(
        first: 100
        after: $cursor
        affiliations: [OWNER]
        isFork: true
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes {
          nameWithOwner
          url
          sshUrl
          parent {
            nameWithOwner
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

interface ViewerForksResponse {
  data?: {
    viewer?: {
      login?: string
      repositories?: {
        nodes?: Array<{
          nameWithOwner?: string
          url?: string
          sshUrl?: string
          parent?: { nameWithOwner?: string } | null
        } | null>
        pageInfo?: {
          hasNextPage?: boolean
          endCursor?: string | null
        }
      }
    }
  }
}

function equalsIgnoreCase(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase()
}

function pickRemoteName(login: string, remotes: RemoteSummary[]): string {
  const names = new Set(remotes.map((remote) => remote.name))
  if (!names.has(login)) return login
  if (!names.has('fork')) return 'fork'

  let suffix = 2
  while (names.has(`fork-${suffix}`)) suffix += 1
  return `fork-${suffix}`
}

function prefersSsh(remotes: RemoteSummary[]): boolean {
  const primaryUrl = remotes.find((remote) => remote.name === 'origin')?.url
    ?? remotes[0]?.url
    ?? ''
  return /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(primaryUrl)
}

export async function discoverGithubForkSuggestion(
  ownerRepo: string,
  remotes: RemoteSummary[],
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubForkSuggestion | null> {
  let cursor: string | null = null

  try {
    do {
      const response = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'ingit',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          query: VIEWER_FORKS_QUERY,
          variables: { cursor },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return null

      const payload = await response.json() as ViewerForksResponse
      const viewer = payload.data?.viewer
      const repositories = viewer?.repositories
      if (!viewer?.login || !repositories) return null

      const fork = repositories.nodes?.find((repository) => (
        repository
        && equalsIgnoreCase(repository.parent?.nameWithOwner, ownerRepo)
        && repository.nameWithOwner
        && repository.url
        && repository.sshUrl
      ))

      if (fork?.nameWithOwner && fork.url && fork.sshUrl) {
        const forkFullName = fork.nameWithOwner
        const alreadyConfigured = remotes.some((remote) => (
          equalsIgnoreCase(extractOwnerRepoFromGithubUrl(remote.url) ?? undefined, forkFullName)
        ))
        if (alreadyConfigured) return null

        return {
          remoteName: pickRemoteName(viewer.login, remotes),
          fullName: forkFullName,
          url: prefersSsh(remotes) ? fork.sshUrl : fork.url,
        }
      }

      cursor = repositories.pageInfo?.hasNextPage
        ? repositories.pageInfo.endCursor ?? null
        : null
    } while (cursor)
  } catch {
    return null
  }

  return null
}

export async function fetchGithubForkSuggestion(
  ownerRepo: string,
  remotes: RemoteSummary[],
): Promise<GithubForkSuggestion | null> {
  const token = await resolveGithubToken()
  if (!token) return null
  return discoverGithubForkSuggestion(ownerRepo, remotes, token)
}
