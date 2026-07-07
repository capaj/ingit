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
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        position: 'relative',
        zIndex: 8,
        boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = hover }}
      onMouseLeave={(e) => { e.currentTarget.style.background = background }}
      onPointerEnter={onMouseEnter}
      onPointerLeave={onMouseLeave}
    >
      {label}
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
        fontSize: compact ? 11 : 12,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.62 : 1,
        borderRadius: compact ? 6 : 7,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
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
      {label}
    </button>
  )
}
