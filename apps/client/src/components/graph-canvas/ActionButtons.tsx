type ActionIconName =
  | 'branch'
  | 'checkout'
  | 'cherry-pick'
  | 'delete'
  | 'fetch'
  | 'force-push'
  | 'merge'
  | 'move'
  | 'push'
  | 'rebase'
  | 'reset'
  | 'revert'
  | 'tag'
  | 'uncommit'

function iconForLabel(label: string): ActionIconName {
  const normalized = label.toLowerCase().replace(/^←\s*/, '')
  if (normalized.includes('force push')) return 'force-push'
  if (normalized.includes('cherry')) return 'cherry-pick'
  if (normalized.includes('uncommit')) return 'uncommit'
  if (normalized.includes('revert')) return 'revert'
  if (normalized.includes('rebase')) return 'rebase'
  if (normalized.includes('merge')) return 'merge'
  if (normalized.includes('checkout')) return 'checkout'
  if (normalized.includes('fetch')) return 'fetch'
  if (normalized.includes('push')) return 'push'
  if (normalized.includes('delete')) return 'delete'
  if (normalized.includes('move')) return 'move'
  if (normalized.includes('reset')) return 'reset'
  if (normalized.includes('branch')) return 'branch'
  if (normalized.includes('tag')) return 'tag'
  return 'checkout'
}

function ActionIcon({ name, size = 14 }: { name: ActionIconName; size?: number }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ flex: '0 0 auto' }}
    >
      {name === 'branch' && (
        <>
          <circle {...common} cx="6" cy="6" r="3" />
          <circle {...common} cx="18" cy="18" r="3" />
          <path {...common} d="M6 9v9" />
          <path {...common} d="M9 18h6" />
        </>
      )}
      {name === 'checkout' && (
        <>
          <path {...common} d="M5 12h14" />
          <path {...common} d="m13 6 6 6-6 6" />
          <path {...common} d="M5 5v14" />
        </>
      )}
      {name === 'cherry-pick' && (
        <>
          <circle {...common} cx="7" cy="7" r="3" />
          <circle {...common} cx="17" cy="17" r="3" />
          <path {...common} d="M10 7h2a5 5 0 0 1 5 5v2" />
        </>
      )}
      {name === 'delete' && (
        <>
          <path {...common} d="M3 6h18" />
          <path {...common} d="M8 6V4h8v2" />
          <path {...common} d="m19 6-1 14H6L5 6" />
          <path {...common} d="M10 11v5" />
          <path {...common} d="M14 11v5" />
        </>
      )}
      {name === 'fetch' && (
        <>
          <path {...common} d="M12 5v12" />
          <path {...common} d="m7 12 5 5 5-5" />
          <path {...common} d="M5 20h14" />
        </>
      )}
      {name === 'force-push' && (
        <path {...common} d="M13 2 4 14h7l-1 8 10-13h-7l0-7Z" />
      )}
      {name === 'merge' && (
        <>
          <circle {...common} cx="6" cy="6" r="3" />
          <circle {...common} cx="6" cy="18" r="3" />
          <circle {...common} cx="18" cy="18" r="3" />
          <path {...common} d="M6 9v6" />
          <path {...common} d="M9 6h1a8 8 0 0 1 8 8v1" />
        </>
      )}
      {name === 'move' && (
        <>
          <path {...common} d="M3 12h18" />
          <path {...common} d="m8 7-5 5 5 5" />
          <path {...common} d="m16 7 5 5-5 5" />
        </>
      )}
      {name === 'push' && (
        <>
          <path {...common} d="M12 19V5" />
          <path {...common} d="m7 10 5-5 5 5" />
          <path {...common} d="M5 20h14" />
        </>
      )}
      {name === 'rebase' && (
        <>
          <circle {...common} cx="6" cy="6" r="3" />
          <circle {...common} cx="6" cy="18" r="3" />
          <circle {...common} cx="18" cy="12" r="3" />
          <path {...common} d="M6 9v6" />
          <path {...common} d="M9 6h2a7 7 0 0 1 7 7" />
        </>
      )}
      {name === 'reset' && (
        <>
          <path {...common} d="M4 7v6h6" />
          <path {...common} d="M20 17a8 8 0 0 1-14.9-4" />
          <path {...common} d="M4 13A8 8 0 0 1 19 8" />
        </>
      )}
      {name === 'revert' && (
        <>
          <path {...common} d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.7 2.7L3 8" />
          <path {...common} d="M3 3v5h5" />
        </>
      )}
      {name === 'tag' && (
        <>
          <path {...common} d="M20 10 10 20 4 14V4h10l6 6Z" />
          <circle {...common} cx="9" cy="9" r="1" />
        </>
      )}
      {name === 'uncommit' && (
        <>
          <path {...common} d="M9 14 4 9l5-5" />
          <path {...common} d="M4 9h10a6 6 0 0 1 0 12h-1" />
        </>
      )}
    </svg>
  )
}

export function CommitActionButton({
  label,
  onClick,
  tone,
  onMouseEnter,
  onMouseLeave,
}: {
  label: string
  onClick: () => void
  tone: 'success' | 'warning' | 'uncommit' | 'merge'
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const color = tone === 'success'
    ? '#0b1020'
    : tone === 'warning'
      ? '#fff7d6'
      : tone === 'merge'
        ? '#fff7ff'
        : '#fff7ed'
  const border = tone === 'success'
    ? '#6d9658'
    : tone === 'warning'
      ? '#d8a43a'
      : tone === 'merge'
        ? '#b764d9'
        : '#9a3412'
  const background = tone === 'success'
    ? '#8dcf78'
    : tone === 'warning'
      ? '#b88a25'
      : tone === 'merge'
        ? '#c77de4'
        : '#b45309'
  const hover = tone === 'success'
    ? '#9cda89'
    : tone === 'warning'
      ? '#c99a30'
      : tone === 'merge'
        ? '#d08bea'
        : '#c26115'

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 104,
        height: 30,
        padding: '0 12px',
        background,
        border: `1px solid ${border}`,
        borderRadius: 7,
        color,
        fontSize: 10,
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        position: 'relative',
        zIndex: 8,
        boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
        gap: 6,
        lineHeight: 1,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = hover }}
      onMouseLeave={(e) => { e.currentTarget.style.background = background }}
      onPointerEnter={onMouseEnter}
      onPointerLeave={onMouseLeave}
    >
      <ActionIcon name={iconForLabel(label)} />
      <span>{label}</span>
    </button>
  )
}

export function RefActionButton({
  label,
  onClick,
  tone,
  size = 'default',
  variant = 'solid',
  disabled = false,
}: {
  label: string
  onClick: () => void
  tone: 'neutral' | 'warning' | 'danger' | 'success'
  size?: 'default' | 'compact'
  variant?: 'solid' | 'ghost'
  disabled?: boolean
}) {
  const compact = size === 'compact'
  const ghost = variant === 'ghost'
  const solidBg = tone === 'danger'
    ? '#5c2430'
    : tone === 'warning'
      ? '#7a4e11'
      : tone === 'success'
        ? '#2c4231'
        : '#2f3348'
  const solidHoverBg = tone === 'danger'
    ? '#6a2b39'
    : tone === 'warning'
      ? '#8a5a16'
      : tone === 'success'
        ? '#37523d'
        : '#3a4058'
  const solidBorder = tone === 'danger'
    ? '#8b3a4a'
    : tone === 'warning'
      ? '#d19128'
      : tone === 'success'
        ? '#588a5c'
        : '#4a4f68'
  const textColor = tone === 'danger'
    ? '#f5a6b8'
    : tone === 'warning'
      ? '#f9d28b'
      : tone === 'success'
        ? '#a6e3a1'
        : ghost ? '#bac2de' : '#cdd6f4'

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (disabled) return
        onClick()
      }}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: compact ? 72 : 84,
        height: compact ? 20 : 28,
        padding: compact ? '0 8px' : '0 10px',
        background: ghost ? 'rgba(24,24,37,0.5)' : solidBg,
        border: ghost ? '1px solid transparent' : `1px solid ${solidBorder}`,
        color: textColor,
        fontSize: 10,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.62 : 1,
        borderRadius: compact ? 6 : 7,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        gap: compact ? 5 : 6,
        lineHeight: 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.background = ghost ? 'rgba(49,50,68,0.8)' : solidHoverBg
      }}
      onMouseLeave={(e) => {
        if (disabled) return
        e.currentTarget.style.background = ghost ? 'rgba(24,24,37,0.5)' : solidBg
      }}
    >
      <ActionIcon name={iconForLabel(label)} size={compact ? 12 : 13} />
      <span>{label}</span>
    </button>
  )
}
