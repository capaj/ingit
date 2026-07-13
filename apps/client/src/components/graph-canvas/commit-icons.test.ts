import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMMIT_ICON_RULES,
  findCommitIcon,
  parseStoredCommitIconRules,
  serializeCommitIconRules,
  type CommitIconRule,
} from './CommitIcons'

describe('commit message icons', () => {
  test('includes a broad default catalog', () => {
    expect(DEFAULT_COMMIT_ICON_RULES.length).toBeGreaterThanOrEqual(13)
  })

  test.each([
    ['chore: clean generated files', 'chore'],
    ['Fix the graph crash', 'fix'],
    ['Squash a nasty bug', 'fix'],
    ['feat(canvas): add semantic nodes', 'feature'],
    ['infra: provision preview server', 'infra'],
    ['docs: explain rebasing', 'docs'],
    ['test: cover lane allocation', 'test'],
    ['refactor: split graph helpers', 'refactor'],
    ['move: relocate graph helpers', 'move'],
    ['rename: clarify graph helper names', 'rename'],
    ['perf: optimize rendering', 'performance'],
    ['style: format action buttons', 'style'],
    ['ci: run Windows checks', 'ci'],
    ['build: configure Vite chunks', 'build'],
    ['deps: bump React', 'dependencies'],
    ['security: patch CVE', 'security'],
    ['a11y: improve screen reader labels', 'accessibility'],
    ['i18n: add Czech translation', 'i18n'],
    ['db: migrate session schema', 'database'],
    ['api: add history endpoint', 'api'],
    ['ui: make sidebar responsive', 'ui'],
    ['release: publish version 1.2.3', 'release'],
    ['revert: undo broken release', 'revert'],
    ['merge: integrate the agent branch', 'merge'],
    ['config: tune settings', 'config'],
  ] as const)('classifies %s as %s', (message, expectedIcon) => {
    expect(findCommitIcon(message)?.icon).toBe(expectedIcon)
  })

  test('prefers an explicit conventional commit type over later keywords', () => {
    expect(findCommitIcon('docs(parser): fix a typo')?.icon).toBe('docs')
    expect(findCommitIcon('feat!: fix the old API')?.icon).toBe('feature')
    expect(findCommitIcon('refactor: move graph helpers')?.icon).toBe('refactor')
  })

  test('recognizes move and rename inflections', () => {
    expect(findCommitIcon('Moved GraphCanvas into components')?.icon).toBe('move')
    expect(findCommitIcon('Renaming the lane allocator')?.icon).toBe('rename')
  })

  test('matches whole words instead of incidental substrings', () => {
    expect(findCommitIcon('Prefix parser output')).toBeNull()
    expect(findCommitIcon('Update the artifact')).toBeNull()
  })

  test('round-trips the complete rule set through the persisted format', () => {
    expect(parseStoredCommitIconRules(serializeCommitIconRules(DEFAULT_COMMIT_ICON_RULES)))
      .toEqual([...DEFAULT_COMMIT_ICON_RULES])
  })

  test('uses a custom rule set as a complete override', () => {
    const customSvg = '<svg viewBox="0 0 24 24"><path d="M4 12h16" /></svg>'
    const customRules: CommitIconRule[] = [{
      id: 'ship-it',
      icon: 'release',
      label: 'Ship it',
      enabled: true,
      types: ['ship'],
      patterns: [String.raw`\bship(?:ped|ping)?\b`],
      customSvg,
    }]

    expect(findCommitIcon('ship: publish the app', customRules)?.icon).toBe('release')
    expect(findCommitIcon('Fix a bug', customRules)).toBeNull()
    expect(parseStoredCommitIconRules(serializeCommitIconRules(customRules))?.[0]?.customSvg).toBe(customSvg)
  })

  test('skips disabled rules and respects custom order', () => {
    const customRules: CommitIconRule[] = [
      {
        id: 'disabled-fix',
        icon: 'fix',
        label: 'Disabled fix',
        enabled: false,
        types: ['fix'],
        patterns: [String.raw`\bbugs?\b`],
      },
      {
        id: 'custom-bug',
        icon: 'feature',
        label: 'Custom bug',
        enabled: true,
        types: [],
        patterns: [String.raw`\bbugs?\b`],
      },
    ]

    expect(findCommitIcon('Fix a bug', customRules)?.id).toBe('custom-bug')
  })

  test('rejects malformed or incompatible persisted settings', () => {
    expect(parseStoredCommitIconRules('{not json')).toBeNull()
    expect(parseStoredCommitIconRules(JSON.stringify({ version: 99, rules: [] }))).toBeNull()
    expect(parseStoredCommitIconRules(JSON.stringify({
      version: 1,
      rules: [{
        id: 'broken',
        icon: 'fix',
        label: 'Broken',
        enabled: true,
        types: [],
        patterns: ['['],
      }],
    }))).toBeNull()
    expect(parseStoredCommitIconRules(JSON.stringify({
      version: 1,
      rules: [{
        id: 'oversized-svg',
        icon: 'fix',
        label: 'Oversized SVG',
        enabled: true,
        types: ['fix'],
        patterns: [],
        customSvg: `<svg>${' '.repeat(20_001)}</svg>`,
      }],
    }))).toBeNull()
  })
})
