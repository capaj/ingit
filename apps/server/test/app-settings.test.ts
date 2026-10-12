import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAppSettings, setAutoUpdate, setCommitMessageAgent } from '../src/app-settings.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

test('updates default on and persist the opt-out across reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ingit-settings-'))
  directories.push(dir)
  const path = join(dir, 'config', 'settings.json')
  expect(await getAppSettings(path)).toEqual({ autoUpdate: true, commitMessageAgent: null })
  expect(await setAutoUpdate(false, path)).toEqual({ autoUpdate: false, commitMessageAgent: null })
  expect(await getAppSettings(path)).toEqual({ autoUpdate: false, commitMessageAgent: null })
  await writeFile(path, '{"autoUpdate":false,"otherSetting":42}')
  await setAutoUpdate(true, path)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ autoUpdate: true, otherSetting: 42 })
})

test('corrupt preferences fail closed instead of silently enabling updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ingit-settings-'))
  directories.push(dir)
  const path = join(dir, 'settings.json')
  for (const contents of ['{broken', 'null', '[]', '{"autoUpdate":"false"}', '{"commitMessageAgent":"automatic"}']) {
    await writeFile(path, contents)
    await expect(getAppSettings(path)).rejects.toThrow()
  }
})

test('requires an explicit agent choice for new and existing settings files, and persists changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ingit-agent-settings-'))
  directories.push(dir)
  const path = join(dir, 'settings.json')
  expect((await getAppSettings(path)).commitMessageAgent).toBeNull()
  await writeFile(path, '{"autoUpdate":false,"otherSetting":42}')
  expect((await getAppSettings(path)).commitMessageAgent).toBeNull()
  await setCommitMessageAgent('codex', path)
  expect(await getAppSettings(path)).toEqual({ autoUpdate: false, commitMessageAgent: 'codex' })
  await Promise.all([setAutoUpdate(true, path), setCommitMessageAgent('claude', path)])
  expect(await getAppSettings(path)).toEqual({ autoUpdate: true, commitMessageAgent: 'claude' })
  expect(JSON.parse(await readFile(path, 'utf8')).otherSetting).toBe(42)
})
