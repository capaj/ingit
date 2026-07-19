export type ViewMode = 'history' | 'reflog'

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

  setViewMode: (mode: ViewMode) => void
  setShowCommitMessages: (value: boolean) => void
  setShowGutterColors: (value: boolean) => void
  showError: (title: string, err: unknown, action?: ErrorDialogAction) => void
  dismissError: () => void
}

export type UiSliceState = Omit<
  UiSlice,
  | 'setViewMode'
  | 'setShowCommitMessages'
  | 'setShowGutterColors'
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

export function createUiSliceState(): UiSliceState {
  return {
    viewMode: 'history',
    errorDialog: null,
    showCommitMessages: readBooleanPreference('showCommitMessages', true),
    showGutterColors: readBooleanPreference('showGutterColors', false),
  }
}
