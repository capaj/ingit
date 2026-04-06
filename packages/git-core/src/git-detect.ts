export interface GitInfo {
  path: string
  version: string
}

async function which(cmd: string): Promise<string> {
  const proc = Bun.spawnSync(['which', cmd], {
    stdout: 'pipe',
    stderr: 'ignore',
  })

  if (!proc.success) {
    throw new Error(`Command not found: ${cmd}`)
  }

  return proc.stdout?.toString('utf8').trim() ?? ''
}

export async function detectGit(): Promise<GitInfo> {
  let gitPath: string
  try {
    gitPath = await which('git')
  } catch {
    throw new Error('git executable not found in PATH')
  }

  let versionOutput: string
  try {
    const proc = Bun.spawnSync(['git', '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (!proc.success) {
      throw new Error('git --version failed')
    }
    versionOutput = proc.stdout?.toString('utf8').trim() ?? ''
  } catch {
    throw new Error('Failed to run git --version')
  }

  // e.g. "git version 2.43.0"
  const match = versionOutput.match(/git version (\d+\.\d+[\.\d]*)/)
  if (!match) {
    throw new Error(`Could not parse git version from: ${versionOutput}`)
  }

  return { path: gitPath, version: match[1] }
}
