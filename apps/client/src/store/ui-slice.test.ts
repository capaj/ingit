import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_GRAPH_ZOOM,
  MAX_GRAPH_ZOOM,
  MIN_GRAPH_ZOOM,
  createUiSliceState,
  normalizeGraphZoom,
  persistGraphZoomPreference,
} from './ui-slice'

const originalLocalStorage = globalThis.localStorage
const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
})

afterEach(() => {
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    })
  }
})

describe('graph zoom preference', () => {
  test('restores a saved zoom level', () => {
    values.set('graphZoom', '1.7')

    expect(createUiSliceState().graphZoom).toBe(1.7)
  })

  test('saves a zoom level for the next app load', () => {
    expect(persistGraphZoomPreference(1.4)).toBe(1.4)
    expect(values.get('graphZoom')).toBe('1.4')
    expect(createUiSliceState().graphZoom).toBe(1.4)
  })

  test('uses the default for a missing or invalid saved value', () => {
    expect(createUiSliceState().graphZoom).toBe(DEFAULT_GRAPH_ZOOM)

    values.set('graphZoom', 'not-a-number')
    expect(createUiSliceState().graphZoom).toBe(DEFAULT_GRAPH_ZOOM)
  })

  test('keeps restored zoom within the supported range', () => {
    expect(normalizeGraphZoom(MIN_GRAPH_ZOOM - 1)).toBe(MIN_GRAPH_ZOOM)
    expect(normalizeGraphZoom(MAX_GRAPH_ZOOM + 1)).toBe(MAX_GRAPH_ZOOM)
  })
})
