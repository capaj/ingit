import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GitInfo {
  path: string
  version: string
}

async function which(cmd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('which', [cmd], { encoding: 'utf8' })
    return stdout.trim()
  } catch {
    throw new Error(`Command not found: ${cmd}`)
  }
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
    const { stdout } = await execFileAsync('git', ['--version'], { encoding: 'utf8' })
    versionOutput = stdout.trim()
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
