import type { ReflogEntry, ReflogEntryKind } from '@ingit/rpc-contract'
import { runGit } from '../git-command.js'

// %x00-separated fields: sha, selector (unix date), reflog subject,
// author name, author email, committer unix, commit subject
const FORMAT = '%H%x00%gD%x00%gs%x00%an%x00%ae%x00%ct%x00%s'

export function classifyReflogMessage(message: string): ReflogEntryKind {
  const head = message.split(':', 1)[0]?.trim().toLowerCase() ?? ''

  if (head.startsWith('commit')) {
    return head.includes('amend') ? 'amend' : 'commit'
  }
  if (head.startsWith('checkout')) return 'checkout'
  if (head.startsWith('reset')) return 'reset'
  if (head.startsWith('rebase')) return 'rebase'
  if (head.startsWith('merge')) return 'merge'
  if (head.startsWith('cherry-pick')) return 'cherry-pick'
  if (head.startsWith('revert')) return 'revert'
  if (head.startsWith('pull')) return 'pull'
  if (head.startsWith('branch')) return 'branch'
  if (head.startsWith('clone')) return 'clone'
  return 'other'
}

interface RawReflogLine {
  sha: string
  selector: string
  message: string
  authorName: string
  authorEmail: string
  committerUnix: number
  subject: string
}

function parseLine(line: string): RawReflogLine | null {
  const parts = line.split('\u0000')
  if (parts.length < 7) return null
  const [sha, selector, message, authorName, authorEmail, committerUnix, subject] = parts
  if (!sha) return null
  return {
    sha,
    selector,
    message,
    authorName,
    authorEmail,
    committerUnix: parseInt(committerUnix, 10) || 0,
    subject,
  }
}

function selectorUnix(selector: string): number {
  // With --date=unix the selector renders as e.g. "HEAD@{1718000000}"
  const match = selector.match(/@\{(\d+)\}/)
  return match ? parseInt(match[1], 10) : 0
}

/**
 * Returns the subset of `shas` that are NOT reachable from any branch, tag,
 * remote ref, or the current HEAD — i.e. commits only the reflog still knows about.
 */
export async function findUnreachableShas(cwd: string, shas: string[]): Promise<Set<string>> {
  const unreachable = new Set<string>()
  if (shas.length === 0) return unreachable

  try {
    const { stdout } = await runGit(
      [
        'rev-list',
        '--ignore-missing',
        ...shas,
        '--not',
        '--branches',
        '--tags',
        '--remotes',
        'HEAD',
        '--',
      ],
      cwd,
    )
    const candidates = new Set(shas)
    for (const line of stdout.split('\n')) {
      const sha = line.trim()
      if (sha && candidates.has(sha)) unreachable.add(sha)
    }
  } catch {
    // If reachability can't be computed, treat everything as reachable
    // rather than alarming the user with false "lost commit" flags.
  }

  return unreachable
}

export async function parseReflog(
  cwd: string,
  ref: string,
  maxCount: number,
): Promise<Omit<ReflogEntry, 'refNames'>[]> {
  let stdout: string
  try {
    const result = await runGit(
      ['log', '-g', '--date=unix', `--format=${FORMAT}`, '-n', String(maxCount), ref, '--'],
      cwd,
    )
    stdout = result.stdout
  } catch {
    // Ref has no reflog (e.g. fresh repo or core.logAllRefUpdates=false)
    return []
  }

  const raw = stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseLine)
    .filter((line): line is RawReflogLine => line !== null)

  const uniqueShas = [...new Set(raw.map((line) => line.sha))]
  const unreachable = await findUnreachableShas(cwd, uniqueShas)

  return raw.map((line, i) => ({
    index: i,
    selector: `${ref}@{${i}}`,
    sha: line.sha,
    // Each reflog record stores old → new; the previous position is the
    // next (older) entry's resulting sha.
    oldSha: raw[i + 1]?.sha ?? null,
    kind: classifyReflogMessage(line.message),
    message: line.message,
    subject: line.subject,
    authorName: line.authorName,
    authorEmail: line.authorEmail,
    committerUnix: line.committerUnix,
    entryUnix: selectorUnix(line.selector),
    isReachable: !unreachable.has(line.sha),
  }))
}
