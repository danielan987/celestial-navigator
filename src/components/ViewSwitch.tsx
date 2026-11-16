import type { PlateView } from '../hooks/useExplorer'
import './ViewSwitch.css'

type Props = {
  view: PlateView
  canShowDifference: boolean // false without single-detector images
  onChange: (view: PlateView) => void
}

const OPTIONS: { id: PlateView; label: string }[] = [
  { id: 'blink', label: 'Blink' },
  { id: 'difference', label: 'Difference' },
  { id: 'spectral', label: 'Spectral' },
]

// Above the plate: blink through the plates, see only what changed between passes, or look
// at the field in SPHEREx's 102-colour all-sky cube.
export default function ViewSwitch({ view, canShowDifference, onChange }: Props) {
  return (
    <div className="view-switch">
      <div className="view-switch__options" role="group" aria-label="Plate view">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            className="view-switch__option"
            aria-pressed={view === o.id}
            disabled={o.id === 'difference' && !canShowDifference}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {!canShowDifference && (
        <p className="view-switch__hint">Difference plates need real SPHEREx passes.</p>
      )}
    </div>
  )
}
