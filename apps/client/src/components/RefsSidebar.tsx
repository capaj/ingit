import { useState } from 'react'
import type { RefSummary } from '@ingit/rpc-contract'

interface RefsSidebarProps {
  refs: RefSummary[]
  onSelectRef: (ref: RefSummary) => void
  selectedSha?: string | null
}

type RefKind = 'head' | 'remote' | 'tag'

const KIND_LABELS: Record<RefKind, string> = {
  head: 'Branches',
  remote: 'Remotes',
  tag: 'Tags',
}

const KIND_ORDER: RefKind[] = ['head', 'remote', 'tag']

export function RefsSidebar({ refs, onSelectRef, selectedSha }: RefsSidebarProps) {
  const [collapsed, setCollapsed] = useState<Partial<Record<RefKind, boolean>>>({})

  const groups: Record<RefKind, RefSummary[]> = { head: [], remote: [], tag: [] }
  for (const ref of refs) {
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
          padding: '12px 14px 8px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: '#6c7086',
          textTransform: 'uppercase',
          borderBottom: '1px solid #313244',
        }}
      >
        Refs
      </div>

      {KIND_ORDER.map((kind) => {
        const items = groups[kind]
        if (items.length === 0) return null
        const isCollapsed = collapsed[kind]

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
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'inherit',
                        overflow: 'hidden',
                      }}
                    >
                      <RefIcon kind={ref.kind} />
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
                        <span
                          style={{
                            display: 'flex',
                            gap: 4,
                            flexShrink: 0,
                            fontSize: 11,
                          }}
                        >
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
    </div>
  )
}

function RefIcon({ kind }: { kind: RefKind }) {
  const style: React.CSSProperties = {
    flexShrink: 0,
    fontSize: 11,
    width: 14,
    textAlign: 'center',
  }
  if (kind === 'head') return <span style={{ ...style, color: '#89b4fa' }}>⎇</span>
  if (kind === 'remote') return <span style={{ ...style, color: '#94e2d5' }}>◉</span>
  return <span style={{ ...style, color: '#f9e2af' }}>◆</span>
}
