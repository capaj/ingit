import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type RunningServer } from '../src/main.js'

let blocker: Server | null = null
let running: RunningServer | null = null
let clientDist: string | null = null

afterEach(async () => {
  running?.close()
  running = null
  if (blocker) {
    await new Promise<void>((resolve) => blocker?.close(() => resolve()))
    blocker = null
  }
  if (clientDist) {
    await rm(clientDist, { recursive: true, force: true })
    clientDist = null
  }
})

describe('startServer', () => {
  test('moves past an occupied port and exposes the ingit health endpoint', async () => {
    blocker = createServer()
    await new Promise<void>((resolve) => blocker?.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('Blocker did not bind to TCP')

    clientDist = await mkdtemp(join(tmpdir(), 'ingit-client-dist-'))
    await writeFile(join(clientDist, 'index.html'), '<!doctype html><title>ingit</title>')

    running = await startServer({
      host: '127.0.0.1',
      port: address.port,
      clientDist,
    })

    expect(running.port).toBeGreaterThan(address.port)
    const response = await fetch(`${running.url}/__ingit/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'ingit' })
  })
})
