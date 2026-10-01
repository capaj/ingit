import { spawn } from 'node:child_process'
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { appSettingsPath, getAppSettings } from '@ingit/server/app-settings'
import { compareVersions } from './existing-server.js'

const PACKAGE = '@ingit/cli'
const REGISTRY = 'https://registry.npmjs.org/@ingit%2fcli/latest'
const INSTALL_TIMEOUT = 120_000
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
interface CommandResult { code: number | null; stdout: string }
export type RunCommand = (manager: PackageManager, args: string[], install?: boolean) => Promise<CommandResult>

// These commands run from home so a repository's packageManager/config cannot
// switch the manager (or registry) used for the global installation.
export const runCommand: RunCommand = (manager, args, install = false) => new Promise((resolve, reject) => {
  const windowsShim = process.platform === 'win32' && manager !== 'bun'
  const child = spawn(manager, args, {
    cwd: homedir(),
    env: {
      ...process.env,
      COREPACK_ENABLE_PROJECT_SPEC: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_ENABLE_NETWORK: '0',
      NO_UPDATE_NOTIFIER: '1',
    },
    // Windows package-manager shims require cmd.exe. Every argument here is
    // fixed, except the strictly validated registry version.
    shell: windowsShim,
    stdio: ['ignore', install ? 'inherit' : 'pipe', install ? 'inherit' : 'ignore'],
    windowsHide: true,
  })
  let stdout = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error(`${manager} timed out`))
  }, install ? INSTALL_TIMEOUT : 3_000)
  child.once('error', (error) => { clearTimeout(timer); reject(error) })
  child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout }) })
})

async function canonical(path: string): Promise<string | null> {
  try { return await realpath(path) } catch { return null }
}

async function query(run: RunCommand, manager: PackageManager, args: string[]): Promise<string | null> {
  try {
    const result = await run(manager, args)
    return result.code === 0 ? result.stdout.trim() : null
  } catch { return null }
}

interface GlobalInstallation {
  manager: PackageManager
  packageDir: string
}

async function globalPackages(manager: PackageManager, run: RunCommand): Promise<string[]> {
  if (manager === 'bun') {
    const bin = await query(run, manager, ['pm', 'bin', '-g'])
    if (!bin || !isAbsolute(bin)) return []
    // Bun links its global bin directly to the launcher, including custom
    // globalDir/globalBinDir configurations.
    const launcher = await canonical(join(bin, 'ingit'))
    if (launcher?.endsWith(`${sep}bin${sep}ingit.cjs`)) return [dirname(dirname(launcher))]
    // Windows uses a binary shim instead of a symlink.
    if (process.platform !== 'win32' || !await canonical(join(bin, 'ingit.exe'))) return []
    const listing = await query(run, manager, ['pm', 'ls', '-g'])
    const root = listing?.split(/\r?\n/)[0]?.match(/^(.+) node_modules \(/)?.[1]
    if (root && isAbsolute(root)) return [join(root, 'node_modules', PACKAGE)]
    return []
  }
  if (manager === 'pnpm') {
    const output = await query(run, manager, ['list', '--global', '--depth=0', '--json'])
    try {
      // pnpm 11+ has separate install groups; earlier versions have one root.
      const groups: unknown = JSON.parse(output ?? '')
      if (!Array.isArray(groups)) return []
      return groups.flatMap((group) => {
        const dependency = group?.dependencies?.[PACKAGE]
        if (!dependency || typeof group.path !== 'string' || !isAbsolute(group.path)) return []
        if (/^(link:|file:)/.test(dependency.version ?? '')) return []
        return [join(group.path, 'node_modules', PACKAGE)]
      })
    } catch { return [] }
  }
  const output = await query(run, manager, manager === 'yarn' ? ['global', 'dir', '--silent'] : ['root', '--global'])
  if (!output || !isAbsolute(output) || output.includes('\n')) return []
  return [join(output, ...(manager === 'yarn' ? ['node_modules'] : []), PACKAGE)]
}

/** Match the actual installation, never a repo lockfile or npm user-agent. */
export async function detectGlobalInstallation(packageDir: string, run: RunCommand = runCommand): Promise<GlobalInstallation | null> {
  const current = await canonical(packageDir)
  if (!current || !current.split(sep).includes('node_modules')) return null
  const managers: PackageManager[] = ['pnpm', 'bun', 'yarn', 'npm']
  const matches = await Promise.all(managers.map(async (manager) => {
    for (const candidate of await globalPackages(manager, run)) {
      if (await canonical(candidate) !== current) continue
      // npm/yarn links to a checkout must not be replaced with a registry copy.
      if (manager === 'npm' || manager === 'yarn') {
        const root = await canonical(dirname(dirname(candidate)))
        if (!root || relative(root, current).startsWith(`..${sep}`)) continue
      }
      return { manager, packageDir: candidate }
    }
    return null
  }))
  const found = matches.filter((match) => match !== null)
  return found.length === 1 ? found[0] : null
}

export function updateArguments(manager: PackageManager, version: string): string[] {
  if (version !== version.trim() || !VERSION.test(version)) throw new Error('Invalid update version')
  const spec = `${PACKAGE}@${version}`
  return manager === 'yarn' ? ['global', 'add', spec] : [manager === 'npm' ? 'install' : 'add', '--global', spec]
}

export async function fetchLatestVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  const response = await fetcher(REGISTRY, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) return null
  const data = await response.json() as { name?: unknown; version?: unknown; optionalDependencies?: Record<string, unknown> }
  if (data?.name !== PACKAGE || typeof data.version !== 'string' || !VERSION.test(data.version)) return null
  // Do not update to a release that doesn't ship this machine's binary.
  if (data.optionalDependencies?.[`${PACKAGE}-${process.platform}-${process.arch}`] !== data.version) return null
  return data.version
}

async function readManifest(packageDir: string): Promise<{ name?: string; version?: string; private?: boolean }> {
  return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
}

async function acquireLock(filePath: string): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(filePath), { recursive: true })
  const deadline = Date.now() + INSTALL_TIMEOUT + 5_000
  while (Date.now() < deadline) {
    try {
      const file = await open(filePath, 'wx', 0o600)
      await file.writeFile(String(process.pid))
      await file.close()
      return () => rm(filePath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const pid = Number(await readFile(filePath, 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              await rm(filePath, { force: true })
              continue
            }
          }
        }
      } catch { /* The other launcher may have just released the lock. */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  return null
}

interface AutoUpdateOptions {
  packageDir: string
  args: string[]
  env?: NodeJS.ProcessEnv
  settingsPath?: string
  run?: RunCommand
  latest?: () => Promise<string | null>
  log?: (message: string) => void
  warn?: (message: string) => void
}

/** Returns the newly installed launcher to run, or null to continue startup. */
export async function autoUpdate({
  packageDir, args, env = process.env, settingsPath = appSettingsPath(),
  run = runCommand, latest = fetchLatestVersion, log = console.log, warn = console.warn,
}: AutoUpdateOptions): Promise<string | null> {
  if (env.INGIT_AUTO_UPDATE === '0' || args.some((arg) => ['--no-auto-update', '--help', '-h', '--version', '-v'].includes(arg))) return null
  let release: (() => Promise<void>) | null = null
  try {
    const manifest = await readManifest(packageDir)
    if (manifest.name !== PACKAGE || manifest.private || !manifest.version) return null
    if (!(await getAppSettings(settingsPath)).autoUpdate) return null
    const version = await latest()
    if (!version || compareVersions(manifest.version, version) !== -1) return null
    const installation = await detectGlobalInstallation(packageDir, run)
    if (!installation) {
      warn(`ingit ${version} is available; automatic update skipped because this installation's global package manager could not be identified.`)
      return null
    }
    release = await acquireLock(join(dirname(settingsPath), 'auto-update.lock'))
    if (!release || !(await getAppSettings(settingsPath)).autoUpdate) return null
    // Another launcher may have updated the package while we waited.
    const installed = await readManifest(installation.packageDir)
    const launcher = join(installation.packageDir, 'bin', 'ingit.cjs')
    if (installed.version && compareVersions(installed.version, version) !== -1) return launcher
    const command = updateArguments(installation.manager, version)
    log(`ingit: updating ${manifest.version} → ${version} (${installation.manager} ${command.join(' ')})`)
    const result = await run(installation.manager, command, true)
    if (result.code !== 0) throw new Error(`${installation.manager} exited with code ${result.code ?? 'unknown'}`)
    // Re-query because pnpm can move its installation when updating.
    for (const updated of await globalPackages(installation.manager, run)) {
      const updatedManifest = await readManifest(updated)
      if (updatedManifest.version === version) {
        log(`ingit: updated to ${version}.`)
        return await realpath(join(updated, 'bin', 'ingit.cjs'))
      }
    }
    throw new Error('The package manager finished, but the new installation could not be verified')
  } catch (error) {
    warn(`ingit: automatic update skipped or failed (${error instanceof Error ? error.message : String(error)}). Continuing startup.`)
    return null
  } finally {
    await release?.().catch(() => {})
  }
}
