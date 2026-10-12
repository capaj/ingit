import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as api from '../api'
import { useAppStore } from '../store'

const initialState = useAppStore.getState()
let finish: (value: { message: string; agent: 'claude' }) => void
let fail: (error: Error) => void
let generate: ReturnType<typeof spyOn<typeof api, 'generateCommitMessage'>>

beforeEach(() => {
  useAppStore.setState({ ...initialState, repoId: 'test', repoPath: '/test' })
  generate = spyOn(api, 'generateCommitMessage').mockImplementation(() => new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  }))
})

afterEach(() => {
  generate.mockRestore()
  useAppStore.setState(initialState, true)
})

test('fills the draft, blocks duplicate requests and clears the loading state', async () => {
  const request = useAppStore.getState().generateWorktreeCommitMessage()
  expect(useAppStore.getState().generatingCommitMessage).toBe(true)
  await useAppStore.getState().generateWorktreeCommitMessage()
  expect(generate).toHaveBeenCalledTimes(1)
  finish({ message: 'Update the example', agent: 'claude' })
  await request
  expect(useAppStore.getState().worktreeCommitMessage).toBe('Update the example')
  expect(useAppStore.getState().generatingCommitMessage).toBe(false)
})

test('preserves a message typed while generation is running', async () => {
  const request = useAppStore.getState().generateWorktreeCommitMessage()
  useAppStore.getState().setWorktreeCommitMessage('My own message')
  finish({ message: 'Generated message', agent: 'claude' })
  await request
  expect(useAppStore.getState().worktreeCommitMessage).toBe('My own message')
})

test('does not publish an old result or clear another repository’s loading state', async () => {
  const request = useAppStore.getState().generateWorktreeCommitMessage()
  useAppStore.setState({ repoId: 'other', worktreeCommitMessage: '', generatingCommitMessage: true })
  finish({ message: 'Old repository message', agent: 'claude' })
  await request
  expect(useAppStore.getState().worktreeCommitMessage).toBe('')
  expect(useAppStore.getState().generatingCommitMessage).toBe(true)
})

test('reports failures and allows another attempt', async () => {
  const showError = spyOn(useAppStore.getState(), 'showError').mockImplementation(() => {})
  try {
    const request = useAppStore.getState().generateWorktreeCommitMessage()
    const error = new Error('Please sign in')
    fail(error)
    await request
    expect(showError).toHaveBeenCalledWith('Commit message generation failed', error)
    expect(useAppStore.getState().generatingCommitMessage).toBe(false)
    expect(useAppStore.getState().worktreeCommitMessage).toBe('')
  } finally {
    showError.mockRestore()
  }
})
