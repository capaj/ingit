import type { ViewMode } from '../store/ui-slice'
import './view-switcher.css'

const VIEWS: Array<{ value: ViewMode; label: string; title: string }> = [
  { value: 'history', label: 'History', title: 'Branch history graph' },
  {
    value: 'reflog',
    label: 'Time Machine',
    title: 'Reflog time machine — recover lost commits and see where HEAD has been',
  },
  { value: 'patch-grep', label: 'Patch grep', title: 'Search the current patch' },
]

export function ViewSwitcher({ value, onChange }: {
  value: ViewMode
  onChange: (view: ViewMode) => void
}) {
  return (
    <div className="view-switcher">
      <div className="view-switcher-tabs" role="group" aria-label="Repository screen">
        {VIEWS.map((view) => (
          <button
            key={view.value}
            type="button"
            data-view={view.value}
            aria-pressed={value === view.value}
            title={view.title}
            onClick={() => onChange(view.value)}
          >
            {view.label}
          </button>
        ))}
      </div>
      <select
        className="view-switcher-select"
        aria-label="Repository screen"
        title="Switch repository screen"
        data-view={value}
        value={value}
        onChange={(event) => onChange(event.target.value as ViewMode)}
      >
        {VIEWS.map((view) => <option key={view.value} value={view.value}>{view.label}</option>)}
      </select>
    </div>
  )
}
