import { useEffect, useMemo, useState } from 'react'
import { highlightText } from '@speed-highlight/core'
import type { ShjLanguage } from '@speed-highlight/core'
import type { ImageDiff, ImagePreview } from '@ingit/rpc-contract'

export interface FileDiffEntry {
  loading: boolean
  patchText?: string
  isBinary?: boolean
  imageDiff?: ImageDiff
  error?: string
}

// Skip syntax highlighting for gigantic patches — parsing tens of thousands of
// lines through the highlighter would just freeze the panel.
const HIGHLIGHT_MAX_LINES = 50_000

// File extension -> @speed-highlight/core language id.
const EXT_LANG: Record<string, ShjLanguage> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', rs: 'rs', go: 'go', java: 'java', lua: 'lua', pl: 'pl',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c',
  css: 'css', scss: 'css', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  json: 'json', md: 'md', markdown: 'md',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', dockerfile: 'docker', makefile: 'make',
}

function languageForPath(path: string): ShjLanguage {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'dockerfile') return 'docker'
  if (base === 'makefile') return 'make'
  const ext = base.slice(base.lastIndexOf('.') + 1)
  return EXT_LANG[ext] ?? 'plain'
}

// Colors for @speed-highlight token classes, matching the app's palette.
const SYNTAX_CSS = `
.file-diff .shj-syn-cmnt { color: #6c7086; font-style: italic; }
.file-diff .shj-syn-kwd { color: #cba6f7; }
.file-diff .shj-syn-num { color: #fab387; }
.file-diff .shj-syn-bool { color: #fab387; }
.file-diff .shj-syn-str { color: #a6e3a1; }
.file-diff .shj-syn-func { color: #89b4fa; }
.file-diff .shj-syn-class { color: #f9e2af; }
.file-diff .shj-syn-section { color: #94e2d5; }
.file-diff .shj-syn-oper { color: #94e2d5; }
.file-diff .shj-syn-var { color: #cdd6f4; }
.file-diff .shj-syn-esc { color: #f5c2e7; }
.file-diff .shj-syn-err { color: #f38ba8; }
`

type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx'

interface DiffLine {
  kind: DiffLineKind
  /** Line content without the leading +/-/space marker. */
  content: string
  marker: string
}

// Turn a raw git patch into displayable lines: drop the per-file header
// (diff --git / index / --- / +++ / mode lines), keep hunks and content.
function parsePatch(patchText: string): DiffLine[] {
  const out: DiffLine[] = []
  let inHunk = false
  for (const line of patchText.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      out.push({ kind: 'hunk', content: line, marker: '' })
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) out.push({ kind: 'add', content: line.slice(1), marker: '+' })
    else if (line.startsWith('-')) out.push({ kind: 'del', content: line.slice(1), marker: '-' })
    else if (line.startsWith(' ') || line === '') out.push({ kind: 'ctx', content: line.slice(1), marker: ' ' })
    else if (line.startsWith('\\')) out.push({ kind: 'ctx', content: line, marker: '' })
  }
  return out
}

const LINE_BG: Record<DiffLineKind, string> = {
  add: '#a6e3a114',
  del: '#f38ba814',
  hunk: 'transparent',
  ctx: 'transparent',
}

const MARKER_COLOR: Record<DiffLineKind, string> = {
  add: '#a6e3a1',
  del: '#f38ba8',
  hunk: '#89b4fa',
  ctx: '#45475a',
}

export function DiffView({ entry, path }: { entry: FileDiffEntry; path: string }) {
  const lines = useMemo(
    () => (entry.patchText ? parsePatch(entry.patchText) : []),
    [entry.patchText],
  )
  const lang = useMemo(() => languageForPath(path), [path])
  const shouldHighlight = lang !== 'plain' && lines.length <= HIGHLIGHT_MAX_LINES
  // Highlighted HTML per line (index-aligned with `lines`), null until ready.
  const [highlighted, setHighlighted] = useState<(string | null)[] | null>(null)

  useEffect(() => {
    setHighlighted(null)
    if (!shouldHighlight || lines.length === 0) return
    let cancelled = false
    Promise.all(
      lines.map((l) =>
        l.kind === 'hunk' || l.content.length === 0
          ? Promise.resolve(null)
          : highlightText(l.content, lang, false).catch(() => null),
      ),
    ).then((html) => {
      if (!cancelled) setHighlighted(html)
    })
    return () => { cancelled = true }
  }, [lines, lang, shouldHighlight])

  if (entry.loading) {
    return <DiffNote text="Loading diff..." />
  }
  if (entry.error) {
    return <DiffNote text={entry.error} color="#f38ba8" />
  }
  if (entry.imageDiff) {
    return <ImageDiffView imageDiff={entry.imageDiff} path={path} />
  }
  if (entry.isBinary) {
    return <DiffNote text="Binary file" />
  }
  if (lines.length === 0) {
    return <DiffNote text="No textual changes" />
  }

  return (
    <div
      className="file-diff"
      style={{
        margin: '2px 0 6px 24px',
        border: '1px solid #313244',
        borderRadius: 6,
        background: '#11111b',
        overflow: 'auto',
        maxHeight: 420,
        fontSize: 11,
        fontFamily: 'monospace',
        lineHeight: 1.5,
      }}
    >
      <style>{SYNTAX_CSS}</style>
      <div style={{ minWidth: 'fit-content' }}>
        {lines.map((line, i) => {
          const html = highlighted?.[i] ?? null
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                background: LINE_BG[line.kind],
                color: line.kind === 'hunk' ? '#89b4fa' : '#cdd6f4',
                whiteSpace: 'pre',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 16,
                  textAlign: 'center',
                  color: MARKER_COLOR[line.kind],
                  userSelect: 'none',
                }}
              >
                {line.marker}
              </span>
              {html !== null ? (
                <span dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <span>{line.content}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ImageDiffView({ imageDiff, path }: { imageDiff: ImageDiff; path: string }) {
  const images: Array<{ label: string; preview: ImagePreview }> = []
  if (imageDiff.before) {
    images.push({
      label: imageDiff.after ? 'Before' : 'Deleted image',
      preview: imageDiff.before,
    })
  }
  if (imageDiff.after) {
    images.push({
      label: imageDiff.before ? 'After' : 'Added image',
      preview: imageDiff.after,
    })
  }

  return (
    <div
      style={{
        margin: '2px 0 6px 24px',
        padding: 10,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        border: '1px solid #313244',
        borderRadius: 6,
        background: '#11111b',
        overflow: 'auto',
        maxHeight: 520,
      }}
    >
      {images.map(({ label, preview }) => (
        <figure
          key={label}
          style={{
            flex: '1 1 220px',
            minWidth: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <figcaption
            style={{
              color: '#a6adc8',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {label}
          </figcaption>
          <div
            style={{
              minHeight: 80,
              padding: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              backgroundColor: '#181825',
              backgroundImage: [
                'linear-gradient(45deg, #242435 25%, transparent 25%)',
                'linear-gradient(-45deg, #242435 25%, transparent 25%)',
                'linear-gradient(45deg, transparent 75%, #242435 75%)',
                'linear-gradient(-45deg, transparent 75%, #242435 75%)',
              ].join(','),
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
              backgroundSize: '16px 16px',
            }}
          >
            <img
              src={preview.dataUrl}
              alt={`${path} ${label.toLowerCase()}`}
              draggable={false}
              style={{
                display: 'block',
                maxWidth: '100%',
                maxHeight: 410,
                objectFit: 'contain',
              }}
            />
          </div>
        </figure>
      ))}
    </div>
  )
}

function DiffNote({ text, color }: { text: string; color?: string }) {
  return (
    <div
      style={{
        margin: '2px 0 6px 24px',
        padding: '6px 10px',
        fontSize: 11,
        color: color ?? '#6c7086',
        border: '1px solid #313244',
        borderRadius: 6,
        background: '#11111b',
      }}
    >
      {text}
    </div>
  )
}
