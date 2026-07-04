import { useId } from 'react'
import type { AgentSession } from '@ingit/rpc-contract'

const CLAUDE_COLOR = '#D97757'

// Lobe centers of the codex "flower cloud" (ring of 7 around the middle).
const CODEX_LOBES: Array<[number, number]> = [
  [12, 6.6], [16.2, 8.6], [17.3, 13.2], [14.3, 16.9],
  [9.7, 16.9], [6.7, 13.2], [7.8, 8.6],
]

/**
 * Inline agent logos (no external assets): Anthropic's starburst for claude,
 * the Codex app's flower-cloud terminal for codex. `busy` pulses the icon.
 */
export function AgentIcon({ agent, size = 12, busy = false }: {
  agent: AgentSession['agent']
  size?: number
  busy?: boolean
}) {
  // Gradient ids must be document-unique; several icons render at once.
  const gradientId = useId()
  const common = {
    width: size,
    height: size,
    style: {
      flexShrink: 0,
      animation: busy ? 'agent-icon-pulse 1.2s ease-in-out infinite' : undefined,
    } as const,
    'aria-label': agent,
    role: 'img',
  }

  return (
    <>
      <style>{`@keyframes agent-icon-pulse { 50% { opacity: 0.25; } }`}</style>
      {agent === 'claude' ? (
        <svg viewBox="0 0 24 24" {...common}>
          <g stroke={CLAUDE_COLOR} strokeWidth="2.8" strokeLinecap="round">
            <line x1="12" y1="2.5" x2="12" y2="21.5" />
            <line x1="2.5" y1="12" x2="21.5" y2="12" />
            <line x1="5.3" y1="5.3" x2="18.7" y2="18.7" />
            <line x1="18.7" y1="5.3" x2="5.3" y2="18.7" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" {...common}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#9a86ee" />
              <stop offset="1" stopColor="#3d31ee" />
            </linearGradient>
          </defs>
          <g fill={`url(#${gradientId})`}>
            {CODEX_LOBES.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={5} />)}
            <circle cx="12" cy="12" r="6.5" />
          </g>
          <g stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M8.8 9 L11.8 12 L8.8 15" />
            <line x1="13.4" y1="15" x2="16.8" y2="15" />
          </g>
        </svg>
      )}
    </>
  )
}
