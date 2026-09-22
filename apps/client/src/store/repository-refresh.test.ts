import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { HistoryWindowResponse } from '@ingit/rpc-contract'
import * as api from '../api'
import { useAppStore } from '../store'

const initialState = useAppStore.getState()
const https = [{ name: 'origin', url: 'https://github.com/example/repo.git' }]
const ssh = [{ name: 'origin', url: 'git@github.com:example/repo.git' }]
const history: HistoryWindowResponse = {
  projectionId: 'test', rows: [], edges: [], checkpointsKnownUntilRow: 0,
  hasMoreBefore: false, hasMoreAfter: false, indexingState: 'warm',
}
const spies: Array<{ mockRestore: () => void }> = []
let finishHistory: (value: HistoryWindowResponse) => void

beforeEach(() => {
  useAppStore.setState({ ...initialState, repoId: 'test', repoPath: '/test', remotes: https, selectedRemoteName: 'origin', normalizeAcrossWorktrees: false })
  spies.push(
    spyOn(api, 'getRefs').mockResolvedValue([]),
    spyOn(api, 'queryHistory').mockImplementation(() => new Promise((resolve) => { finishHistory = resolve })),
    spyOn(api, 'getWorktreeChanges').mockResolvedValue({ headSha: '', staged: [], unstaged: [] }),
    spyOn(api, 'getWorktrees').mockResolvedValue([]),
    spyOn(api, 'getStashes').mockResolvedValue([]),
    spyOn(api, 'getRemotes').mockResolvedValue(https),
  )
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  useAppStore.setState(initialState, true)
})

test('a delayed refresh cannot overwrite remotes returned by SSH conversion', async () => {
  const refresh = useAppStore.getState().reloadFromServer()
  useAppStore.setState({ remotes: ssh, sshConversionRemote: null })
  finishHistory(history)
  await refresh
  expect(useAppStore.getState().remotes).toEqual(ssh)
  expect(useAppStore.getState().historyWindow).toEqual(history)
})

test('a subsequent refresh still picks up external remote changes', async () => {
  useAppStore.setState({ remotes: ssh })
  const refresh = useAppStore.getState().reloadFromServer()
  finishHistory(history)
  await refresh
  expect(useAppStore.getState().remotes).toEqual(https)
})

test('a delayed refresh cannot publish to a different repository', async () => {
  const refresh = useAppStore.getState().reloadFromServer()
  useAppStore.setState({ repoId: 'other', remotes: [] })
  finishHistory(history)
  await refresh
  expect(useAppStore.getState().remotes).toEqual([])
  expect(useAppStore.getState().historyWindow).toBe(initialState.historyWindow)
})

test('a delayed refresh cannot overwrite an optimistic mutation', async () => {
  const refresh = useAppStore.getState().reloadFromServer()
  useAppStore.setState({ pendingMutation: true })
  finishHistory(history)
  expect(await refresh).toBe(false)
  expect(useAppStore.getState().historyWindow).toBe(initialState.historyWindow)
})

test('a refresh started before a completed mutation is discarded', async () => {
  spies.push(spyOn(api, 'createStash').mockResolvedValue({
    ok: true, message: 'created', stashes: [], changes: { headSha: '', staged: [], unstaged: [] },
  }))
  const refresh = useAppStore.getState().reloadFromServer()
  expect(await useAppStore.getState().createStash()).toBe(true)
  finishHistory(history)
  expect(await refresh).toBe(false)
  expect(useAppStore.getState().historyWindow).toBe(initialState.historyWindow)
})

test('an older refresh cannot overwrite a newer refresh', async () => {
  const older = useAppStore.getState().reloadFromServer()
  const finishOlder = finishHistory
  const newer = useAppStore.getState().reloadFromServer()
  const newerHistory = { ...history, projectionId: 'newer' }
  finishHistory(newerHistory)
  expect(await newer).toBe(true)
  finishOlder(history)
  expect(await older).toBe(false)
  expect(useAppStore.getState().historyWindow).toEqual(newerHistory)
})

test('automatic refresh preserves the loaded history depth', async () => {
  useAppStore.setState({ historyWindow: { ...history, rows: new Array(2_000) } })
  const refresh = useAppStore.getState().reloadFromServer()
  expect(api.queryHistory).toHaveBeenLastCalledWith('test', expect.objectContaining({ afterRows: 2_000 }))
  finishHistory(history)
  expect(await refresh).toBe(true)
})
