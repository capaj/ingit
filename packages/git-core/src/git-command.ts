import { execFile } from 'node:child_process'

export class GitCommandError extends Error {
  readonly code: number
  readonly stderr: string
  readonly args: string[]

  constructor(args: string[], code: number, stderr: string) {
    super(`git ${args.join(' ')} exited with code ${code}: ${stderr.trim()}`)
    this.name = 'GitCommandError'
    this.code = code
    this.stderr = stderr
    this.args = args
  }
}

export interface GitRunResult {
  stdout: string
  stderr: string
  code: number
}

export interface GitRunOptions {
  timeout?: number
  signal?: AbortSignal
}

export function runGit(
  args: string[],
  cwd: string,
  opts: GitRunOptions = {},
): Promise<GitRunResult> {
  const { timeout = 30000, signal } = opts

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const child = execFile('git', args, { cwd, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }

      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
        const exitCode = typeof code === 'number' ? code : -1
        // execFile wraps non-zero exit as an error; extract actual exit code
        const exitSignal = (err as NodeJS.ErrnoException & { signal?: string }).signal
        if (exitSignal === 'SIGTERM') {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const realCode = (err as { code?: unknown }).code === 'ETIMEDOUT'
          ? -1
          : ((err as NodeJS.ErrnoException & { status?: number }).status ?? exitCode)
        reject(new GitCommandError(args, realCode, stderr as unknown as string))
        return
      }

      resolve({ stdout: stdout as unknown as string, stderr: stderr as unknown as string, code: 0 })
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

export async function runGitLines(
  args: string[],
  cwd: string,
  opts: GitRunOptions = {},
): Promise<string[]> {
  const { stdout } = await runGit(args, cwd, opts)
  return stdout.split('\n').filter((line) => line.length > 0)
}
