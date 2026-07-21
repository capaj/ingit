import { describe, expect, test } from 'bun:test'
import { terminalLaunchCandidates } from '../src/open-terminal.js'

describe('terminalLaunchCandidates', () => {
  test('uses the configured terminal first and passes the repo path without a shell', () => {
    const candidates = terminalLaunchCandidates('/code/my repo', 'linux', { TERMINAL: 'kitty' })

    expect(candidates[0]).toEqual({ command: 'kitty', args: [] })
    expect(candidates).toContainEqual({
      command: 'gnome-terminal',
      args: ['--working-directory=/code/my repo'],
    })
  })

  test('opens macOS Terminal at the repo path', () => {
    expect(terminalLaunchCandidates('/code/repo', 'darwin', {})).toEqual([
      { command: 'open', args: ['-a', 'Terminal', '/code/repo'] },
    ])
  })

  test('uses the Windows command processor so the default console host handles it', () => {
    expect(terminalLaunchCandidates('C:\\code\\repo', 'win32', {
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    })).toEqual([
      { command: 'C:\\Windows\\System32\\cmd.exe', args: [] },
    ])
  })
})
