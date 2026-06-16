import { oc } from '@orpc/contract'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const CommitSha = z.string()
export const RepoId = z.string()

export const HeadInfo = z.object({
  kind: z.enum(['symbolic', 'detached']),
  refName: z.string().optional(),
  sha: CommitSha,
})

export const RefSummary = z.object({
  name: z.string(),
  shortName: z.string(),
  kind: z.enum(['head', 'remote', 'tag']),
  targetSha: CommitSha,
  peeledSha: CommitSha.optional(),
  upstream: z.string().optional(),
  ahead: z.number().optional(),
  behind: z.number().optional(),
  isCurrent: z.boolean().optional(),
})

export const CommitRow = z.object({
  row: z.number(),
  sha: CommitSha,
  parentShas: z.array(CommitSha),
  authorName: z.string(),
  authorEmail: z.string(),
  authorUnix: z.number(),
  committerUnix: z.number(),
  subject: z.string(),
  additions: z.number(),
  deletions: z.number(),
  locChanged: z.number(),
  bodyPreview: z.string().optional(),
  refNames: z.array(z.string()),
  lane: z.number(),
})

export const EdgeSegment = z.object({
  fromRow: z.number(),
  toRow: z.number(),
  fromLane: z.number(),
  toLane: z.number(),
  kind: z.enum(['linear', 'merge', 'fork']),
})

export const ChangedPath = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U']),
})

export const WorktreeFileStatus = z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U', '?'])

export const WorktreeFile = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: WorktreeFileStatus,
})

export const WorktreeChanges = z.object({
  branch: z.string().optional(),
  headSha: CommitSha,
  staged: z.array(WorktreeFile),
  unstaged: z.array(WorktreeFile),
})

export const StageActionKind = z.enum(['stage', 'unstage', 'stage-all', 'unstage-all'])

export const CommitActionKind = z.enum(['cherry-pick', 'revert', 'uncommit'])
export const MergePreviewReason = z.enum(['current-branch', 'detached-head', 'up-to-date', 'missing-ref'])
export const RefActionKind = z.enum(['checkout', 'push', 'fetch', 'delete', 'move', 'reset', 'create'])

export const ReflogEntryKind = z.enum([
  'commit', 'amend', 'checkout', 'reset', 'rebase', 'merge',
  'cherry-pick', 'revert', 'pull', 'branch', 'clone', 'other',
])

export const ReflogEntry = z.object({
  index: z.number(),
  selector: z.string(),
  sha: CommitSha,
  oldSha: CommitSha.nullable(),
  kind: ReflogEntryKind,
  message: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  committerUnix: z.number(),
  entryUnix: z.number(),
  isReachable: z.boolean(),
  refNames: z.array(z.string()),
})

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const contract = {
  openRepo: oc
    .input(z.object({ path: z.string() }))
    .output(z.object({
      repoId: RepoId,
      rootPath: z.string(),
      currentWorktreePath: z.string(),
      totalCommitCount: z.number(),
      githubUrl: z.string().nullable(),
      head: HeadInfo,
    })),

  getRecentRepos: oc
    .input(z.object({}))
    .output(z.array(z.string())),

  discoverRepos: oc
    .input(z.object({ folder: z.string().optional() }))
    .output(z.object({
      folder: z.string(),
      repos: z.array(z.string()),
    })),

  getRefs: oc
    .input(z.object({ repoId: RepoId }))
    .output(z.array(RefSummary)),

  getStatus: oc
    .input(z.object({ repoId: RepoId }))
    .output(z.object({
      branch: z.string().optional(),
      headSha: CommitSha,
      stagedCount: z.number(),
      unstagedCount: z.number(),
      untrackedCount: z.number(),
      conflictedCount: z.number(),
    })),

  getWorktreeChanges: oc
    .input(z.object({ repoId: RepoId }))
    .output(WorktreeChanges),

  stageAction: oc
    .input(z.object({
      repoId: RepoId,
      action: StageActionKind,
      paths: z.array(z.string()),
    }))
    .output(WorktreeChanges),

  queryHistory: oc
    .input(z.object({
      repoId: RepoId,
      scope: z.object({
        kind: z.enum(['all', 'ref', 'range', 'path']),
        value: z.string().optional(),
        secondaryValue: z.string().optional(),
      }),
      anchor: z.object({
        kind: z.enum(['head', 'ref', 'sha', 'row', 'mergeBase']),
        value: z.string().optional(),
        secondaryValue: z.string().optional(),
      }),
      beforeRows: z.number(),
      afterRows: z.number(),
      firstParent: z.boolean(),
      topoOrder: z.boolean(),
    }))
    .output(z.object({
      projectionId: z.string(),
      rows: z.array(CommitRow),
      edges: z.array(EdgeSegment),
      checkpointsKnownUntilRow: z.number(),
      totalRowsKnown: z.number().optional(),
      hasMoreBefore: z.boolean(),
      hasMoreAfter: z.boolean(),
      indexingState: z.enum(['cold', 'warming', 'warm']),
    })),

  getCommitDetail: oc
    .input(z.object({ repoId: RepoId, sha: CommitSha }))
    .output(z.object({
      sha: CommitSha,
      parents: z.array(CommitSha),
      authorName: z.string(),
      authorEmail: z.string(),
      authorUnix: z.number(),
      committerName: z.string(),
      committerEmail: z.string(),
      committerUnix: z.number(),
      subject: z.string(),
      body: z.string(),
      treeSha: z.string(),
      refs: z.array(z.string()),
    })),

  getCommitDiff: oc
    .input(z.object({ repoId: RepoId, sha: CommitSha }))
    .output(z.object({
      sha: CommitSha,
      changedPaths: z.array(ChangedPath),
      additions: z.number(),
      deletions: z.number(),
      patchText: z.string().optional(),
    })),

  getCommitPRs: oc
    .input(z.object({ repoId: RepoId, sha: CommitSha }))
    .output(z.array(z.object({
      number: z.number(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
      mergedAt: z.string().nullable(),
    }))),

  getCommitCIStatus: oc
    .input(z.object({ repoId: RepoId, sha: CommitSha }))
    .output(z.object({
      state: z.enum(['success', 'pending', 'failure', 'error', 'neutral', 'none']),
      runs: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        state: z.enum(['success', 'pending', 'failure', 'error', 'neutral']),
        url: z.string().optional(),
      })),
    })),

  getCommitCIStatuses: oc
    .input(z.object({ repoId: RepoId, shas: z.array(CommitSha) }))
    .output(z.record(z.string(), z.object({
      state: z.enum(['success', 'pending', 'failure', 'error', 'neutral', 'none']),
      runs: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        state: z.enum(['success', 'pending', 'failure', 'error', 'neutral']),
        url: z.string().optional(),
      })),
    }))),

  commitAction: oc
    .input(z.object({
      repoId: RepoId,
      sha: CommitSha,
      action: CommitActionKind,
    }))
    .output(z.object({
      ok: z.boolean(),
      message: z.string(),
      headSha: CommitSha,
    })),

  getMergePreview: oc
    .input(z.object({
      repoId: RepoId,
      refName: z.string(),
    }))
    .output(z.object({
      mergeable: z.boolean(),
      reason: MergePreviewReason.optional(),
      sourceRefName: z.string(),
      sourceSha: CommitSha.optional(),
      targetRefName: z.string().optional(),
      targetSha: CommitSha.optional(),
      requiresFetch: z.boolean(),
    })),

  mergeRef: oc
    .input(z.object({
      repoId: RepoId,
      refName: z.string(),
    }))
    .output(z.object({
      ok: z.boolean(),
      message: z.string(),
      headSha: CommitSha,
    })),

  rebaseRef: oc
    .input(z.object({
      repoId: RepoId,
      refName: z.string(),
    }))
    .output(z.object({
      ok: z.boolean(),
      message: z.string(),
      headSha: CommitSha,
    })),

  refAction: oc
    .input(z.object({
      repoId: RepoId,
      action: RefActionKind,
      refName: z.string(),
      sha: CommitSha,
      // For `push`: force-push (--force-with-lease). Needed after a rebase, when
      // the branch diverged from its upstream and a normal push is rejected.
      force: z.boolean().optional(),
    }))
    .output(z.object({
      ok: z.boolean(),
      message: z.string(),
    })),

  getReflog: oc
    .input(z.object({
      repoId: RepoId,
      ref: z.string().optional(),
      maxCount: z.number().optional(),
    }))
    .output(z.object({
      refName: z.string(),
      entries: z.array(ReflogEntry),
    })),
}
