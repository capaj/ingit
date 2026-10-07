export type PatchLineKind = 'added' | 'removed' | 'context' | 'header'
export type PatchLineFilter = 'all' | 'changed' | 'added' | 'removed'

export interface PatchLine {
  text: string
  kind: PatchLineKind
  oldLine: number | null
  newLine: number | null
}

export interface SearchablePatch {
  key: string
  path: string
  label: string
  lines: PatchLine[]
  isBinary?: boolean
  error?: string
}

export interface MatchRange {
  start: number
  end: number
}

export interface PatchLineMatch {
  index: number
  ranges: MatchRange[]
}

export interface PatchSearchOptions {
  regex: boolean
  caseSensitive: boolean
  lineFilter: PatchLineFilter
}

/** Keep the raw patch searchable, while tracking both sides of each hunk. */
export function parsePatchLines(patchText: string): PatchLine[] {
  const rawLines = patchText.split('\n')
  if (rawLines.at(-1) === '') rawLines.pop()
  let oldLine = 0
  let newLine = 0
  let parentCount = 0

  return rawLines.map((text) => {
    const line: PatchLine = { text, kind: 'header', oldLine: null, newLine: null }
    if (text.startsWith('diff ')) parentCount = 0
    const hunk = /^(@{2,}) (.+?) \1(?: |$)/.exec(text)
    if (hunk) {
      const ranges = [...hunk[2]!.matchAll(/([+-])(\d+)(?:,\d+)?/g)]
      parentCount = hunk[1]!.length - 1
      if (ranges.length !== parentCount + 1) {
        parentCount = 0
        return line
      }
      oldLine = Number(ranges[0]![2])
      newLine = Number(ranges.at(-1)![2])
      return line
    }
    if (!parentCount || text.startsWith('\\')) return line

    const markers = text.slice(0, parentCount)
    if (markers.length !== parentCount || /[^ +\-]/.test(markers)) return line
    if (markers.includes('-')) {
      line.kind = 'removed'
      if (parentCount === 1) line.oldLine = oldLine++
    } else if (markers.includes('+')) {
      line.kind = 'added'
      line.newLine = newLine++
    } else {
      line.kind = 'context'
      if (parentCount === 1) line.oldLine = oldLine++
      line.newLine = newLine++
    }
    return line
  })
}

export function searchPatches(
  patches: SearchablePatch[],
  query: string,
  options: PatchSearchOptions,
  limit = 500,
) {
  const files: Array<{ patch: SearchablePatch; matches: PatchLineMatch[]; matchingLines: number }> = []
  let matchingLines = 0
  let matchingFiles = 0
  let error: string | null = null
  if (!query) return { files, matchingLines, matchingFiles, error, truncated: false }

  let pattern: RegExp
  try {
    const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    pattern = new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  } catch (err) {
    error = err instanceof Error ? err.message : 'Invalid regular expression'
    return { files, matchingLines, matchingFiles, error, truncated: false }
  }

  for (const patch of patches) {
    const matches: PatchLineMatch[] = []
    let fileMatchingLines = 0
    for (let index = 0; index < patch.lines.length; index++) {
      const line = patch.lines[index]!
      if (options.lineFilter === 'changed' && line.kind !== 'added' && line.kind !== 'removed') continue
      if (options.lineFilter === 'added' && line.kind !== 'added') continue
      if (options.lineFilter === 'removed' && line.kind !== 'removed') continue
      pattern.lastIndex = 0
      if (!pattern.test(line.text)) continue
      fileMatchingLines++
      matchingLines++
      if (matchingLines > limit) continue
      pattern.lastIndex = 0
      // matchAll advances past zero-width matches, including Unicode characters.
      const ranges = [...line.text.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      }))
      matches.push({ index, ranges })
    }
    if (fileMatchingLines) matchingFiles++
    if (matches.length) files.push({ patch, matches, matchingLines: fileMatchingLines })
  }
  return { files, matchingLines, matchingFiles, error, truncated: matchingLines > limit }
}

/** Merge nearby matches so their surrounding lines are displayed only once. */
export function patchMatchWindows(lineCount: number, matches: PatchLineMatch[], context = 2) {
  const windows: Array<{ start: number; end: number }> = []
  for (const match of matches) {
    const start = Math.max(0, match.index - context)
    const end = Math.min(lineCount, match.index + context + 1)
    const previous = windows.at(-1)
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
    else windows.push({ start, end })
  }
  return windows
}

/** Limit concurrent RPCs, and stop scheduling work when a screen is superseded. */
export async function loadPatchFiles<T>(
  files: T[],
  load: (file: T) => Promise<SearchablePatch>,
  cancelled: () => boolean,
): Promise<SearchablePatch[]> {
  const patches: SearchablePatch[] = new Array(files.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (!cancelled()) {
      const index = next++
      if (index >= files.length) return
      patches[index] = await load(files[index]!)
    }
  }))
  return patches
}
