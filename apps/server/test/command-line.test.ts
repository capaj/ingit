import { describe, expect, test } from 'bun:test'
import { parseCommandLine } from '@ingit/rpc-contract'

describe('parseCommandLine', () => {
  test('splits executable arguments without a shell', () => {
    expect(parseCommandLine('go mod tidy')).toEqual(['go', 'mod', 'tidy'])
    expect(parseCommandLine('tool resolve --project "My App"')).toEqual([
      'tool',
      'resolve',
      '--project',
      'My App',
    ])
    expect(parseCommandLine(String.raw`tool resolve My\ App`)).toEqual([
      'tool',
      'resolve',
      'My App',
    ])
  })

  test('preserves shell operators as ordinary arguments', () => {
    expect(parseCommandLine('tool resolve && echo done')).toEqual([
      'tool',
      'resolve',
      '&&',
      'echo',
      'done',
    ])
  })

  test('rejects empty commands and unterminated quotes', () => {
    expect(parseCommandLine('   ')).toBeNull()
    expect(parseCommandLine('tool "unfinished')).toBeNull()
  })
})
