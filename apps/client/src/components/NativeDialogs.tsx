import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'

const dialogStyle = {
  position: 'fixed',
  inset: 0,
  margin: 'auto',
  width: 'min(420px, calc(100vw - 32px))',
  padding: 0,
  border: '1px solid #45475a',
  borderRadius: 8,
  background: '#1e1e2e',
  color: '#cdd6f4',
  boxShadow: '0 22px 64px rgba(0,0,0,0.58)',
} satisfies CSSProperties

const formStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 18,
  fontFamily: 'system-ui, -apple-system, sans-serif',
} satisfies CSSProperties

const titleStyle = {
  margin: 0,
  color: '#f5e0dc',
  fontSize: 16,
  fontWeight: 700,
  lineHeight: 1.25,
} satisfies CSSProperties

const secondaryButtonStyle = {
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid #45475a',
  background: '#181825',
  color: '#bac2de',
  fontSize: 12,
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: 'pointer',
} satisfies CSSProperties

const primaryButtonStyle = {
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid #6d9658',
  background: '#8dcf78',
  color: '#0b1020',
  fontSize: 12,
  fontWeight: 800,
  fontFamily: 'inherit',
  cursor: 'pointer',
} satisfies CSSProperties

interface NativeTextInputDialogProps {
  open: boolean
  title: string
  label: string
  initialValue?: string
  confirmLabel: string
  onSubmit: (value: string) => void
  onClose: () => void
}

export function NativeTextInputDialog({
  open,
  title,
  label,
  initialValue = '',
  confirmLabel,
  onSubmit,
  onClose,
}: NativeTextInputDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    if (open) setValue(initialValue)
  }, [initialValue, open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      if (!dialog.open) dialog.showModal()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }

    if (dialog.open) dialog.close()
  }, [open])

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) {
      inputRef.current?.focus()
      return
    }
    onSubmit(trimmed)
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="text-input-dialog-title"
      onCancel={onClose}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={dialogStyle}
    >
      <form method="dialog" onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} style={formStyle}>
        <h2 id="text-input-dialog-title" style={titleStyle}>{title}</h2>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 7, color: '#bac2de', fontSize: 12, fontWeight: 700 }}>
          {label}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
            style={{
              height: 34,
              padding: '0 10px',
              borderRadius: 6,
              border: '1px solid #45475a',
              background: '#11111b',
              color: '#cdd6f4',
              fontSize: 13,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 2 }}>
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>Cancel</button>
          <button type="submit" value="confirm" style={primaryButtonStyle}>{confirmLabel}</button>
        </div>
      </form>
    </dialog>
  )
}

interface NativeConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}

export function NativeConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: NativeConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      if (!dialog.open) dialog.showModal()
      return
    }

    if (dialog.open) dialog.close()
  }, [open])

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    onConfirm()
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="confirm-dialog-title"
      onCancel={onClose}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={dialogStyle}
    >
      <form method="dialog" onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} style={formStyle}>
        <h2 id="confirm-dialog-title" style={titleStyle}>{title}</h2>
        <p style={{ margin: 0, color: '#bac2de', fontSize: 13, lineHeight: 1.45 }}>{message}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 2 }}>
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>Cancel</button>
          <button type="submit" value="confirm" style={primaryButtonStyle}>{confirmLabel}</button>
        </div>
      </form>
    </dialog>
  )
}
