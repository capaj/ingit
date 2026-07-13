import { describe, expect, test } from 'bun:test'
import { copyFile, link, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  classifyAgentProcess,
  detectAgent,
  listAgentSessions,
} from '../src/agent-sessions.js'
import type { ProcessInfo } from '../src/darwin-processes.js'

function processInfo(overrides: Partial<ProcessInfo>): ProcessInfo {
  return {
    pid: 123,
    ppid: 1,
    comm: '',
    state: '',
    ttyNr: 0,
    tty: null,
    cpuTicks: 0,
    argv: [],
    command: '',
    exe: '',
    cwd: 'C:\\code\\repo',
    ...overrides,
  }
}

describe('listAgentSessions', () => {
  test.skipIf(process.platform !== 'darwin')('lists sessions without procfs on macOS', async () => {
    const result = await listAgentSessions()

    expect(Array.isArray(result.sessions)).toBe(true)
    expect(result.capabilities.displayServer).toBe('aqua')
  })

  test.skipIf(process.platform !== 'win32')('finds a live Windows Codex process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ingit-windows-agent-'))
    const executable = join(cwd, 'codex.exe')
    await link(process.execPath, executable).catch(() => copyFile(process.execPath, executable))

    const child = Bun.spawn([executable, '-e', 'setInterval(() => {}, 1000)'], {
      cwd,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
      let session: Awaited<ReturnType<typeof listAgentSessions>>['sessions'][number] | undefined
      for (let attempt = 0; attempt < 20; attempt++) {
        session = (await listAgentSessions()).sessions.find((candidate) => candidate.pid === child.pid)
        if (session) break
        await sleep(100)
      }
      expect(session).toMatchObject({
        pid: child.pid,
        agent: 'codex',
        kind: 'terminal',
        focusable: false,
      })
      expect(resolve(session?.cwd ?? '').toLowerCase()).toBe(resolve(cwd).toLowerCase())
    } finally {
      child.kill()
      await child.exited
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})

describe('Windows agent process classification', () => {
  test('detects a version-pinned Claude Code process as a terminal session', () => {
    const info = processInfo({
      comm: '2.1.207.exe',
      exe: 'C:\\Users\\me\\.local\\share\\claude\\versions\\2.1.207.exe',
      argv: ['C:\\Users\\me\\.local\\share\\claude\\versions\\2.1.207.exe'],
      command: '"C:\\Users\\me\\.local\\share\\claude\\versions\\2.1.207.exe"',
    })

    expect(detectAgent(info, 'win32')).toBe('claude')
    expect(classifyAgentProcess(info, 'claude', 'win32')).toMatchObject({
      kind: 'terminal',
      cwd: 'C:\\code\\repo',
      tty: null,
    })
  })

  test('detects an older Node-hosted Claude Code process', () => {
    const info = processInfo({
      comm: 'node.exe',
      exe: 'C:\\Program Files\\nodejs\\node.exe',
      argv: [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      ],
      command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"',
    })

    expect(detectAgent(info, 'win32')).toBe('claude')
  })

  test('detects Codex while excluding infrastructure and desktop-shell processes', () => {
    const cli = processInfo({
      comm: 'codex.exe',
      exe: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe',
      argv: ['codex.exe'],
      command: 'codex.exe',
    })
    expect(detectAgent(cli, 'win32')).toBe('codex')
    expect(detectAgent({ ...cli, argv: ['codex.exe', 'mcp-server'] }, 'win32')).toBeNull()
    expect(detectAgent({
      ...cli,
      exe: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\Codex.exe',
      command: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\Codex.exe"',
    }, 'win32')).toBeNull()
  })

  test('recognizes Windows IDE extension paths', () => {
    const info = processInfo({
      comm: 'claude.exe',
      exe: 'C:\\Users\\me\\.vscode\\extensions\\anthropic.claude-code\\claude.exe',
      argv: ['claude.exe'],
      command: 'C:\\Users\\me\\.vscode\\extensions\\anthropic.claude-code\\claude.exe',
    })

    expect(classifyAgentProcess(info, 'claude', 'win32')).toMatchObject({
      kind: 'ide',
      ide: 'vscode',
    })
  })
})
