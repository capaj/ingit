import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const PACKAGE_JSON = resolve(ROOT, 'package.json')
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/

function fail(message: string): never {
  console.error(`Release aborted: ${message}`)
  process.exit(1)
}

function run(command: string[], capture = false, env?: Record<string, string>): string {
  const proc = Bun.spawnSync(command, {
    cwd: ROOT,
    env: env ? { ...process.env, ...env } : undefined,
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = proc.stdout.toString()
  const stderr = proc.stderr.toString()

  if (!capture) {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  }

  if (proc.exitCode !== 0) {
    const detail = capture ? stderr.trim() : ''
    fail(`${command.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }

  return capture ? stdout.trim() : ''
}

function nextPatch(version: string): string {
  const match = SEMVER.exec(version)
  if (!match) fail(`package.json contains an invalid version: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function requestedVersion(currentVersion: string): string {
  const argument = process.argv[2]
  if (!argument) return nextPatch(currentVersion)
  const version = argument.replace(/^v/, '')
  if (!SEMVER.test(version)) fail(`invalid version: ${argument}`)
  if (process.argv.length > 3) fail('expected at most one version argument')
  return version
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: bun run release [version]\n\nDefaults to the next patch version.')
    return
  }

  const status = run(['git', 'status', '--porcelain'], true)
  if (status) fail('the working tree is not clean; commit or stash changes first')

  const branch = run(['git', 'branch', '--show-current'], true)
  if (!branch) fail('HEAD is detached')

  run(['git', 'fetch', '--tags', 'origin'])
  const remoteBranch = `origin/${branch}`
  run(['git', 'rev-parse', '--verify', remoteBranch], true)
  const [behindText] = run(['git', 'rev-list', '--left-right', '--count', `${remoteBranch}...HEAD`], true)
    .split(/\s+/)
  if (Number(behindText) > 0) {
    fail(`${branch} is behind or diverged from ${remoteBranch}; sync it before releasing`)
  }

  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string }
  if (!packageJson.version) fail('package.json has no version')
  const version = requestedVersion(packageJson.version)
  const tag = `v${version}`

  if (run(['git', 'tag', '--list', tag], true)) fail(`${tag} already exists`)

  run(['bun', 'run', 'cli:release'], false, { INGIT_VERSION: version })

  packageJson.version = version
  writeFileSync(PACKAGE_JSON, `${JSON.stringify(packageJson, null, 2)}\n`)

  run(['git', 'add', 'package.json'])
  run(['git', 'commit', '-m', `release ${tag}`])
  run(['git', 'tag', '-a', tag, '-m', `Release ${tag}`])
  run(['git', 'push', '--atomic', 'origin', branch, tag])

  console.log(`\nReleased ${tag}. Local artifacts are in apps/cli/release; GitHub Actions will build and publish the npm packages.`)
}

main()
