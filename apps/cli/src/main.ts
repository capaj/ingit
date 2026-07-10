/**
 * ingit CLI entry point.
 *
 * This file is compiled into a standalone, self-contained executable with
 * `bun build --compile` (the bun runtime is embedded, so end users need no
 * bun/node install). It also runs directly in dev via `bun apps/cli/src/main.ts`.
 *
 * It locates the bundled assets (built client + native git library), points the
 * server at them via env vars, starts the server and opens the browser.
 */
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { findRunningIngit, repositoryUrl } from './existing-server.js'

// Baked in at compile time via `bun build --define` (see scripts/build.ts).
const VERSION = process.env.INGIT_VERSION ?? '0.1.0'

interface CliArgs {
  repoPath?: string
  host?: string
  port?: number
  open: boolean
  help: boolean
  version: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { open: true, help: false, version: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true
        break
      case '-v':
      case '--version':
        args.version = true
        break
      case '--no-open':
        args.open = false
        break
      case '--host':
        args.host = argv[++i]
        break
      case '-p':
      case '--port':
        args.port = Number(argv[++i])
        break
      default:
        if (arg && !arg.startsWith('-') && args.repoPath === undefined) {
          args.repoPath = arg
        }
    }
  }

  return args
}

const HELP = `ingit — a local git history & graph viewer

Usage:
  ingit [path] [options]

Arguments:
  path              Folder to open (defaults to the current directory).
                    Its child folders are scanned for git repositories.

Options:
  -p, --port <n>    Preferred port (default 8488; reuses ingit, else next free).
      --host <h>    Host to bind (default 127.0.0.1).
      --no-open     Don't open the browser automatically.
  -v, --version     Print version and exit.
  -h, --help        Show this help and exit.
`

function nativeLibFilename(): string | null {
  switch (process.platform) {
    case 'darwin':
      return 'libziggit.dylib'
    case 'linux':
      return 'libziggit.so'
    default:
      return null
  }
}

/**
 * In a compiled standalone binary `process.execPath` is the binary itself; in
 * dev it's the `bun` (or `node`) executable. This distinguishes the two so we
 * can resolve assets relative to the binary vs. relative to the repo.
 */
function isCompiledBinary(): boolean {
  return !/[\\/](bun|node)(\.exe)?$/i.test(process.execPath)
}

interface AssetPaths {
  clientDist: string
  nativeLib: string | null
}

function resolveAssets(): AssetPaths {
  const libName = nativeLibFilename()

  if (isCompiledBinary()) {
    // Platform package layout: <dir>/ingit, <dir>/client/**, <dir>/libziggit.*
    const baseDir = dirname(process.execPath)
    return {
      clientDist: join(baseDir, 'client'),
      nativeLib: libName ? join(baseDir, libName) : null,
    }
  }

  // Dev: running from apps/cli/src
  const repoRoot = resolve(import.meta.dir, '../../..')
  return {
    clientDist: join(repoRoot, 'apps/client/dist'),
    nativeLib: libName ? join(repoRoot, 'packages/git-core', libName) : null,
  }
}

async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === 'darwin' ? ['open', url] : ['xdg-open', url]
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref()
  } catch {
    // Best effort — the URL is printed to the console anyway.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  if (args.repoPath !== undefined) {
    const target = isAbsolute(args.repoPath)
      ? args.repoPath
      : resolve(process.cwd(), args.repoPath)
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      console.error(`Not a directory: ${target}`)
      process.exit(1)
    }
    process.chdir(target)
  }

  const preferredPort = args.port
    ?? (process.env.PORT ? Number(process.env.PORT) : 8488)
  const runningUrl = await findRunningIngit(args.host, preferredPort)
  if (runningUrl) {
    const url = repositoryUrl(runningUrl, process.cwd())
    if (args.open) await openBrowser(url)
    console.log(`ingit is already running at ${runningUrl}`)
    console.log(`Open ${url} in your browser.`)
    return
  }

  const assets = resolveAssets()

  // Point the server at the bundled assets. Must happen before importing the
  // server, because git-core reads INGIT_ZIGGIT_LIB at module load time.
  process.env.INGIT_CLIENT_DIST = assets.clientDist
  if (assets.nativeLib && existsSync(assets.nativeLib)) {
    process.env.INGIT_ZIGGIT_LIB = assets.nativeLib
  }

  const { startServer } = await import('@ingit/server')
  const server = await startServer({ host: args.host, port: args.port })
  const url = repositoryUrl(server.url, process.cwd())

  if (args.open) {
    await openBrowser(url)
  }
  console.log(`\nOpen ${url} in your browser.  Press Ctrl+C to stop.`)
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
