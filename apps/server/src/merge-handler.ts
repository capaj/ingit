import { GitCommandError, runGit } from '@ingit/git-core'
import type { RepoSession, ResolvedRef } from '@ingit/git-core'
import type { MergePreviewResponse } from '@ingit/rpc-contract'

function buildPreviewBase(
  refName: string,
  resolved: ResolvedRef | null,
  targetRefName?: string,
  targetSha?: string,
): Omit<MergePreviewResponse, 'mergeable' | 'reason'> {
  return {
    sourceRefName: refName,
    sourceSha: resolved?.sha,
    targetRefName,
    targetSha,
    requiresFetch: resolved?.kind === 'remote',
  }
}

export async function getMergePreview(
  session: RepoSession,
  refName: string,
): Promise<MergePreviewResponse> {
  const resolved = await session.resolveRef(refName)
  if (!resolved || resolved.kind === 'tag' || resolved.kind === 'other') {
    return {
      mergeable: false,
      reason: 'missing-ref',
      ...buildPreviewBase(refName, resolved),
    }
  }

  const status = await session.getStatus()
  const base = buildPreviewBase(refName, resolved, status.branch, status.headSha)

  if (!status.branch) {
    return {
      mergeable: false,
      reason: 'detached-head',
      ...base,
    }
  }

  if (resolved.kind === 'head' && resolved.refName === status.branch) {
    return {
      mergeable: false,
      reason: 'current-branch',
      ...base,
    }
  }

  try {
    await runGit(['merge-base', '--is-ancestor', resolved.sha, 'HEAD'], session.rootPath)
    return {
      mergeable: false,
      reason: 'up-to-date',
      ...base,
    }
  } catch (err) {
    if (!(err instanceof GitCommandError) || err.code !== 1) {
      throw err
    }
  }

  return {
    mergeable: true,
    ...base,
  }
}
