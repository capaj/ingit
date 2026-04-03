import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { detectGit } from '@ingit/git-core'
import { SessionManager } from './session-manager.js'
import { WsHandler } from './ws-handler.js'
import { handleHistoryQuery } from './history-handler.js'
import { parseBody, sendJson, sendError, matchRoute } from './router.js'
import type { OpenRepoRequest, HistoryQuery, CommitDiffResponse } from '@ingit/rpc-contract'

const HOST = '127.0.0.1'
const PORT = 8448

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_DIST = resolve(__dirname, '../../client/dist')

// MIME type map
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
  const mime = getMime(filePath)
  res.writeHead(200, { 'Content-Type': mime })
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
    // Inject session token into HTML shell via a <script> block in <head>
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

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  sessionManager: SessionManager,
  sessionToken: string,
): Promise<void> {
  // GET /api/session-token
  if (url === '/api/session-token' && method === 'GET') {
    sendJson(res, 200, { token: sessionToken })
    return
  }

  // POST /api/repo/open
  if (url === '/api/repo/open' && method === 'POST') {
    try {
      const body = await parseBody(req) as OpenRepoRequest
      if (!body || typeof (body as OpenRepoRequest).path !== 'string') {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing or invalid path field')
        return
      }
      const response = await sessionManager.openRepo((body as OpenRepoRequest).path)
      sendJson(res, 200, response)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 400, 'OPEN_REPO_FAILED', message)
    }
    return
  }

  // GET /api/repo/:repoId/refs
  const refsParams = matchRoute(url, '/api/repo/:repoId/refs')
  if (refsParams && method === 'GET') {
    const session = sessionManager.getSession(refsParams['repoId'] ?? '')
    if (!session) {
      sendError(res, 404, 'REPO_NOT_FOUND', 'No session found for this repoId')
      return
    }
    try {
      const refs = await session.getRefs()
      sendJson(res, 200, refs)
    } catch (err) {
      sendError(res, 500, 'REFS_FAILED', err instanceof Error ? err.message : String(err))
    }
    return
  }

  // GET /api/repo/:repoId/status
  const statusParams = matchRoute(url, '/api/repo/:repoId/status')
  if (statusParams && method === 'GET') {
    const session = sessionManager.getSession(statusParams['repoId'] ?? '')
    if (!session) {
      sendError(res, 404, 'REPO_NOT_FOUND', 'No session found for this repoId')
      return
    }
    try {
      const status = await session.getStatus()
      sendJson(res, 200, status)
    } catch (err) {
      sendError(res, 500, 'STATUS_FAILED', err instanceof Error ? err.message : String(err))
    }
    return
  }

  // POST /api/repo/:repoId/history
  const historyParams = matchRoute(url, '/api/repo/:repoId/history')
  if (historyParams && method === 'POST') {
    const session = sessionManager.getSession(historyParams['repoId'] ?? '')
    if (!session) {
      sendError(res, 404, 'REPO_NOT_FOUND', 'No session found for this repoId')
      return
    }
    try {
      const query = await parseBody(req) as HistoryQuery
      if (!query || typeof query !== 'object') {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing or invalid query body')
        return
      }
      const result = await handleHistoryQuery(session, query)
      sendJson(res, 200, result)
    } catch (err) {
      sendError(res, 500, 'HISTORY_FAILED', err instanceof Error ? err.message : String(err))
    }
    return
  }

  // GET /api/repo/:repoId/commit/:sha/diff  — must be matched before the commit detail route
  const diffParams = matchRoute(url, '/api/repo/:repoId/commit/:sha/diff')
  if (diffParams && method === 'GET') {
    const session = sessionManager.getSession(diffParams['repoId'] ?? '')
    if (!session) {
      sendError(res, 404, 'REPO_NOT_FOUND', 'No session found for this repoId')
      return
    }
    try {
      const sha = diffParams['sha'] ?? ''
      const changedPaths = await session.getCommitDiff(sha)
      const response: CommitDiffResponse = { sha, changedPaths }
      sendJson(res, 200, response)
    } catch (err) {
      sendError(res, 500, 'COMMIT_DIFF_FAILED', err instanceof Error ? err.message : String(err))
    }
    return
  }

  // GET /api/repo/:repoId/commit/:sha
  const commitParams = matchRoute(url, '/api/repo/:repoId/commit/:sha')
  if (commitParams && method === 'GET') {
    const session = sessionManager.getSession(commitParams['repoId'] ?? '')
    if (!session) {
      sendError(res, 404, 'REPO_NOT_FOUND', 'No session found for this repoId')
      return
    }
    try {
      const detail = await session.getCommitDetail(commitParams['sha'] ?? '')
      sendJson(res, 200, detail)
    } catch (err) {
      sendError(res, 500, 'COMMIT_DETAIL_FAILED', err instanceof Error ? err.message : String(err))
    }
    return
  }

  // No route matched
  sendError(res, 404, 'NOT_FOUND', `No API route: ${method} ${url}`)
}

async function main(): Promise<void> {
  // 1. Check git availability
  try {
    const gitInfo = await detectGit()
    console.log(`git found: ${gitInfo.path} (version ${gitInfo.version})`)
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  // 2. Generate session token
  const sessionToken = randomBytes(32).toString('hex')

  // 3. Create managers
  const sessionManager = new SessionManager()
  const wsHandler = new WsHandler()

  // 4. Create HTTP server
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/'
    const url = (rawUrl.split('?')[0] ?? '/') as string
    const method = (req.method ?? 'GET').toUpperCase()

    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Route API requests
    if (url.startsWith('/api/')) {
      handleApiRequest(req, res, url, method, sessionManager, sessionToken).catch((err) => {
        console.error('Unhandled API error:', err)
        if (!res.headersSent) {
          sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error')
        }
      })
      return
    }

    // Serve static files from the built frontend
    // Sanitize path to prevent directory traversal
    const safePath = url.replace(/\.\./g, '').replace(/\/+/g, '/')
    const filePath = join(CLIENT_DIST, safePath === '/' ? 'index.html' : safePath)

    if (safePath !== '/' && existsSync(filePath) && statSync(filePath).isFile()) {
      if (extname(filePath) === '.html') {
        // Inject token even for non-root HTML files
        serveIndexHtml(res, sessionToken)
      } else {
        serveStatic(res, filePath)
      }
    } else {
      // SPA fallback: serve index.html for any unmatched path
      serveIndexHtml(res, sessionToken)
    }
  })

  // 5. Create WebSocket server attached to the HTTP server on path '/ws'
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  wsHandler.attach(wss)

  // 6. Graceful shutdown
  const shutdown = (): void => {
    console.log('\nShutting down...')
    wsHandler.close()
    sessionManager.closeAll()
    httpServer.close(() => {
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // 7. Start listening
  httpServer.listen(PORT, HOST, () => {
    console.log(`ingit server running at http://${HOST}:${PORT}`)
    console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`)
    console.log(
      `Session token: ${sessionToken.slice(0, 8)}... (full token at GET /api/session-token)`,
    )
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
