import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RepoSession } from '@ingit/git-core'

const versions = new WeakMap<RepoSession, { expires: number; value: Promise<string> }>()

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function entries(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return []
    throw error
  })
}

/** Fingerprint ref metadata, never the working tree, objects, index, or reflogs. */
export async function readRepositoryVersion(gitDir: string): Promise<string> {
  const commonPath = await readFile(resolve(gitDir, 'commondir'), 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return '.'
    throw error
  })
  const commonDir = resolve(gitDir, commonPath.trim())
  const parts: string[] = []

  const file = async (path: string) => {
    try {
      const stat = await lstat(path, { bigint: true })
      parts.push(`${path}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
    } catch (error) {
      // Ref deletion/atomic replacement can race a scan; the next poll settles it.
      if (!isMissing(error)) throw error
    }
  }
  const tree = async (path: string): Promise<void> => {
    await Promise.all((await entries(path)).filter((entry) => !entry.name.endsWith('.lock')).map(
      (entry) => entry.isDirectory() ? tree(resolve(path, entry.name)) : file(resolve(path, entry.name)),
    ))
  }

  await Promise.all([
    file(resolve(gitDir, 'HEAD')),
    file(resolve(commonDir, 'HEAD')),
    file(resolve(commonDir, 'packed-refs')),
    tree(resolve(commonDir, 'refs')),
    // Also supports repositories using Git's reftable storage.
    tree(resolve(commonDir, 'reftable')),
    ...(commonDir !== gitDir ? [tree(resolve(gitDir, 'refs')), tree(resolve(gitDir, 'reftable'))] : []),
    entries(resolve(commonDir, 'worktrees')).then(async (worktrees) => {
      await Promise.all(worktrees.filter((entry) => entry.isDirectory()).map(
        (entry) => file(resolve(commonDir, 'worktrees', entry.name, 'HEAD')),
      ))
    }),
  ])
  return createHash('sha256').update(parts.sort().join('\n')).digest('hex')
}

export function getRepositoryVersion(session: RepoSession): Promise<string> {
  const cached = versions.get(session)
  if (cached && cached.expires > Date.now()) return cached.value
  // Multiple tabs share a scan. The weak key needs no session cleanup timer.
  const value = readRepositoryVersion(resolve(session.rootPath, session.gitDir))
  const entry = { expires: Date.now() + 1_000, value }
  versions.set(session, entry)
  void value.catch(() => {
    if (versions.get(session) === entry) versions.delete(session)
  })
  return value
}
