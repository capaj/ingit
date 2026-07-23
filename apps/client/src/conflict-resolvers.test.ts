import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONFLICT_RESOLVERS,
  findConflictResolver,
  parseStoredConflictResolvers,
  serializeConflictResolvers,
  type ConflictResolver,
} from './conflict-resolvers'

describe('conflict resolvers', () => {
  test('ships defaults for common language ecosystems', () => {
    const defaults = new Map(DEFAULT_CONFLICT_RESOLVERS.map(
      (resolver) => [resolver.fileName, resolver.command],
    ))

    expect(defaults.get('pnpm-lock.yaml')).toBe('pnpm install')
    expect(defaults.get('poetry.lock')).toBe('poetry lock --regenerate')
    expect(defaults.get('Gemfile.lock')).toBe('bundle install')
    expect(defaults.get('go.sum')).toBe('go mod tidy')
    expect(defaults.get('Cargo.lock')).toBe('cargo generate-lockfile')
    expect(defaults.get('composer.lock')).toBe('composer update --lock')
    expect(defaults.get('Package.resolved')).toBe('swift package resolve')
    expect(defaults.get('packages.lock.json')).toBe('dotnet restore --force-evaluate')
  })

  test('matches the exact basename in nested directories', () => {
    const resolvers: ConflictResolver[] = [{
      id: 'custom',
      fileName: 'dependencies.lock',
      command: 'tool resolve',
    }]

    expect(findConflictResolver('packages/app/dependencies.lock', resolvers)).toEqual(resolvers[0])
    expect(findConflictResolver('dependencies.lock.backup', resolvers)).toBeNull()
  })

  test('round-trips valid custom settings', () => {
    const resolvers: ConflictResolver[] = [{
      id: 'custom',
      fileName: 'dependencies.lock',
      command: 'tool resolve --project "My App"',
    }]

    expect(parseStoredConflictResolvers(serializeConflictResolvers(resolvers))).toEqual(resolvers)
  })

  test('rejects duplicate file names and path-like names', () => {
    expect(parseStoredConflictResolvers(JSON.stringify({
      version: 1,
      resolvers: [
        { id: 'one', fileName: 'same.lock', command: 'one install' },
        { id: 'two', fileName: 'same.lock', command: 'two install' },
      ],
    }))).toBeNull()
    expect(parseStoredConflictResolvers(JSON.stringify({
      version: 1,
      resolvers: [
        { id: 'nested', fileName: 'packages/app.lock', command: 'tool install' },
      ],
    }))).toBeNull()
    expect(parseStoredConflictResolvers(JSON.stringify({
      version: 1,
      resolvers: [
        { id: 'broken-command', fileName: 'broken.lock', command: 'tool "unfinished' },
      ],
    }))).toBeNull()
  })
})
