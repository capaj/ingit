import type { ChangedPath } from '@ingit/rpc-contract'
import { runGitLines } from '../git-command.js'

type ChangeStatus = ChangedPath['status']

function parseStatusLetter(letter: string): ChangeStatus {
  // Only the first character matters; rename/copy have score suffix e.g. R90
  const ch = letter[0]?.toUpperCase()
  switch (ch) {
    case 'A': return 'A'
    case 'M': return 'M'
    case 'D': return 'D'
    case 'R': return 'R'
    case 'C': return 'C'
    case 'T': return 'T'
    case 'U': return 'U'
    default: return 'M'
  }
}

export async function parseDiffTree(cwd: string, sha: string): Promise<ChangedPath[]> {
  // -r: recurse into subtrees, --no-commit-id: omit sha prefix, -M: detect renames, -C: detect copies
  // Output format per line: ":oldmode newmode oldsha newsha status\tpath[\toldpath]"
  const lines = await runGitLines(
    ['diff-tree', '-r', '--no-commit-id', '-M', '-C', sha],
    cwd,
  )

  const result: ChangedPath[] = []

  for (const line of lines) {
    if (!line.startsWith(':')) continue

    // Split on tab to separate the metadata prefix from path(s)
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue

    const meta = line.slice(0, tabIdx)
    const rest = line.slice(tabIdx + 1)

    const metaParts = meta.split(' ')
    if (metaParts.length < 5) continue

    // status field is the 5th element, e.g. "M", "R90", "C80"
    const statusField = metaParts[4] ?? ''
    const status = parseStatusLetter(statusField)

    // Paths: for renames/copies there are two tab-separated paths
    const pathParts = rest.split('\t')
    const path = pathParts[0] ?? ''

    const entry: ChangedPath = { path, status }

    if ((status === 'R' || status === 'C') && pathParts.length >= 2) {
      // For renames/copies: first path is new, second is old
      entry.path = pathParts[1] ?? path
      entry.oldPath = pathParts[0]
    }

    result.push(entry)
  }

  return result
}
