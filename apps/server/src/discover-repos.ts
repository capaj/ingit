import { readdir, stat } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { homedir } from 'node:os'

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
])

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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export interface DirectoryEntry {
  name: string
  path: string
  isGitRepo: boolean
}

export interface DirectoryListing {
  path: string
  parentPath: string | null
  isGitRepo: boolean
  entries: DirectoryEntry[]
  error?: string
}

export async function listDirectory(folder?: string): Promise<DirectoryListing> {
  const root = resolve(expandTilde(folder ?? process.cwd()))
  const parent = dirname(root)

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (err) {
    return {
      path: root,
      parentPath: parent === root ? null : parent,
      isGitRepo: await hasGitDir(root),
      entries: [],
      error: err instanceof Error ? err.message : 'Unable to read directory',
    }
  }

  const directories = await Promise.all(entries.map(async (entry) => {
    if (IGNORED_DIRECTORY_NAMES.has(entry.name)) return null
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return null

    const path = join(root, entry.name)
    if (entry.isSymbolicLink() && !(await isDirectory(path))) return null

    return {
      name: entry.name,
      path,
      isGitRepo: await hasGitDir(path),
    }
  }))

  return {
    path: root,
    parentPath: parent === root ? null : parent,
    isGitRepo: await hasGitDir(root),
    entries: directories
      .filter((entry): entry is DirectoryEntry => entry !== null)
      .sort((a, b) => {
        if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
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
