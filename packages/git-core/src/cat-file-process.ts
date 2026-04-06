export interface ObjectInfo {
  oid: string
  type: string
  size: number
}

export interface ObjectContents extends ObjectInfo {
  data: Buffer
}

export class CatFileProcess {
  private proc: Bun.Subprocess
  private buffer: Buffer = Buffer.alloc(0)
  private queue: Array<{
    resolve: (data: Buffer) => void
    reject: (err: unknown) => void
    neededBytes: number | null
    needsTrailingNewline: boolean
    headerResolver?: (line: string) => { bytes: number; needsTrailingNewline: boolean } | null
  }> = []
  private closed = false
  private requestChain: Promise<void> = Promise.resolve()

  constructor(cwd: string) {
    this.proc = Bun.spawn(['git', 'cat-file', '--batch-command'], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      onExit: (_proc, _code, _signal, error) => {
        this.closed = true
        this.failPending(error ?? new Error('cat-file process closed'))
      },
    })

    void this.pumpStdout()
  }

  private tryFlush(): void {
    while (this.queue.length > 0) {
      const item = this.queue[0]

      if (item.neededBytes === null && item.headerResolver) {
        // waiting for a header line
        const nlIdx = this.buffer.indexOf('\n')
        if (nlIdx === -1) return
        const line = this.buffer.subarray(0, nlIdx).toString('utf8')
        this.buffer = this.buffer.subarray(nlIdx + 1)
        const bytes = item.headerResolver(line)
        if (bytes === null) {
          // missing object — resolve with empty sentinel
          item.resolve(Buffer.from(line))
          this.queue.shift()
        } else if (bytes.bytes === 0 && !bytes.needsTrailingNewline) {
          item.resolve(Buffer.from(line))
          this.queue.shift()
        } else {
          item.neededBytes = bytes.bytes
          item.needsTrailingNewline = bytes.needsTrailingNewline
          // fall through to read body
        }
      }

      if (item.neededBytes !== null) {
        const total = item.neededBytes + (item.needsTrailingNewline ? 1 : 0)
        if (this.buffer.length < total) return
        const data = this.buffer.subarray(0, item.neededBytes)
        this.buffer = this.buffer.subarray(total)
        item.resolve(data)
        this.queue.shift()
      }
    }
  }

  private async pumpStdout(): Promise<void> {
    const stdout = this.proc.stdout
    if (!stdout || typeof stdout === 'number') {
      this.closed = true
      this.failPending(new Error('cat-file stdout is not readable'))
      return
    }

    const reader = stdout.getReader()

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue

        this.buffer = Buffer.concat([this.buffer, Buffer.from(value)] as const)
        this.tryFlush()
      }
    } catch (err) {
      this.closed = true
      this.failPending(err)
    } finally {
      reader.releaseLock()
    }
  }

  private failPending(err: unknown): void {
    for (const item of this.queue) {
      item.reject(err)
    }
    this.queue = []
  }

  private sendCommand(command: string): void {
    if (this.closed) throw new Error('CatFileProcess is closed')
    const stdin = this.proc.stdin
    if (!stdin || typeof stdin === 'number') {
      throw new Error('CatFileProcess stdin is not writable')
    }
    stdin.write(command + '\n')
    stdin.flush()
  }

  private enqueue(
    command: string,
    headerResolver: (line: string) => { bytes: number; needsTrailingNewline: boolean } | null,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.requestChain = this.requestChain.then(() => {
        return new Promise<void>((chainResolve) => {
          if (this.closed) {
            reject(new Error('CatFileProcess is closed'))
            chainResolve()
            return
          }

          this.queue.push({
            resolve: (data) => {
              resolve(data)
              chainResolve()
            },
            reject: (err) => {
              reject(err)
              chainResolve()
            },
            neededBytes: null,
            needsTrailingNewline: false,
            headerResolver,
          })

          try {
            this.sendCommand(command)
          } catch (err) {
            const last = this.queue.pop()
            if (last) {
              last.reject(err)
            }
            reject(err)
            chainResolve()
          }
        })
      })
    })
  }

  async info(oid: string): Promise<ObjectInfo | null> {
    const data = await this.enqueue(`info ${oid}`, (line) => {
      // "<oid> <type> <size>" or "<oid> missing"
      if (line.endsWith(' missing') || line === 'missing') return null
      return { bytes: 0, needsTrailingNewline: false }
    })

    const line = data.toString('utf8')
    if (line.endsWith(' missing') || line === 'missing') return null

    // For info command, we get a header line with no body bytes
    const parts = line.trim().split(' ')
    if (parts.length < 3) return null
    return { oid: parts[0], type: parts[1], size: parseInt(parts[2], 10) }
  }

  async contents(oid: string): Promise<ObjectContents | null> {
    const box: { header: { oid: string; type: string; size: number } | null } = { header: null }

    const data = await this.enqueue(`contents ${oid}`, (line) => {
      if (line.endsWith(' missing') || line === 'missing') return null
      const parts = line.trim().split(' ')
      if (parts.length < 3) return null
      const size = parseInt(parts[2], 10)
      box.header = { oid: parts[0] ?? '', type: parts[1] ?? '', size }
      return { bytes: size, needsTrailingNewline: true }
    })

    const headerLine = data.toString('utf8')
    // If data is actually the sentinel (missing), check
    if (headerLine.endsWith(' missing') || headerLine === 'missing') return null

    if (box.header === null) return null

    return { oid: box.header.oid, type: box.header.type, size: box.header.size, data: Buffer.from(data) }
  }

  close(): void {
    this.closed = true
    const stdin = this.proc.stdin
    if (stdin && typeof stdin !== 'number') {
      stdin.end()
    }
  }
}
