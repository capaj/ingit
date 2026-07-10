import { resolveGithubToken } from './ci-status-handler.js'

export interface GithubCommitAuthor {
  avatarUrl: string | null
}

const authorCache = new Map<string, GithubCommitAuthor>()

export async function fetchGithubCommitAuthor(
  ownerRepo: string,
  sha: string,
): Promise<GithubCommitAuthor> {
  const key = `${ownerRepo}@${sha}`
  const cached = authorCache.get(key)
  if (cached) return cached

  try {
    const token = await resolveGithubToken()
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ingit',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const response = await fetch(
      `https://api.github.com/repos/${ownerRepo}/commits/${sha}`,
      { headers, signal: AbortSignal.timeout(5_000) },
    )
    if (!response.ok) return { avatarUrl: null }

    const data = await response.json() as {
      author?: { avatar_url?: string | null } | null
    }
    const result = { avatarUrl: data.author?.avatar_url ?? null }
    authorCache.set(key, result)
    return result
  } catch {
    return { avatarUrl: null }
  }
}
