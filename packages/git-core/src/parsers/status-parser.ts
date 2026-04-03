import type { WorktreeStatusResponse } from '@ingit/rpc-contract'
import { runGitLines } from '../git-command.js'

export async function parseStatus(cwd: string): Promise<WorktreeStatusResponse> {
  const lines = await runGitLines(['status', '--porcelain=v2', '--branch'], cwd)

  let branch: string | undefined
  let headSha = ''
  let stagedCount = 0
  let unstagedCount = 0
  let untrackedCount = 0
  let conflictedCount = 0

  for (const line of lines) {
    if (line.startsWith('# branch.oid ')) {
      headSha = line.slice('# branch.oid '.length).trim()
      continue
    }

    if (line.startsWith('# branch.head ')) {
      const val = line.slice('# branch.head '.length).trim()
      // detached HEAD is represented as "(detached)"
      if (val && val !== '(detached)') {
        branch = val
      }
      continue
    }

    if (line.startsWith('# ')) {
      // other branch headers, skip
      continue
    }

    // Ordinary changed entry: "1 XY sub mH mI mW hH hI path"
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      const x = xy[0]
      const y = xy[1]
      if (x && x !== '.') stagedCount++
      if (y && y !== '.') unstagedCount++
      continue
    }

    // Unmerged (conflicted)
    if (line.startsWith('u ')) {
      conflictedCount++
      continue
    }

    // Untracked
    if (line.startsWith('? ')) {
      untrackedCount++
      continue
    }

    // Ignored (!) — skip
  }

  const result: WorktreeStatusResponse = {
    headSha,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
  }

  if (branch !== undefined) {
    result.branch = branch
  }

  return result
}
