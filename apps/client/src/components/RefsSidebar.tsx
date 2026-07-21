import { useState } from 'react'
import type { RefSummary, StashSummary, WorktreeSummary } from '@ingit/rpc-contract'

interface RefsSidebarProps {
  refs: RefSummary[]
  stashes: StashSummary[]
  worktrees: WorktreeSummary[]
  onSelectRef: (ref: RefSummary) => void
  onSelectStash: (stashSha: string) => void
  onSelectStashParent: (parentSha: string) => void
  onOpenWorktree: (path: string) => void
  onRemoveWorktree: (path: string) => Promise<boolean>
  selectedStashSha?: string | null
  selectedSha?: string | null
  onClose: () => void
  onOpenSettings: () => void
  settingsOpen?: boolean
}

type RefKind = 'head' | 'remote' | 'tag'

const KIND_LABELS: Record<RefKind, string> = {
  head: 'Branches',
  remote: 'Remotes',
  tag: 'Tags',
}

const KIND_ORDER: RefKind[] = ['head', 'remote', 'tag']

export function RefsSidebar({
  refs,
  stashes,
  worktrees,
  onSelectRef,
  onSelectStash,
  onSelectStashParent,
  onOpenWorktree,
  onRemoveWorktree,
  selectedStashSha,
  selectedSha,
  onClose,
  onOpenSettings,
  settingsOpen = false,
}: RefsSidebarProps) {
  const [collapsed, setCollapsed] = useState<Partial<Record<RefKind, boolean>>>({ head: true, remote: true, tag: true })
  const [filter, setFilter] = useState('')
  const [stashesExpanded, setStashesExpanded] = useState(false)
  const [worktreesExpanded, setWorktreesExpanded] = useState(true)
  const [removingWorktreePath, setRemovingWorktreePath] = useState<string | null>(null)

  const filterLower = filter.toLowerCase()
  const filteredWorktrees = worktrees.filter((worktree) => !filterLower
    || worktree.path.toLowerCase().includes(filterLower)
    || worktree.branchShortName?.toLowerCase().includes(filterLower))
  const groups: Record<RefKind, RefSummary[]> = { head: [], remote: [], tag: [] }
  for (const ref of refs) {
    if (filterLower && !ref.shortName.toLowerCase().includes(filterLower)) continue
    groups[ref.kind].push(ref)
  }

  function toggleGroup(kind: RefKind) {
    setCollapsed((prev) => ({ ...prev, [kind]: !prev[kind] }))
  }

  async function removeWorktree(worktree: WorktreeSummary) {
    if (worktree.isCurrent || removingWorktreePath) return
    const confirmed = window.confirm(
      `Remove the worktree at ${worktree.path}? Git will refuse if it contains uncommitted changes.`,
    )
    if (!confirmed) return

    setRemovingWorktreePath(worktree.path)
    try {
      await onRemoveWorktree(worktree.path)
    } finally {
      setRemovingWorktreePath(null)
    }
  }

  return (
    <div
      style={{
        width: 250,
        flexShrink: 0,
        height: '100%',
        background: '#181825',
        borderRight: '1px solid #313244',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          padding: '8px 14px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: '#6c7086',
          textTransform: 'uppercase',
          borderBottom: '1px solid #313244',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        Refs
        <button
          onClick={onClose}
          title="Hide refs"
          style={{
            background: 'none',
            border: 'none',
            color: '#6c7086',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 2px',
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ padding: '6px 10px', borderBottom: '1px solid #313244' }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter refs and worktrees..."
          style={{
            width: '100%',
            background: '#1e1e2e',
            border: '1px solid #45475a',
            borderRadius: 4,
            color: '#cdd6f4',
            fontSize: 12,
            padding: '5px 8px',
            outline: 'none',
            fontFamily: 'inherit',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#89b4fa' }}
          onBlur={(e) => { e.currentTarget.style.borderColor = '#45475a' }}
        />
      </div>

      <div
        style={{
          margin: '8px 10px 4px',
          border: '1px solid #704752',
          borderRadius: 7,
          background: '#55323c',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <button
            type="button"
            onClick={() => setStashesExpanded((expanded) => !expanded)}
            aria-expanded={stashesExpanded}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '7px 9px',
              border: 'none',
              background: 'transparent',
              color: '#f5e0dc',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 700,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                transform: stashesExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s',
                color: '#d7a6b2',
                fontSize: 9,
              }}
            >
              ▶
            </span>
            Stashes
            <span
              style={{
                marginLeft: 'auto',
                minWidth: 16,
                padding: '1px 5px',
                borderRadius: 8,
                background: '#311f25aa',
                color: '#d7a6b2',
                fontSize: 10,
                fontWeight: 600,
                textAlign: 'center',
              }}
            >
              {stashes.length}
            </span>
          </button>
        </div>

        {stashesExpanded && (
          <div style={{ borderTop: '1px solid #704752' }}>
            {stashes.length === 0 ? (
              <div style={{ padding: '9px 10px 5px', color: '#c4939f', fontSize: 11 }}>
                No stashed changes
              </div>
            ) : (
              <div>
                {stashes.map((stash) => {
                  const display = stashDisplayMessage(stash.message)
                  return (
                    <div
                      key={stash.sha}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selectedStashSha === stash.sha}
                      onClick={() => onSelectStash(stash.sha)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelectStash(stash.sha)
                        }
                      }}
                      style={{
                        padding: '8px 9px',
                        borderBottom: '1px solid #704752',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                        background: selectedStashSha === stash.sha ? '#f5c2e71a' : 'transparent',
                        boxShadow: selectedStashSha === stash.sha ? 'inset 3px 0 #f5c2e7' : 'none',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            title={stash.message}
                            style={{
                              color: '#f5e0dc',
                              fontSize: 11,
                              fontWeight: 650,
                              lineHeight: 1.35,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {display.message || stash.selector}
                          </div>
                          <div style={{ marginTop: 2, color: '#c4939f', fontSize: 9.5 }}>
                            {stash.selector}{display.context ? ` · ${display.context}` : ''} · {formatStashDate(stash.createdAt)}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onSelectStashParent(stash.parentSha)
                        }}
                        title={`Go to ${stash.parentSha}`}
                        style={{
                          alignSelf: 'flex-start',
                          padding: 0,
                          border: 'none',
                          background: 'none',
                          color: '#89b4fa',
                          fontFamily: 'monospace',
                          fontSize: 10,
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textUnderlineOffset: 2,
                        }}
                      >
                        parent {stash.parentSha.slice(0, 8)}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <button
          type="button"
          onClick={() => setWorktreesExpanded((expanded) => !expanded)}
          aria-expanded={filter ? true : worktreesExpanded}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            background: 'none',
            border: 'none',
            color: '#a6adc8',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              transform: !filter && !worktreesExpanded ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            ▼
          </span>
          Worktrees
          <span
            style={{
              marginLeft: 'auto',
              background: '#313244',
              borderRadius: 8,
              padding: '1px 6px',
              fontSize: 10,
              color: '#6c7086',
              fontWeight: 500,
            }}
          >
            {filteredWorktrees.length}
          </span>
        </button>

        {(filter || worktreesExpanded) && (
          <div>
            {filteredWorktrees.length === 0 ? (
              <div style={{ padding: '5px 14px 7px 28px', color: '#6c7086', fontSize: 11 }}>
                No matching worktrees
              </div>
            ) : filteredWorktrees.map((worktree) => {
              const displayName = worktreeDisplayName(worktree)
              const removing = removingWorktreePath === worktree.path
              return (
                <div
                  key={worktree.path}
                  style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    paddingLeft: 20,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!worktree.isCurrent) onOpenWorktree(worktree.path)
                    }}
                    title={worktree.isCurrent ? `${worktree.path} (current worktree)` : `Open ${worktree.path}`}
                    disabled={worktree.isCurrent}
                    style={{
                      minWidth: 0,
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '5px 6px 5px 8px',
                      background: 'none',
                      border: 'none',
                      color: worktree.isCurrent ? '#a6e3a1' : '#cdd6f4',
                      cursor: worktree.isCurrent ? 'default' : 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                    }}
                  >
                    <WorktreeIcon current={worktree.isCurrent} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 12,
                          fontWeight: worktree.isCurrent ? 700 : 500,
                        }}
                      >
                        {displayName}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          marginTop: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: '#6c7086',
                          fontSize: 9.5,
                        }}
                      >
                        {worktree.path}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { void removeWorktree(worktree) }}
                    disabled={worktree.isCurrent || removingWorktreePath !== null}
                    title={worktree.isCurrent
                      ? 'The current worktree cannot be removed'
                      : `Remove worktree ${worktree.path}`}
                    aria-label={removing ? `Removing worktree ${displayName}` : `Remove worktree ${displayName}`}
                    style={{
                      width: 32,
                      flexShrink: 0,
                      display: 'grid',
                      placeItems: 'center',
                      padding: 0,
                      border: 'none',
                      background: 'none',
                      color: removing ? '#f9e2af' : '#f38ba8',
                      cursor: worktree.isCurrent || removingWorktreePath !== null ? 'default' : 'pointer',
                      opacity: worktree.isCurrent ? 0.25 : removingWorktreePath && !removing ? 0.4 : 0.8,
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {KIND_ORDER.map((kind) => {
        const items = groups[kind]
        if (items.length === 0) return null
        const isCollapsed = filter ? false : collapsed[kind]

        return (
          <div key={kind}>
            <button
              onClick={() => toggleGroup(kind)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                background: 'none',
                border: 'none',
                color: '#a6adc8',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s',
                  fontSize: 10,
                  lineHeight: 1,
                }}
              >
                ▼
              </span>
              {KIND_LABELS[kind]}
              <span
                style={{
                  marginLeft: 'auto',
                  background: '#313244',
                  borderRadius: 8,
                  padding: '1px 6px',
                  fontSize: 10,
                  color: '#6c7086',
                  fontWeight: 500,
                }}
              >
                {items.length}
              </span>
            </button>

            {!isCollapsed && (
              <div>
                {items.map((ref) => {
                  const isSelected = ref.targetSha === selectedSha
                  return (
                    <button
                      key={ref.name}
                      onClick={() => onSelectRef(ref)}
                      title={ref.name}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 14px 5px 28px',
                        background: isSelected ? '#313244' : 'none',
                        border: 'none',
                        color: isSelected ? '#89b4fa' : '#cdd6f4',
                        fontSize: 13,
                        fontWeight: ref.isCurrent ? 700 : 'normal',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'inherit',
                        overflow: 'hidden',
                      }}
                    >
                      <RefIcon kind={ref.kind} isCurrent={ref.isCurrent} />
                      <span
                        style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {ref.shortName}
                      </span>
                      {(ref.ahead != null || ref.behind != null) && (
                        <span style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11 }}>
                          {ref.ahead != null && ref.ahead > 0 && (
                            <span style={{ color: '#a6e3a1' }}>↑{ref.ahead}</span>
                          )}
                          {ref.behind != null && ref.behind > 0 && (
                            <span style={{ color: '#f38ba8' }}>↓{ref.behind}</span>
                          )}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <div style={{ marginTop: 'auto', padding: '10px', borderTop: '1px solid #313244' }}>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Open settings"
          aria-label="Open settings"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            borderRadius: 5,
            border: '1px solid #313244',
            background: settingsOpen ? '#89b4fa20' : 'transparent',
            color: settingsOpen ? '#89b4fa' : '#a6adc8',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true" style={{ color: settingsOpen ? '#89b4fa' : '#6c7086' }}>⚙</span>
          Settings
        </button>
      </div>
    </div>
  )
}

function stashDisplayMessage(message: string): { message: string; context: string } {
  const match = /^(?:WIP )?on ([^:]+):\s*(.*)$/i.exec(message)
  if (!match) return { message, context: '' }
  return {
    message: match[2] ?? message,
    context: `on ${match[1]}`,
  }
}

function formatStashDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function RefIcon({ kind, isCurrent }: { kind: RefKind; isCurrent?: boolean }) {
  const style: React.CSSProperties = {
    flexShrink: 0,
    fontSize: 11,
    width: 14,
    textAlign: 'center',
  }
  if (kind === 'head') return <span style={{ ...style, color: isCurrent ? '#a6e3a1' : '#89b4fa' }}>{isCurrent ? '●' : '⎇'}</span>
  if (kind === 'remote') return <span style={{ ...style, color: '#94e2d5' }}>◉</span>
  return <span style={{ ...style, color: '#f9e2af' }}>◆</span>
}

function worktreeDisplayName(worktree: WorktreeSummary): string {
  if (worktree.branchShortName) return worktree.branchShortName
  if (worktree.detached && worktree.headSha) return `Detached at ${worktree.headSha.slice(0, 8)}`
  const normalized = worktree.path.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]+/).at(-1) || worktree.path
}

function WorktreeIcon({ current }: { current: boolean }) {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="4" cy="3" r="2" fill={current ? '#a6e3a1' : '#94e2d5'} />
      <circle cx="12" cy="5" r="2" fill={current ? '#a6e3a1' : '#94e2d5'} />
      <circle cx="8" cy="13" r="2" fill={current ? '#a6e3a1' : '#94e2d5'} />
      <path d="M4 5v2.5A2.5 2.5 0 0 0 6.5 10H8m4-3v.5A2.5 2.5 0 0 1 9.5 10H8v1" stroke={current ? '#a6e3a1' : '#94e2d5'} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 5h9m-6-2h3l.75 2h-4.5l.75-2Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 5.5 5.5 13h5l.5-7.5M7 7.5v3.5m2-3.5v3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
