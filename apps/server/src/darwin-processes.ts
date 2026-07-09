import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
const MAX_BUFFER = 16 * 1024 * 1024

export interface ProcessInfo {
  pid: number
  ppid: number
  comm: string
  state: string
  ttyNr: number
  tty: string | null
  /** CPU time normalized to centiseconds, matching Linux's usual clock ticks. */
  cpuTicks: number
  argv: string[]
  command: string
  exe: string
  cwd: string
}

/** Parse ps's [[days-]hours:]minutes:seconds CPU-time format. */
export function parsePsCpuTicks(value: string): number {
  const daySplit = value.split('-')
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0
  const clock = daySplit.at(-1) ?? ''
  const parts = clock.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return 0

  const seconds = parts.at(-1) ?? 0
  const minutes = parts.at(-2) ?? 0
  const hours = parts.length === 3 ? parts[0] ?? 0 : 0
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 100)
}

/**
 * Turn ps's displayed argument string back into useful tokens. BSD ps has
 * already flattened argv, so this is necessarily best-effort for arguments
 * containing spaces, but preserves the flags/subcommands used for detection.
 */
export function splitPsArgs(command: string): string[] {
  const argv: string[] = []
  let token = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (const char of command.trim()) {
    if (escaped) {
      token += char
      escaped = false
    } else if (char === '\\' && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (char === quote) quote = null
      else token += char
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (/\s/.test(char)) {
      if (token) {
        argv.push(token)
        token = ''
      }
    } else {
      token += char
    }
  }
  if (escaped) token += '\\'
  if (token) argv.push(token)
  return argv
}

function parsePidValueOutput(output: string): Map<number, string> {
  const values = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (match) values.set(Number(match[1]), match[2] ?? '')
  }
  return values
}

/** Parse the two delimiter-safe ps queries used by readDarwinProcesses. */
export function parseDarwinPsOutput(basicsOutput: string, argsOutput: string): ProcessInfo[] {
  const commands = parsePidValueOutput(argsOutput)
  const processes: ProcessInfo[] = []

  for (const line of basicsOutput.split('\n')) {
    // `comm` is deliberately last: executable paths may contain spaces.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const ttyName = match[4] ?? ''
    const comm = match[6]?.trim() ?? ''
    const command = commands.get(pid)?.trim() || comm
    const argv = splitPsArgs(command)
    processes.push({
      pid,
      ppid: Number(match[2]),
      comm,
      state: match[3] ?? '',
      ttyNr: 0,
      tty: ttyName && ttyName !== '??' && ttyName !== '-' && ttyName !== '?'
        ? `/dev/${ttyName.replace(/^\/dev\//, '')}`
        : null,
      cpuTicks: parsePsCpuTicks(match[5] ?? ''),
      argv: argv.length > 0 ? argv : [comm],
      command,
      exe: comm,
      cwd: '',
    })
  }
  return processes
}

function outputFromError(error: unknown): string {
  const stdout = (error as { stdout?: unknown })?.stdout
  if (typeof stdout === 'string') return stdout
  if (Buffer.isBuffer(stdout)) return stdout.toString('utf8')
  return ''
}

async function runPs(args: string[]): Promise<string> {
  try {
    return (await execFile('/bin/ps', args, { maxBuffer: MAX_BUFFER })).stdout
  } catch (error) {
    // A selected process may exit between discovery and lookup. ps still
    // returns any rows it managed to read on stdout.
    return outputFromError(error)
  }
}

/** Read macOS process metadata. Cwds are populated separately for candidates. */
export async function readDarwinProcesses(pids?: number[]): Promise<ProcessInfo[]> {
  if (pids?.length === 0) return []
  const selector = pids ? ['-p', pids.join(',')] : ['-A']
  const common = ['-ww', ...selector]
  const [basics, args] = await Promise.all([
    runPs([...common,
      '-o', 'pid=', '-o', 'ppid=', '-o', 'state=', '-o', 'tty=', '-o', 'time=', '-o', 'comm=']),
    runPs([...common, '-o', 'pid=', '-o', 'args=']),
  ])
  return parseDarwinPsOutput(basics, args)
}

async function runLsof(args: string[]): Promise<string> {
  for (const executable of ['/usr/sbin/lsof', 'lsof']) {
    try {
      return (await execFile(executable, args, { maxBuffer: MAX_BUFFER })).stdout
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') continue
      // lsof exits non-zero when one of a batch of pids disappears, while
      // retaining useful records for the processes that are still alive.
      return outputFromError(error)
    }
  }
  return ''
}

/** Parse `lsof -Fpn` output selected to cwd descriptors. */
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1))
      pid = Number.isFinite(parsed) ? parsed : null
    } else if (pid !== null && line.startsWith('n')) {
      cwds.set(pid, line.slice(1))
    }
  }
  return cwds
}

/** Resolve only candidate processes, avoiding an expensive all-process lsof. */
export async function readDarwinCwds(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  const unique = [...new Set(pids)]
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100)
    if (batch.length === 0) continue
    const output = await runLsof(['-a', '-d', 'cwd', '-p', batch.join(','), '-Fpn'])
    for (const [pid, cwd] of parseLsofCwds(output)) cwds.set(pid, cwd)
  }
  return cwds
}

/** File paths currently open by a macOS process. */
export async function readDarwinOpenFiles(pid: number): Promise<string[]> {
  const output = await runLsof(['-p', String(pid), '-Fpn'])
  return output.split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
}
