import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  parseCommandLine,
  type PackageManagerInstallEvent,
  type WorktreeChangesResponse,
} from '@ingit/rpc-contract'

interface LockfileRepo {
  rootPath: string
  getWorktreeChanges(): Promise<WorktreeChangesResponse>
  stageFiles(paths: string[]): Promise<WorktreeChangesResponse>
}

export interface LockfileInstallProcess {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

export type SpawnLockfileInstall = (
  command: readonly string[],
  cwd: string,
) => LockfileInstallProcess

function spawnLockfileInstall(
  command: readonly string[],
  cwd: string,
): LockfileInstallProcess {
  const proc = Bun.spawn([...command], {
    cwd,
    stdin: null,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (!proc.stdout || typeof proc.stdout === 'number') {
    throw new Error('Package manager stdout is not readable')
  }
  if (!proc.stderr || typeof proc.stderr === 'number') {
    throw new Error('Package manager stderr is not readable')
  }

  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
  }
}

export function containsConflictMarkers(contents: string): boolean {
  return /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(contents)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveLockfilePath(rootPath: string, path: string): {
  absolutePath: string
  installDirectory: string
} | null {
  const root = resolve(rootPath)
  const absolutePath = resolve(root, path)
  const repoRelativePath = relative(root, absolutePath)

  if (
    repoRelativePath === '..'
    || repoRelativePath.startsWith(`..${sep}`)
    || repoRelativePath.length === 0
  ) {
    return null
  }

  return {
    absolutePath,
    installDirectory: dirname(absolutePath),
  }
}

async function* streamProcessOutput(
  proc: LockfileInstallProcess,
): AsyncGenerator<Extract<PackageManagerInstallEvent, { type: 'output' }>> {
  type StreamName = 'stdout' | 'stderr'

  const readers: Record<StreamName, ReadableStreamDefaultReader<Uint8Array>> = {
    stdout: proc.stdout.getReader(),
    stderr: proc.stderr.getReader(),
  }
  const decoders: Record<StreamName, TextDecoder> = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  }
  const readNext = (stream: StreamName) => (
    readers[stream].read().then((result) => ({ stream, result }))
  )
  const pending = new Map<StreamName, ReturnType<typeof readNext>>()

  const schedule = (stream: StreamName) => {
    pending.set(stream, readNext(stream))
  }

  schedule('stdout')
  schedule('stderr')

  try {
    while (pending.size > 0) {
      const { stream, result } = await Promise.race(pending.values())
      pending.delete(stream)

      if (result.done) {
        const finalText = decoders[stream].decode()
        if (finalText) yield { type: 'output', stream, text: finalText }
        continue
      }

      const text = decoders[stream].decode(result.value, { stream: true })
      if (text) yield { type: 'output', stream, text }
      schedule(stream)
    }
  } finally {
    readers.stdout.releaseLock()
    readers.stderr.releaseLock()
  }
}

export async function* installAndResolveLockfile(
  repo: LockfileRepo,
  path: string,
  fileName: string,
  command: string,
  spawn: SpawnLockfileInstall = spawnLockfileInstall,
): AsyncGenerator<PackageManagerInstallEvent> {
  const pathFileName = path.replaceAll('\\', '/').split('/').at(-1)
  if (!pathFileName || pathFileName !== fileName) {
    yield {
      type: 'complete',
      ok: false,
      error: 'The configured file name does not match the conflicted file',
    }
    return
  }

  const commandArgs = parseCommandLine(command)
  if (!commandArgs) {
    yield {
      type: 'complete',
      ok: false,
      error: 'The configured command is empty or contains an unterminated quote',
    }
    return
  }

  const resolvedPath = resolveLockfilePath(repo.rootPath, path)
  if (!resolvedPath) {
    yield {
      type: 'complete',
      ok: false,
      error: 'The lockfile path must be inside the repository',
    }
    return
  }

  try {
    const changes = await repo.getWorktreeChanges()
    const isStillConflicted = changes.unstaged.some(
      (file) => file.status === 'U' && file.path === path,
    )
    if (!isStillConflicted) {
      yield {
        type: 'complete',
        ok: false,
        error: `${path} is no longer conflicted`,
      }
      return
    }

    yield { type: 'start', command: command.trim() }
    const proc = spawn(commandArgs, resolvedPath.installDirectory)
    for await (const event of streamProcessOutput(proc)) yield event

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      yield {
        type: 'complete',
        ok: false,
        exitCode,
        error: `${commandArgs[0]} exited with code ${exitCode}`,
      }
      return
    }

    const contents = await readFile(resolvedPath.absolutePath, 'utf8')
    if (containsConflictMarkers(contents)) {
      yield {
        type: 'complete',
        ok: false,
        exitCode,
        error: 'Install finished, but conflict markers remain in the lockfile',
      }
      return
    }

    yield {
      type: 'output',
      stream: 'status',
      text: '\nInstall finished. Marking the lockfile resolved…\n',
    }
    const nextChanges = await repo.stageFiles([path])
    yield {
      type: 'complete',
      ok: true,
      exitCode,
      changes: nextChanges,
    }
  } catch (error) {
    yield {
      type: 'complete',
      ok: false,
      error: errorMessage(error),
    }
  }
}
