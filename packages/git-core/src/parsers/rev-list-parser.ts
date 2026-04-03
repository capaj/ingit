import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface RevListEntry {
  sha: string
  parentShas: string[]
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
