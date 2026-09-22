import { afterEach, expect, test } from 'bun:test'
import { observeRepository } from './repository-observer'

let stop = () => {}
afterEach(() => stop())

async function until(condition: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Observer did not settle')
    await Bun.sleep(5)
  }
}

test('refreshes initially and on changed refs, but not on unchanged checks', async () => {
  let version = 'a'
  let checks = 0
  let reloads = 0
  stop = observeRepository({
    getVersion: async () => { checks++; return version },
    reload: async () => { reloads++; return true },
    canReload: () => true,
    intervalMs: 5,
  })
  await until(() => checks >= 3)
  expect(reloads).toBe(1)
  version = 'b'
  await until(() => reloads === 2)
  stop()
  await Bun.sleep(20)
  expect(reloads).toBe(2)
})

test('waits out mutations and retries refreshes that were skipped or failed', async () => {
  let busy = true
  let checks = 0
  let reloads = 0
  stop = observeRepository({
    getVersion: async () => { checks++; return 'a' },
    reload: async () => { reloads++; return reloads > 1 },
    canReload: () => !busy,
    intervalMs: 5,
  })
  await Bun.sleep(20)
  expect(checks).toBe(0)
  busy = false
  await until(() => checks >= 4)
  expect(reloads).toBe(2)
})

test('does not overlap refreshes and stops publishing after cleanup', async () => {
  let finishVersion!: (version: string) => void
  let checks = 0
  let reloads = 0
  stop = observeRepository({
    getVersion: () => { checks++; return new Promise((resolve) => { finishVersion = resolve }) },
    reload: async () => { reloads++; return true },
    canReload: () => true,
    intervalMs: 5,
  })
  await Bun.sleep(20)
  expect(checks).toBe(1)
  stop()
  finishVersion('a')
  await Bun.sleep(20)
  expect(reloads).toBe(0)
  expect(checks).toBe(1)
})

test('uses reload recovery after a lost server session', async () => {
  let reloads = 0
  stop = observeRepository({
    getVersion: async () => { throw new Error('No session') },
    reload: async () => { reloads++; return true },
    canReload: () => true,
    intervalMs: 5,
  })
  await until(() => reloads > 0)
})
