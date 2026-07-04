import { open, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const execFile = promisify(execFileCb)

export type AgentSessionKind = 'terminal' | 'ide' | 'background'
export type AgentName = 'claude' | 'codex'

export interface AgentSession {
  pid: number
  agent: AgentName
  kind: AgentSessionKind
  cwd: string
  gitRoot: string | null
  tty: string | null
  ide: string | null
  focusable: boolean
  /**
   * True when the session looks like it's actively working (inference
   * streaming / tool running), null before two CPU samples exist.
   */
  busy: boolean | null
  /** Conversation title (what the agent shows in its terminal tab), if known. */
  title: string | null
}

export interface FocusCapabilities {
  displayServer: string
  canFocusTerminals: boolean
  canInstallWindowCalls: boolean
}

export interface FocusResult {
  ok: boolean
  method?: string
  error?: string
}

// ---------------------------------------------------------------------------
// /proc scanning
// ---------------------------------------------------------------------------

interface ProcInfo {
  pid: number
  ppid: number
  comm: string
  state: string
  ttyNr: number
  /** utime + stime in clock ticks (100/s) — total CPU consumed so far. */
  cpuTicks: number
  argv: string[]
  exe: string
  cwd: string
}

async function readProc(pid: number): Promise<ProcInfo | null> {
  try {
    const [statRaw, cmdlineRaw, cwd] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      readlink(`/proc/${pid}/cwd`).catch(() => ''),
    ])
    // comm is parenthesized and may itself contain spaces/parens — split
    // around the *last* closing paren.
    const close = statRaw.lastIndexOf(')')
    const comm = statRaw.slice(statRaw.indexOf('(') + 1, close)
    const rest = statRaw.slice(close + 2).split(' ')
    const argv = cmdlineRaw.split('\0').filter(Boolean)
    return {
      pid,
      ppid: Number(rest[1] ?? 0),
      comm,
      state: rest[0] ?? '',
      ttyNr: Number(rest[4] ?? 0),
      cpuTicks: Number(rest[11] ?? 0) + Number(rest[12] ?? 0),
      argv,
      exe: argv[0] ?? '',
      cwd,
    }
  } catch {
    return null
  }
}

/** Decode stat's tty_nr into a /dev/pts path (unix98 pty majors 136-143). */
function ptsFromTtyNr(ttyNr: number): string | null {
  if (ttyNr <= 0) return null
  const major = (ttyNr >> 8) & 0xfff
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00)
  if (major < 136 || major > 143) return null
  return `/dev/pts/${(major - 136) * 256 + minor}`
}

const IDE_MARKERS: Array<{ pattern: RegExp; ide: string; cli: string }> = [
  { pattern: /\/\.vscode-insiders\//, ide: 'vscode-insiders', cli: 'code-insiders' },
  { pattern: /\/\.vscode\//, ide: 'vscode', cli: 'code' },
  { pattern: /\/\.cursor\//, ide: 'cursor', cli: 'cursor' },
  { pattern: /\/\.windsurf\//, ide: 'windsurf', cli: 'windsurf' },
]

// Plumbing processes that belong to a session but aren't one themselves.
const CLAUDE_INFRA_FLAGS = new Set(['--bg-pty-host', '--bg-spare', '--claude-in-chrome-mcp'])
// Codex subcommands that serve tooling. The VS Code extension's app-server is
// one shared process for every window (cwd = home), so it can't be attributed
// to a repo or focused meaningfully — infra too.
const CODEX_INFRA_SUBCOMMANDS = new Set(['app-server', 'mcp-server', 'login', 'logout', 'completion'])

function detectAgent(info: ProcInfo): AgentName | null {
  if (
    basename(info.exe) === 'claude' || info.comm === 'claude'
    // Version-pinned binaries live at ~/.local/share/claude/versions/<semver>,
    // so neither basename nor comm reads "claude" for those.
    || info.exe.includes('/share/claude/versions/')
  ) {
    if (info.argv.some((a) => CLAUDE_INFRA_FLAGS.has(a))) return null
    if (info.argv[1] === 'daemon') return null
    return 'claude'
  }

  // Codex's npm wrapper (`node .../bin/codex.js`) spawns the real vendored
  // binary as a child; matching on the binary alone avoids double-counting.
  if (basename(info.exe) === 'codex' || info.comm === 'codex') {
    const subcommand = info.argv[1]
    if (subcommand !== undefined && CODEX_INFRA_SUBCOMMANDS.has(subcommand)) return null
    return 'codex'
  }

  return null
}

/** Walk up from `dir` to the enclosing git repository root. */
async function findGitRoot(dir: string): Promise<string | null> {
  let current = dir
  for (let depth = 0; depth < 64; depth++) {
    try {
      // `.git` is a directory in a normal clone, a file in a worktree/submodule.
      await stat(join(current, '.git'))
      return current
    } catch { /* keep walking up */ }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

function classify(info: ProcInfo, agent: AgentName): Omit<AgentSession, 'focusable' | 'gitRoot' | 'busy' | 'title'> | null {
  if (info.state === 'Z' || !info.cwd) return null

  const ideMarker = IDE_MARKERS.find((m) => m.pattern.test(info.exe))
  if (ideMarker) {
    return { pid: info.pid, agent, kind: 'ide', cwd: info.cwd, tty: null, ide: ideMarker.ide }
  }

  const tty = ptsFromTtyNr(info.ttyNr)
  if (tty) return { pid: info.pid, agent, kind: 'terminal', cwd: info.cwd, tty, ide: null }

  return { pid: info.pid, agent, kind: 'background', cwd: info.cwd, tty: null, ide: null }
}

// ---------------------------------------------------------------------------
// Session titles
//
// The title an agent shows in its terminal tab lives in its session transcript,
// not anywhere readable via the window system. Codex keeps its rollout .jsonl
// open (visible in /proc/pid/fd). Claude doesn't, so we pair the process with
// a transcript in ~/.claude/projects/<escaped-cwd>/ whose creation time is
// closest to the process start time.
// ---------------------------------------------------------------------------

// Generous — the UI ellipsizes to the actual available width via CSS.
const TITLE_MAX_CHARS = 300
// A transcript is considered "this process's" only if created within this
// window around process start (resumed sessions fall back to newest-written).
const TRANSCRIPT_BIRTH_TOLERANCE_MS = 180_000

let bootEpochMsPromise: Promise<number> | null = null

function getBootEpochMs(): Promise<number> {
  bootEpochMsPromise ??= readFile('/proc/stat', 'utf8').then((s) => {
    const m = s.match(/^btime (\d+)$/m)
    if (!m) throw new Error('btime not found in /proc/stat')
    return Number(m[1]) * 1000
  })
  return bootEpochMsPromise
}

/** Absolute start time of a process (starttime is clock ticks since boot). */
async function procStartEpochMs(pid: number): Promise<number | null> {
  try {
    const statRaw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const rest = statRaw.slice(statRaw.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(rest[19] ?? NaN)
    if (!Number.isFinite(startTicks)) return null
    return (await getBootEpochMs()) + (startTicks / CLOCK_TICKS_PER_SEC) * 1000
  } catch {
    return null
  }
}

async function readFileSlice(path: string, bytes: number, fromEnd: boolean): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(bytes, size)
    const position = fromEnd ? size - length : 0
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, position)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function cleanTitle(text: string): string {
  const cleaned = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > TITLE_MAX_CHARS ? `${cleaned.slice(0, TITLE_MAX_CHARS - 1)}…` : cleaned
}

// Transcript user entries that aren't the user's actual request.
const TRANSCRIPT_NOISE = [
  /^Caveat: The messages below/,
  /<command-name>/,
  /<local-command-std/,
  /^This session is being continued/,
  /^<system-reminder>/,
  // IDE-integration context injections, not typed by the user.
  /^The user (opened|selected)/,
  /^\[Request interrupted/,
]

function firstSummaryIn(lines: string[]): string | null {
  for (const line of lines) {
    if (!line.includes('"type":"summary"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'summary' && typeof entry.summary === 'string') {
        return cleanTitle(entry.summary)
      }
    } catch { /* partial line at the slice boundary */ }
  }
  return null
}

/** Latest conversation summary from a Claude Code transcript, else the first user message. */
async function claudeTranscriptTitle(path: string): Promise<string | null> {
  try {
    const tail = await readFileSlice(path, 131_072, true)
    const head = await readFileSlice(path, 131_072, false)
    // Summaries land at the top on resume and get appended as the conversation
    // is compacted — prefer the newest.
    const summary = firstSummaryIn(tail.split('\n').reverse())
      ?? firstSummaryIn(head.split('\n'))
    if (summary) return summary

    for (const line of head.split('\n')) {
      if (!line.includes('"type":"user"') || line.includes('"isMeta":true')) continue
      try {
        const entry = JSON.parse(line)
        const content = entry.message?.content
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.find((c: { type?: string; text?: string }) => c.type === 'text')?.text
            : null
        if (typeof text !== 'string' || !text.trim()) continue
        const cleaned = cleanTitle(text)
        // Check both raw and cleaned: tag wrappers (<ide_opened_file>…) hide
        // the noise prefix until stripped.
        if (TRANSCRIPT_NOISE.some((re) => re.test(text.trim()) || re.test(cleaned))) continue
        return cleaned
      } catch { /* skip malformed line */ }
    }
    return null
  } catch {
    return null
  }
}

/** First user message from a Codex rollout file. */
async function codexRolloutTitle(path: string): Promise<string | null> {
  try {
    const head = await readFileSlice(path, 65_536, false)
    for (const line of head.split('\n')) {
      if (!line.includes('user_message')) continue
      try {
        const entry = JSON.parse(line)
        const message = entry.payload?.type === 'user_message' ? entry.payload.message : null
        if (typeof message === 'string' && message.trim()) return cleanTitle(message)
      } catch { /* skip malformed line */ }
    }
    return null
  } catch {
    return null
  }
}

// pid → transcript path. The pairing is stable for a process's lifetime.
const transcriptByPid = new Map<number, string>()

function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

interface ClaudeRegistryEntry {
  sessionId?: string
  status?: string
  name?: string
  nameSource?: string
}

/** Claude Code registers each live session at ~/.claude/sessions/<pid>.json. */
async function readClaudeRegistry(pid: number): Promise<ClaudeRegistryEntry | null> {
  try {
    return JSON.parse(await readFile(join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function resolveClaudeTranscript(
  pid: number,
  cwd: string,
  sessionId: string | undefined,
  claimed: Set<string>,
): Promise<string | null> {
  const cached = transcriptByPid.get(pid)
  if (cached) {
    claimed.add(cached)
    return cached
  }

  const dir = claudeProjectDir(cwd)

  // The session registry gives the exact transcript; no guessing needed.
  if (sessionId) {
    const exact = join(dir, `${sessionId}.jsonl`)
    if (await stat(exact).then(() => true, () => false)) {
      claimed.add(exact)
      transcriptByPid.set(pid, exact)
      return exact
    }
  }
  const names = await readdir(dir).catch(() => [] as string[])
  const files = (await Promise.all(names
    .filter((n) => n.endsWith('.jsonl'))
    .map(async (n) => {
      const path = join(dir, n)
      const st = await stat(path).catch(() => null)
      return st ? { path, btime: st.birthtimeMs, mtime: st.mtimeMs } : null
    })))
    .filter((f): f is { path: string; btime: number; mtime: number } => f !== null && !claimed.has(f.path))
  if (files.length === 0) return null

  const started = await procStartEpochMs(pid)
  let best: typeof files[number] | null = null
  if (started !== null) {
    best = files.reduce((a, b) => (Math.abs(a.btime - started) < Math.abs(b.btime - started) ? a : b))
    if (Math.abs(best.btime - started) > TRANSCRIPT_BIRTH_TOLERANCE_MS) best = null
  }
  // Resumed sessions reuse an old transcript — fall back to the one most
  // recently written to among those no other process claimed.
  best ??= files.reduce((a, b) => (a.mtime > b.mtime ? a : b))

  claimed.add(best.path)
  transcriptByPid.set(pid, best.path)
  return best.path
}

async function resolveCodexRollout(pid: number): Promise<string | null> {
  const cached = transcriptByPid.get(pid)
  if (cached) return cached
  try {
    const fds = await readdir(`/proc/${pid}/fd`)
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
      if (link.includes('/.codex/sessions/') && link.endsWith('.jsonl')) {
        transcriptByPid.set(pid, link)
        return link
      }
    }
  } catch { /* process gone or fds unreadable */ }
  return null
}

async function claudeSessionInfo(
  session: { pid: number; cwd: string },
  claimedTranscripts: Set<string>,
): Promise<{ title: string | null; busy: boolean | null }> {
  const registry = await readClaudeRegistry(session.pid)
  const busy = registry?.status === 'busy' ? true : registry?.status === 'idle' ? false : null

  // A deliberately assigned session name beats anything derived.
  if (registry?.name && registry.nameSource !== 'derived') {
    return { title: cleanTitle(registry.name), busy }
  }

  const transcript = await resolveClaudeTranscript(
    session.pid, session.cwd, registry?.sessionId, claimedTranscripts)
  const title = (transcript ? await claudeTranscriptTitle(transcript) : null)
    ?? (registry?.name ? cleanTitle(registry.name) : null)
  return { title, busy }
}

function pruneTranscripts(livePids: Set<number>): void {
  for (const pid of transcriptByPid.keys()) {
    if (!livePids.has(pid)) transcriptByPid.delete(pid)
  }
}

// An idle TUI waiting at its prompt sits at ~0% CPU; streaming inference
// (SSE parsing + re-rendering) or a running tool shows up well above this.
const BUSY_CPU_FRACTION = 0.02
const CLOCK_TICKS_PER_SEC = 100

const cpuSamples = new Map<number, { ticks: number; at: number; busy: boolean | null }>()

/**
 * Compare this scan's CPU counter with the previous scan's to decide whether
 * the session is actively working. Needs two samples ≥1s apart, so the first
 * call for a pid returns null.
 */
function sampleBusy(pid: number, ticks: number): boolean | null {
  const now = Date.now()
  const prev = cpuSamples.get(pid)
  if (!prev) {
    cpuSamples.set(pid, { ticks, at: now, busy: null })
    return null
  }
  const elapsedSec = (now - prev.at) / 1000
  if (elapsedSec < 1) return prev.busy
  const cpuFraction = (ticks - prev.ticks) / CLOCK_TICKS_PER_SEC / elapsedSec
  const busy = cpuFraction > BUSY_CPU_FRACTION
  cpuSamples.set(pid, { ticks, at: now, busy })
  return busy
}

function pruneCpuSamples(livePids: Set<number>): void {
  for (const pid of cpuSamples.keys()) {
    if (!livePids.has(pid)) cpuSamples.delete(pid)
  }
}

async function scanAgentProcs(): Promise<Array<{ info: ProcInfo; agent: AgentName }>> {
  const entries = await readdir('/proc')
  const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number)
  const infos = await Promise.all(pids.map(readProc))
  return infos.flatMap((info) => {
    const agent = info && detectAgent(info)
    return info && agent ? [{ info, agent }] : []
  })
}

// ---------------------------------------------------------------------------
// Focus backends
// ---------------------------------------------------------------------------

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFile('which', [cmd])
    return true
  } catch {
    return false
  }
}

const WINDOW_CALLS_ARGS = [
  'call', '--session',
  '--dest', 'org.gnome.Shell',
  '--object-path', '/org/gnome/Shell/Extensions/Windows',
  '--method',
]

function parseGVariantString(stdout: string): string {
  // gdbus prints a GVariant tuple: ('...',)
  const match = stdout.match(/\('(.*)',\)\s*$/s)
  if (!match) throw new Error(`Unexpected gdbus output: ${stdout.slice(0, 120)}`)
  return match[1]!.replace(/\\'/g, "'")
}

/** Windows via the "Window Calls" GNOME Shell extension (Wayland-capable). */
async function listShellWindows(): Promise<Array<{ id: number; pid: number; title?: string; focus?: boolean }>> {
  const { stdout } = await execFile('gdbus', [
    ...WINDOW_CALLS_ARGS, 'org.gnome.Shell.Extensions.Windows.List',
  ])
  return JSON.parse(parseGVariantString(stdout))
}

async function getShellWindowTitle(id: number): Promise<string> {
  const { stdout } = await execFile('gdbus', [
    ...WINDOW_CALLS_ARGS, 'org.gnome.Shell.Extensions.Windows.GetTitle', String(id),
  ])
  return parseGVariantString(stdout)
}

async function activateShellWindow(id: number): Promise<void> {
  await execFile('gdbus', [
    ...WINDOW_CALLS_ARGS, 'org.gnome.Shell.Extensions.Windows.Activate', String(id),
  ])
}

/** X11/XWayland windows via wmctrl. Blind to native Wayland windows. */
async function focusViaWmctrl(pids: Set<number>): Promise<boolean> {
  const { stdout } = await execFile('wmctrl', ['-lp'])
  for (const line of stdout.split('\n')) {
    const [winId, , pidStr] = line.trim().split(/\s+/)
    if (winId && pids.has(Number(pidStr))) {
      await execFile('wmctrl', ['-ia', winId])
      return true
    }
  }
  return false
}

interface FocusTarget {
  /** Controlling tty of the session (lets us tag its window via an escape code). */
  tty: string | null
  cwd: string
  agent: AgentName
}

/** Set the terminal's title through its own pty (OSC 2). */
async function setTtyTitle(tty: string, title: string): Promise<void> {
  await writeFile(tty, `\x1b]2;${title}\x07`)
}

/**
 * Terminal servers like gnome-terminal-server own every terminal window under
 * one pid, so pid matching alone is ambiguous (and window stacking reorders
 * List() between calls). Disambiguate by writing a unique marker title to the
 * session's tty and finding the window that shows it. The claude TUI manages
 * the title itself, so restore a sane one afterwards either way.
 */
async function findWindowByTtyMarker<W extends { id: number; title: string }>(
  candidates: W[],
  tty: string,
  cwd: string,
): Promise<W | null> {
  const marker = `ingit-focus-${process.pid}-${tty.replace(/\D/g, '')}`
  try {
    await setTtyTitle(tty, marker)
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(120)
      const titled = await Promise.all(candidates.map(async (w) => ({
        ...w,
        title: await getShellWindowTitle(w.id).catch(() => ''),
      })))
      const hit = titled.find((w) => w.title.includes(marker))
      if (hit) return hit
    }
    return null
  } finally {
    setTtyTitle(tty, basename(cwd)).catch(() => {})
  }
}

/**
 * Fallback when the marker isn't visible (e.g. the session sits in an
 * inactive tab, whose title the window doesn't show). Token-level compare so
 * "groas" doesn't hit "groas2"/"groas.ai".
 */
function titleMatchScore(title: string, target: FocusTarget): number {
  if (!title) return 0
  if (title.includes(target.cwd)) return 4
  const home = homedir()
  if (target.cwd.startsWith(home) && title.includes(`~${target.cwd.slice(home.length)}`)) return 3
  const tokens = title.split(/[\s:'"()[\]]+/).flatMap((t) => t.split('/'))
  if (tokens.includes(basename(target.cwd))) return 2
  if (title.toLowerCase().includes(target.agent)) return 1
  return 0
}

async function focusViaWindowCalls(pids: Set<number>, target: FocusTarget): Promise<boolean> {
  const windows = await listShellWindows()
  const candidates = windows.map((w) => ({ ...w, title: w.title ?? '' }))
    .filter((w) => pids.has(w.pid))
  if (candidates.length === 0) return false

  let winner = candidates[0]!
  if (candidates.length > 1) {
    const marked = target.tty
      ? await findWindowByTtyMarker(candidates, target.tty, target.cwd)
      : null
    if (marked) {
      winner = marked
    } else {
      const titled = await Promise.all(candidates.map(async (w) => ({
        ...w,
        title: w.title || await getShellWindowTitle(w.id).catch(() => ''),
      })))
      winner = titled.reduce((best, w) =>
        titleMatchScore(w.title, target) > titleMatchScore(best.title, target) ? w : best)
    }
  }
  await activateShellWindow(winner.id)
  return true
}

/** Try each backend to raise a window owned by any of `pids`. */
async function focusWindowOfPids(pids: Set<number>, target: FocusTarget): Promise<string | null> {
  try {
    if (await focusViaWindowCalls(pids, target)) return 'window-calls'
  } catch { /* extension missing — fall through */ }
  try {
    if (await focusViaWmctrl(pids)) return 'wmctrl'
  } catch { /* fall through */ }
  return null
}

// ---------------------------------------------------------------------------
// Capability probing (cached — tool availability doesn't change mid-run)
// ---------------------------------------------------------------------------

interface ProbedCapabilities {
  displayServer: string
  hasWmctrl: boolean
  hasWindowCalls: boolean
  ideClis: Map<string, boolean>
}

// Tool presence on PATH won't change mid-run, but the Window Calls GNOME
// extension can be installed while we're running — probe that one fresh so a
// just-installed extension works without a server restart.
let staticCapsPromise: Promise<Omit<ProbedCapabilities, 'hasWindowCalls'>> | null = null

async function getCapabilities(): Promise<ProbedCapabilities> {
  staticCapsPromise ??= (async () => {
    const [hasWmctrl, ideCliChecks] = await Promise.all([
      commandExists('wmctrl'),
      Promise.all(IDE_MARKERS.map(async (m) => [m.cli, await commandExists(m.cli)] as const)),
    ])
    return {
      displayServer: process.env.XDG_SESSION_TYPE ?? 'unknown',
      hasWmctrl,
      ideClis: new Map(ideCliChecks),
    }
  })()
  const [staticCaps, hasWindowCalls] = await Promise.all([
    staticCapsPromise,
    listShellWindows().then(() => true).catch(() => false),
  ])
  return { ...staticCaps, hasWindowCalls }
}

function ideCliFor(ide: string): string | null {
  return IDE_MARKERS.find((m) => m.ide === ide)?.cli ?? null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listAgentSessions(): Promise<{
  sessions: AgentSession[]
  capabilities: FocusCapabilities
}> {
  const [procs, caps] = await Promise.all([scanAgentProcs(), getCapabilities()])
  // On Wayland wmctrl only reaches XWayland windows — modern terminals are
  // native Wayland, so don't advertise focus support from wmctrl alone there.
  const canFocusTerminals = caps.hasWindowCalls
    || (caps.hasWmctrl && caps.displayServer !== 'wayland')
  const isGnome = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().includes('gnome')
  const canInstallWindowCalls = !caps.hasWindowCalls && isGnome

  const cpuByPid = new Map(procs.map(({ info }) => [info.pid, info.cpuTicks]))
  const base = (await Promise.all(procs
    .map(({ info, agent }) => classify(info, agent))
    // Headless/background sessions have no window to focus — not worth listing.
    .filter((s): s is Omit<AgentSession, 'focusable' | 'gitRoot' | 'busy' | 'title'> =>
      s !== null && s.kind !== 'background')
    .map(async (s) => ({
      ...s,
      gitRoot: await findGitRoot(s.cwd),
      busy: sampleBusy(s.pid, cpuByPid.get(s.pid) ?? 0),
      focusable:
        s.kind === 'ide'
          ? canFocusTerminals || (caps.ideClis.get(ideCliFor(s.ide!) ?? '') ?? false)
        : s.kind === 'terminal' ? canFocusTerminals
        : false,
    }))))
    .sort((a, b) => a.cwd.localeCompare(b.cwd) || a.pid - b.pid)

  // Sequential: several sessions in one repo compete for the same transcript
  // files, and each claim must be visible to the next resolution.
  const claimedTranscripts = new Set<string>()
  const sessions: AgentSession[] = []
  for (const s of base) {
    if (s.agent === 'claude') {
      const { title, busy } = await claudeSessionInfo(s, claimedTranscripts)
      // The registry's self-reported status beats the CPU heuristic.
      sessions.push({ ...s, title, busy: busy ?? s.busy })
    } else {
      const rollout = await resolveCodexRollout(s.pid)
      sessions.push({ ...s, title: rollout ? await codexRolloutTitle(rollout) : null })
    }
  }

  const livePids = new Set(sessions.map((s) => s.pid))
  pruneCpuSamples(livePids)
  pruneTranscripts(livePids)

  return {
    sessions,
    capabilities: { displayServer: caps.displayServer, canFocusTerminals, canInstallWindowCalls },
  }
}

const WINDOW_CALLS_UUID = 'window-calls@domandoman.xyz'

/**
 * Ask GNOME Shell to install the Window Calls extension. Shell shows its own
 * consent dialog, so this blocks until the user answers it. The extension
 * loads immediately on approval — no shell restart or re-login needed.
 */
export async function installWindowCalls(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout } = await execFile('gdbus', [
      'call', '--session',
      '--dest', 'org.gnome.Shell',
      '--object-path', '/org/gnome/Shell',
      '--method', 'org.gnome.Shell.Extensions.InstallRemoteExtension',
      WINDOW_CALLS_UUID,
    ], { timeout: 120_000 })
    const result = parseGVariantString(stdout)
    if (result === 'successful') return { ok: true }
    return {
      ok: false,
      error: result === 'cancelled'
        ? 'Installation was cancelled in the GNOME dialog'
        : `Installation failed: ${result}`,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Installation failed' }
  }
}

/** Parent chain from `pid` up to (not including) init. */
async function ancestorChain(pid: number): Promise<Array<{ pid: number; comm: string }>> {
  const chain: Array<{ pid: number; comm: string }> = []
  let cur = pid
  for (let depth = 0; depth < 32 && cur > 1; depth++) {
    const info = await readProc(cur)
    if (!info) break
    chain.push({ pid: cur, comm: info.comm })
    cur = info.ppid
  }
  return chain
}

/**
 * When the session lives inside tmux, select its window/session so it's
 * visible once the hosting terminal is raised, and return the pids of tmux
 * client processes (their ancestor terminals are the windows to raise).
 */
async function prepareTmuxTarget(chainPids: Set<number>): Promise<Set<number>> {
  const { stdout: panesOut } = await execFile('tmux', [
    'list-panes', '-a', '-F', '#{pane_pid}\t#{session_name}\t#{window_index}',
  ])
  const pane = panesOut.split('\n')
    .map((l) => l.split('\t'))
    .find(([panePid]) => chainPids.has(Number(panePid)))
  if (!pane) return new Set()

  const [, sessionName, windowIndex] = pane
  await execFile('tmux', ['select-window', '-t', `${sessionName}:${windowIndex}`]).catch(() => {})
  await execFile('tmux', ['switch-client', '-t', sessionName!]).catch(() => {})

  const { stdout: clientsOut } = await execFile('tmux', ['list-clients', '-F', '#{client_pid}'])
  const clientPids = new Set<number>()
  for (const line of clientsOut.split('\n')) {
    const clientPid = Number(line.trim())
    if (!clientPid) continue
    for (const anc of await ancestorChain(clientPid)) clientPids.add(anc.pid)
  }
  return clientPids
}

export async function focusAgentSession(pid: number): Promise<FocusResult> {
  const info = await readProc(pid)
  const agent = info && detectAgent(info)
  if (!info || !agent) {
    return { ok: false, error: `No agent session with pid ${pid} (it may have exited)` }
  }
  const session = classify(info, agent)
  if (!session) return { ok: false, error: `Process ${pid} is not a focusable agent session` }

  if (session.kind === 'ide') {
    // Direct window activation first: the IDE is an electron app whose main
    // process owns every window, and it's in the claude process's ancestor
    // chain. Title scoring picks the window showing this workspace. The CLI
    // fallback (`code <dir>`) reuses the right window but GNOME's
    // focus-stealing prevention usually swallows the raise on Wayland.
    const chain = await ancestorChain(pid)
    const chainPids = new Set(chain.map((c) => c.pid))
    const method = await focusWindowOfPids(chainPids, { tty: null, cwd: session.cwd, agent })
    if (method) return { ok: true, method }

    const cli = ideCliFor(session.ide!)
    const caps = await getCapabilities()
    if (!cli || !caps.ideClis.get(cli)) {
      return { ok: false, error: `IDE CLI for ${session.ide} not found in PATH` }
    }
    await execFile(cli, [session.cwd])
    return { ok: true, method: 'ide-cli' }
  }

  if (session.kind === 'background') {
    return { ok: false, error: 'Background session has no window to focus' }
  }

  const chain = await ancestorChain(pid)
  let targetPids = new Set(chain.map((c) => c.pid))

  if (chain.some((c) => c.comm.startsWith('tmux'))) {
    try {
      const clientAncestors = await prepareTmuxTarget(targetPids)
      if (clientAncestors.size > 0) targetPids = clientAncestors
    } catch { /* tmux gone or no clients — fall back to the raw chain */ }
  }

  const method = await focusWindowOfPids(targetPids, { tty: session.tty, cwd: session.cwd, agent })
  if (method) return { ok: true, method }

  const caps = await getCapabilities()
  return {
    ok: false,
    error: caps.hasWindowCalls || caps.hasWmctrl
      ? 'No window found for this session (terminal may be on another display)'
      : caps.displayServer === 'wayland'
        ? "No window-activation backend. Install the 'Window Calls' GNOME Shell extension (extensions.gnome.org/extension/4724)."
        : 'No window-activation backend. Install wmctrl.',
  }
}
