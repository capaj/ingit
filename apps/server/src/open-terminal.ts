import { spawn, type ChildProcess } from 'node:child_process'

interface TerminalLaunchCandidate {
  command: string
  args: string[]
}

type SpawnTerminal = (
  command: string,
  args: string[],
  options: {
    cwd: string
    detached: boolean
    stdio: 'ignore'
    windowsHide: boolean
  },
) => ChildProcess

function uniqueCandidates(candidates: TerminalLaunchCandidate[]): TerminalLaunchCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.args.join('\0')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function terminalLaunchCandidates(
  repoPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalLaunchCandidate[] {
  if (platform === 'win32') {
    // Modern Windows routes console applications through the user's selected
    // default terminal host. Older versions open the regular Command Prompt.
    return [{ command: env.COMSPEC?.trim() || 'cmd.exe', args: [] }]
  }

  const configuredTerminal = env.TERMINAL?.trim()
  if (platform === 'darwin') {
    return uniqueCandidates([
      ...(configuredTerminal ? [{ command: configuredTerminal, args: [] }] : []),
      { command: 'open', args: ['-a', 'Terminal', repoPath] },
    ])
  }

  return uniqueCandidates([
    ...(configuredTerminal ? [{ command: configuredTerminal, args: [] }] : []),
    // x-terminal-emulator is the system-selected alternative on Debian-family
    // desktops. Each fallback is invoked without a shell and starts in cwd.
    { command: 'x-terminal-emulator', args: [] },
    { command: 'gnome-terminal', args: [`--working-directory=${repoPath}`] },
    { command: 'konsole', args: ['--workdir', repoPath] },
    { command: 'kitty', args: ['--directory', repoPath] },
    { command: 'alacritty', args: ['--working-directory', repoPath] },
    { command: 'wezterm', args: ['start', '--cwd', repoPath] },
    { command: 'xfce4-terminal', args: [`--working-directory=${repoPath}`] },
    { command: 'mate-terminal', args: [`--working-directory=${repoPath}`] },
    { command: 'lxterminal', args: [`--working-directory=${repoPath}`] },
  ])
}

function tryLaunchTerminal(
  candidate: TerminalLaunchCandidate,
  repoPath: string,
  spawnTerminal: SpawnTerminal,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawnTerminal(candidate.command, candidate.args, {
        cwd: repoPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      let settled = false
      child.once('spawn', () => {
        if (settled) return
        settled = true
        child.unref()
        resolve(true)
      })
      child.once('error', () => {
        if (settled) return
        settled = true
        resolve(false)
      })
    } catch {
      resolve(false)
    }
  })
}

export async function openDefaultTerminal(
  repoPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  spawnTerminal: SpawnTerminal = spawn,
): Promise<void> {
  for (const candidate of terminalLaunchCandidates(repoPath, platform, env)) {
    if (await tryLaunchTerminal(candidate, repoPath, spawnTerminal)) return
  }

  throw new Error('No supported terminal application was found')
}
