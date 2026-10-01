import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { autoUpdate, detectGlobalInstallation, fetchLatestVersion, updateArguments, type PackageManager, type RunCommand } from '../src/auto-update.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function fixture(manager: PackageManager = 'npm') {
  const dir = await mkdtemp(join(tmpdir(), 'ingit-update-'))
  directories.push(dir)
  const root = join(dir, 'global', 'node_modules')
  const packageDir = join(root, '@ingit', 'cli')
  const settingsPath = join(dir, 'config', 'settings.json')
  await mkdir(join(packageDir, 'bin'), { recursive: true })
  const manifest = (version = '1.0.0') => writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@ingit/cli', version }))
  await manifest()
  await writeFile(join(packageDir, 'bin', 'ingit.cjs'), '// launcher')
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await symlink(join(packageDir, 'bin', 'ingit.cjs'), join(bin, 'ingit'))
  const commands: Array<[PackageManager, string[]]> = []
  const run: RunCommand = async (name, args, install) => {
    if (install) {
      commands.push([name, args])
      await manifest('1.1.0')
      return { code: 0, stdout: '' }
    }
    if (name !== manager) return { code: 1, stdout: '' }
    const output = manager === 'pnpm'
      ? JSON.stringify([{ path: dirname(root), dependencies: { '@ingit/cli': { version: '1.0.0' } } }])
      : manager === 'bun' ? bin : manager === 'yarn' ? dirname(root) : root
    return { code: 0, stdout: output + '\n' }
  }
  const warnings: string[] = []
  const options = {
    packageDir, settingsPath, args: [], env: {}, run,
    latest: async () => '1.1.0', log: () => {}, warn: (message: string) => warnings.push(message),
  }
  return { dir, root, packageDir, settingsPath, manifest, commands, run, warnings, options }
}

describe('automatic CLI updates', () => {
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    test(`updates the verified ${manager} installation and returns its new launcher`, async () => {
      const f = await fixture(manager)
      expect(await autoUpdate(f.options)).toBe(join(f.packageDir, 'bin', 'ingit.cjs'))
      expect(f.commands).toEqual([[manager, updateArguments(manager, '1.1.0')]])
      expect(f.warnings).toEqual([])
    })
  }

  test('uses the owning global manager despite another npm user-agent', async () => {
    const f = await fixture('pnpm')
    expect(await autoUpdate({ ...f.options, env: { npm_config_user_agent: 'yarn/1.22.22' } })).not.toBeNull()
    expect(f.commands[0]?.[0]).toBe('pnpm')
  })

  test('handles pnpm store symlinks and moving install groups', async () => {
    const f = await fixture('pnpm')
    const oldPackage = join(f.dir, 'store', 'old', 'node_modules', '@ingit', 'cli')
    await mkdir(dirname(oldPackage), { recursive: true })
    const { rename } = await import('node:fs/promises')
    await rename(f.packageDir, oldPackage)
    await symlink(oldPackage, f.packageDir, 'dir')
    const newRoot = join(f.dir, 'new-group', 'node_modules')
    const newPackage = join(newRoot, '@ingit', 'cli')
    let updated = false
    const run: RunCommand = async (manager, args, install) => {
      if (!install) {
        if (manager === 'pnpm' && updated) return {
          code: 0, stdout: JSON.stringify([{ path: dirname(newRoot), dependencies: { '@ingit/cli': { version: '1.1.0' } } }]),
        }
        return f.run(manager, args)
      }
      await mkdir(join(newPackage, 'bin'), { recursive: true })
      await writeFile(join(newPackage, 'package.json'), JSON.stringify({ name: '@ingit/cli', version: '1.1.0' }))
      await writeFile(join(newPackage, 'bin', 'ingit.cjs'), '// new launcher')
      updated = true
      return { code: 0, stdout: '' }
    }
    expect(await autoUpdate({ ...f.options, packageDir: oldPackage, run })).toBe(join(newPackage, 'bin', 'ingit.cjs'))
  })

  test('opt-out prevents registry and package-manager calls', async () => {
    const f = await fixture()
    await mkdir(dirname(f.settingsPath), { recursive: true })
    await writeFile(f.settingsPath, '{"autoUpdate":false}')
    let checked = false
    expect(await autoUpdate({ ...f.options, latest: async () => { checked = true; return '1.1.0' } })).toBeNull()
    expect(checked).toBe(false)
    expect(f.commands).toEqual([])
  })

  test('help, version, CLI/env opt-out, and private development builds skip checks', async () => {
    const f = await fixture()
    let checked = false
    const latest = async () => { checked = true; return '1.1.0' }
    for (const arg of ['--help', '-h', '--version', '-v', '--no-auto-update']) {
      expect(await autoUpdate({ ...f.options, args: [arg], latest })).toBeNull()
    }
    expect(await autoUpdate({ ...f.options, env: { INGIT_AUTO_UPDATE: '0' }, latest })).toBeNull()
    await writeFile(join(f.packageDir, 'package.json'), '{"name":"@ingit/cli","version":"1.0.0","private":true}')
    expect(await autoUpdate({ ...f.options, latest })).toBeNull()
    expect(checked).toBe(false)
  })

  test('never downgrades or reinstalls the current version', async () => {
    const f = await fixture()
    for (const version of ['1.0.0', '0.9.9', '1.0.0-beta.1', 'invalid']) {
      expect(await autoUpdate({ ...f.options, latest: async () => version })).toBeNull()
    }
    expect(f.commands).toEqual([])
  })

  test('network errors, invalid preferences, and installer errors do not abort startup', async () => {
    const f = await fixture()
    expect(await autoUpdate({ ...f.options, latest: async () => { throw new Error('offline') } })).toBeNull()
    expect(await autoUpdate({ ...f.options, run: (name, args, install) => install ? Promise.resolve({ code: 1, stdout: '' }) : f.run(name, args) })).toBeNull()
    await writeFile(f.settingsPath, '{broken')
    expect(await autoUpdate(f.options)).toBeNull()
    expect(f.warnings).toHaveLength(3)
    expect(f.commands).toEqual([])
  })

  test('skips local/npx installs and ambiguous ownership', async () => {
    const f = await fixture()
    const unknown: RunCommand = async () => ({ code: 1, stdout: '' })
    expect(await autoUpdate({ ...f.options, run: unknown })).toBeNull()
    const ambiguous: RunCommand = (name, args) => name === 'yarn'
      ? Promise.resolve({ code: 0, stdout: dirname(f.root) }) : f.run(name, args)
    expect(await detectGlobalInstallation(f.packageDir, ambiguous)).toBeNull()
    expect(f.commands).toEqual([])
  })

  test('does not overwrite an npm link to a local checkout', async () => {
    const f = await fixture()
    const checkout = join(f.dir, 'project', 'node_modules', '@ingit', 'cli')
    await mkdir(checkout, { recursive: true })
    await rm(f.packageDir, { recursive: true })
    await symlink(checkout, f.packageDir, 'dir')
    expect(await detectGlobalInstallation(checkout, f.run)).toBeNull()
  })

  test('serializes simultaneous launches and installs once', async () => {
    const f = await fixture()
    const [first, second] = await Promise.all([autoUpdate(f.options), autoUpdate(f.options)])
    expect(first).toBe(join(f.packageDir, 'bin', 'ingit.cjs'))
    expect(second).toBe(first)
    expect(f.commands).toHaveLength(1)
    expect(await readFile(join(f.packageDir, 'package.json'), 'utf8')).toContain('1.1.0')
  })

  test('rejects versions that could become shell arguments', () => {
    for (const version of ['1.2.3;touch /tmp/foo', '$(id)', '1.2.3\n', '--help']) {
      expect(() => updateArguments('npm', version)).toThrow()
    }
    expect(updateArguments('yarn', '1.2.3')).toEqual(['global', 'add', '@ingit/cli@1.2.3'])
  })
})

test('checks npm latest with a timeout and validates version/platform metadata', async () => {
  const data = { name: '@ingit/cli', version: '2.0.0', optionalDependencies: { [`@ingit/cli-${process.platform}-${process.arch}`]: '2.0.0' } }
  const fetcher = (async (url: unknown, options: RequestInit) => {
    expect(url).toBe('https://registry.npmjs.org/@ingit%2fcli/latest')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    return Response.json(data)
  }) as typeof fetch
  expect(await fetchLatestVersion(fetcher)).toBe('2.0.0')
  for (const body of [{ version: '2.0.0' }, { ...data, version: 'garbage' }, { ...data, optionalDependencies: {} }]) {
    expect(await fetchLatestVersion((async () => Response.json(body)) as typeof fetch)).toBeNull()
  }
  expect(await fetchLatestVersion((async () => new Response('', { status: 503 })) as typeof fetch)).toBeNull()
})
