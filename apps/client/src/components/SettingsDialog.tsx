import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { parseCommandLine } from '@ingit/rpc-contract'
import { useAppStore } from '../store'
import {
  cloneConflictResolvers,
  DEFAULT_CONFLICT_RESOLVERS,
  resetConflictResolvers,
  saveConflictResolvers,
  serializeConflictResolvers,
  useConflictResolvers,
  type ConflictResolver,
} from '../conflict-resolvers'
import {
  cloneCommitIconRules,
  COMMIT_ICON_NAMES,
  CommitMessageIcon,
  commitIconPatternError,
  DEFAULT_COMMIT_ICON_RULES,
  findCommitIcon,
  resetCommitIconRules,
  saveCommitIconRules,
  serializeCommitIconRules,
  useCommitIconRules,
  type CommitIconName,
  type CommitIconRule,
} from './graph-canvas/CommitIcons'
import { customSvgIconError } from './graph-canvas/CustomSvgIcon'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

const fieldStyle = {
  width: '100%',
  border: '1px solid #45475a',
  borderRadius: 6,
  background: '#11111b',
  color: '#cdd6f4',
  fontFamily: 'inherit',
  fontSize: 12,
  outline: 'none',
} satisfies CSSProperties

const secondaryButtonStyle = {
  height: 30,
  padding: '0 11px',
  border: '1px solid #45475a',
  borderRadius: 6,
  background: '#181825',
  color: '#bac2de',
  fontFamily: 'inherit',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
} satisfies CSSProperties

const primaryButtonStyle = {
  ...secondaryButtonStyle,
  border: '1px solid #6d9658',
  background: '#8dcf78',
  color: '#0b1020',
  fontWeight: 800,
} satisfies CSSProperties

const CUSTOM_SVG_TEMPLATE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="m12 3 2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5L12 3Z" />
</svg>`

function newRuleId(existingRules: readonly CommitIconRule[]): string {
  const existing = new Set(existingRules.map((rule) => rule.id))
  const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let id = `custom-${randomPart}`
  let suffix = 2
  while (existing.has(id)) {
    id = `custom-${randomPart}-${suffix}`
    suffix += 1
  }
  return id
}

function newConflictResolverId(existingResolvers: readonly ConflictResolver[]): string {
  const existing = new Set(existingResolvers.map((resolver) => resolver.id))
  const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let id = `custom-${randomPart}`
  let suffix = 2
  while (existing.has(id)) {
    id = `custom-${randomPart}-${suffix}`
    suffix += 1
  }
  return id
}

function IconPreview({
  icon,
  customSvg,
  size = 18,
  muted = false,
}: {
  icon: CommitIconName
  customSvg?: string
  size?: number
  muted?: boolean
}) {
  const frameSize = size + 10
  return (
    <svg
      aria-hidden="true"
      width={frameSize}
      height={frameSize}
      viewBox="-12 -12 24 24"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      <circle r="10" fill="#11111b" stroke={muted ? '#45475a' : '#89b4fa'} strokeWidth="1.5" />
      <CommitMessageIcon icon={icon} customSvg={customSvg} color={muted ? '#6c7086' : '#89b4fa'} size={size} />
    </svg>
  )
}

function normalizeRules(rules: readonly CommitIconRule[]): CommitIconRule[] {
  return rules.map((rule) => ({
    ...rule,
    label: rule.label.trim(),
    types: rule.types.map((type) => type.trim()).filter(Boolean),
    patterns: rule.patterns.map((pattern) => pattern.trim()).filter(Boolean),
    ...(rule.customSvg === undefined ? {} : { customSvg: rule.customSvg.trim() }),
  }))
}

function ruleValidationError(rules: readonly CommitIconRule[]): { id: string; message: string } | null {
  for (const rule of rules) {
    if (!rule.label.trim()) return { id: rule.id, message: 'Every rule needs a name.' }
    if (rule.enabled && rule.types.length === 0 && rule.patterns.length === 0) {
      return { id: rule.id, message: `“${rule.label}” needs at least one commit type or message pattern.` }
    }
    for (const pattern of rule.patterns) {
      const error = commitIconPatternError(pattern)
      if (error) return { id: rule.id, message: `Invalid pattern in “${rule.label}”: ${error}` }
    }
    if (rule.customSvg !== undefined) {
      const error = customSvgIconError(rule.customSvg)
      if (error) return { id: rule.id, message: `Invalid custom SVG in “${rule.label}”: ${error}` }
    }
  }
  return null
}

function literalKeywordPattern(keyword: string): string {
  const trimmed = keyword.trim()
  const escaped = trimmed
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(String.raw`\s+`)
  const leadingBoundary = /^\w/.test(trimmed) ? String.raw`\b` : ''
  const trailingBoundary = /\w$/.test(trimmed) ? String.raw`\b` : ''
  return `${leadingBoundary}${escaped}${trailingBoundary}`
}

function RuleDetails({
  rule,
  index,
  count,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: {
  rule: CommitIconRule
  index: number
  count: number
  onChange: (update: Partial<CommitIconRule>) => void
  onMove: (direction: -1 | 1) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [typesText, setTypesText] = useState(rule.types.join(', '))
  const [patternsText, setPatternsText] = useState(rule.patterns.join('\n'))
  const [customSvgText, setCustomSvgText] = useState(rule.customSvg ?? '')
  const [newKeyword, setNewKeyword] = useState('')
  const customSvgError = rule.customSvg === undefined ? null : customSvgIconError(customSvgText)
  const patternErrors = patternsText
    .split('\n')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => ({ pattern, error: commitIconPatternError(pattern) }))
    .filter((entry): entry is { pattern: string; error: string } => entry.error !== null)

  const addKeyword = () => {
    if (!newKeyword.trim()) return
    const pattern = literalKeywordPattern(newKeyword)
    const patterns = [...rule.patterns, pattern]
    setPatternsText(patterns.join('\n'))
    setNewKeyword('')
    onChange({ patterns })
  }

  return (
    <div style={{ display: 'flex', minHeight: 0, height: '100%', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid #313244' }}>
        <IconPreview icon={rule.icon} customSvg={rule.customSvg} size={17} muted={!rule.enabled} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: '#cdd6f4', fontSize: 14, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rule.label || 'Untitled rule'}
          </div>
          <div style={{ marginTop: 2, color: '#6c7086', fontSize: 10 }}>Rule {index + 1} of {count} · evaluated top to bottom</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: rule.enabled ? '#a6e3a1' : '#7f849c', fontSize: 11, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
            style={{ accentColor: '#a6e3a1' }}
          />
          Enabled
        </label>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, color: '#bac2de', fontSize: 11, fontWeight: 700 }}>
            Rule name
            <input
              value={rule.label}
              maxLength={100}
              onChange={(event) => onChange({ label: event.target.value })}
              style={{ ...fieldStyle, height: 34, padding: '0 9px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, color: '#bac2de', fontSize: 11, fontWeight: 700 }}>
            Conventional Commit types
            <input
              value={typesText}
              onChange={(event) => {
                const value = event.target.value
                setTypesText(value)
                onChange({ types: value.split(',').map((type) => type.trim()).filter(Boolean) })
              }}
              placeholder="feat, feature"
              spellCheck={false}
              style={{ ...fieldStyle, height: 34, padding: '0 9px', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
            />
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 7, color: '#bac2de', fontSize: 11, fontWeight: 700 }}>Icon</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(38px, 1fr))', gap: 5 }}>
            {COMMIT_ICON_NAMES.map((icon) => {
              const selected = rule.customSvg === undefined && rule.icon === icon
              return (
                <button
                  key={icon}
                  type="button"
                  title={icon}
                  aria-label={`Use ${icon} icon`}
                  aria-pressed={selected}
                  onClick={() => onChange({ icon, customSvg: undefined })}
                  style={{
                    height: 38,
                    display: 'grid',
                    placeItems: 'center',
                    padding: 0,
                    border: `1px solid ${selected ? '#89b4fa' : '#313244'}`,
                    borderRadius: 6,
                    background: selected ? '#89b4fa18' : '#181825',
                    cursor: 'pointer',
                  }}
                >
                  <IconPreview icon={icon} size={14} muted={!selected} />
                </button>
              )
            })}
          </div>
          <button
            type="button"
            aria-pressed={rule.customSvg !== undefined}
            onClick={() => {
              const source = customSvgText || CUSTOM_SVG_TEMPLATE
              setCustomSvgText(source)
              onChange({ customSvg: source })
            }}
            style={{
              width: '100%',
              height: 38,
              marginTop: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              border: `1px solid ${rule.customSvg !== undefined ? '#89b4fa' : '#313244'}`,
              borderRadius: 6,
              background: rule.customSvg !== undefined ? '#89b4fa18' : '#181825',
              color: rule.customSvg !== undefined ? '#89b4fa' : '#9399b2',
              fontFamily: 'inherit',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            <IconPreview icon={rule.icon} customSvg={rule.customSvg ?? CUSTOM_SVG_TEMPLATE} size={13} muted={rule.customSvg === undefined} />
            Custom SVG
          </button>
          {rule.customSvg !== undefined && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9, color: '#bac2de', fontSize: 11, fontWeight: 700 }}>
              Raw SVG
              <textarea
                value={customSvgText}
                onChange={(event) => {
                  const value = event.target.value
                  setCustomSvgText(value)
                  onChange({ customSvg: value })
                }}
                rows={5}
                placeholder='<svg viewBox="0 0 24 24">…</svg>'
                spellCheck={false}
                style={{
                  ...fieldStyle,
                  minHeight: 112,
                  resize: 'vertical',
                  padding: '8px 9px',
                  lineHeight: 1.45,
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  borderColor: customSvgError ? '#f38ba888' : '#45475a',
                }}
              />
              <span style={{ color: customSvgError ? '#f38ba8' : '#6c7086', fontSize: 10, fontWeight: 500, lineHeight: 1.4 }}>
                {customSvgError ?? 'Scripts, events, external references, and unsupported elements are blocked. Paint inherits the branch color.'}
              </span>
            </label>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 6, color: '#bac2de', fontSize: 11, fontWeight: 700 }}>Quick-add a keyword or phrase</div>
          <div style={{ display: 'flex', gap: 7 }}>
            <input
              value={newKeyword}
              onChange={(event) => setNewKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addKeyword()
                }
              }}
              placeholder="e.g. upgrade dependency"
              style={{ ...fieldStyle, height: 32, flex: 1, padding: '0 9px' }}
            />
            <button type="button" onClick={addKeyword} disabled={!newKeyword.trim()} style={{ ...secondaryButtonStyle, height: 32, opacity: newKeyword.trim() ? 1 : 0.45 }}>
              Add keyword
            </button>
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 13, color: '#bac2de', fontSize: 11, fontWeight: 700 }}>
          Message patterns <span style={{ color: '#6c7086', fontWeight: 500 }}>(advanced)</span>
          <textarea
            value={patternsText}
            onChange={(event) => {
              const value = event.target.value
              setPatternsText(value)
              onChange({ patterns: value.split('\n').map((pattern) => pattern.trim()).filter(Boolean) })
            }}
            rows={5}
            placeholder={String.raw`\bkeyword\b`}
            spellCheck={false}
            style={{ ...fieldStyle, minHeight: 108, resize: 'vertical', padding: '8px 9px', lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
          />
        </label>
        <div style={{ marginTop: 6, color: '#6c7086', fontSize: 10, lineHeight: 1.45 }}>
          One case-insensitive regular expression per line. The keyword helper adds safe word boundaries automatically. Conventional Commit types are matched before message patterns.
        </div>
        {patternErrors.map(({ pattern, error }) => (
          <div key={`${pattern}:${error}`} style={{ marginTop: 6, color: '#f38ba8', fontSize: 10 }}>
            <code>{pattern}</code>: {error}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderTop: '1px solid #313244', background: '#181825' }}>
        <button type="button" onClick={() => onMove(-1)} disabled={index === 0} title="Move rule up" style={{ ...secondaryButtonStyle, opacity: index === 0 ? 0.4 : 1 }}>↑ Up</button>
        <button type="button" onClick={() => onMove(1)} disabled={index === count - 1} title="Move rule down" style={{ ...secondaryButtonStyle, opacity: index === count - 1 ? 0.4 : 1 }}>↓ Down</button>
        <button type="button" onClick={onDuplicate} style={secondaryButtonStyle}>Duplicate</button>
        <button type="button" onClick={onDelete} style={{ ...secondaryButtonStyle, marginLeft: 'auto', borderColor: '#f38ba866', color: '#f38ba8' }}>Delete</button>
      </div>
    </div>
  )
}

function CommitIconSettings({
  onClose,
  onDirtyChange,
}: {
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const activeRules = useCommitIconRules()
  const [draftRules, setDraftRules] = useState<CommitIconRule[]>(() => cloneCommitIconRules(activeRules))
  const [selectedId, setSelectedId] = useState<string | null>(() => activeRules[0]?.id ?? null)
  const [testMessage, setTestMessage] = useState('feat: add commit icon settings')
  const [saveError, setSaveError] = useState<string | null>(null)

  const selectedIndex = draftRules.findIndex((rule) => rule.id === selectedId)
  const selectedRule = selectedIndex >= 0 ? draftRules[selectedIndex] ?? null : null
  const testMatch = useMemo(() => findCommitIcon(testMessage, draftRules), [testMessage, draftRules])
  const enabledCount = draftRules.filter((rule) => rule.enabled).length
  const dirty = useMemo(() => (
    serializeCommitIconRules(normalizeRules(draftRules)) !== serializeCommitIconRules(activeRules)
  ), [activeRules, draftRules])

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const updateSelected = (update: Partial<CommitIconRule>) => {
    if (!selectedId) return
    setSaveError(null)
    setDraftRules((rules) => rules.map((rule) => rule.id === selectedId ? { ...rule, ...update } : rule))
  }

  const addRule = () => {
    const rule: CommitIconRule = {
      id: newRuleId(draftRules),
      icon: 'feature',
      label: 'New rule',
      enabled: true,
      types: [],
      patterns: [String.raw`\bkeyword\b`],
    }
    setDraftRules((rules) => [...rules, rule])
    setSelectedId(rule.id)
    setSaveError(null)
  }

  const moveSelected = (direction: -1 | 1) => {
    if (selectedIndex < 0) return
    const target = selectedIndex + direction
    if (target < 0 || target >= draftRules.length) return
    setDraftRules((rules) => {
      const next = [...rules]
      const [moved] = next.splice(selectedIndex, 1)
      if (moved) next.splice(target, 0, moved)
      return next
    })
    setSaveError(null)
  }

  const duplicateSelected = () => {
    if (!selectedRule) return
    const copy: CommitIconRule = {
      ...selectedRule,
      id: newRuleId(draftRules),
      label: `${selectedRule.label} copy`,
      types: [...selectedRule.types],
      patterns: [...selectedRule.patterns],
    }
    setDraftRules((rules) => {
      const next = [...rules]
      next.splice(selectedIndex + 1, 0, copy)
      return next
    })
    setSelectedId(copy.id)
    setSaveError(null)
  }

  const deleteSelected = () => {
    if (selectedIndex < 0) return
    const next = draftRules.filter((_, index) => index !== selectedIndex)
    setDraftRules(next)
    setSelectedId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null)
    setSaveError(null)
  }

  const restoreDefaults = () => {
    const defaults = cloneCommitIconRules(DEFAULT_COMMIT_ICON_RULES)
    setDraftRules(defaults)
    setSelectedId(defaults[0]?.id ?? null)
    setSaveError(null)
  }

  const save = () => {
    const normalized = normalizeRules(draftRules)
    const validationError = ruleValidationError(normalized)
    if (validationError) {
      setSelectedId(validationError.id)
      setSaveError(validationError.message)
      return
    }

    const isDefault = serializeCommitIconRules(normalized) === serializeCommitIconRules(DEFAULT_COMMIT_ICON_RULES)
    const saved = isDefault ? resetCommitIconRules() : saveCommitIconRules(normalized)
    if (!saved) {
      setSaveError('Could not save commit icon settings to local storage.')
      return
    }
    onClose()
  }

  return (
    <div style={{ display: 'flex', minWidth: 0, minHeight: 0, height: '100%', flexDirection: 'column' }}>
      <div style={{ padding: '15px 18px 13px', borderBottom: '1px solid #313244' }}>
        <h2 style={{ margin: 0, color: '#f5e0dc', fontSize: 16 }}>Commit icons</h2>
        <p style={{ margin: '5px 0 0', color: '#7f849c', fontSize: 11, lineHeight: 1.45 }}>
          Choose how commit messages map to graph-node icons. Rule order matters; the first enabled match wins.
        </p>
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 9, borderBottom: '1px solid #313244', background: '#181825' }}>
        <span style={{ color: '#7f849c', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Test</span>
        <input
          value={testMessage}
          onChange={(event) => setTestMessage(event.target.value)}
          aria-label="Test commit message"
          placeholder="Enter a commit message…"
          style={{ ...fieldStyle, minWidth: 120, height: 32, flex: 1, padding: '0 9px' }}
        />
        <div style={{ width: 145, display: 'flex', alignItems: 'center', gap: 7, color: testMatch ? '#cdd6f4' : '#6c7086', fontSize: 11 }}>
          {testMatch ? (
            <>
              <IconPreview icon={testMatch.icon} customSvg={testMatch.customSvg} size={14} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{testMatch.label}</span>
            </>
          ) : 'No matching icon'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '250px minmax(0, 1fr)', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', minHeight: 0, flexDirection: 'column', borderRight: '1px solid #313244', background: '#181825' }}>
          <div style={{ height: 42, padding: '0 10px 0 12px', display: 'flex', alignItems: 'center', color: '#7f849c', fontSize: 10 }}>
            {enabledCount} enabled · {draftRules.length} total
            <button type="button" onClick={addRule} style={{ ...secondaryButtonStyle, height: 26, marginLeft: 'auto', padding: '0 8px' }}>＋ Add</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 8px' }}>
            {draftRules.map((rule, index) => {
              const selected = rule.id === selectedId
              return (
                <button
                  key={rule.id}
                  type="button"
                  onClick={() => setSelectedId(rule.id)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 42,
                    padding: '5px 8px',
                    border: `1px solid ${selected ? '#89b4fa55' : 'transparent'}`,
                    borderRadius: 6,
                    background: selected ? '#89b4fa16' : 'transparent',
                    color: rule.enabled ? '#cdd6f4' : '#6c7086',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                    opacity: rule.enabled ? 1 : 0.68,
                  }}
                >
                  <span style={{ width: 18, flexShrink: 0, color: '#585b70', fontSize: 9, textAlign: 'right' }}>{index + 1}</span>
                  <IconPreview icon={rule.icon} customSvg={rule.customSvg} size={13} muted={!rule.enabled} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 650 }}>{rule.label || 'Untitled rule'}</span>
                    <span style={{ display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#6c7086', fontSize: 9 }}>
                      {rule.types.length > 0 ? rule.types.join(', ') : `${rule.patterns.length} pattern${rule.patterns.length === 1 ? '' : 's'}`}
                    </span>
                  </span>
                </button>
              )
            })}
            {draftRules.length === 0 && (
              <div style={{ padding: '26px 14px', color: '#6c7086', fontSize: 11, lineHeight: 1.5, textAlign: 'center' }}>
                No rules. Add one, or restore the defaults.
              </div>
            )}
          </div>
        </div>

        <div style={{ minWidth: 0, minHeight: 0 }}>
          {selectedRule ? (
            <RuleDetails
              key={selectedRule.id}
              rule={selectedRule}
              index={selectedIndex}
              count={draftRules.length}
              onChange={updateSelected}
              onMove={moveSelected}
              onDuplicate={duplicateSelected}
              onDelete={deleteSelected}
            />
          ) : (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#6c7086', fontSize: 12 }}>
              Select or add a rule to edit it.
            </div>
          )}
        </div>
      </div>

      <div style={{ minHeight: 52, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #313244', background: '#11111b' }}>
        <button type="button" onClick={restoreDefaults} style={secondaryButtonStyle}>Restore defaults</button>
        <span style={{ color: saveError ? '#f38ba8' : '#585b70', fontSize: 10, marginLeft: 4 }}>
          {saveError ?? 'Custom settings are stored in this browser.'}
        </span>
        <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>Cancel</button>
        <button type="button" onClick={save} style={primaryButtonStyle}>Save settings</button>
      </div>
    </div>
  )
}

function normalizeConflictResolvers(
  resolvers: readonly ConflictResolver[],
): ConflictResolver[] {
  return resolvers.map((resolver) => ({
    ...resolver,
    fileName: resolver.fileName.trim(),
    command: resolver.command.trim(),
  }))
}

function conflictResolverValidationError(
  resolvers: readonly ConflictResolver[],
): string | null {
  const fileNames = new Set<string>()
  for (const resolver of resolvers) {
    const fileName = resolver.fileName.trim()
    const command = resolver.command.trim()
    if (!fileName) return 'Every resolver needs a file name.'
    if (fileName === '.' || fileName === '..' || fileName.includes('/') || fileName.includes('\\')) {
      return `“${fileName}” must be a file name, not a path.`
    }
    if (fileNames.has(fileName)) return `“${fileName}” has more than one resolver.`
    if (!command) return `“${fileName}” needs a command.`
    if (!parseCommandLine(command)) {
      return `The command for “${fileName}” is empty or contains an unterminated quote.`
    }
    fileNames.add(fileName)
  }
  return null
}

function ConflictResolverSettings({
  onClose,
  onDirtyChange,
}: {
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const activeResolvers = useConflictResolvers()
  const [draftResolvers, setDraftResolvers] = useState<ConflictResolver[]>(
    () => cloneConflictResolvers(activeResolvers),
  )
  const [saveError, setSaveError] = useState<string | null>(null)
  const dirty = useMemo(() => (
    serializeConflictResolvers(normalizeConflictResolvers(draftResolvers))
      !== serializeConflictResolvers(activeResolvers)
  ), [activeResolvers, draftResolvers])

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const updateResolver = (id: string, update: Partial<ConflictResolver>) => {
    setSaveError(null)
    setDraftResolvers((resolvers) => resolvers.map(
      (resolver) => resolver.id === id ? { ...resolver, ...update } : resolver,
    ))
  }

  const addResolver = () => {
    const next: ConflictResolver = {
      id: newConflictResolverId(draftResolvers),
      fileName: '',
      command: '',
    }
    setDraftResolvers((resolvers) => [...resolvers, next])
    setSaveError(null)
  }

  const restoreDefaults = () => {
    setDraftResolvers(cloneConflictResolvers(DEFAULT_CONFLICT_RESOLVERS))
    setSaveError(null)
  }

  const save = () => {
    const normalized = normalizeConflictResolvers(draftResolvers)
    const validationError = conflictResolverValidationError(normalized)
    if (validationError) {
      setSaveError(validationError)
      return
    }

    const isDefault = serializeConflictResolvers(normalized)
      === serializeConflictResolvers(DEFAULT_CONFLICT_RESOLVERS)
    const saved = isDefault ? resetConflictResolvers() : saveConflictResolvers(normalized)
    if (!saved) {
      setSaveError('Could not save conflict resolver settings to local storage.')
      return
    }
    onClose()
  }

  return (
    <div style={{ display: 'flex', minWidth: 0, minHeight: 0, height: '100%', flexDirection: 'column' }}>
      <div style={{ padding: '15px 18px 13px', borderBottom: '1px solid #313244' }}>
        <h2 style={{ margin: 0, color: '#f5e0dc', fontSize: 16 }}>Lockfile conflict resolvers</h2>
        <p style={{ margin: '5px 0 0', color: '#7f849c', fontSize: 11, lineHeight: 1.45 }}>
          Show “run install &amp; resolve” for conflicted files with an exact matching name.
          The command runs from that file&apos;s directory.
        </p>
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid #313244', background: '#181825' }}>
        <span style={{ color: '#7f849c', fontSize: 10 }}>
          Commands launch directly with your user permissions. Quotes are supported; no shell is added implicitly.
        </span>
        <button
          type="button"
          onClick={addResolver}
          style={{ ...secondaryButtonStyle, height: 28, marginLeft: 'auto', flexShrink: 0 }}
        >
          ＋ Add resolver
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        <div
          aria-hidden="true"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(170px, 0.7fr) minmax(280px, 1.3fr) 32px',
            gap: 8,
            padding: '0 8px 7px',
            color: '#6c7086',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          <span>File name</span>
          <span>Command</span>
          <span />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {draftResolvers.map((resolver, index) => (
            <div
              key={resolver.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(170px, 0.7fr) minmax(280px, 1.3fr) 32px',
                alignItems: 'center',
                gap: 8,
                padding: 8,
                border: '1px solid #313244',
                borderRadius: 7,
                background: '#181825',
              }}
            >
              <input
                value={resolver.fileName}
                aria-label={`Resolver ${index + 1} file name`}
                placeholder="example.lock"
                spellCheck={false}
                onChange={(event) => updateResolver(resolver.id, { fileName: event.target.value })}
                style={{ ...fieldStyle, height: 32, padding: '0 9px', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
              />
              <input
                value={resolver.command}
                aria-label={`Resolver ${index + 1} command`}
                placeholder="package-manager install"
                spellCheck={false}
                onChange={(event) => updateResolver(resolver.id, { command: event.target.value })}
                style={{ ...fieldStyle, height: 32, padding: '0 9px', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
              />
              <button
                type="button"
                aria-label={`Delete resolver for ${resolver.fileName || `row ${index + 1}`}`}
                title="Delete resolver"
                onClick={() => {
                  setDraftResolvers((resolvers) => resolvers.filter((entry) => entry.id !== resolver.id))
                  setSaveError(null)
                }}
                style={{
                  width: 30,
                  height: 30,
                  padding: 0,
                  border: '1px solid transparent',
                  borderRadius: 6,
                  background: 'transparent',
                  color: '#f38ba8',
                  fontSize: 15,
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>
          ))}
          {draftResolvers.length === 0 && (
            <div style={{ padding: 36, border: '1px dashed #313244', borderRadius: 7, color: '#6c7086', fontSize: 11, textAlign: 'center' }}>
              No resolvers configured. Conflicted files will use the normal “Mark resolved” action.
            </div>
          )}
        </div>
      </div>

      <div style={{ minHeight: 52, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #313244', background: '#11111b' }}>
        <button type="button" onClick={restoreDefaults} style={secondaryButtonStyle}>Restore defaults</button>
        <span style={{ color: saveError ? '#f38ba8' : '#585b70', fontSize: 10, marginLeft: 4 }}>
          {saveError ?? `${draftResolvers.length} resolver${draftResolvers.length === 1 ? '' : 's'} · stored in this browser`}
        </span>
        <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>Cancel</button>
        <button type="button" onClick={save} style={primaryButtonStyle}>Save settings</button>
      </div>
    </div>
  )
}

function GraphAppearanceSettings({ onClose }: { onClose: () => void }) {
  const showGutterColors = useAppStore((state) => state.showGutterColors)
  const setShowGutterColors = useAppStore((state) => state.setShowGutterColors)

  return (
    <div style={{ display: 'flex', minWidth: 0, minHeight: 0, height: '100%', flexDirection: 'column' }}>
      <div style={{ padding: '15px 18px 13px', borderBottom: '1px solid #313244' }}>
        <h2 style={{ margin: 0, color: '#f5e0dc', fontSize: 16 }}>Graph appearance</h2>
        <p style={{ margin: '5px 0 0', color: '#7f849c', fontSize: 11, lineHeight: 1.45 }}>
          Control visual aids used across repository graphs.
        </p>
      </div>
      <div style={{ flex: 1, padding: 18 }}>
        <label
          title="Give each graph gutter a distinct background color"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            maxWidth: 560,
            padding: 14,
            border: `1px solid ${showGutterColors ? '#89b4fa55' : '#313244'}`,
            borderRadius: 7,
            background: showGutterColors ? '#89b4fa10' : '#181825',
            color: '#cdd6f4',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showGutterColors}
            onChange={(event) => setShowGutterColors(event.target.checked)}
            style={{ margin: '2px 0 0', accentColor: '#89b4fa', cursor: 'pointer' }}
          />
          <span>
            <span style={{ display: 'block', fontSize: 12, fontWeight: 750 }}>Color-code gutters</span>
            <span style={{ display: 'block', marginTop: 4, color: '#7f849c', fontSize: 10, lineHeight: 1.45 }}>
              Tint each branch lane with its stable branch color to make parallel histories easier to follow.
            </span>
          </span>
        </label>
      </div>
      <div style={{ minHeight: 52, padding: '10px 14px', display: 'flex', alignItems: 'center', borderTop: '1px solid #313244', background: '#11111b' }}>
        <span style={{ color: '#585b70', fontSize: 10 }}>Appearance settings are saved automatically.</span>
        <button type="button" onClick={onClose} style={{ ...primaryButtonStyle, marginLeft: 'auto' }}>Done</button>
      </div>
    </div>
  )
}

function settingsNavButtonStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    padding: '8px 9px',
    border: `1px solid ${active ? '#89b4fa44' : 'transparent'}`,
    borderRadius: 6,
    background: active ? '#89b4fa16' : 'transparent',
    color: active ? '#89b4fa' : '#a6adc8',
    fontFamily: 'inherit',
    fontSize: 11,
    fontWeight: 700,
    textAlign: 'left',
    cursor: 'pointer',
  }
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [section, setSection] = useState<'appearance' | 'commit-icons' | 'conflict-resolvers'>('appearance')
  const [commitIconsDirty, setCommitIconsDirty] = useState(false)
  const [conflictResolversDirty, setConflictResolversDirty] = useState(false)

  const requestClose = () => {
    if (
      (commitIconsDirty || conflictResolversDirty)
      && !window.confirm('Discard unsaved settings changes?')
    ) return
    onClose()
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      if (!dialog.open) dialog.showModal()
      requestAnimationFrame(() => closeButtonRef.current?.focus())
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className="ingit-settings-dialog"
      aria-labelledby="settings-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        requestClose()
      }}
      onClose={requestClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        width: 'min(980px, calc(100vw - 32px))',
        height: 'min(720px, calc(100vh - 32px))',
        margin: 'auto',
        padding: 0,
        overflow: 'hidden',
        border: '1px solid #45475a',
        borderRadius: 9,
        background: '#1e1e2e',
        color: '#cdd6f4',
        boxShadow: '0 24px 80px rgba(0,0,0,0.65)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <style>{`.ingit-settings-dialog::backdrop { background: rgba(10, 10, 18, 0.72); backdrop-filter: blur(2px); }`}</style>
      <div onClick={(event) => event.stopPropagation()} style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', height: '100%' }}>
        <aside style={{ display: 'flex', flexDirection: 'column', background: '#181825', borderRight: '1px solid #313244' }}>
          <div style={{ height: 58, padding: '0 14px', display: 'flex', alignItems: 'center', borderBottom: '1px solid #313244' }}>
            <h1 id="settings-dialog-title" style={{ margin: 0, color: '#f5e0dc', fontSize: 16 }}>Settings</h1>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={requestClose}
              aria-label="Close settings"
              title="Close settings"
              style={{ marginLeft: 'auto', padding: 3, border: 'none', background: 'transparent', color: '#7f849c', fontSize: 15, cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: '12px 8px' }}>
            <div style={{ padding: '0 8px 6px', color: '#585b70', fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Graph</div>
            <button
              type="button"
              onClick={() => setSection('appearance')}
              aria-current={section === 'appearance' ? 'page' : undefined}
              style={settingsNavButtonStyle(section === 'appearance')}
            >
              Appearance
            </button>
            <button
              type="button"
              onClick={() => setSection('commit-icons')}
              aria-current={section === 'commit-icons' ? 'page' : undefined}
              style={{ ...settingsNavButtonStyle(section === 'commit-icons'), marginTop: 3 }}
            >
              Commit icons{commitIconsDirty ? ' •' : ''}
            </button>
            <div style={{ padding: '14px 8px 6px', color: '#585b70', fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Working tree</div>
            <button
              type="button"
              onClick={() => setSection('conflict-resolvers')}
              aria-current={section === 'conflict-resolvers' ? 'page' : undefined}
              style={settingsNavButtonStyle(section === 'conflict-resolvers')}
            >
              Lockfile resolvers{conflictResolversDirty ? ' •' : ''}
            </button>
          </div>
          <div style={{ marginTop: 'auto', padding: 12, borderTop: '1px solid #313244', color: '#45475a', fontSize: 9, lineHeight: 1.45 }}>
            Settings apply across repositories on this device.
          </div>
        </aside>
        <main style={{ minWidth: 0, minHeight: 0 }}>
          {open && (
            <>
              <div style={{ display: section === 'appearance' ? 'block' : 'none', height: '100%' }}>
                <GraphAppearanceSettings onClose={requestClose} />
              </div>
              <div style={{ display: section === 'commit-icons' ? 'block' : 'none', height: '100%' }}>
                <CommitIconSettings onClose={onClose} onDirtyChange={setCommitIconsDirty} />
              </div>
              <div style={{ display: section === 'conflict-resolvers' ? 'block' : 'none', height: '100%' }}>
                <ConflictResolverSettings onClose={onClose} onDirtyChange={setConflictResolversDirty} />
              </div>
            </>
          )}
        </main>
      </div>
    </dialog>
  )
}
