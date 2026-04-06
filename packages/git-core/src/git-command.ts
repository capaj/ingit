import { createAbortError, readStreamText } from './bun-process.js'

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
  return runGitWithBun(args, cwd, opts)
}

async function runGitWithBun(
  args: string[],
  cwd: string,
  opts: GitRunOptions,
): Promise<GitRunResult> {
  const { timeout = 30000, signal } = opts

  if (signal?.aborted) {
    throw createAbortError()
  }

  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdin: null,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    killSignal: 'SIGTERM',
  })

  let timedOut = false
  const timeoutId = timeout > 0
    ? setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, timeout)
    : null

  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      readStreamText(proc.stdout),
      readStreamText(proc.stderr),
    ])

    if (signal?.aborted || proc.signalCode === 'SIGTERM' && signal?.aborted) {
      throw createAbortError()
    }

    if (timedOut) {
      throw new GitCommandError(args, -1, stderr)
    }

    if (code !== 0) {
      throw new GitCommandError(args, code, stderr)
    }

    return { stdout, stderr, code }
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
  }
}

export async function runGitLines(
  args: string[],
  cwd: string,
  opts: GitRunOptions = {},
): Promise<string[]> {
  const { stdout } = await runGit(args, cwd, opts)
  return stdout.split('\n').filter((line) => line.length > 0)
}
