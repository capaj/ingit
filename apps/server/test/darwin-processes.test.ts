import { describe, expect, test } from 'bun:test'
import {
  parseDarwinPsOutput,
  parseLsofCwds,
  parsePsCpuTicks,
  splitPsArgs,
} from '../src/darwin-processes.js'

describe('macOS process discovery parsers', () => {
  test('parses BSD ps metadata and arguments', () => {
    const basics = [
      '  123   12 S+   ttys004    00:02.34 /Users/me/.local/share/claude/versions/2.1.0',
      '  456    1 S    ??       01:02:03.45 /Users/me/.vscode/extensions/openai.chatgpt/bin/codex',
    ].join('\n')
    const args = [
      '  123 /Users/me/.local/share/claude/versions/2.1.0 --verbose',
      '  456 /Users/me/.vscode/extensions/openai.chatgpt/bin/codex app-server',
    ].join('\n')

    expect(parseDarwinPsOutput(basics, args)).toEqual([
      {
        pid: 123,
        ppid: 12,
        comm: '/Users/me/.local/share/claude/versions/2.1.0',
        state: 'S+',
        ttyNr: 0,
        tty: '/dev/ttys004',
        cpuTicks: 234,
        argv: ['/Users/me/.local/share/claude/versions/2.1.0', '--verbose'],
        command: '/Users/me/.local/share/claude/versions/2.1.0 --verbose',
        exe: '/Users/me/.local/share/claude/versions/2.1.0',
        cwd: '',
      },
      {
        pid: 456,
        ppid: 1,
        comm: '/Users/me/.vscode/extensions/openai.chatgpt/bin/codex',
        state: 'S',
        ttyNr: 0,
        tty: null,
        cpuTicks: 372345,
        argv: ['/Users/me/.vscode/extensions/openai.chatgpt/bin/codex', 'app-server'],
        command: '/Users/me/.vscode/extensions/openai.chatgpt/bin/codex app-server',
        exe: '/Users/me/.vscode/extensions/openai.chatgpt/bin/codex',
        cwd: '',
      },
    ])
  })

  test('parses CPU times with days and quoted arguments', () => {
    expect(parsePsCpuTicks('2-03:04:05.67')).toBe(18_384_567)
    expect(splitPsArgs('/path/to/codex app-server --name "hello world"')).toEqual([
      '/path/to/codex', 'app-server', '--name', 'hello world',
    ])
  })

  test('maps lsof cwd records, including paths with spaces', () => {
    expect(parseLsofCwds([
      'p123',
      'fcwd',
      'n/Users/me/src/first repo',
      'p456',
      'fcwd',
      'n/Users/me/src/second',
    ].join('\n'))).toEqual(new Map([
      [123, '/Users/me/src/first repo'],
      [456, '/Users/me/src/second'],
    ]))
  })
})
