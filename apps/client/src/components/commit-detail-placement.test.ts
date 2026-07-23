import { describe, expect, test } from 'bun:test'
import { shouldShowCommitDetailAtTop } from './commit-detail-placement'

describe('shouldShowCommitDetailAtTop', () => {
  const container = { top: 0, right: 1280, bottom: 720, left: 0 }
  const panel = { width: 400, height: 360 }

  test('moves the pane when its bottom-right placement covers the selected node', () => {
    expect(shouldShowCommitDetailAtTop(
      { top: 640, right: 980, bottom: 680, left: 940 },
      container,
      panel,
    )).toBe(true)
  })

  test('keeps the pane at the bottom when the node is outside its horizontal bounds', () => {
    expect(shouldShowCommitDetailAtTop(
      { top: 640, right: 840, bottom: 680, left: 800 },
      container,
      panel,
    )).toBe(false)
  })

  test('keeps the pane at the bottom when the node is above it', () => {
    expect(shouldShowCommitDetailAtTop(
      { top: 220, right: 980, bottom: 260, left: 940 },
      container,
      panel,
    )).toBe(false)
  })
})
