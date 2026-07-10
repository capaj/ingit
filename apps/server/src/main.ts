import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { RPCHandler } from '@orpc/server/ws'
import { onError } from '@orpc/server'
import { detectGit } from '@ingit/git-core'
import { router, sessionManager } from './rpc-router.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8488
const SERVER_ID = 'ingit'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_CLIENT_DIST = resolve(__dirname, '../../client/dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

function getMime(filePath: string): string {
  return MIME[extname(filePath)] ?? 'application/octet-stream'
}

function serveStatic(res: ServerResponse, filePath: string): void {
  res.writeHead(200, { 'Content-Type': getMime(filePath) })
  createReadStream(filePath).pipe(res)
}

function serveIndexHtml(res: ServerResponse, clientDist: string, sessionToken: string): void {
  const indexPath = join(clientDist, 'index.html')
  if (!existsSync(indexPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Frontend not built. Run the client build first.')
    return
  }
  try {
    let html = readFileSync(indexPath, 'utf8')
    const injection = `<script>window.__INGIT_SESSION_TOKEN__ = ${JSON.stringify(sessionToken)};</script>`
    html = html.replace('</head>', `${injection}\n</head>`)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    })
    res.end(html)
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Failed to read index.html')
  }
}

export interface StartServerOptions {
  host?: string
  /** Preferred port. If taken, the next free port is used. */
  port?: number
  /** Directory holding the built client (index.html + assets). */
  clientDist?: string
}

export interface RunningServer {
  host: string
  port: number
  url: string
  close: () => void
}

function listen(
  server: ReturnType<typeof createServer>,
  host: string,
  startPort: number,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let port = startPort
    let attempts = 0

    const tryListen = (): void => {
      server.listen(port, host)
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempts < 20) {
        attempts += 1
        port += 1
        tryListen()
        return
      }
      reject(err)
    })

    server.on('listening', () => resolvePort(port))
    tryListen()
  })
}

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST
  const startPort = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT)
  const clientDist = opts.clientDist ?? process.env.INGIT_CLIENT_DIST ?? DEFAULT_CLIENT_DIST

  const gitInfo = await detectGit()
  console.log(`git found: ${gitInfo.path} (version ${gitInfo.version})`)

  const sessionToken = randomBytes(32).toString('hex')

  // oRPC WebSocket handler
  const rpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((err) => {
        console.error('RPC error:', err instanceof Error ? err.stack : err)
      }),
    ],
  })

  // HTTP server for static files only
  const httpServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = _req.url ?? '/'
    const url = (rawUrl.split('?')[0] ?? '/') as string
    const method = (_req.method ?? 'GET').toUpperCase()

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (method === 'GET' && url === '/__ingit/health') {
      const body = JSON.stringify({ name: SERVER_ID })
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      res.end(body)
      return
    }

    // Serve static files
    const safePath = url.replace(/\.\./g, '').replace(/\/+/g, '/')
    const filePath = join(clientDist, safePath === '/' ? 'index.html' : safePath)

    if (safePath !== '/' && existsSync(filePath) && statSync(filePath).isFile()) {
      if (extname(filePath) === '.html') {
        serveIndexHtml(res, clientDist, sessionToken)
      } else {
        serveStatic(res, filePath)
      }
    } else {
      serveIndexHtml(res, clientDist, sessionToken)
    }
  })

  const port = await listen(httpServer, host, startPort)
  const url = `http://${host}:${port}`

  // Attach WebSockets only after HTTP has found a free port. Attaching first
  // makes ws re-emit EADDRINUSE and crash before listen() can try the next one.
  const wss = new WebSocketServer({ server: httpServer, path: '/rpc' })
  wss.on('connection', (ws) => {
    rpcHandler.upgrade(ws, { context: {} })
  })

  // Graceful shutdown
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    sessionManager.closeAll()
    wss.close()
    httpServer.close()
  }
  const shutdown = (): void => {
    console.log('\nShutting down...')
    close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log(`ingit server running at ${url}`)
  console.log(`oRPC WebSocket endpoint: ws://${host}:${port}/rpc`)

  return { host, port, url, close }
}

// Run directly (dev: `bun src/main.ts`) but not when imported by the CLI.
if (import.meta.main) {
  startServer().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
}
