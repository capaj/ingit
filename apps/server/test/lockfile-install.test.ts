import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeChangesResponse } from '@ingit/rpc-contract'
import {
  containsConflictMarkers,
  installAndResolveLockfile,
  type LockfileInstallProcess,
} from '../src/lockfile-install.js'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    (path) => rm(path, { recursive: true, force: true }),
  ))
})

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>
}

function changes(conflicted: boolean): WorktreeChangesResponse {
  return {
    headSha: 'a'.repeat(40),
    staged: [],
    unstaged: conflicted
      ? [{ path: 'pnpm-lock.yaml', status: 'U' }]
      : [],
  }
}

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of iterator) events.push(event)
  return events
}

describe('package manager lockfile resolution', () => {
  test('recognizes standard conflict marker lines', () => {
    expect(containsConflictMarkers('<<<<<<< HEAD\nvalue\n=======\nother\n>>>>>>> branch\n')).toBe(true)
    expect(containsConflictMarkers('lockfileVersion: 9\npackages: {}\n')).toBe(false)
  })
})

describe('installAndResolveLockfile', () => {
  test('streams output and stages the resolved lockfile after a successful install', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'ingit-lockfile-install-'))
    tempDirectories.push(rootPath)
    await writeFile(join(rootPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n')

    const stagedPaths: string[][] = []
    const repo = {
      rootPath,
      getWorktreeChanges: async () => changes(true),
      stageFiles: async (paths: string[]) => {
        stagedPaths.push(paths)
        return changes(false)
      },
    }
    const spawn = (command: readonly string[], cwd: string): LockfileInstallProcess => {
      expect(command).toEqual(['pnpm', 'install'])
      expect(cwd).toBe(rootPath)
      return {
        stdout: stream('resolved dependencies\n'),
        stderr: stream('warning from package manager\n'),
        exited: Promise.resolve(0),
      }
    }

    const events = await collect(installAndResolveLockfile(
      repo,
      'pnpm-lock.yaml',
      'pnpm-lock.yaml',
      'pnpm install',
      spawn,
    ))

    expect(events.some((event) => event.type === 'output' && event.text.includes('resolved dependencies'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'complete', ok: true, exitCode: 0 })
    expect(stagedPaths).toEqual([['pnpm-lock.yaml']])
  })

  test('keeps the file unresolved when install fails', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'ingit-lockfile-install-'))
    tempDirectories.push(rootPath)
    await writeFile(join(rootPath, 'pnpm-lock.yaml'), '<<<<<<< HEAD\n=======\n>>>>>>> branch\n')

    let staged = false
    const repo = {
      rootPath,
      getWorktreeChanges: async () => changes(true),
      stageFiles: async () => {
        staged = true
        return changes(false)
      },
    }
    const spawn = (): LockfileInstallProcess => ({
      stdout: stream(''),
      stderr: stream('install error\n'),
      exited: Promise.resolve(1),
    })

    const events = await collect(installAndResolveLockfile(
      repo,
      'pnpm-lock.yaml',
      'pnpm-lock.yaml',
      'pnpm install',
      spawn,
    ))

    expect(events.at(-1)).toEqual({
      type: 'complete',
      ok: false,
      exitCode: 1,
      error: 'pnpm exited with code 1',
    })
    expect(staged).toBe(false)
  })

  test('does not stage when the package manager leaves conflict markers behind', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'ingit-lockfile-install-'))
    tempDirectories.push(rootPath)
    await writeFile(join(rootPath, 'pnpm-lock.yaml'), '<<<<<<< HEAD\n=======\n>>>>>>> branch\n')

    let staged = false
    const repo = {
      rootPath,
      getWorktreeChanges: async () => changes(true),
      stageFiles: async () => {
        staged = true
        return changes(false)
      },
    }
    const spawn = (): LockfileInstallProcess => ({
      stdout: stream('done\n'),
      stderr: stream(''),
      exited: Promise.resolve(0),
    })

    const events = await collect(installAndResolveLockfile(
      repo,
      'pnpm-lock.yaml',
      'pnpm-lock.yaml',
      'pnpm install',
      spawn,
    ))

    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      ok: false,
      error: 'Install finished, but conflict markers remain in the lockfile',
    })
    expect(staged).toBe(false)
  })

  test('rejects a resolver that does not match the conflicted basename', async () => {
    const repo = {
      rootPath: '/repo',
      getWorktreeChanges: async () => changes(true),
      stageFiles: async () => changes(false),
    }
    let spawned = false
    const spawn = (): LockfileInstallProcess => {
      spawned = true
      return {
        stdout: stream(''),
        stderr: stream(''),
        exited: Promise.resolve(0),
      }
    }

    const events = await collect(installAndResolveLockfile(
      repo,
      'pnpm-lock.yaml',
      'other.lock',
      'pnpm install',
      spawn,
    ))

    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      ok: false,
      error: 'The configured file name does not match the conflicted file',
    })
    expect(spawned).toBe(false)
  })
})
