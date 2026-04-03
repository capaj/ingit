import type { WebSocketServer, WebSocket } from 'ws'
import type { WsEvent } from '@ingit/rpc-contract'

const PING_INTERVAL_MS = 30_000

export class WsHandler {
  private clients: Set<WebSocket> = new Set()
  private pingTimer: NodeJS.Timeout | null = null

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws)

      ws.on('message', (data) => {
        // Handle any incoming messages from clients
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>
          if (msg['type'] === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }))
          }
        } catch {
          // Ignore malformed messages
        }
      })

      ws.on('pong', () => {
        // Client responded to server ping — still alive
      })

      ws.on('close', () => {
        this.clients.delete(ws)
      })

      ws.on('error', () => {
        this.clients.delete(ws)
      })

      // Send a welcome event so the client knows the connection is live
      ws.send(JSON.stringify({ type: 'connected' }))
    })

    // Start keepalive pings
    this.pingTimer = setInterval(() => {
      for (const ws of this.clients) {
        if ((ws as WebSocket & { isAlive?: boolean }).isAlive === false) {
          ws.terminate()
          this.clients.delete(ws)
          continue
        }
        ;(ws as WebSocket & { isAlive?: boolean }).isAlive = false
        ws.ping()
      }
    }, PING_INTERVAL_MS)
  }

  broadcast(event: WsEvent): void {
    const payload = JSON.stringify(event)
    for (const ws of this.clients) {
      try {
        ws.send(payload)
      } catch {
        // Client may have disconnected mid-send
        this.clients.delete(ws)
      }
    }
  }

  close(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    for (const ws of this.clients) {
      ws.terminate()
    }
    this.clients.clear()
  }
}
