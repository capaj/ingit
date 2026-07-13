import { useState } from 'react'
import type { RefSummary } from '@ingit/rpc-contract'

interface RefsSidebarProps {
  refs: RefSummary[]
  onSelectRef: (ref: RefSummary) => void
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
  onSelectRef,
  selectedSha,
  onClose,
  onOpenSettings,
  settingsOpen = false,
}: RefsSidebarProps) {
  const [collapsed, setCollapsed] = useState<Partial<Record<RefKind, boolean>>>({ head: true, remote: true, tag: true })
  const [filter, setFilter] = useState('')

  const filterLower = filter.toLowerCase()
  const groups: Record<RefKind, RefSummary[]> = { head: [], remote: [], tag: [] }
  for (const ref of refs) {
    if (filterLower && !ref.shortName.toLowerCase().includes(filterLower)) continue
    groups[ref.kind].push(ref)
  }

  function toggleGroup(kind: RefKind) {
    setCollapsed((prev) => ({ ...prev, [kind]: !prev[kind] }))
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
          placeholder="Filter branches..."
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
