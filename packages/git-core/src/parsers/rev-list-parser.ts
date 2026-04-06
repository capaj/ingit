import { createAbortError, readStreamLines, readStreamText, requireReadableStream } from '../bun-process.js'

export interface RevListEntry {
  sha: string
  parentShas: string[]
}

export interface RevListEntryWithMeta extends RevListEntry {
  authorName: string
  authorEmail: string
  authorUnix: number
  committerUnix: number
  subject: string
}

export function parseRevListLine(line: string): RevListEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const parts = trimmed.split(' ')
  if (parts.length === 0 || !parts[0]) return null

  const sha = parts[0]
  const parentShas = parts.slice(1).filter((s) => s.length > 0)

  return { sha, parentShas }
}

/**
 * Stream rev-list with --parents only (topology).
 */
export function streamRevList(
  args: string[],
  cwd: string,
  onCommit: (entry: RevListEntry) => void,
  signal?: AbortSignal,
): Promise<number> {
  return streamRevListInternal(args, cwd, onCommit, signal)
}

/**
 * Stream rev-list with --parents AND --format to get topology + metadata
 * in a single git process. Uses format: authorName\0authorEmail\0authorUnix\0subject
 *
 * Output per commit is two lines:
 *   commit <sha> [<parent>...]
 *   <authorName>\0<authorEmail>\0<authorUnix>\0<committerUnix>\0<subject>
 */
export function streamRevListWithMeta(
  args: string[],
  cwd: string,
  onCommit: (entry: RevListEntryWithMeta) => void,
  signal?: AbortSignal,
): Promise<number> {
  return streamRevListWithMetaInternal(args, cwd, onCommit, signal)
}

async function streamRevListInternal(
  args: string[],
  cwd: string,
  onCommit: (entry: RevListEntry) => void,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) {
    throw createAbortError()
  }

  const proc = spawnRevListProcess(['rev-list', ...args], cwd, signal)
  const stdout = requireReadableStream(proc.stdout, 'git rev-list stdout')
  const stderrPromise = readStreamText(proc.stderr)
  let count = 0

  await readStreamLines(stdout, (line) => {
    const entry = parseRevListLine(line)
    if (!entry) {
      return
    }

    count++
    onCommit(entry)
  })

  await assertRevListExit(proc, stderrPromise, signal)
  return count
}

async function streamRevListWithMetaInternal(
  args: string[],
  cwd: string,
  onCommit: (entry: RevListEntryWithMeta) => void,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) {
    throw createAbortError()
  }

  const proc = spawnRevListProcess(
    ['rev-list', '--format=%aN%x00%aE%x00%at%x00%ct%x00%s', ...args],
    cwd,
    signal,
  )
  const stdout = requireReadableStream(proc.stdout, 'git rev-list stdout')
  const stderrPromise = readStreamText(proc.stderr)
  let count = 0
  let pendingEntry: RevListEntry | null = null

  await readStreamLines(stdout, (line) => {
    if (line.startsWith('commit ')) {
      const rest = line.slice(7)
      const parts = rest.split(' ')
      pendingEntry = {
        sha: parts[0] ?? '',
        parentShas: parts.slice(1).filter((s) => s.length > 0),
      }
      return
    }

    if (!pendingEntry) {
      return
    }

    const parts = line.split('\0')
    const entry: RevListEntryWithMeta = {
      ...pendingEntry,
      authorName: parts[0] ?? '',
      authorEmail: parts[1] ?? '',
      authorUnix: parseInt(parts[2] ?? '0', 10),
      committerUnix: parseInt(parts[3] ?? '0', 10),
      subject: parts[4] ?? '',
    }

    pendingEntry = null
    count++
    onCommit(entry)
  })

  await assertRevListExit(proc, stderrPromise, signal)
  return count
}

function spawnRevListProcess(args: string[], cwd: string, signal?: AbortSignal): Bun.Subprocess {
  return Bun.spawn(['git', ...args], {
    cwd,
    stdin: null,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    killSignal: 'SIGTERM',
  })
}

async function assertRevListExit(
  proc: Bun.Subprocess,
  stderrPromise: Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
  const [code, stderrOutput] = await Promise.all([proc.exited, stderrPromise])

  if (signal?.aborted || proc.signalCode) {
    throw createAbortError()
  }

  if (code !== 0) {
    throw new Error(`git rev-list exited with code ${code}: ${stderrOutput.trim()}`)
  }
}
