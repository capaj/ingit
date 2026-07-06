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
  mergeHeadShas: z.array(CommitSha).optional(),
  rebaseHeadSha: CommitSha.optional(),
  staged: z.array(WorktreeFile),
  unstaged: z.array(WorktreeFile),
})

export const StageActionKind = z.enum(['stage', 'unstage', 'stage-all', 'unstage-all'])

export const WorktreeDiffArea = z.enum(['staged', 'unstaged'])

export const CommitActionKind = z.enum(['cherry-pick', 'revert', 'uncommit'])
export const MergePreviewReason = z.enum(['current-branch', 'detached-head', 'up-to-date', 'missing-ref'])
export const RefActionKind = z.enum(['checkout', 'push', 'fetch', 'delete', 'move', 'reset', 'create', 'create-tag'])

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

export const DirectoryEntry = z.object({
  name: z.string(),
  path: z.string(),
  isGitRepo: z.boolean(),
})

export const AgentSessionKind = z.enum(['terminal', 'ide', 'background'])
export const AgentName = z.enum(['claude', 'codex'])

export const AgentSession = z.object({
  pid: z.number(),
  /** Which coding agent this session runs. */
  agent: AgentName,
  kind: AgentSessionKind,
  /** Working directory of the claude process (usually the repo it works in). */
  cwd: z.string(),
  /** Root of the git repository containing cwd, or null when outside any repo. */
  gitRoot: z.string().nullable(),
  /** Controlling terminal (e.g. /dev/pts/12) for terminal sessions. */
  tty: z.string().nullable(),
  /** IDE hosting the session ('vscode', 'cursor', ...) for ide sessions. */
  ide: z.string().nullable(),
  /** Whether focusAgentSession can bring this session's window to front. */
  focusable: z.boolean(),
  /**
   * True when the session looks actively working (inference streaming / tool
   * running), false when idle, null before enough CPU samples exist.
   */
  busy: z.boolean().nullable(),
  /** Conversation title (what the agent shows in its terminal tab), if known. */
  title: z.string().nullable(),
})

export const FocusCapabilities = z.object({
  /** 'x11' | 'wayland' | 'unknown' */
  displayServer: z.string(),
  /** True when a terminal-window activation backend is available. */
  canFocusTerminals: z.boolean(),
  /**
   * True when terminal focus is unavailable but installing the "Window Calls"
   * GNOME Shell extension (via installWindowCalls) would enable it.
   */
  canInstallWindowCalls: z.boolean(),
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

  listDirectory: oc
    .input(z.object({ folder: z.string().optional() }))
    .output(z.object({
      path: z.string(),
      parentPath: z.string().nullable(),
      isGitRepo: z.boolean(),
      entries: z.array(DirectoryEntry),
      error: z.string().optional(),
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

  getWorktreeFileDiff: oc
    .input(z.object({
      repoId: RepoId,
      path: z.string(),
      area: WorktreeDiffArea,
      // Original path for staged renames/copies, so the patch shows the rename.
      oldPath: z.string().optional(),
    }))
    .output(z.object({
      path: z.string(),
      area: WorktreeDiffArea,
      patchText: z.string(),
      isBinary: z.boolean(),
    })),

  commit: oc
    .input(z.object({
      repoId: RepoId,
      message: z.string().min(1),
      // Pass --no-verify to skip pre-commit / commit-msg hooks.
      noVerify: z.boolean().optional(),
    }))
    .output(z.object({
      ok: z.boolean(),
      headSha: CommitSha,
      changes: WorktreeChanges,
    })),

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

  listAgentSessions: oc
    .input(z.object({}))
    .output(z.object({
      sessions: z.array(AgentSession),
      capabilities: FocusCapabilities,
    })),

  focusAgentSession: oc
    .input(z.object({
      pid: z.number(),
      /**
       * The session's workspace cwd. Needed when the process's own cwd isn't
       * the workspace (codex app-server hosts several conversations from $HOME).
       */
      cwd: z.string().optional(),
    }))
    .output(z.object({
      ok: z.boolean(),
      /** How the focus was performed ('ide-cli', 'window-calls', 'wmctrl'). */
      method: z.string().optional(),
      error: z.string().optional(),
    })),

  /**
   * Prompt the user (via GNOME's native consent dialog) to install the
   * "Window Calls" shell extension that terminal-window focusing needs on
   * GNOME Wayland.
   */
  installWindowCalls: oc
    .input(z.object({}))
    .output(z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    })),
}
