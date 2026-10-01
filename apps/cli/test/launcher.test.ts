import { expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test.skipIf(process.platform === 'win32')('updated launcher preserves arguments/cwd and skips only the recursive update check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ingit-launcher-'))
  try {
    const oldDir = join(root, 'old')
    const newDir = join(root, 'updated')
    for (const dir of [oldDir, newDir]) {
      await mkdir(join(dir, 'bin'), { recursive: true })
      await copyFile(resolve(import.meta.dir, '../bin/ingit.cjs'), join(dir, 'bin', 'ingit.cjs'))
    }
    await writeFile(join(oldDir, 'bin', 'auto-update.cjs'), `exports.autoUpdate = async () => ${JSON.stringify(join(newDir, 'bin', 'ingit.cjs'))}`)
    await writeFile(join(newDir, 'bin', 'auto-update.cjs'), 'throw new Error("Recursive update check")')
    const platformDir = join(newDir, 'node_modules', '@ingit', `cli-${process.platform}-${process.arch}`)
    await mkdir(platformDir, { recursive: true })
    const binary = join(platformDir, 'ingit')
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),skip:process.env.INGIT_SKIP_AUTO_UPDATE??null}))\n')
    await chmod(binary, 0o755)
    const result = Bun.spawnSync(['node', join(oldDir, 'bin', 'ingit.cjs'), 'repo with spaces', '--port', '9876', '--no-open', '--no-auto-update'], {
      cwd: root,
      env: { ...process.env, INGIT_SKIP_AUTO_UPDATE: undefined },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ args: ['repo with spaces', '--port', '9876', '--no-open'], cwd: root, skip: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
