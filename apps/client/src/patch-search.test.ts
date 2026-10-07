import { describe, expect, test } from 'bun:test'
import {
  loadPatchFiles,
  parsePatchLines,
  patchMatchWindows,
  searchPatches,
  type PatchSearchOptions,
  type SearchablePatch,
} from './patch-search'

const patchText = [
  'diff --git a/example.ts b/example.ts',
  '--- a/example.ts',
  '+++ b/example.ts',
  '@@ -10,3 +20,4 @@ function example()',
  ' context',
  '-const value = "Old";',
  '+const value = "New";',
  '+console.log(value, value);',
  ' end',
  '@@ -50 +60 @@',
  '-tail',
  '\\ No newline at end of file',
  '+TAIL',
  '\\ No newline at end of file',
  '',
].join('\n')

const options: PatchSearchOptions = { regex: false, caseSensitive: false, lineFilter: 'all' }
const patch: SearchablePatch = { key: 'staged:example.ts', path: 'example.ts', label: 'Staged', lines: parsePatchLines(patchText) }

describe('patch line parsing', () => {
  test('tracks old and new line numbers across additions, removals, and separate hunks', () => {
    expect(patch.lines.slice(4, 9).map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine }))).toEqual([
      { kind: 'context', oldLine: 10, newLine: 20 },
      { kind: 'removed', oldLine: 11, newLine: null },
      { kind: 'added', oldLine: null, newLine: 21 },
      { kind: 'added', oldLine: null, newLine: 22 },
      { kind: 'context', oldLine: 12, newLine: 23 },
    ])
    expect(patch.lines[10]!.oldLine).toBe(50)
    expect(patch.lines[12]!.newLine).toBe(60)
    expect(patch.lines[11]!.oldLine).toBeNull()
    expect(patch.lines).toHaveLength(14)
  })

  test('distinguishes file headers from content beginning with pluses or minuses', () => {
    const lines = parsePatchLines('--- a/file\n+++ b/file\n@@ -1 +1 @@\n---old\n+++new\n')
    expect(lines.map((line) => line.kind)).toEqual(['header', 'header', 'header', 'removed', 'added'])
  })

  test('handles added and deleted files and resets at the next file header', () => {
    const lines = parsePatchLines('@@ -0,0 +1,2 @@\n+first\n+second\ndiff --git a/deleted b/deleted\n--- a/deleted\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-first\n-second\n')
    expect(lines[1]!.newLine).toBe(1)
    expect(lines[2]!.newLine).toBe(2)
    expect(lines[4]!.kind).toBe('header')
    expect(lines[8]!.oldLine).toBe(2)
    expect(parsePatchLines('')).toEqual([])
  })

  test('tracks the resulting line numbers in combined conflict patches', () => {
    const lines = parsePatchLines('diff --cc file\n@@@ -1,2 -1,2 +1,3 @@@\n  context\n- old\n +new\n++result\n')
    expect(lines.slice(2).map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine }))).toEqual([
      { kind: 'context', oldLine: null, newLine: 1 },
      { kind: 'removed', oldLine: null, newLine: null },
      { kind: 'added', oldLine: null, newLine: 2 },
      { kind: 'added', oldLine: null, newLine: 3 },
    ])
  })
})

describe('patch grep', () => {
  test('treats regex punctuation as literal text unless regex is enabled', () => {
    expect(searchPatches([patch], 'console.log(value, value)', options).matchingLines).toBe(1)
    expect(searchPatches([patch], 'value.*New', options).matchingLines).toBe(0)
    expect(searchPatches([patch], 'value.*New', { ...options, regex: true }).matchingLines).toBe(1)
  })

  test('supports case sensitivity and highlights every occurrence on a matching line', () => {
    expect(searchPatches([patch], 'TAIL', options).matchingLines).toBe(2)
    expect(searchPatches([patch], 'TAIL', { ...options, caseSensitive: true }).matchingLines).toBe(1)
    const results = searchPatches([patch], 'value', options)
    expect(results.matchingLines).toBe(3)
    expect(results.files[0]!.matches[2]!.ranges).toEqual([{ start: 13, end: 18 }, { start: 20, end: 25 }])
  })

  test('filters by changed, added, or removed content without matching file headers', () => {
    expect(searchPatches([patch], 'example.ts', options).matchingLines).toBe(3)
    expect(searchPatches([patch], 'example.ts', { ...options, lineFilter: 'changed' }).matchingLines).toBe(0)
    expect(searchPatches([patch], 'value', { ...options, lineFilter: 'added' }).matchingLines).toBe(2)
    expect(searchPatches([patch], 'value', { ...options, lineFilter: 'removed' }).matchingLines).toBe(1)
  })

  test('reports malformed regexes even when there are no patches, and permits empty searches', () => {
    expect(searchPatches([], '[', { ...options, regex: true }).error).not.toBeNull()
    expect(searchPatches([patch], '', options)).toMatchObject({ matchingLines: 0, error: null })
  })

  test('handles anchors, zero-width matches, and Unicode without looping', () => {
    expect(searchPatches([patch], '^\\+.*value', { ...options, regex: true }).matchingLines).toBe(2)
    const unicode = { ...patch, lines: parsePatchLines('@@ -0,0 +1 @@\n+😀\n') }
    const results = searchPatches([unicode], '(?=😀)|$', { ...options, regex: true, lineFilter: 'added' })
    expect(results.files[0]!.matches[0]!.ranges).toEqual([{ start: 1, end: 1 }, { start: 3, end: 3 }])
  })

  test('counts all matching lines while limiting display and keeping patch areas separate', () => {
    const results = searchPatches([patch, { ...patch, key: 'unstaged:example.ts', label: 'Unstaged' }], 'value', options, 4)
    expect(results).toMatchObject({ matchingLines: 6, matchingFiles: 2, truncated: true })
    expect(results.files.map((file) => file.matches.length)).toEqual([3, 1])
    expect(results.files[1]!.patch.label).toBe('Unstaged')
  })

  test('merges overlapping context excerpts and clamps them to the patch bounds', () => {
    expect(patchMatchWindows(20, [0, 3, 15, 19].map((index) => ({ index, ranges: [] })))).toEqual([
      { start: 0, end: 6 }, { start: 13, end: 20 },
    ])
  })
})

describe('loading patch files', () => {
  test('limits concurrency and preserves file order when responses arrive out of order', async () => {
    let active = 0
    let maximum = 0
    const pending: Array<() => void> = []
    const loading = loadPatchFiles([0, 1, 2, 3, 4], async (index) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => { pending[index] = resolve })
      active--
      return { ...patch, key: String(index) }
    }, () => false)
    expect(active).toBe(4)
    pending[3]!()
    await Promise.resolve()
    await Promise.resolve()
    pending[4]!()
    for (const index of [2, 1, 0]) pending[index]!()
    expect((await loading).map((file) => file.key)).toEqual(['0', '1', '2', '3', '4'])
    expect(maximum).toBe(4)
  })

  test('stops scheduling more RPCs after the patch source changes', async () => {
    let cancelled = false
    let calls = 0
    const finish: Array<() => void> = []
    const loading = loadPatchFiles([0, 1, 2, 3, 4, 5], async () => {
      calls++
      await new Promise<void>((resolve) => { finish.push(resolve) })
      return patch
    }, () => cancelled)
    cancelled = true
    for (const resolve of finish) resolve()
    await loading
    expect(calls).toBe(4)
  })
})
