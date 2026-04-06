export function createAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function requireReadableStream(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | number | null | undefined,
  label: string,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  if (!stream || typeof stream === 'number') {
    throw new Error(`${label} is not readable`)
  }
  return stream
}

export async function readStreamText(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | number | null | undefined,
): Promise<string> {
  if (!stream || typeof stream === 'number') {
    return ''
  }
  return new Response(stream).text()
}

export async function readStreamLines(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue

      pending += decoder.decode(value, { stream: true })
      pending = flushCompleteLines(pending, onLine)
    }

    pending += decoder.decode()
    if (pending.length > 0) {
      onLine(stripTrailingCarriageReturn(pending))
    }
  } finally {
    reader.releaseLock()
  }
}

function flushCompleteLines(buffer: string, onLine: (line: string) => void): string {
  let lineStart = 0
  let newlineIndex = buffer.indexOf('\n', lineStart)

  while (newlineIndex !== -1) {
    onLine(stripTrailingCarriageReturn(buffer.slice(lineStart, newlineIndex)))
    lineStart = newlineIndex + 1
    newlineIndex = buffer.indexOf('\n', lineStart)
  }

  return buffer.slice(lineStart)
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
