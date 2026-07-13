import { useSyncExternalStore } from 'react'
import { CustomSvgIcon, customSvgIconError, MAX_CUSTOM_SVG_LENGTH } from './CustomSvgIcon'

export type CommitIconName =
  | 'accessibility'
  | 'api'
  | 'build'
  | 'chore'
  | 'ci'
  | 'config'
  | 'database'
  | 'dependencies'
  | 'docs'
  | 'feature'
  | 'fix'
  | 'i18n'
  | 'infra'
  | 'merge'
  | 'move'
  | 'performance'
  | 'refactor'
  | 'release'
  | 'rename'
  | 'revert'
  | 'security'
  | 'style'
  | 'test'
  | 'ui'

export interface CommitIconRule {
  id: string
  icon: CommitIconName
  label: string
  enabled: boolean
  types: readonly string[]
  patterns: readonly string[]
  customSvg?: string
}

export const COMMIT_ICON_NAMES: readonly CommitIconName[] = [
  'accessibility',
  'api',
  'build',
  'chore',
  'ci',
  'config',
  'database',
  'dependencies',
  'docs',
  'feature',
  'fix',
  'i18n',
  'infra',
  'merge',
  'move',
  'performance',
  'refactor',
  'release',
  'rename',
  'revert',
  'security',
  'style',
  'test',
  'ui',
]

function defaultRule(
  icon: CommitIconName,
  label: string,
  types: readonly string[],
  ...patterns: string[]
): CommitIconRule {
  return { id: icon, icon, label, enabled: true, types, patterns }
}

// Rules double as the default icon catalog. Conventional Commit types are
// matched first; otherwise the first matching message pattern wins.
export const DEFAULT_COMMIT_ICON_RULES: readonly CommitIconRule[] = [
  defaultRule('revert', 'Revert', ['revert'], String.raw`\b(?:revert(?:ed|ing)?|rollbacks?)\b`),
  defaultRule('merge', 'Merge', ['merge'], String.raw`\bmerg(?:e|ed|ing)\b`),
  defaultRule('security', 'Security', ['security', 'sec'], String.raw`\b(?:security|vulnerabilit(?:y|ies)|cve|xss|csrf)\b`),
  defaultRule('fix', 'Fix', ['fix', 'bugfix', 'hotfix'], String.raw`\b(?:fix(?:es|ed|ing)?|bugs?|bugfix(?:es)?|hotfix(?:es)?)\b`),
  defaultRule('feature', 'Feature', ['feat', 'feature'], String.raw`\b(?:feat|feature)s?\b`),
  defaultRule('performance', 'Performance', ['perf', 'performance'], String.raw`\b(?:perf|performance|optimi[sz](?:e[ds]?|ing|ation)|speedups?)\b`),
  defaultRule('refactor', 'Refactor', ['refactor'], String.raw`\b(?:refactor(?:s|ed|ing)?|restructur(?:e[ds]?|ing))\b`),
  defaultRule('move', 'Move', ['move'], String.raw`\b(?:move[ds]?|moving|relocat(?:e[ds]?|ing))\b`),
  defaultRule('rename', 'Rename', ['rename'], String.raw`\b(?:rename[ds]?|renaming)\b`),
  defaultRule('test', 'Tests', ['test', 'tests'], String.raw`\b(?:tests?|specs?|coverage|e2e)\b`),
  defaultRule('docs', 'Documentation', ['docs', 'doc'], String.raw`\b(?:docs?|documentation|readme|changelog)\b`),
  defaultRule('accessibility', 'Accessibility', ['a11y', 'accessibility'], String.raw`\b(?:a11y|accessibility|aria|screen[\s-]?reader)\b`),
  defaultRule('i18n', 'Localization', ['i18n', 'l10n'], String.raw`\b(?:i18n|l10n|internationali[sz]ation|locali[sz]ation|translations?)\b`),
  defaultRule('database', 'Database', ['db', 'database', 'migration'], String.raw`\b(?:database|db|sql|schemas?|migrations?)\b`),
  defaultRule('api', 'API', ['api'], String.raw`\b(?:apis?|graphql|grpc|rpc|endpoints?|webhooks?)\b`),
  defaultRule('ui', 'UI', ['ui', 'ux'], String.raw`\b(?:ui|ux|frontend|layouts?|responsive)\b`),
  defaultRule('infra', 'Infrastructure', ['infra', 'infrastructure', 'deploy'], String.raw`\b(?:infra|infrastructure|terraform|kubernetes|k8s|docker|deploy(?:ment|s|ed|ing)?)\b`),
  defaultRule('ci', 'CI', ['ci'], String.raw`\b(?:ci|continuous[\s-]integration|github[\s-]actions?|workflows?|pipelines?)\b`),
  defaultRule('build', 'Build', ['build'], String.raw`\b(?:builds?|built|bundl(?:e[ds]?|er|ing)|compil(?:e[ds]?|er|ing)|webpack|vite)\b`),
  defaultRule('dependencies', 'Dependencies', ['deps', 'dependencies', 'dependency'], String.raw`\b(?:deps?|dependencies|dependency|packages?|lockfiles?|bump(?:s|ed|ing)?)\b`),
  defaultRule('release', 'Release', ['release'], String.raw`\b(?:releases?|version(?:ing)?|publish(?:es|ed|ing)?)\b`),
  defaultRule('config', 'Configuration', ['config'], String.raw`\b(?:config|configuration|settings?|environment)\b`, String.raw`(?:^|\s)\.env(?:\s|$)`),
  defaultRule('style', 'Style', ['style', 'format', 'lint'], String.raw`\b(?:styles?|styling|css|themes?|format(?:ted|ting)?|lint(?:ed|ing)?)\b`),
  defaultRule('chore', 'Chore', ['chore'], String.raw`\b(?:chores?|cleanup|housekeeping|maintenance)\b`),
]

const CONVENTIONAL_COMMIT_PREFIX = /^([a-z][a-z0-9-]*)(?:\([^)]*\))?!?:/i

const PATTERN_CACHE = new Map<string, RegExp | null>()

function compiledPattern(source: string): RegExp | null {
  if (PATTERN_CACHE.has(source)) return PATTERN_CACHE.get(source) ?? null
  try {
    const pattern = new RegExp(source, 'i')
    PATTERN_CACHE.set(source, pattern)
    return pattern
  } catch {
    PATTERN_CACHE.set(source, null)
    return null
  }
}

export function commitIconPatternError(source: string): string | null {
  if (!source.trim()) return 'Pattern cannot be empty.'
  try {
    new RegExp(source, 'i')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid regular expression.'
  }
}

export function findCommitIcon(
  message: string,
  rules: readonly CommitIconRule[] = DEFAULT_COMMIT_ICON_RULES,
): CommitIconRule | null {
  const conventionalType = CONVENTIONAL_COMMIT_PREFIX.exec(message.trim())?.[1]?.toLowerCase()
  if (conventionalType) {
    const conventionalRule = rules.find((rule) => (
      rule.enabled && rule.types.some((type) => type.toLowerCase() === conventionalType)
    ))
    if (conventionalRule) return conventionalRule
  }

  return rules.find((rule) => (
    rule.enabled && rule.patterns.some((source) => compiledPattern(source)?.test(message) === true)
  )) ?? null
}

const COMMIT_ICON_STORAGE_KEY = 'ingit.commitIconRules'
const COMMIT_ICON_STORAGE_VERSION = 1
const MAX_CUSTOM_RULES = 200
const MAX_RULE_VALUES = 50
const MAX_PATTERN_LENGTH = 500

export function cloneCommitIconRules(rules: readonly CommitIconRule[]): CommitIconRule[] {
  return rules.map((rule) => ({
    ...rule,
    types: [...rule.types],
    patterns: [...rule.patterns],
  }))
}

export function serializeCommitIconRules(rules: readonly CommitIconRule[]): string {
  return JSON.stringify({ version: COMMIT_ICON_STORAGE_VERSION, rules })
}

function isCommitIconName(value: unknown): value is CommitIconName {
  return typeof value === 'string' && COMMIT_ICON_NAMES.includes(value as CommitIconName)
}

function stringArray(value: unknown, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_RULE_VALUES) return null
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > maxLength) return null
    result.push(trimmed)
  }
  return result
}

export function parseStoredCommitIconRules(raw: string | null): CommitIconRule[] | null {
  if (raw === null) return null
  try {
    const payload: unknown = JSON.parse(raw)
    if (!payload || typeof payload !== 'object') return null
    const { version, rules } = payload as { version?: unknown; rules?: unknown }
    if (version !== COMMIT_ICON_STORAGE_VERSION || !Array.isArray(rules) || rules.length > MAX_CUSTOM_RULES) {
      return null
    }

    const ids = new Set<string>()
    const parsed: CommitIconRule[] = []
    for (const value of rules) {
      if (!value || typeof value !== 'object') return null
      const candidate = value as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
      const types = stringArray(candidate.types, 80)
      const patterns = stringArray(candidate.patterns, MAX_PATTERN_LENGTH)
      const customSvg = candidate.customSvg === undefined
        ? undefined
        : typeof candidate.customSvg === 'string'
          ? candidate.customSvg.trim()
          : null
      if (
        !id || id.length > 100 || ids.has(id)
        || !label || label.length > 100
        || !isCommitIconName(candidate.icon)
        || typeof candidate.enabled !== 'boolean'
        || types === null
        || patterns === null
        || customSvg === null
        || (customSvg !== undefined && (!customSvg || customSvg.length > MAX_CUSTOM_SVG_LENGTH))
        || (customSvg !== undefined && typeof DOMParser !== 'undefined' && customSvgIconError(customSvg) !== null)
        || patterns.some((pattern) => commitIconPatternError(pattern) !== null)
      ) {
        return null
      }
      ids.add(id)
      parsed.push({
        id,
        label,
        icon: candidate.icon,
        enabled: candidate.enabled,
        types,
        patterns,
        ...(customSvg === undefined ? {} : { customSvg }),
      })
    }
    return parsed
  } catch {
    return null
  }
}

function localCommitIconStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function loadCommitIconRules(): CommitIconRule[] {
  const storage = localCommitIconStorage()
  if (!storage) return cloneCommitIconRules(DEFAULT_COMMIT_ICON_RULES)
  try {
    return parseStoredCommitIconRules(storage.getItem(COMMIT_ICON_STORAGE_KEY))
      ?? cloneCommitIconRules(DEFAULT_COMMIT_ICON_RULES)
  } catch {
    return cloneCommitIconRules(DEFAULT_COMMIT_ICON_RULES)
  }
}

let activeCommitIconRules: readonly CommitIconRule[] = loadCommitIconRules()
const commitIconRuleListeners = new Set<() => void>()

function publishCommitIconRules(rules: readonly CommitIconRule[]) {
  activeCommitIconRules = rules
  for (const listener of commitIconRuleListeners) listener()
}

function handleCommitIconStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== COMMIT_ICON_STORAGE_KEY) return
  publishCommitIconRules(
    parseStoredCommitIconRules(event.newValue) ?? cloneCommitIconRules(DEFAULT_COMMIT_ICON_RULES),
  )
}

function subscribeToCommitIconRules(listener: () => void) {
  const wasEmpty = commitIconRuleListeners.size === 0
  commitIconRuleListeners.add(listener)
  if (wasEmpty && typeof window !== 'undefined') {
    window.addEventListener('storage', handleCommitIconStorage)
  }
  return () => {
    commitIconRuleListeners.delete(listener)
    if (commitIconRuleListeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleCommitIconStorage)
    }
  }
}

export function useCommitIconRules(): readonly CommitIconRule[] {
  return useSyncExternalStore(
    subscribeToCommitIconRules,
    () => activeCommitIconRules,
    () => DEFAULT_COMMIT_ICON_RULES,
  )
}

export function saveCommitIconRules(rules: readonly CommitIconRule[]): boolean {
  const normalized = parseStoredCommitIconRules(serializeCommitIconRules(rules))
  if (!normalized) return false
  const storage = localCommitIconStorage()
  if (!storage) return false
  try {
    storage.setItem(COMMIT_ICON_STORAGE_KEY, serializeCommitIconRules(normalized))
  } catch {
    return false
  }
  publishCommitIconRules(normalized)
  return true
}

export function resetCommitIconRules(): boolean {
  const storage = localCommitIconStorage()
  if (!storage) return false
  try {
    storage.removeItem(COMMIT_ICON_STORAGE_KEY)
  } catch {
    return false
  }
  publishCommitIconRules(cloneCommitIconRules(DEFAULT_COMMIT_ICON_RULES))
  return true
}

const STROKE_PROPS = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function CommitMessageIcon({
  icon,
  color,
  size = 13,
  customSvg,
}: {
  icon: CommitIconName
  color: string
  size?: number
  customSvg?: string
}) {
  if (customSvg) return <CustomSvgIcon source={customSvg} color={color} size={size} />

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      x={-size / 2}
      y={-size / 2}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ color, overflow: 'visible' }}
    >
      {icon === 'accessibility' && (
        <>
          <circle {...STROKE_PROPS} cx="12" cy="4" r="2" />
          <path {...STROKE_PROPS} d="M5 8h14M12 6v7M8 21l4-8 4 8M7 13l5-2 5 2" />
        </>
      )}
      {icon === 'api' && (
        <>
          <path {...STROKE_PROPS} d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5v5" />
          <path {...STROKE_PROPS} d="M8 12h8" />
        </>
      )}
      {icon === 'build' && (
        <>
          <path {...STROKE_PROPS} d="m14 5 5 5M16 3l5 5-3 3-5-5 3-3Z" />
          <path {...STROKE_PROPS} d="M14.5 8.5 4 19l1 1L15.5 9.5" />
        </>
      )}
      {icon === 'chore' && (
        <>
          <path {...STROKE_PROPS} d="m20 3-9 9M11 10l3 3" />
          <path {...STROKE_PROPS} d="m11 10-7 7 3 3 7-7-3-3ZM3 21h9" />
        </>
      )}
      {icon === 'ci' && (
        <>
          <circle {...STROKE_PROPS} cx="6" cy="6" r="2.5" />
          <circle {...STROKE_PROPS} cx="18" cy="6" r="2.5" />
          <circle {...STROKE_PROPS} cx="12" cy="18" r="2.5" />
          <path {...STROKE_PROPS} d="M8.5 6h7M7.4 8.2l3.2 7.6M16.6 8.2l-3.2 7.6" />
        </>
      )}
      {icon === 'config' && (
        <>
          <path {...STROKE_PROPS} d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
          <circle {...STROKE_PROPS} cx="16" cy="6" r="2" />
          <circle {...STROKE_PROPS} cx="8" cy="12" r="2" />
          <circle {...STROKE_PROPS} cx="14" cy="18" r="2" />
        </>
      )}
      {icon === 'database' && (
        <>
          <ellipse {...STROKE_PROPS} cx="12" cy="5" rx="7" ry="3" />
          <path {...STROKE_PROPS} d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
        </>
      )}
      {icon === 'dependencies' && (
        <>
          <path {...STROKE_PROPS} d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path {...STROKE_PROPS} d="M3 8v8l9 5 9-5V8M12 13v8" />
        </>
      )}
      {icon === 'docs' && (
        <>
          <path {...STROKE_PROPS} d="M12 6a6 6 0 0 0-8-2v15a6 6 0 0 1 8 2V6Z" />
          <path {...STROKE_PROPS} d="M12 6a6 6 0 0 1 8-2v15a6 6 0 0 0-8 2V6Z" />
        </>
      )}
      {icon === 'feature' && (
        <>
          <path {...STROKE_PROPS} d="M12 3c.6 3.2 1.8 4.4 5 5-3.2.6-4.4 1.8-5 5-.6-3.2-1.8-4.4-5-5 3.2-.6 4.4-1.8 5-5Z" />
          <path {...STROKE_PROPS} d="M19 15c.3 1.7 1 2.4 2.7 2.7-1.7.3-2.4 1-2.7 2.7-.3-1.7-1-2.4-2.7-2.7 1.7-.3 2.4-1 2.7-2.7Z" />
        </>
      )}
      {icon === 'fix' && (
        <>
          <rect {...STROKE_PROPS} x="7" y="6" width="10" height="14" rx="5" />
          <path {...STROKE_PROPS} d="M9 6 7 3M15 6l2-3M3 10h4M17 10h4M3 15h4M17 15h4M9 11h.01M15 11h.01M12 14v6" />
        </>
      )}
      {icon === 'i18n' && (
        <>
          <circle {...STROKE_PROPS} cx="12" cy="12" r="9" />
          <path {...STROKE_PROPS} d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </>
      )}
      {icon === 'infra' && (
        <>
          <rect {...STROKE_PROPS} x="3" y="4" width="18" height="6" rx="2" />
          <rect {...STROKE_PROPS} x="3" y="14" width="18" height="6" rx="2" />
          <path {...STROKE_PROPS} d="M7 7h.01M7 17h.01M11 7h7M11 17h7" />
        </>
      )}
      {icon === 'merge' && (
        <>
          <circle {...STROKE_PROPS} cx="6" cy="5" r="2" />
          <circle {...STROKE_PROPS} cx="18" cy="19" r="2" />
          <circle {...STROKE_PROPS} cx="6" cy="19" r="2" />
          <path {...STROKE_PROPS} d="M6 7v10M8 5h2a8 8 0 0 1 8 8v4" />
        </>
      )}
      {icon === 'move' && (
        <path {...STROKE_PROPS} d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4" />
      )}
      {icon === 'performance' && (
        <>
          <path {...STROKE_PROPS} d="M4 18a8 8 0 1 1 16 0M12 18l4-5M6.5 10l1 1M12 7v2M17.5 10l-1 1" />
          <circle {...STROKE_PROPS} cx="12" cy="18" r="1" />
        </>
      )}
      {icon === 'refactor' && (
        <>
          <path {...STROKE_PROPS} d="m8 7 4-4 4 4M12 3v7M18 10l3 4-3 4M21 14h-7M8 21l-4-4 4-4M4 17h7" />
        </>
      )}
      {icon === 'release' && (
        <>
          <path {...STROKE_PROPS} d="M14 4c3-2 5-1 6 0s2 3 0 6l-6 6-6-6 6-6Z" />
          <circle {...STROKE_PROPS} cx="16" cy="8" r="1.5" />
          <path {...STROKE_PROPS} d="M8 10H5l-2 4 5 1M14 16v3l-4 2-1-5M7 17l-2 2" />
        </>
      )}
      {icon === 'rename' && (
        <>
          <path {...STROKE_PROPS} d="m14 5 5 5M4 20l3.5-.8L20 6.7 17.3 4 4.8 16.5 4 20Z" />
          <path {...STROKE_PROPS} d="M3 22h9" />
        </>
      )}
      {icon === 'revert' && (
        <>
          <path {...STROKE_PROPS} d="m9 7-5 5 5 5M4 12h10a6 6 0 0 1 6 6v2" />
        </>
      )}
      {icon === 'security' && (
        <>
          <path {...STROKE_PROPS} d="M12 3 20 6v6c0 5-3.4 8-8 10-4.6-2-8-5-8-10V6l8-3Z" />
          <path {...STROKE_PROPS} d="m8.5 12 2.2 2.2 4.8-5" />
        </>
      )}
      {icon === 'style' && (
        <>
          <path {...STROKE_PROPS} d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a6 6 0 0 0 0-12h-3Z" />
          <path {...STROKE_PROPS} d="M7.5 10h.01M9 6.5h.01M14 6.5h.01M17 9h.01" />
        </>
      )}
      {icon === 'test' && (
        <>
          <path {...STROKE_PROPS} d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />
          <path {...STROKE_PROPS} d="M7.5 15h9" />
        </>
      )}
      {icon === 'ui' && (
        <>
          <rect {...STROKE_PROPS} x="3" y="4" width="18" height="16" rx="2" />
          <path {...STROKE_PROPS} d="M9 4v16M9 10h12" />
        </>
      )}
    </svg>
  )
}
