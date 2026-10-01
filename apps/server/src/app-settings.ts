import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AppSettings {
  autoUpdate: boolean
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

export async function getAppSettings(filePath = appSettingsPath()): Promise<AppSettings> {
  const data = await readSettings(filePath)
  if (data.autoUpdate !== undefined && typeof data.autoUpdate !== 'boolean') {
    throw new Error('Invalid automatic update preference')
  }
  return { autoUpdate: data.autoUpdate ?? true }
}

export async function setAutoUpdate(autoUpdate: boolean, filePath = appSettingsPath()): Promise<AppSettings> {
  const data = await readSettings(filePath)
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify({ ...data, autoUpdate }, null, 2) + '\n', { mode: 0o600 })
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return { autoUpdate }
}
