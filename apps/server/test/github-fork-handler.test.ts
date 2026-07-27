import { describe, expect, test } from 'bun:test'
import { discoverGithubForkSuggestion } from '../src/github-fork-handler.js'

function mockGithubGraphql(
  payloads: unknown[],
  bodies: Array<{ variables?: { cursor?: string | null } }> = [],
): typeof fetch {
  let index = 0
  return (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const payload = payloads[index]
    index += 1
    return new Response(JSON.stringify(payload), {
      status: payload ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

function viewerPage(
  nodes: Array<{
    nameWithOwner: string
    url: string
    sshUrl: string
    parent: { nameWithOwner: string }
  }>,
  options: { login?: string; hasNextPage?: boolean; endCursor?: string | null } = {},
) {
  return {
    data: {
      viewer: {
        login: options.login ?? 'capaj',
        repositories: {
          nodes,
          pageInfo: {
            hasNextPage: options.hasNextPage ?? false,
            endCursor: options.endCursor ?? null,
          },
        },
      },
    },
  }
}

const fork = {
  nameWithOwner: 'capaj/my-upstream',
  url: 'https://github.com/capaj/my-upstream',
  sshUrl: 'git@github.com:capaj/my-upstream.git',
  parent: { nameWithOwner: 'openai/upstream' },
}

describe('discoverGithubForkSuggestion', () => {
  test('finds a matching fork across pages and suggests the user login as the remote name', async () => {
    const requestBodies: Array<{ variables?: { cursor?: string | null } }> = []
    const fetchImpl = mockGithubGraphql([
      viewerPage([], { hasNextPage: true, endCursor: 'next-page' }),
      viewerPage([fork]),
    ], requestBodies)

    const result = await discoverGithubForkSuggestion(
      'OpenAI/Upstream',
      [{ name: 'origin', url: 'https://github.com/openai/upstream.git' }],
      'token',
      fetchImpl,
    )

    expect(result).toEqual({
      remoteName: 'capaj',
      fullName: 'capaj/my-upstream',
      url: 'https://github.com/capaj/my-upstream',
    })
    expect(requestBodies.map((body) => body.variables?.cursor)).toEqual([null, 'next-page'])
  })

  test('matches the existing remote transport and avoids remote-name collisions', async () => {
    const result = await discoverGithubForkSuggestion(
      'openai/upstream',
      [
        { name: 'origin', url: 'git@github.com:openai/upstream.git' },
        { name: 'capaj', url: 'https://example.com/other.git' },
        { name: 'fork', url: 'https://example.com/another.git' },
      ],
      'token',
      mockGithubGraphql([viewerPage([fork])]),
    )

    expect(result).toEqual({
      remoteName: 'fork-2',
      fullName: 'capaj/my-upstream',
      url: 'git@github.com:capaj/my-upstream.git',
    })
  })

  test('does not suggest a fork that is already configured as a remote', async () => {
    const result = await discoverGithubForkSuggestion(
      'openai/upstream',
      [
        { name: 'origin', url: 'https://github.com/openai/upstream.git' },
        { name: 'mine', url: 'git@github.com:capaj/my-upstream.git' },
      ],
      'token',
      mockGithubGraphql([viewerPage([fork])]),
    )

    expect(result).toBeNull()
  })

  test('returns null when the viewer has forks, but not of this repository', async () => {
    const result = await discoverGithubForkSuggestion(
      'openai/other',
      [{ name: 'origin', url: 'https://github.com/openai/other.git' }],
      'token',
      mockGithubGraphql([viewerPage([fork])]),
    )

    expect(result).toBeNull()
  })
})
