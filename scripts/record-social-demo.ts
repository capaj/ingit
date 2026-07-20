import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const APP_URL = process.env.INGIT_RECORD_URL ?? 'http://127.0.0.1:8488'
const WIDTH = Number(process.env.INGIT_RECORD_WIDTH ?? 1440)
const HEIGHT = Number(process.env.INGIT_RECORD_HEIGHT ?? 900)
const FPS = Number(process.env.INGIT_RECORD_FPS ?? 30)
const PRE_ACTION_DELAY_MS = Number(process.env.INGIT_RECORD_PRE_ACTION_DELAY_MS ?? 2500)
const PRE_CLICK_DELAY_MS = Number(process.env.INGIT_RECORD_PRE_CLICK_DELAY_MS ?? 900)
const OUT_DIR = process.env.INGIT_RECORD_OUT ?? join(process.cwd(), 'video-showcase')
const CHROME_PORT = Number(process.env.INGIT_CHROME_PORT ?? 9230)

type GitEnv = Record<string, string>

interface Clip {
  slug: string
  title: string
  posterTimeSeconds: number
  currentBranch?: string
  run: (page: PageDriver) => Promise<void>
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  return new Response(stream).text()
}

async function runCommand(cmd: string[], cwd?: string, env?: GitEnv): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`${cmd.join(' ')} failed with ${code}\n${stderr || stdout}`)
  }
  return stdout
}

async function fetchJson<T>(url: string, timeoutMs = 750): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`${url} returned ${res.status}`)
    return await res.json() as T
  } finally {
    clearTimeout(timer)
  }
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function git(cwd: string, args: string[], env?: GitEnv): Promise<string> {
  return runCommand(['git', ...args], cwd, env)
}

async function write(repo: string, relPath: string, content: string) {
  const abs = join(repo, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

async function append(repo: string, relPath: string, content: string) {
  const abs = join(repo, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await Bun.write(abs, `${existsSync(abs) ? await Bun.file(abs).text() : ''}${content}`)
}

async function createDemoRepo(name: string, currentBranch = 'main'): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), `ingit-social-${name}-`))
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.name', 'Ingit Demo'])
  await git(repo, ['config', 'user.email', 'demo@ingit.local'])

  let commitIndex = 0
  const baseTime = Date.UTC(2026, 6, 9, 7, 0, 0)
  const commitEnv = (): GitEnv => {
    const date = new Date(baseTime + commitIndex * 90_000).toISOString()
    commitIndex += 1
    return {
      GIT_AUTHOR_NAME: 'Ingit Demo',
      GIT_AUTHOR_EMAIL: 'demo@ingit.local',
      GIT_COMMITTER_NAME: 'Ingit Demo',
      GIT_COMMITTER_EMAIL: 'demo@ingit.local',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    }
  }

  async function commit(message: string, files: Record<string, string>) {
    for (const [relPath, content] of Object.entries(files)) await write(repo, relPath, content)
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', message], commitEnv())
  }

  await commit('chore: seed demo repository', {
    'README.md': '# ingit social demo\n\nA disposable repo for recording graph operations.\n',
  })
  await commit('feat: add product dashboard', {
    'src/dashboard.ts': 'export const dashboard = ["commits", "branches", "worktree"]\n',
  })
  await commit('feat: add graph canvas previews', {
    'src/graph-preview.ts': 'export const graphPreview = { animated: true, optimistic: true }\n',
  })

  await git(repo, ['tag', 'v0.1.0'])
  await git(repo, ['branch', 'staging'])
  const forkPoint = (await git(repo, ['rev-parse', 'HEAD'])).trim()

  await git(repo, ['checkout', '-b', 'payments'])
  await commit('feat: add payment intent graph', {
    'src/payments/intent.ts': 'export function createIntent(total: number) { return { total, state: "draft" } }\n',
  })
  await commit('feat: reconcile payment webhooks', {
    'src/payments/webhooks.ts': 'export const webhookEvents = ["created", "settled", "refunded"]\n',
  })

  await git(repo, ['checkout', 'main'])
  await commit('feat: add activity feed', {
    'src/activity-feed.ts': 'export const activityFeed = ["checkout", "merge", "rebase"]\n',
  })
  await commit('feat: polish keyboard shortcuts', {
    'docs/shortcuts.md': '# Shortcuts\n\n- enter: inspect\n- esc: clear selection\n',
  })

  await git(repo, ['checkout', '-b', 'refactor', forkPoint])
  await commit('refactor: split graph layout pipeline', {
    'src/refactor/layout.ts': 'export const stages = ["refs", "lanes", "edges", "labels"]\n',
  })
  await commit('refactor: isolate optimistic mutations', {
    'src/refactor/optimistic.ts': 'export const optimisticMutations = ["merge", "rebase", "cherry-pick"]\n',
  })

  await git(repo, ['checkout', '-b', 'banner', 'main~1'])
  await commit('fix: ship announcement banner', {
    'src/banner.ts': 'export const banner = "Graph operations now animate immediately"\n',
  })

  await git(repo, ['checkout', 'main'])
  await commit('spike: abandoned graph idea', {
    'spikes/abandoned-idea.md': 'This commit is intentionally reset away so Time Machine can recover it.\n',
  })
  await git(repo, ['reset', '--hard', 'HEAD~1'])

  await append(repo, 'notes/uncommitted.md', 'Uncommitted changes float above HEAD in the graph.\n')

  if (currentBranch !== 'main') await git(repo, ['checkout', currentBranch])
  return repo
}

interface CdpMessage {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string }
}

class CdpClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: CdpMessage['result']) => void; reject: (err: Error) => void }>()
  private listeners = new Map<string, Array<(params: unknown) => void>>()

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP error'))
        else pending.resolve(message.result)
        return
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
      }
    })
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.ws.send(payload)
    })
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
    return () => {
      const current = this.listeners.get(method) ?? []
      this.listeners.set(method, current.filter((candidate) => candidate !== listener))
    }
  }
}

async function connectPage(): Promise<{ cdp: CdpClient; chrome: ReturnType<typeof Bun.spawn> }> {
  const profile = await mkdtemp(join(tmpdir(), 'ingit-social-chrome-'))
  console.log(`Launching headless Chrome on DevTools port ${CHROME_PORT}`)
  const chrome = Bun.spawn([
    'google-chrome',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], {
    stdout: 'ignore',
    stderr: 'ignore',
  })

  let version: { webSocketDebuggerUrl?: string } | null = null
  for (let i = 0; i < 80; i++) {
    try {
      version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${CHROME_PORT}/json/version`)
      if (version.webSocketDebuggerUrl) break
    } catch {
      await sleep(100)
    }
  }
  if (!version?.webSocketDebuggerUrl) {
    chrome.kill()
    throw new Error(`Chrome did not expose DevTools on ${CHROME_PORT}`)
  }

  console.log('Chrome DevTools is reachable')
  const targets = await fetchJson<Array<{ type: string; webSocketDebuggerUrl?: string }>>(`http://127.0.0.1:${CHROME_PORT}/json/list`, 2_000)
  const pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (!pageTarget?.webSocketDebuggerUrl) throw new Error('No Chrome page target found')

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome target')), 5_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Failed to connect to Chrome target'))
    }, { once: true })
  })

  const cdp = new CdpClient(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  })

  return { cdp, chrome }
}

interface Point {
  x: number
  y: number
}

interface TextPointOptions {
  tag?: string
  exact?: boolean
  maxXRatio?: number
}

class PageDriver {
  constructor(private cdp: CdpClient) { }

  async navigate(url: string) {
    await this.cdp.send('Page.navigate', { url })
    await this.waitFor(() => document.readyState === 'complete')
    await this.installCursor()
  }

  async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
    const expression = `(${fn.toString()})()`
    const result = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result.value as T
  }

  async evaluateWithArgs<TArgs, T>(fn: (args: TArgs) => T | Promise<T>, args: TArgs): Promise<T> {
    const expression = `(${fn.toString()})(${JSON.stringify(args)})`
    const result = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result.value as T
  }

  async waitFor(fn: () => boolean, timeoutMs = 15_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await this.evaluate(fn).catch(() => false)) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for browser condition: ${fn.toString()}`)
  }

  async waitForText(text: string, timeoutMs = 15_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const hasText = await this.evaluateWithArgs((needle: string) => document.body.innerText.includes(needle), text)
        .catch(() => false)
      if (hasText) return
      await sleep(100)
    }
    const body = await this.evaluate(() => document.body.innerText).catch(() => '')
    throw new Error(`Timed out waiting for text: ${text}\nVisible text:\n${body.slice(0, 2000)}`)
  }

  async installCursor() {
    await this.evaluate(() => {
      type RecordingWindow = Window & {
        __ingitMoveRecordingCursor?: (point: { x: number; y: number }) => void
        __ingitShowRecordingClick?: (point: { x: number; y: number }) => void
      }

      const existing = document.getElementById('__ingit_recording_cursor')
      existing?.remove()

      const cursor = document.createElement('div')
      cursor.id = '__ingit_recording_cursor'
      cursor.style.cssText = [
        'position: fixed',
        'left: 0',
        'top: 0',
        'width: 28px',
        'height: 28px',
        'z-index: 2147483647',
        'pointer-events: none',
        'opacity: 0.96',
        'transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 120ms ease',
        'filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45))',
      ].join(';')
      cursor.innerHTML = [
        '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">',
        '<path d="M4 3L4 24L10.3 17.8L14.1 26L18.5 23.9L14.7 15.9H23.8L4 3Z" fill="white" stroke="#111827" stroke-width="1.7" stroke-linejoin="round"/>',
        '</svg>',
      ].join('')
      document.body.appendChild(cursor)

      const move = (point: { x: number; y: number }) => {
        cursor.style.transform = `translate3d(${Math.round(point.x - 4)}px, ${Math.round(point.y - 3)}px, 0)`
      }
      const recordingWindow = window as RecordingWindow
      recordingWindow.__ingitMoveRecordingCursor = move
      recordingWindow.__ingitShowRecordingClick = (point: { x: number; y: number }) => {
        const indicator = document.createElement('div')
        indicator.style.cssText = [
          'position: fixed',
          `left: ${Math.round(point.x - 9)}px`,
          `top: ${Math.round(point.y - 9)}px`,
          'width: 18px',
          'height: 18px',
          'box-sizing: border-box',
          'z-index: 2147483646',
          'pointer-events: none',
          'border: 3px solid #ef4444',
          'border-radius: 50%',
          'background: rgba(239, 68, 68, 0.22)',
          'box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.75)',
        ].join(';')
        document.body.appendChild(indicator)
        const animation = indicator.animate([
          { transform: 'scale(0.65)', opacity: 1 },
          { transform: 'scale(1)', opacity: 0.95, offset: 0.28 },
          { transform: 'scale(1.65)', opacity: 0 },
        ], {
          duration: 500,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
          fill: 'forwards',
        })
        animation.addEventListener('finish', () => indicator.remove(), { once: true })
      }
      move({ x: window.innerWidth - 96, y: 80 })
    })
  }

  async moveCursor(point: Point) {
    await this.evaluateWithArgs((nextPoint: Point) => {
      type RecordingWindow = Window & {
        __ingitMoveRecordingCursor?: (point: Point) => void
      }
      ;(window as RecordingWindow).__ingitMoveRecordingCursor?.(nextPoint)
    }, point).catch(() => { })
  }

  async showClickIndicator(point: Point) {
    await this.evaluateWithArgs((clickPoint: Point) => {
      type RecordingWindow = Window & {
        __ingitShowRecordingClick?: (point: Point) => void
      }
      ;(window as RecordingWindow).__ingitShowRecordingClick?.(clickPoint)
    }, point).catch(() => { })
  }

  async captureFrame(path: string) {
    const result = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 88,
      fromSurface: true,
    })
    await writeFile(path, base64ToBytes(result.data))
  }

  async startFrameSampler(dir: string): Promise<() => Promise<number>> {
    let latestFrame: string | null = null
    let running = true
    let frame = 0

    const off = this.cdp.on('Page.screencastFrame', (params) => {
      const frameParams = params as { data?: string; sessionId?: number }
      if (frameParams.data) latestFrame = frameParams.data
      if (typeof frameParams.sessionId === 'number') {
        void this.cdp.send('Page.screencastFrameAck', { sessionId: frameParams.sessionId }).catch(() => { })
      }
    })

    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 88,
      maxWidth: WIDTH,
      maxHeight: HEIGHT,
      everyNthFrame: 1,
    })

    const started = Date.now()
    while (!latestFrame && Date.now() - started < 3_000) await sleep(50)
    if (!latestFrame) {
      off()
      await this.cdp.send('Page.stopScreencast').catch(() => { })
      throw new Error('Chrome did not deliver an initial screencast frame')
    }

    const intervalMs = Math.max(1, Math.floor(1000 / FPS))
    const writer = (async () => {
      while (running) {
        if (latestFrame) {
          frame += 1
          await writeFile(join(dir, `frame-${String(frame).padStart(5, '0')}.jpg`), base64ToBytes(latestFrame))
        }
        await sleep(intervalMs)
      }
    })()

    return async () => {
      running = false
      await writer
      await this.cdp.send('Page.stopScreencast').catch(() => { })
      off()
      return frame
    }
  }

  async clickPoint(point: Point) {
    await this.moveCursor(point)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    await sleep(PRE_CLICK_DELAY_MS)
    await this.showClickIndicator(point)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }

  async hoverPoint(point: Point) {
    await this.moveCursor(point)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
  }

  async insertText(text: string) {
    await this.cdp.send('Input.insertText', { text })
  }

  async replaceText(text: string) {
    const selected = await this.evaluate(() => {
      const active = document.activeElement
      if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return false
      active.setSelectionRange(0, active.value.length)
      return true
    })
    if (!selected) throw new Error('Could not replace text because no text input is focused')
    await this.insertText(text)
  }

  async pointForText(text: string, opts: TextPointOptions = {}): Promise<Point> {
    const point = await this.evaluateWithArgs((args: TextPointOptions & { text: string }) => {
      const tag = args.tag?.toUpperCase()
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(tag ? args.tag! : 'button, div, span, label'))
      const matches = candidates
        .map((el) => {
          const rect = el.getBoundingClientRect()
          const style = window.getComputedStyle(el)
          const textContent = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
          const visible = rect.width > 0
            && rect.height > 0
            && rect.bottom >= 0
            && rect.right >= 0
            && rect.top <= window.innerHeight
            && rect.left <= window.innerWidth
            && (args.maxXRatio === undefined || rect.left + rect.width / 2 <= window.innerWidth * args.maxXRatio)
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || '1') > 0.01
          const matched = args.exact ? textContent === args.text : textContent.includes(args.text)
          return visible && matched
            ? {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              area: rect.width * rect.height,
              tag: el.tagName,
            }
            : null
        })
        .filter((match): match is { x: number; y: number; area: number; tag: string } => match !== null)
        .sort((a, b) => {
          if (a.tag === 'BUTTON' && b.tag !== 'BUTTON') return -1
          if (a.tag !== 'BUTTON' && b.tag === 'BUTTON') return 1
          return a.area - b.area
        })
      return matches[0] ?? null
    }, { text, ...opts })
    if (!point) throw new Error(`Could not find visible text: ${text}`)
    return point
  }

  async clickText(text: string, opts: TextPointOptions = {}) {
    await this.clickPoint(await this.pointForText(text, opts))
  }

  async hoverText(text: string, opts: TextPointOptions = {}) {
    await this.hoverPoint(await this.pointForText(text, opts))
  }

  async clickDialogButton(label: string) {
    const point = await this.evaluateWithArgs((label: string) => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog[open] button'))
      const button = buttons.find((candidate) => (candidate.textContent ?? '').trim() === label)
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, label)
    if (!point) throw new Error(`Could not find dialog button: ${label}`)
    await this.clickPoint(point)
  }

  async pointForSvgTitle(titleText: string): Promise<Point> {
    const point = await this.evaluateWithArgs((titleText: string) => {
      const title = Array.from(document.querySelectorAll<SVGTitleElement>('svg title'))
        .find((candidate) => (candidate.textContent ?? '').includes(titleText))
      const target = title?.parentElement
      if (!target) return null
      const rect = target.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, titleText)
    if (!point) throw new Error(`Could not find SVG title: ${titleText}`)
    return point
  }

  async clickSvgTitle(titleText: string) {
    await this.clickPoint(await this.pointForSvgTitle(titleText))
  }

  async hoverSvgTitle(titleText: string) {
    await this.hoverPoint(await this.pointForSvgTitle(titleText))
  }

  async clickButtonNearSvgTitle(buttonLabel: string, titleText: string) {
    const target = await this.pointForSvgTitle(titleText)
    const point = await this.evaluateWithArgs((args: { label: string; targetY: number }) => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .filter((button) => (button.textContent ?? '').trim() === args.label)
        .map((button) => {
          const rect = button.getBoundingClientRect()
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            distance: Math.abs(rect.top + rect.height / 2 - args.targetY),
          }
        })
        .sort((a, b) => a.distance - b.distance)
      return buttons[0] ?? null
    }, { label: buttonLabel, targetY: target.y })
    if (!point) throw new Error(`Could not find ${buttonLabel} near ${titleText}`)
    await this.clickPoint(point)
  }
}

async function recordClip(page: PageDriver, clip: Clip) {
  const repo = await createDemoRepo(clip.slug, clip.currentBranch)
  const clipDir = join(OUT_DIR, `${clip.slug}-frames`)
  await rm(clipDir, { recursive: true, force: true })
  await mkdir(clipDir, { recursive: true })
  const videoPath = join(OUT_DIR, `${clip.slug}.mp4`)

  console.log(`Recording ${clip.slug}: ${clip.title}`)
  try {
    await page.navigate(`${APP_URL}/?recording=${encodeURIComponent(`${clip.slug}-${Date.now()}`)}#/repository?path=${encodeURIComponent(repo)}`)
    await page.waitForText(repo)
    await page.waitForText('Time Machine')
    await sleep(900)
  } catch (err) {
    const debugPath = join(OUT_DIR, `${clip.slug}-load-failure.jpg`)
    await page.captureFrame(debugPath).catch(() => { })
    console.error(`Captured load failure screenshot: ${debugPath}`)
    throw err
  }

  const stopCapture = await page.startFrameSampler(clipDir)
  await sleep(PRE_ACTION_DELAY_MS)
  await clip.run(page)
  await sleep(900)
  const frameCount = await stopCapture()
  if (frameCount === 0) throw new Error(`No frames captured for ${clip.slug}`)

  await runCommand([
    'ffmpeg',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-framerate', String(FPS),
    '-i', join(clipDir, 'frame-%05d.jpg'),
    '-vf', 'scale=1280:-2,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '22',
    '-movflags', '+faststart',
    videoPath,
  ])
  await runCommand([
    'ffmpeg',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', String(clip.posterTimeSeconds),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '3',
    join(OUT_DIR, `${clip.slug}.jpg`),
  ])
  if (process.env.INGIT_KEEP_FRAMES !== '1') {
    await rm(clipDir, { recursive: true, force: true })
  }
  console.log(`Wrote ${videoPath}`)
}

const clips: Clip[] = [
  {
    slug: '01-switch-branches',
    title: 'Switch branches and recenter the graph',
    posterTimeSeconds: 3.47,
    run: async (page) => {
      await page.clickText('payments')
      await sleep(450)
      await page.clickText('Checkout', { tag: 'button', exact: true })
      await sleep(1800)
    },
  },
  {
    slug: '02-merge-preview',
    title: 'Preview and merge a feature branch',
    posterTimeSeconds: 5.9,
    run: async (page) => {
      await page.clickText('payments')
      await sleep(650)
      await page.hoverText('Merge', { tag: 'button', exact: true })
      await sleep(900)
      await page.clickText('Merge', { tag: 'button', exact: true })
      await sleep(2100)
    },
  },
  {
    slug: '03-rebase-branch',
    title: 'Rebase an experiment branch onto main',
    posterTimeSeconds: 6.15,
    currentBranch: 'refactor',
    run: async (page) => {
      await page.clickText('refactor')
      await sleep(500)
      await page.clickButtonNearSvgTitle('Rebase', 'feat: polish keyboard shortcuts')
      await sleep(400)
      await page.clickDialogButton('Rebase')
      await sleep(2400)
    },
  },
  {
    slug: '04-cherry-pick',
    title: 'Cherry-pick a side-branch commit',
    posterTimeSeconds: 6.05,
    run: async (page) => {
      await page.clickSvgTitle('fix: ship announcement banner')
      await sleep(500)
      await page.clickText('Cherry pick', { tag: 'button', exact: true })
      await sleep(350)
      await page.clickDialogButton('Cherry pick')
      await sleep(2200)
    },
  },
  {
    slug: '05-time-machine-recover',
    title: 'Recover a lost commit from Time Machine',
    posterTimeSeconds: 12.2,
    run: async (page) => {
      await page.clickText('Time Machine', { tag: 'button', exact: true })
      await page.waitForText('LOST')
      await sleep(650)
      await page.clickText('LOST')
      await sleep(500)
      await page.clickText('Recover branch', { tag: 'button', exact: true })
      await sleep(300)
      await page.replaceText('recovered-social-demo')
      await sleep(250)
      await page.clickDialogButton('Create')
      await sleep(1200)
      await page.clickText('History', { tag: 'button', exact: true })
      await page.waitForText('recovered-social-demo')
      await sleep(700)
      await page.clickText('recovered-social-demo', { maxXRatio: 0.7 })
      await sleep(2400)
    },
  },
  {
    slug: '06-create-branch',
    title: 'Create a branch from any commit',
    posterTimeSeconds: 7.35,
    run: async (page) => {
      await page.hoverSvgTitle('feat: add activity feed')
      await sleep(350)
      await page.clickText('+', { tag: 'button', exact: true })
      await sleep(250)
      await page.clickText('Branch', { tag: 'button', exact: true })
      await sleep(300)
      await page.insertText('activity-followup')
      await sleep(250)
      await page.clickDialogButton('Create')
      await sleep(1600)
    },
  },
  {
    slug: '07-move-branch',
    title: 'Move a branch label to another commit',
    posterTimeSeconds: 6.05,
    run: async (page) => {
      await page.clickText('staging')
      await sleep(500)
      await page.hoverSvgTitle('feat: polish keyboard shortcuts')
      await sleep(350)
      await page.clickButtonNearSvgTitle('Move staging here', 'feat: polish keyboard shortcuts')
      await sleep(350)
      await page.clickDialogButton('Move')
      await sleep(1800)
    },
  },
]

async function main() {
  const requested = new Set(process.argv.slice(2).filter(Boolean))
  const selected = requested.size === 0
    ? clips
    : clips.filter((clip) => requested.has(clip.slug) || requested.has(clip.slug.split('-', 1)[0]))

  if (selected.length === 0) {
    throw new Error(`No matching clips. Available: ${clips.map((clip) => clip.slug).join(', ')}`)
  }

  await mkdir(OUT_DIR, { recursive: true })
  const { cdp, chrome } = await connectPage()
  const page = new PageDriver(cdp)

  try {
    for (const clip of selected) await recordClip(page, clip)
  } finally {
    chrome.kill()
  }

  console.log(`Done. Output directory: ${OUT_DIR}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
