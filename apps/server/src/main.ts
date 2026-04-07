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

const HOST = '127.0.0.1'
const PORT = 8488

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_DIST = resolve(__dirname, '../../client/dist')

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

function serveIndexHtml(res: ServerResponse, sessionToken: string): void {
  const indexPath = join(CLIENT_DIST, 'index.html')
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

async function main(): Promise<void> {
  try {
    const gitInfo = await detectGit()
    console.log(`git found: ${gitInfo.path} (version ${gitInfo.version})`)
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

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

    // Serve static files
    const safePath = url.replace(/\.\./g, '').replace(/\/+/g, '/')
    const filePath = join(CLIENT_DIST, safePath === '/' ? 'index.html' : safePath)

    if (safePath !== '/' && existsSync(filePath) && statSync(filePath).isFile()) {
      if (extname(filePath) === '.html') {
        serveIndexHtml(res, sessionToken)
      } else {
        serveStatic(res, filePath)
      }
    } else {
      serveIndexHtml(res, sessionToken)
    }
  })

  // WebSocket server — oRPC handles all RPC calls
  const wss = new WebSocketServer({ server: httpServer, path: '/rpc' })
  wss.on('connection', (ws) => {
    rpcHandler.upgrade(ws, { context: {} })
  })

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\nShutting down...')
    sessionManager.closeAll()
    httpServer.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  httpServer.listen(PORT, HOST, () => {
    console.log(`ingit server running at http://${HOST}:${PORT}`)
    console.log(`oRPC WebSocket endpoint: ws://${HOST}:${PORT}/rpc`)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
