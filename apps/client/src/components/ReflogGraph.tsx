import { useMemo, useState, useEffect } from 'react'
import type { ReflogEntry, ReflogEntryKind } from '@ingit/rpc-contract'
import { useAppStore } from '../store'
import { CommitActionButton, RefActionButton } from './graph-canvas/ActionButtons'
import { NativeConfirmDialog, NativeTextInputDialog } from './NativeDialogs'

// ---------------------------------------------------------------------------
// Layout — mirrors GraphCanvas visuals on a HEAD-movement timeline
// ---------------------------------------------------------------------------

const NODE_SPACING_Y = 56
const LANE_WIDTH = 56
const NODE_RADIUS = 12
const NODE_FILL = '#11111b'
const PAD_TOP = 56
const PAD_BOTTOM = 80
const TIME_GUTTER = 110
const GRAPH_ORIGIN_X = TIME_GUTTER + 40
const TEXT_GAP = 28
const TEXT_AREA_WIDTH = 640

const LANE_COLORS = [
  '#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7',
  '#94e2d5', '#fab387', '#74c7ec', '#f5c2e7', '#b4befe',
]

function laneColor(lane: number) {
  return LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]
}

const LOST_COLOR = '#f9e2af'

const KIND_COLORS: Record<ReflogEntryKind, string> = {
  'commit': '#a6e3a1',
  'amend': '#f9e2af',
  'checkout': '#89b4fa',
  'reset': '#f38ba8',
  'rebase': '#fab387',
  'merge': '#cba6f7',
  'cherry-pick': '#94e2d5',
  'revert': '#f5c2e7',
  'pull': '#74c7ec',
  'branch': '#b4befe',
  'clone': '#9399b2',
  'other': '#9399b2',
}

// Operations that rewrite or discard history — work can become unreachable here
const DANGEROUS_KINDS = new Set<ReflogEntryKind>(['reset', 'rebase', 'amend'])

const KIND_EXPLANATIONS: Partial<Record<ReflogEntryKind, string>> = {
  'reset': 'reset moved HEAD away — commits only on the old position may be unreachable',
  'rebase': 'rebase rewrote history — the original commits live on only in the reflog',
  'amend': 'amend replaced the previous commit — the original version is only in the reflog',
}

interface RecoverDialogState {
  entry: ReflogEntry
  defaultName: string
}

interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
}

// Same cubic bezier as GraphCanvas edges
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1},${y1}L${x2},${y2}`
  const dy = y2 - y1
  return `M${x1},${y1}C${x1},${y1 + dy * 0.3} ${x2},${y2 - dy * 0.3} ${x2},${y2}`
}

// Assign a lane per unique commit, recycling lanes once a commit no longer
// appears further down. Revisited commits (checkout ping-pong, reset back)
// line up vertically — that is what makes the timeline read as a graph.
function assignLanes(entries: ReflogEntry[]): { lanes: number[]; maxLane: number } {
  const lastIndexBySha = new Map<string, number>()
  entries.forEach((entry, i) => lastIndexBySha.set(entry.sha, i))

  const laneBySha = new Map<string, number>()
  const laneOccupants: Array<string | null> = []
  const lanes: number[] = []
  let maxLane = 0

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    let lane = laneBySha.get(entry.sha)
    if (lane === undefined) {
      lane = laneOccupants.indexOf(null)
      if (lane === -1) {
        lane = laneOccupants.length
        laneOccupants.push(entry.sha)
      } else {
        laneOccupants[lane] = entry.sha
      }
      laneBySha.set(entry.sha, lane)
    }
    lanes.push(lane)
    if (lane > maxLane) maxLane = lane
    if (lastIndexBySha.get(entry.sha) === i) {
      laneOccupants[lane] = null
    }
  }

  return { lanes, maxLane }
}

function relativeTime(unix: number): string {
  if (!unix) return ''
  const diff = Math.floor(Date.now() / 1000 - unix)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 172800) return 'yesterday'
  if (diff < 14 * 86400) return `${Math.floor(diff / 86400)}d ago`
  const date = new Date(unix * 1000)
  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return date.getFullYear() === new Date().getFullYear()
    ? label
    : `${label} ${date.getFullYear()}`
}

export function ReflogGraph() {
  const reflog = useAppStore((state) => state.reflog)
  const reflogLoading = useAppStore((state) => state.reflogLoading)
  const reflogMaxCount = useAppStore((state) => state.reflogMaxCount)
  const selectedSha = useAppStore((state) => state.selectedSha)
  const selectCommit = useAppStore((state) => state.selectCommit)
  const recoverBranch = useAppStore((state) => state.recoverBranch)
  const checkoutSha = useAppStore((state) => state.checkoutSha)
  const performCommitAction = useAppStore((state) => state.performCommitAction)
  const loadMoreReflog = useAppStore((state) => state.loadMoreReflog)
  const showError = useAppStore((state) => state.showError)

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [recoverDialog, setRecoverDialog] = useState<RecoverDialogState | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)

  // Entries shift when the reflog reloads after an action — drop the selection
  useEffect(() => {
    setSelectedIndex(null)
  }, [reflog])

  const entries = reflog?.entries ?? []

  const { lanes, maxLane } = useMemo(() => assignLanes(entries), [entries])

  const lostShas = useMemo(() => {
    const set = new Set<string>()
    for (const entry of entries) {
      if (!entry.isReachable) set.add(entry.sha)
    }
    return set
  }, [entries])

  const nodeX = (lane: number) => GRAPH_ORIGIN_X + lane * LANE_WIDTH
  const nodeY = (index: number) => PAD_TOP + index * NODE_SPACING_Y
  const textX = GRAPH_ORIGIN_X + (maxLane + 1) * LANE_WIDTH + TEXT_GAP

  const totalWidth = textX + TEXT_AREA_WIDTH
  const totalHeight = PAD_TOP + entries.length * NODE_SPACING_Y + PAD_BOTTOM

  // Time labels only where they change, like the main graph's time rail
  const timeLabels = useMemo(() => {
    let previous = ''
    return entries.map((entry) => {
      const label = relativeTime(entry.entryUnix)
      if (label === previous) return ''
      previous = label
      return label
    })
  }, [entries])

  const handleRecover = (entry: ReflogEntry) => {
    setRecoverDialog({
      entry,
      defaultName: `recovered-${entry.sha.slice(0, 7)}`,
    })
  }

  const handleCheckout = (entry: ReflogEntry) => {
    setConfirmDialog({
      title: 'Checkout commit',
      message: `Checkout ${entry.sha.slice(0, 8)}? This detaches HEAD at that state.`,
      confirmLabel: 'Checkout',
      onConfirm: () => {
        checkoutSha(entry.sha).catch((err) => showError('Checkout failed', err))
      },
    })
  }

  const handleCherryPick = (entry: ReflogEntry) => {
    setConfirmDialog({
      title: 'Cherry pick commit',
      message: `Cherry-pick ${entry.sha.slice(0, 8)} onto the current branch?`,
      confirmLabel: 'Cherry pick',
      onConfirm: () => {
        performCommitAction('cherry-pick', entry.sha).catch((err) => showError('Cherry-pick failed', err))
      },
    })
  }

  const submitRecoverBranch = (branchName: string) => {
    if (!recoverDialog) return
    const { entry } = recoverDialog
    setRecoverDialog(null)
    recoverBranch(branchName, entry.sha).catch((err) => showError('Recover failed', err))
  }

  const handleCopySha = (entry: ReflogEntry) => {
    void navigator.clipboard?.writeText(entry.sha)
  }

  if (!reflog && reflogLoading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6c7086', fontSize: 13 }}>
        Reading reflog…
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#45475a', fontSize: 13 }}>
        No reflog entries — this repository has no recorded HEAD movements yet
      </div>
    )
  }

  return (
    <div
      style={{ flex: 1, height: '100%', overflow: 'auto', position: 'relative', background: '#1e1e2e' }}
      onClick={() => setSelectedIndex(null)}
    >
      <NativeTextInputDialog
        open={!!recoverDialog}
        title={recoverDialog ? `Create branch at ${recoverDialog.entry.sha.slice(0, 8)}` : 'Create branch'}
        label="Branch name"
        initialValue={recoverDialog?.defaultName ?? ''}
        confirmLabel="Create"
        onSubmit={submitRecoverBranch}
        onClose={() => setRecoverDialog(null)}
      />
      <NativeConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel={confirmDialog?.confirmLabel ?? 'Confirm'}
        onConfirm={() => {
          const run = confirmDialog?.onConfirm
          setConfirmDialog(null)
          run?.()
        }}
        onClose={() => setConfirmDialog(null)}
      />

      {lostShas.size > 0 && (
        <div style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          margin: '10px 14px 0',
          padding: '8px 14px',
          borderRadius: 6,
          background: '#f9e2af18',
          border: `1px solid ${LOST_COLOR}55`,
          color: LOST_COLOR,
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ fontSize: 14 }}>⚠</span>
          <span>
            {lostShas.size === 1
              ? '1 commit in your reflog is no longer reachable from any branch.'
              : `${lostShas.size} commits in your reflog are no longer reachable from any branch.`}
            {' '}Select a dashed entry below to recover it.
          </span>
        </div>
      )}

      <div style={{ width: totalWidth, height: totalHeight, position: 'relative' }}>
        <div style={{
          position: 'absolute',
          left: TIME_GUTTER + 40 - NODE_RADIUS,
          top: 16,
          color: '#585b70',
          fontSize: 11,
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}>
          {reflog?.refName ?? 'HEAD'} time machine — every state HEAD has pointed to, newest first
        </div>

        <svg
          width={totalWidth}
          height={totalHeight}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
        >
          {entries.slice(0, -1).map((_entry, i) => {
            const x1 = nodeX(lanes[i])
            const y1 = nodeY(i)
            const x2 = nodeX(lanes[i + 1])
            const y2 = nodeY(i + 1)
            return (
              <path
                key={`edge-${i}`}
                d={edgePath(x2, y2, x1, y1)}
                stroke={laneColor(lanes[i])}
                strokeWidth={2.25}
                fill="none"
                strokeLinecap="round"
                opacity={0.85}
              />
            )
          })}

          {entries.map((entry, i) => {
            const x = nodeX(lanes[i])
            const y = nodeY(i)
            const color = laneColor(lanes[i])
            const isSelected = selectedIndex === i || (selectedIndex === null && entry.sha === selectedSha)
            const isLost = !entry.isReachable
            return (
              <g
                key={`node-${i}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedIndex(i)
                  selectCommit(entry.sha)
                }}
                style={{ cursor: 'pointer', pointerEvents: 'auto' }}
              >
                <title>{`${entry.selector} — ${entry.message}`}</title>
                {isSelected && (
                  <circle cx={x} cy={y} r={NODE_RADIUS * 2.3} fill={color} opacity={0.15} />
                )}
                {isLost && (
                  <circle
                    cx={x}
                    cy={y}
                    r={NODE_RADIUS + 5}
                    fill="none"
                    stroke={LOST_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    opacity={0.9}
                  />
                )}
                <circle
                  cx={x}
                  cy={y}
                  r={NODE_RADIUS}
                  fill={NODE_FILL}
                  stroke={color}
                  strokeWidth={isSelected ? 3 : 2.25}
                />
                {i === 0 && <circle cx={x} cy={y} r={3} fill={color} />}
              </g>
            )
          })}
        </svg>

        {entries.map((_entry, i) => {
          const y = nodeY(i)
          if (!timeLabels[i]) return null
          return (
            <div
              key={`time-${i}`}
              style={{
                position: 'absolute',
                left: 0,
                top: y - 7,
                width: TIME_GUTTER,
                textAlign: 'right',
                color: '#585b70',
                fontSize: 11,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {timeLabels[i]}
            </div>
          )
        })}

        {entries.map((entry, i) => {
          const y = nodeY(i)
          const isSelected = selectedIndex === i
          const isLost = !entry.isReachable
          const kindColor = KIND_COLORS[entry.kind]
          const isDangerous = DANGEROUS_KINDS.has(entry.kind)
          const explanation = KIND_EXPLANATIONS[entry.kind]

          return (
            <div
              key={`row-${i}`}
              onClick={(e) => {
                e.stopPropagation()
                setSelectedIndex(i)
                selectCommit(entry.sha)
              }}
              style={{ position: 'absolute', left: textX, top: y - 10, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 20, whiteSpace: 'nowrap' }}>
                <span
                  title={explanation ?? entry.message}
                  style={{
                    height: 18,
                    padding: '0 8px',
                    borderRadius: 4,
                    background: kindColor + '20',
                    border: `1px solid ${kindColor}55`,
                    color: kindColor,
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: '18px',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  {isDangerous ? '⚠ ' : ''}{entry.kind}
                </span>
                {isLost && (
                  <span
                    title="Not reachable from any branch — only the reflog still knows this commit"
                    style={{
                      height: 18,
                      padding: '0 8px',
                      borderRadius: 4,
                      background: LOST_COLOR + '20',
                      border: `1px solid ${LOST_COLOR}`,
                      color: LOST_COLOR,
                      fontSize: 10,
                      fontWeight: 700,
                      lineHeight: '18px',
                    }}
                  >
                    LOST
                  </span>
                )}
                {entry.refNames.slice(0, 3).map((refName) => (
                  <span
                    key={refName}
                    style={{
                      height: 18,
                      padding: '0 7px',
                      borderRadius: 4,
                      background: '#89b4fa18',
                      border: '1px solid #89b4fa55',
                      color: '#89b4fa',
                      fontSize: 10,
                      fontWeight: 600,
                      lineHeight: '18px',
                    }}
                  >
                    {refName}
                  </span>
                ))}
                <span style={{ color: '#6c7086', fontSize: 11, fontFamily: 'monospace' }}>
                  {entry.sha.slice(0, 7)}
                </span>
                <span style={{
                  color: '#a6adc8',
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 360,
                }}>
                  {entry.subject}
                </span>
              </div>

              {isSelected ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  {isLost ? (
                    <CommitActionButton
                      label="Recover branch"
                      tone="success"
                      onClick={() => handleRecover(entry)}
                    />
                  ) : (
                    <RefActionButton
                      label="Branch here"
                      tone="neutral"
                      size="compact"
                      onClick={() => handleRecover(entry)}
                    />
                  )}
                  <RefActionButton
                    label="Checkout"
                    tone="warning"
                    size="compact"
                    onClick={() => handleCheckout(entry)}
                  />
                  <RefActionButton
                    label="Cherry-pick"
                    tone="neutral"
                    size="compact"
                    onClick={() => handleCherryPick(entry)}
                  />
                  <RefActionButton
                    label="Copy sha"
                    tone="neutral"
                    size="compact"
                    variant="ghost"
                    onClick={() => handleCopySha(entry)}
                  />
                </div>
              ) : (
                <div style={{
                  marginTop: 4,
                  color: '#6c7086',
                  fontSize: 10,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: TEXT_AREA_WIDTH - 40,
                }}>
                  {entry.message}
                </div>
              )}
            </div>
          )
        })}

        {entries.length >= reflogMaxCount && (
          <div style={{ position: 'absolute', left: textX, top: nodeY(entries.length) + 4 }}>
            <RefActionButton
              label={reflogLoading ? 'Loading…' : 'Load older entries'}
              tone="neutral"
              size="compact"
              variant="ghost"
              onClick={() => { void loadMoreReflog() }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
