import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { findRunningIngit, repositoryUrl } from '../src/existing-server.js'

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
    const port = await serve(JSON.stringify({ name: 'ingit' }), 'application/json')
    expect(await findRunningIngit('127.0.0.1', port)).toBe(`http://127.0.0.1:${port}`)
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
    expect(repositoryUrl('http://127.0.0.1:8488', '/tmp/repo with spaces')).toBe(
      'http://127.0.0.1:8488/#/repository?path=%2Ftmp%2Frepo%20with%20spaces',
    )
  })
})
