import type { RefSummary } from '@ingit/rpc-contract'
import { runGitLines } from '../git-command.js'

const FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(objecttype)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream)',
  '%(upstream:track,nobracket)',
].join('%09')

function parseAheadBehind(track: string): { ahead?: number; behind?: number } {
  if (!track) return {}
  const ahead = track.match(/ahead (\d+)/)
  const behind = track.match(/behind (\d+)/)
  return {
    ahead: ahead ? parseInt(ahead[1], 10) : undefined,
    behind: behind ? parseInt(behind[1], 10) : undefined,
  }
}

function refKind(refname: string): RefSummary['kind'] {
  if (refname.startsWith('refs/heads/')) return 'head'
  if (refname.startsWith('refs/remotes/')) return 'remote'
  return 'tag'
}

export async function parseRefs(cwd: string): Promise<RefSummary[]> {
  const lines = await runGitLines(
    [
      'for-each-ref',
      `--format=${FORMAT}`,
      'refs/heads',
      'refs/tags',
      'refs/remotes',
    ],
    cwd,
  )

  const refs: RefSummary[] = []

  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length < 7) continue

    const [refname, shortName, objecttype, objectname, peeledSha, upstream, track] = parts

    if (!refname || !objectname) continue

    // For tags, objecttype may be 'tag'; peeledSha is the commit it points to
    const targetSha = objectname.trim()
    const peeled = peeledSha?.trim()

    const { ahead, behind } = parseAheadBehind(track ?? '')

    const ref: RefSummary = {
      name: refname,
      shortName: shortName ?? refname,
      kind: refKind(refname),
      targetSha,
      ...(peeled ? { peeledSha: peeled } : {}),
      ...(upstream?.trim() ? { upstream: upstream.trim() } : {}),
      ...(ahead !== undefined ? { ahead } : {}),
      ...(behind !== undefined ? { behind } : {}),
    }

    // Skip symrefs like HEAD under refs/remotes
    if (objecttype === 'commit' || objecttype === 'tag') {
      refs.push(ref)
    }
  }

  return refs
}
