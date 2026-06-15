import { readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    // `.git` is a directory in a normal clone, a file in a worktree/submodule.
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Scan the immediate children of `folder` and return the absolute paths of
 * those that contain a git repository. `folder` defaults to the server's
 * current working directory.
 */
export async function discoverRepos(
  folder?: string,
): Promise<{ folder: string; repos: string[] }> {
  const root = resolve(expandTilde(folder ?? process.cwd()))

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { folder: root, repos: [] }
  }

  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => join(root, e.name))

  const repos = (await Promise.all(
    dirs.map(async (dir) => ((await hasGitDir(dir)) ? dir : null)),
  )).filter((dir): dir is string => dir !== null)

  repos.sort((a, b) => a.localeCompare(b))
  return { folder: root, repos }
}
