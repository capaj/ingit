import { useSyncExternalStore } from 'react'
import { parseCommandLine } from '@ingit/rpc-contract'

export interface ConflictResolver {
  id: string
  fileName: string
  command: string
}

function resolver(id: string, fileName: string, command: string): ConflictResolver {
  return { id, fileName, command }
}

export const DEFAULT_CONFLICT_RESOLVERS: readonly ConflictResolver[] = [
  resolver('npm', 'package-lock.json', 'npm install'),
  resolver('npm-shrinkwrap', 'npm-shrinkwrap.json', 'npm install'),
  resolver('pnpm', 'pnpm-lock.yaml', 'pnpm install'),
  resolver('yarn', 'yarn.lock', 'yarn install'),
  resolver('bun-text', 'bun.lock', 'bun install'),
  resolver('bun-binary', 'bun.lockb', 'bun install'),
  resolver('python-poetry', 'poetry.lock', 'poetry lock --regenerate'),
  resolver('python-uv', 'uv.lock', 'uv sync'),
  resolver('python-pipenv', 'Pipfile.lock', 'pipenv lock'),
  resolver('ruby-bundler', 'Gemfile.lock', 'bundle install'),
  resolver('go-modules', 'go.sum', 'go mod tidy'),
  resolver('go-workspace', 'go.work.sum', 'go work sync'),
  resolver('rust-cargo', 'Cargo.lock', 'cargo generate-lockfile'),
  resolver('php-composer', 'composer.lock', 'composer update --lock'),
  resolver('swift-package-manager', 'Package.resolved', 'swift package resolve'),
  resolver('cocoapods', 'Podfile.lock', 'pod install'),
  resolver('dart-pub', 'pubspec.lock', 'dart pub get'),
  resolver('elixir-mix', 'mix.lock', 'mix deps.get'),
  resolver('dotnet-nuget', 'packages.lock.json', 'dotnet restore --force-evaluate'),
  resolver('gradle', 'gradle.lockfile', 'gradle dependencies --write-locks'),
]

const STORAGE_KEY = 'ingit.conflictResolvers'
const STORAGE_VERSION = 1
const MAX_RESOLVERS = 100
const MAX_ID_LENGTH = 100
const MAX_FILE_NAME_LENGTH = 255
const MAX_COMMAND_LENGTH = 1_000

function validFileName(fileName: string): boolean {
  return fileName.length > 0
    && fileName.length <= MAX_FILE_NAME_LENGTH
    && fileName !== '.'
    && fileName !== '..'
    && !fileName.includes('/')
    && !fileName.includes('\\')
}

export function cloneConflictResolvers(
  resolvers: readonly ConflictResolver[],
): ConflictResolver[] {
  return resolvers.map((entry) => ({ ...entry }))
}

export function serializeConflictResolvers(
  resolvers: readonly ConflictResolver[],
): string {
  return JSON.stringify({ version: STORAGE_VERSION, resolvers })
}

export function parseStoredConflictResolvers(raw: string | null): ConflictResolver[] | null {
  if (raw === null) return null
  try {
    const payload: unknown = JSON.parse(raw)
    if (!payload || typeof payload !== 'object') return null
    const { version, resolvers } = payload as { version?: unknown; resolvers?: unknown }
    if (
      version !== STORAGE_VERSION
      || !Array.isArray(resolvers)
      || resolvers.length > MAX_RESOLVERS
    ) {
      return null
    }

    const ids = new Set<string>()
    const fileNames = new Set<string>()
    const parsed: ConflictResolver[] = []
    for (const value of resolvers) {
      if (!value || typeof value !== 'object') return null
      const candidate = value as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
      const fileName = typeof candidate.fileName === 'string' ? candidate.fileName.trim() : ''
      const command = typeof candidate.command === 'string' ? candidate.command.trim() : ''
      if (
        !id
        || id.length > MAX_ID_LENGTH
        || ids.has(id)
        || !validFileName(fileName)
        || fileNames.has(fileName)
        || !command
        || command.length > MAX_COMMAND_LENGTH
        || !parseCommandLine(command)
      ) {
        return null
      }
      ids.add(id)
      fileNames.add(fileName)
      parsed.push({ id, fileName, command })
    }
    return parsed
  } catch {
    return null
  }
}

export function findConflictResolver(
  path: string,
  resolvers: readonly ConflictResolver[],
): ConflictResolver | null {
  const fileName = path.replaceAll('\\', '/').split('/').at(-1)
  if (!fileName) return null
  return resolvers.find((entry) => entry.fileName === fileName) ?? null
}

function localResolverStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function loadConflictResolvers(): ConflictResolver[] {
  const storage = localResolverStorage()
  if (!storage) return cloneConflictResolvers(DEFAULT_CONFLICT_RESOLVERS)
  try {
    return parseStoredConflictResolvers(storage.getItem(STORAGE_KEY))
      ?? cloneConflictResolvers(DEFAULT_CONFLICT_RESOLVERS)
  } catch {
    return cloneConflictResolvers(DEFAULT_CONFLICT_RESOLVERS)
  }
}

let activeConflictResolvers: readonly ConflictResolver[] = loadConflictResolvers()
const listeners = new Set<() => void>()

function publishConflictResolvers(resolvers: readonly ConflictResolver[]) {
  activeConflictResolvers = resolvers
  for (const listener of listeners) listener()
}

function handleStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  publishConflictResolvers(
    parseStoredConflictResolvers(event.newValue)
      ?? cloneConflictResolvers(DEFAULT_CONFLICT_RESOLVERS),
  )
}

function subscribe(listener: () => void) {
  const wasEmpty = listeners.size === 0
  listeners.add(listener)
  if (wasEmpty && typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorage)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorage)
    }
  }
}

export function useConflictResolvers(): readonly ConflictResolver[] {
  return useSyncExternalStore(
    subscribe,
    () => activeConflictResolvers,
    () => DEFAULT_CONFLICT_RESOLVERS,
  )
}

export function saveConflictResolvers(resolvers: readonly ConflictResolver[]): boolean {
  const normalized = parseStoredConflictResolvers(serializeConflictResolvers(resolvers))
  if (!normalized) return false
  const storage = localResolverStorage()
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, serializeConflictResolvers(normalized))
  } catch {
    return false
  }
  publishConflictResolvers(normalized)
  return true
}

export function resetConflictResolvers(): boolean {
  const storage = localResolverStorage()
  if (!storage) return false
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    return false
  }
  publishConflictResolvers(cloneConflictResolvers(DEFAULT_CONFLICT_RESOLVERS))
  return true
}
