export type ViewMode = 'history' | 'reflog'

export const DEFAULT_GRAPH_ZOOM = 1
export const MIN_GRAPH_ZOOM = 0.1
export const MAX_GRAPH_ZOOM = 3

/** Optional extra button shown in the error dialog (e.g. "Force push"). */
export interface ErrorDialogAction {
  label: string
  run: () => void
}

export interface UiSlice {
  viewMode: ViewMode
  errorDialog: { title: string; message: string; action?: ErrorDialogAction } | null
  showCommitMessages: boolean
  showGutterColors: boolean
  graphZoom: number

  setViewMode: (mode: ViewMode) => void
  setShowCommitMessages: (value: boolean) => void
  setShowGutterColors: (value: boolean) => void
  setGraphZoom: (value: number) => void
  showError: (title: string, err: unknown, action?: ErrorDialogAction) => void
  dismissError: () => void
}

export type UiSliceState = Omit<
  UiSlice,
  | 'setViewMode'
  | 'setShowCommitMessages'
  | 'setShowGutterColors'
  | 'setGraphZoom'
  | 'showError'
  | 'dismissError'
>

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? fallback : stored === 'true'
  } catch {
    return fallback
  }
}

export function normalizeGraphZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GRAPH_ZOOM
  return Math.max(MIN_GRAPH_ZOOM, Math.min(MAX_GRAPH_ZOOM, value))
}

export function persistGraphZoomPreference(value: number): number {
  const graphZoom = normalizeGraphZoom(value)
  try {
    localStorage.setItem('graphZoom', String(graphZoom))
  } catch {}
  return graphZoom
}

function readGraphZoomPreference(): number {
  try {
    const stored = localStorage.getItem('graphZoom')
    if (stored === null) return DEFAULT_GRAPH_ZOOM
    return normalizeGraphZoom(Number(stored))
  } catch {
    return DEFAULT_GRAPH_ZOOM
  }
}

export function createUiSliceState(): UiSliceState {
  return {
    viewMode: 'history',
    errorDialog: null,
    showCommitMessages: readBooleanPreference('showCommitMessages', true),
    showGutterColors: readBooleanPreference('showGutterColors', false),
    graphZoom: readGraphZoomPreference(),
  }
}
