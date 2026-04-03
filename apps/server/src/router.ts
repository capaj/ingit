import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiError } from '@ingit/rpc-contract'

export function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  hint?: string,
): void {
  const error: ApiError = { code, message, ...(hint !== undefined ? { hint } : {}) }
  sendJson(res, status, error)
}

/**
 * Match a URL path against a pattern like `/api/repo/:repoId/commit/:sha`.
 * Returns a params object if matched, or null if not.
 */
export function matchRoute(
  url: string,
  pattern: string,
): Record<string, string> | null {
  // Strip query string from url
  const urlPath = url.split('?')[0] ?? url

  const urlParts = urlPath.split('/')
  const patternParts = pattern.split('/')

  if (urlParts.length !== patternParts.length) return null

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]
    const u = urlParts[i]
    if (p === undefined || u === undefined) return null

    if (p.startsWith(':')) {
      const paramName = p.slice(1)
      params[paramName] = decodeURIComponent(u)
    } else if (p !== u) {
      return null
    }
  }

  return params
}
