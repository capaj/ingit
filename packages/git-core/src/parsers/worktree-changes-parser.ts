import type { WorktreeChangesResponse, WorktreeFile, WorktreeFileStatus } from '@ingit/rpc-contract'
import { runGit } from '../git-command.js'

const VALID_STATUS = new Set(['A', 'M', 'D', 'R', 'C', 'T', 'U', '?'])

function toStatus(letter: string): WorktreeFileStatus {
  return VALID_STATUS.has(letter) ? (letter as WorktreeFileStatus) : 'M'
}

/**
 * Parse `git status --porcelain=v2 --branch` output into the staged / unstaged
 * file lists that the staging UI consumes.
 *
 * Porcelain v2 encodes a per-path XY pair: X is the index (staged) state and Y
 * is the worktree (unstaged) state. A single path can carry changes on both
 * sides, so it may appear in both lists. Untracked (`?`) and unmerged (`u`)
 * entries are surfaced as unstaged.
 *
 * Pure and line-based so it can be unit tested without a repository.
 */
export function parseWorktreeChanges(lines: string[]): WorktreeChangesResponse {
  let branch: string | undefined
  let headSha = ''
  const staged: WorktreeFile[] = []
  const unstaged: WorktreeFile[] = []

  for (const line of lines) {
    if (line.startsWith('# branch.oid ')) {
      headSha = line.slice('# branch.oid '.length).trim()
      continue
    }
    if (line.startsWith('# branch.head ')) {
      const val = line.slice('# branch.head '.length).trim()
      if (val && val !== '(detached)') branch = val
      continue
    }
    if (line.startsWith('# ')) continue

    // Ordinary (1) or rename/copy (2) entry:
    //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const isRename = line.startsWith('2 ')
      const fields = line.split(' ')
      const xy = fields[1] ?? '..'
      const x = xy[0]
      const y = xy[1]
      // The path is everything after the fixed-width fields (8 for ordinary,
      // 9 for rename). Re-join with spaces since paths may contain spaces.
      const pathFieldStart = isRename ? 9 : 8
      const rest = fields.slice(pathFieldStart).join(' ')
      const [path, origPath] = isRename ? rest.split('\t') : [rest, undefined]

      if (x && x !== '.') {
        staged.push({ path, ...(origPath ? { oldPath: origPath } : {}), status: toStatus(x) })
      }
      if (y && y !== '.') {
        unstaged.push({ path, ...(origPath ? { oldPath: origPath } : {}), status: toStatus(y) })
      }
      continue
    }

    // Unmerged / conflicted: "u <xy> ... <path>"
    if (line.startsWith('u ')) {
      const fields = line.split(' ')
      const path = fields.slice(10).join(' ')
      if (path) unstaged.push({ path, status: 'U' })
      continue
    }

    // Untracked: "? <path>"
    if (line.startsWith('? ')) {
      unstaged.push({ path: line.slice(2), status: '?' })
      continue
    }

    // Ignored (!) — skip
  }

  const result: WorktreeChangesResponse = { headSha, staged, unstaged }
  if (branch !== undefined) result.branch = branch
  return result
}

export async function readWorktreeChanges(cwd: string): Promise<WorktreeChangesResponse> {
  const [{ stdout }, { stdout: mergeHeadOut }, { stdout: rebaseHeadOut }] = await Promise.all([
    runGit(['status', '--porcelain=v2', '--branch'], cwd),
    runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD^{commit}'], cwd, { okCodes: [1] }),
    runGit(['rev-parse', '-q', '--verify', 'REBASE_HEAD^{commit}'], cwd, { okCodes: [1] }),
  ])
  const lines = stdout.split('\n').filter((line) => line.length > 0)
  const changes = parseWorktreeChanges(lines)
  const mergeHeadShas = mergeHeadOut.split('\n').map((line) => line.trim()).filter(Boolean)
  if (mergeHeadShas.length > 0) changes.mergeHeadShas = mergeHeadShas
  const rebaseHeadSha = rebaseHeadOut.trim()
  if (rebaseHeadSha) changes.rebaseHeadSha = rebaseHeadSha
  return changes
}
