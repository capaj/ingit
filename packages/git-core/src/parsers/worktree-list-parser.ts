import { resolve } from 'node:path'
import type { WorktreeSummary } from '@ingit/rpc-contract'

const LOCAL_BRANCH_PREFIX = 'refs/heads/'

/** Parse `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string, currentWorktreePath: string): WorktreeSummary[] {
  const worktrees: WorktreeSummary[] = []
  let fields: string[] = []

  const finishRecord = () => {
    if (fields.length === 0) return

    let path: string | undefined
    let headSha: string | null = null
    let branchRef: string | undefined
    let detached = false
    let bare = false
    let locked = false
    let lockedReason: string | undefined
    let prunable = false
    let prunableReason: string | undefined

    for (const field of fields) {
      const separator = field.indexOf(' ')
      const key = separator === -1 ? field : field.slice(0, separator)
      const value = separator === -1 ? '' : field.slice(separator + 1)

      switch (key) {
        case 'worktree': path = value; break
        case 'HEAD': headSha = value || null; break
        case 'branch': branchRef = value || undefined; break
        case 'detached': detached = true; break
        case 'bare': bare = true; break
        case 'locked':
          locked = true
          lockedReason = value || undefined
          break
        case 'prunable':
          prunable = true
          prunableReason = value || undefined
          break
      }
    }

    if (path) {
      worktrees.push({
        path,
        headSha,
        ...(branchRef ? { branchRef } : {}),
        ...(branchRef?.startsWith(LOCAL_BRANCH_PREFIX)
          ? { branchShortName: branchRef.slice(LOCAL_BRANCH_PREFIX.length) }
          : {}),
        isCurrent: resolve(path) === resolve(currentWorktreePath),
        detached,
        bare,
        locked,
        ...(lockedReason ? { lockedReason } : {}),
        prunable,
        ...(prunableReason ? { prunableReason } : {}),
      })
    }

    fields = []
  }

  for (const field of output.split('\0')) {
    if (field === '') finishRecord()
    else fields.push(field)
  }
  finishRecord()

  return worktrees
}
