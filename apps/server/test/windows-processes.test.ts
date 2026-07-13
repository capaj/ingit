import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  normalizeWindowsPath,
  readWindowsProcesses,
  readWindowsProcessCwd,
  splitWindowsCommandLine,
} from '../src/windows-processes.js'

describe('Windows process discovery', () => {
  test('splits quoted Windows command lines without treating path separators as escapes', () => {
    expect(splitWindowsCommandLine(
      '"C:\\Program Files\\OpenAI\\codex.exe" app-server -c "model=gpt 5" C:\\code\\repo',
    )).toEqual([
      'C:\\Program Files\\OpenAI\\codex.exe',
      'app-server',
      '-c',
      'model=gpt 5',
      'C:\\code\\repo',
    ])
  })

  test('handles backslashes and escaped quotes according to CommandLineToArgvW rules', () => {
    expect(splitWindowsCommandLine(
      'claude.exe "say \\"hello\\"" "C:\\path with spaces\\\\"',
    )).toEqual([
      'claude.exe',
      'say "hello"',
      'C:\\path with spaces\\',
    ])
  })

  test('normalizes extended drive and UNC paths', () => {
    expect(normalizeWindowsPath('\\\\?\\C:\\code\\repo')).toBe('C:\\code\\repo')
    expect(normalizeWindowsPath('\\\\?\\UNC\\server\\share\\repo'))
      .toBe('\\\\server\\share\\repo')
  })

  test.skipIf(process.platform !== 'win32')('reads the current process metadata and cwd', async () => {
    const [info] = await readWindowsProcesses([process.pid])
    expect(info?.pid).toBe(process.pid)
    expect(resolve(info?.cwd ?? '').toLowerCase()).toBe(resolve(process.cwd()).toLowerCase())
    expect(resolve(await readWindowsProcessCwd(process.pid) ?? '').toLowerCase())
      .toBe(resolve(process.cwd()).toLowerCase())
    expect(info?.argv.length).toBeGreaterThan(0)
    expect(info?.startEpochMs).toBeGreaterThan(0)
  })
})
