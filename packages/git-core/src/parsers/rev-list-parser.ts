import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

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
  return new Promise<number>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const child = spawn('git', ['rev-list', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let count = 0
    let stderrOutput = ''

    child.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString()
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

    rl.on('line', (line) => {
      const entry = parseRevListLine(line)
      if (entry) {
        count++
        onCommit(entry)
      }
    })

    child.on('close', (code, sig) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      if (sig) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      if (code !== 0) {
        reject(new Error(`git rev-list exited with code ${code}: ${stderrOutput.trim()}`))
        return
      }
      resolve(count)
    })

    child.on('error', (err) => {
      reject(err)
    })

    if (signal) {
      const onAbort = () => {
        child.kill('SIGTERM')
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('close', () => signal.removeEventListener('abort', onAbort))
    }
  })
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
  return new Promise<number>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    // Inject --format into args, before any -- separator
    const fullArgs = ['rev-list', '--format=%aN%x00%aE%x00%at%x00%ct%x00%s', ...args]

    const child = spawn('git', fullArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let count = 0
    let stderrOutput = ''
    let pendingEntry: RevListEntry | null = null

    child.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString()
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

    rl.on('line', (line) => {
      if (line.startsWith('commit ')) {
        // This is the topology line: "commit <sha> [<parent>...]"
        const rest = line.slice(7) // skip "commit "
        const parts = rest.split(' ')
        const sha = parts[0]
        const parentShas = parts.slice(1).filter((s) => s.length > 0)
        pendingEntry = { sha, parentShas }
      } else if (pendingEntry) {
        // This is the format line: authorName\0authorEmail\0authorUnix\0subject
        const parts = line.split('\0')
        const entry: RevListEntryWithMeta = {
          ...pendingEntry,
          authorName: parts[0] ?? '',
          authorEmail: parts[1] ?? '',
          authorUnix: parseInt(parts[2] ?? '0', 10),
          committerUnix: parseInt(parts[3] ?? '0', 10),
          subject: parts[4] ?? '',
        }
        count++
        onCommit(entry)
        pendingEntry = null
      }
    })

    child.on('close', (code, sig) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      if (sig) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      if (code !== 0) {
        reject(new Error(`git rev-list exited with code ${code}: ${stderrOutput.trim()}`))
        return
      }
      resolve(count)
    })

    child.on('error', (err) => {
      reject(err)
    })

    if (signal) {
      const onAbort = () => {
        child.kill('SIGTERM')
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('close', () => signal.removeEventListener('abort', onAbort))
    }
  })
}
