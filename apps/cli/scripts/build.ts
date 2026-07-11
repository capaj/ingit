/**
 * Builds the publishable npm artifacts for the `ingit` CLI.
 *
 * Output (under apps/cli/release/):
 *   cli/                    -> published as `@ingit/cli` (tiny node launcher + optional deps)
 *   cli-linux-x64/          -> published as `@ingit/cli-linux-x64`
 *   cli-linux-arm64/        -> published as `@ingit/cli-linux-arm64`
 *   cli-darwin-x64/         -> published as `@ingit/cli-darwin-x64`
 *   cli-darwin-arm64/       -> published as `@ingit/cli-darwin-arm64`
 *   cli-win32-x64/          -> published as `@ingit/cli-win32-x64`
 *
 * Each platform package contains a self-contained binary (`bun build --compile`,
 * runtime embedded), the built client, and an optional native git accelerator.
 * The `@ingit/cli` package exposes the `ingit` command and picks the matching
 * platform package at runtime via optionalDependencies.
 *
 * Usage:
 *   bun scripts/build.ts                 # build all targets
 *   bun scripts/build.ts linux-x64       # build a single target (faster local check)
 */
import { chmodSync, rmSync, mkdirSync, cpSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Tag-driven in CI (INGIT_VERSION=${GITHUB_REF_NAME#v}); defaults for local builds.
const VERSION = (process.env.INGIT_VERSION ?? '0.1.0').replace(/^v/, '')
const REPO_ROOT = resolve(import.meta.dir, '../../..')
const CLI_DIR = resolve(import.meta.dir, '..')
const RELEASE_DIR = join(CLI_DIR, 'release')
const CLIENT_DIST = join(REPO_ROOT, 'apps/client/dist')
const GIT_CORE_DIR = join(REPO_ROOT, 'packages/git-core')
const REPOSITORY = {
  type: 'git',
  url: 'git+https://github.com/capaj/ingit.git',
}
const PUBLISH_CONFIG = {
  access: 'public',
  registry: 'https://registry.npmjs.org/',
}

interface Target {
  /** npm os/cpu identity, e.g. linux-x64 */
  id: string
  os: string
  cpu: string
  bunTarget: string
  binaryName: string
  /** Optional FFI accelerator. The Git subprocess implementation is the fallback. */
  nativeLib?: string
}

const TARGETS: Target[] = [
  { id: 'linux-x64', os: 'linux', cpu: 'x64', bunTarget: 'bun-linux-x64', binaryName: 'ingit', nativeLib: 'libziggit.so' },
  { id: 'linux-arm64', os: 'linux', cpu: 'arm64', bunTarget: 'bun-linux-arm64', binaryName: 'ingit', nativeLib: 'libziggit.so' },
  { id: 'darwin-x64', os: 'darwin', cpu: 'x64', bunTarget: 'bun-darwin-x64', binaryName: 'ingit', nativeLib: 'libziggit.dylib' },
  { id: 'darwin-arm64', os: 'darwin', cpu: 'arm64', bunTarget: 'bun-darwin-arm64', binaryName: 'ingit', nativeLib: 'libziggit.dylib' },
  { id: 'win32-x64', os: 'win32', cpu: 'x64', bunTarget: 'bun-windows-x64', binaryName: 'ingit.exe' },
]

const ALL_PLATFORM_PKGS = TARGETS.map((t) => `@ingit/cli-${t.id}`)

function writePackageJson(pkgDir: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

async function buildClient(): Promise<void> {
  console.log('▶ Building client (vite)…')
  const proc = Bun.spawn(['bun', 'run', '--filter', '@ingit/client', 'build'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`client build failed (exit ${code})`)
  if (!existsSync(join(CLIENT_DIST, 'index.html'))) {
    throw new Error(`client build produced no index.html at ${CLIENT_DIST}`)
  }
}

async function buildSharedPackages(): Promise<void> {
  console.log('▶ Building shared packages…')
  const proc = Bun.spawn(['bun', 'run', 'build:packages'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`shared package build failed (exit ${code})`)
}

async function buildTarget(target: Target): Promise<void> {
  const pkgDir = join(RELEASE_DIR, `cli-${target.id}`)
  rmSync(pkgDir, { recursive: true, force: true })
  mkdirSync(pkgDir, { recursive: true })

  console.log(`▶ Compiling ${target.id} (${target.bunTarget})…`)
  const proc = Bun.spawn(
    [
      'bun',
      'build',
      join(CLI_DIR, 'src/main.ts'),
      '--compile',
      '--minify',
      `--target=${target.bunTarget}`,
      `--define=process.env.INGIT_VERSION=${JSON.stringify(VERSION)}`,
      `--outfile=${join(pkgDir, target.binaryName)}`,
    ],
    { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit' },
  )
  const code = await proc.exited
  if (code !== 0) throw new Error(`compile failed for ${target.id} (exit ${code})`)

  // Bundle the built client next to the binary.
  cpSync(CLIENT_DIST, join(pkgDir, 'client'), { recursive: true })

  // Ship the optional native git accelerator where one is supported. CI
  // cross-builds it into native-dist/<id>/; local builds can use the committed
  // host library. Windows intentionally uses the Git subprocess fallback.
  if (target.nativeLib) {
    const perTargetLib = join(GIT_CORE_DIR, 'native-dist', target.id, target.nativeLib)
    const fallbackLib = join(GIT_CORE_DIR, target.nativeLib)
    const libSrc = existsSync(perTargetLib) ? perTargetLib : fallbackLib
    if (existsSync(libSrc)) {
      cpSync(libSrc, join(pkgDir, target.nativeLib))
    } else {
      console.warn(`  ! native lib ${target.nativeLib} not found — ${target.id} will use git subprocesses`)
    }
  }

  const files = [target.binaryName, 'client']
  if (target.nativeLib) files.push(target.nativeLib)

  writePackageJson(pkgDir, {
    name: `@ingit/cli-${target.id}`,
    version: VERSION,
    description: `ingit prebuilt binary for ${target.id}`,
    os: [target.os],
    cpu: [target.cpu],
    license: 'MIT',
    repository: REPOSITORY,
    files,
    publishConfig: PUBLISH_CONFIG,
  })

  console.log(`  ✓ ${pkgDir}`)
}

function buildLauncher(): void {
  const pkgDir = join(RELEASE_DIR, 'cli')
  rmSync(pkgDir, { recursive: true, force: true })
  mkdirSync(join(pkgDir, 'bin'), { recursive: true })

  cpSync(join(CLI_DIR, 'bin/ingit.cjs'), join(pkgDir, 'bin/ingit.cjs'))
  if (process.platform !== 'win32') {
    chmodSync(join(pkgDir, 'bin/ingit.cjs'), 0o755)
  }
  if (existsSync(join(CLI_DIR, 'README.md'))) {
    cpSync(join(CLI_DIR, 'README.md'), join(pkgDir, 'README.md'))
  }

  const optionalDependencies: Record<string, string> = {}
  for (const name of ALL_PLATFORM_PKGS) optionalDependencies[name] = VERSION

  writePackageJson(pkgDir, {
    name: '@ingit/cli',
    version: VERSION,
    description: 'Local git history & graph viewer in your browser',
    bin: { ingit: 'bin/ingit.cjs' },
    files: ['bin', 'README.md'],
    optionalDependencies,
    license: 'MIT',
    engines: { node: '>=18' },
    repository: REPOSITORY,
    publishConfig: PUBLISH_CONFIG,
  })

  console.log(`  ✓ ${pkgDir}`)
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const targets = requested.length ? TARGETS.filter((t) => requested.includes(t.id)) : TARGETS
  if (requested.length && targets.length !== requested.length) {
    const known = TARGETS.map((t) => t.id).join(', ')
    console.error(`Unknown target in "${requested.join(' ')}". Known: ${known}`)
    process.exit(1)
  }

  rmSync(RELEASE_DIR, { recursive: true, force: true })
  mkdirSync(RELEASE_DIR, { recursive: true })

  await buildSharedPackages()
  await buildClient()
  for (const target of targets) await buildTarget(target)
  buildLauncher()

  console.log(`\n✓ Done. Artifacts in ${RELEASE_DIR}`)
  console.log('  Publish each platform package, then the `@ingit/cli` launcher package.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
