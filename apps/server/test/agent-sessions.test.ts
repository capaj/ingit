import { describe, expect, test } from 'bun:test'
import { listAgentSessions } from '../src/agent-sessions.js'

describe('listAgentSessions', () => {
  test.skipIf(process.platform !== 'darwin')('lists sessions without procfs on macOS', async () => {
    const result = await listAgentSessions()

    expect(Array.isArray(result.sessions)).toBe(true)
    expect(result.capabilities.displayServer).toBe('aqua')
  })
})
