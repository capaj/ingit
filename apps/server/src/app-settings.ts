import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentName } from '@ingit/rpc-contract'

export interface AppSettings {
  autoUpdate: boolean
  commitMessageAgent: AgentName | null
}

export function appSettingsPath(): string {
  const base = process.platform === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'ingit', 'settings.json')
}

async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  try {
    const data: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid ingit settings file')
    }
    return data as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // An unreadable preference must not silently re-enable updates.
    throw error
  }
}

function parseSettings(data: Record<string, unknown>): AppSettings {
  if (data.autoUpdate !== undefined && typeof data.autoUpdate !== 'boolean') {
    throw new Error('Invalid automatic update preference')
  }
  if (data.commitMessageAgent != null && data.commitMessageAgent !== 'claude' && data.commitMessageAgent !== 'codex') {
    throw new Error('Invalid commit message agent preference')
  }
  return { autoUpdate: data.autoUpdate ?? true, commitMessageAgent: data.commitMessageAgent ?? null }
}

export async function getAppSettings(filePath = appSettingsPath()): Promise<AppSettings> {
  return parseSettings(await readSettings(filePath))
}

let pendingWrite: Promise<unknown> = Promise.resolve()

function updateSettings(patch: Partial<AppSettings>, filePath: string): Promise<AppSettings> {
  const result = pendingWrite.catch(() => {}).then(() => writeSettings(patch, filePath))
  pendingWrite = result
  return result
}

async function writeSettings(patch: Partial<AppSettings>, filePath: string): Promise<AppSettings> {
  const data = await readSettings(filePath)
  const updated = { ...data, ...patch }
  const settings = parseSettings(updated)
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 })
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return settings
}

export function setAutoUpdate(autoUpdate: boolean, filePath = appSettingsPath()): Promise<AppSettings> {
  return updateSettings({ autoUpdate }, filePath)
}

export function setCommitMessageAgent(commitMessageAgent: AgentName, filePath = appSettingsPath()): Promise<AppSettings> {
  return updateSettings({ commitMessageAgent }, filePath)
}
