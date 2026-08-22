import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import {
  compareVersions,
  findRunningIngit,
  inspectRunningIngit,
  repositoryUrl,
  runningIngitNeedsRestart,
  stopRunningIngit,
} from '../src/existing-server.js'

const servers: Server[] = []

async function serve(body: string, contentType: string): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind to TCP')
  return address.port
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => (
    new Promise<void>((resolve) => server.close(() => resolve()))
  )))
})

describe('running ingit discovery', () => {
  test('recognizes the health response from a running server', async () => {
    const port = await serve(
      JSON.stringify({ name: 'ingit', version: '0.3.3', pid: 12345 }),
      'application/json',
    )
    expect(await findRunningIngit('127.0.0.1', port)).toBe(`http://127.0.0.1:${port}`)
    expect(await inspectRunningIngit('127.0.0.1', port)).toEqual({
      url: `http://127.0.0.1:${port}`,
      version: '0.3.3',
      pid: 12345,
    })
  })

  test('recognizes the injected marker from older ingit versions', async () => {
    const port = await serve(
      '<script>window.__INGIT_SESSION_TOKEN__ = "token";</script>',
      'text/html',
    )
    expect(await findRunningIngit('127.0.0.1', port)).toBe(`http://127.0.0.1:${port}`)
  })

  test('ignores an unrelated service', async () => {
    const port = await serve('not ingit', 'text/plain')
    expect(await findRunningIngit('127.0.0.1', port)).toBeNull()
  })

  test('builds a repository URL with an encoded absolute path', () => {
    expect(repositoryUrl('http://127.0.0.1:8449', '/tmp/repo with spaces')).toBe(
      'http://127.0.0.1:8449/#/repository?path=%2Ftmp%2Frepo%20with%20spaces',
    )
  })

  test('restarts only older versions, including legacy unversioned servers', () => {
    expect(runningIngitNeedsRestart('0.3.2', '0.3.3')).toBe(true)
    expect(runningIngitNeedsRestart(undefined, '0.3.3')).toBe(true)
    expect(runningIngitNeedsRestart('0.3.3', '0.3.3')).toBe(false)
    expect(runningIngitNeedsRestart('0.4.0', '0.3.3')).toBe(false)
  })

  test('compares semver prereleases correctly', () => {
    expect(compareVersions('0.3.3-beta.2', '0.3.3-beta.10')).toBe(-1)
    expect(compareVersions('0.3.3-beta.10', '0.3.3')).toBe(-1)
    expect(compareVersions('v1.0.0+build.2', '1.0.0')).toBe(0)
    expect(compareVersions('not-a-version', '1.0.0')).toBeNull()
  })

  test('stops a legacy unversioned server process', async () => {
    const source = `
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          return new Response(JSON.stringify({ name: 'ingit' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        },
      })
      console.log(server.port)
    `
    const child = Bun.spawn([process.execPath, '-e', source], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    })

    try {
      const reader = child.stdout.getReader()
      const first = await reader.read()
      const port = Number(new TextDecoder().decode(first.value).trim())
      expect(Number.isSafeInteger(port)).toBe(true)

      const running = await inspectRunningIngit('127.0.0.1', port)
      expect(running).toEqual({ url: `http://127.0.0.1:${port}` })
      await stopRunningIngit(running!)

      expect(await child.exited).not.toBe(0)
      expect(await inspectRunningIngit('127.0.0.1', port)).toBeNull()
    } finally {
      child.kill()
    }
  }, 10_000)
})
