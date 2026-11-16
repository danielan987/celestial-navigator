import type { Pass, Target } from '../api/types'
import { eclipticLatitude } from '../utils/sky'
import './TargetBar.css'

type Props = {
  targets: Target[]
  selectedTarget: Target
  passes: Pass[] | null // null while loading
  onSelect: (id: string) => void
  onBackToSky: () => void
}

const formatDegrees = (n: number, signed = false, places = 5) =>
  `${signed && n >= 0 ? '+' : ''}${n < 0 ? '−' : ''}${Math.abs(n).toFixed(places)}°`

const plural = (n: number, word: string, words: string) => `${n} ${n === 1 ? word : words}`

// "3 passes", or "3 passes + 1 short visit"
function describePasses(passes: Pass[]) {
  const short = passes.filter((p) => p.short).length
  const full = plural(passes.length - short, 'pass', 'passes')
  return short ? `${full} + ${plural(short, 'short visit', 'short visits')}` : full
}

// The instrument's header: which target is on the plate, where it is, and a way back up.
export default function TargetBar({
  targets,
  selectedTarget,
  passes,
  onSelect,
  onBackToSky,
}: Props) {
  const readouts = [
    ['Right ascension', formatDegrees(selectedTarget.ra)],
    ['Declination', formatDegrees(selectedTarget.dec, true)],
    [
      'From the ecliptic',
      formatDegrees(eclipticLatitude(selectedTarget.ra, selectedTarget.dec), true, 1),
    ],
    // Almanac fact, for built-in targets only
    ...(selectedTarget.type ? [['Type', selectedTarget.type]] : []),
    ['Passes on file', passes ? describePasses(passes) : '—'],
  ]

  return (
    <section className="target-bar panel" aria-label="Target">
      <div className="target-bar__picker">
        <label className="label" htmlFor="target-select">
          Now observing
        </label>
        <select
          id="target-select"
          className="target-bar__select"
          value={selectedTarget.id}
          onChange={(e) => onSelect(e.target.value)}
        >
          {!targets.some((t) => t.id === selectedTarget.id) && (
            <option value={selectedTarget.id}>{selectedTarget.name}</option>
          )}
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.messier} · {t.name}
            </option>
          ))}
        </select>
      </div>

      <dl className="target-bar__readouts" aria-live="polite">
        {readouts.map(([label, value]) => (
          <div key={label} className="target-bar__readout">
            <dt className="label">{label}</dt>
            <dd>
              <output className="data">{value}</output>
            </dd>
          </div>
        ))}
      </dl>

      <button type="button" className="target-bar__back" onClick={onBackToSky}>
        <svg viewBox="0 0 24 14" aria-hidden="true">
          <path d="M2 12 L12 2 L22 12" />
        </svg>
        Sky chart
      </button>
    </section>
  )
}
