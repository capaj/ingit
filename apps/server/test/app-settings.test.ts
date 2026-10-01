import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAppSettings, setAutoUpdate } from '../src/app-settings.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

test('updates default on and persist the opt-out across reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ingit-settings-'))
  directories.push(dir)
  const path = join(dir, 'config', 'settings.json')
  expect(await getAppSettings(path)).toEqual({ autoUpdate: true })
  expect(await setAutoUpdate(false, path)).toEqual({ autoUpdate: false })
  expect(await getAppSettings(path)).toEqual({ autoUpdate: false })
  await writeFile(path, '{"autoUpdate":false,"otherSetting":42}')
  await setAutoUpdate(true, path)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ autoUpdate: true, otherSetting: 42 })
})

test('corrupt preferences fail closed instead of silently enabling updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ingit-settings-'))
  directories.push(dir)
  const path = join(dir, 'settings.json')
  for (const contents of ['{broken', 'null', '[]', '{"autoUpdate":"false"}']) {
    await writeFile(path, contents)
    expect(getAppSettings(path)).rejects.toThrow()
  }
})
