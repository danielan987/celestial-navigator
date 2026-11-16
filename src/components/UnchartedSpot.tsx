import type { SpotScout, Target } from '../api/types'
import type { SkySpot, SpotFetchState, SpotScoutState } from '../hooks/useExplorer'
import { formatDec, formatRA } from '../utils/coords'
import { formatDate } from '../utils/dates'
import { eclipticLatitude } from '../utils/sky'
import './UnchartedSpot.css'

type Props = {
  spot: SkySpot
  nearest: { target: Target; distance: number } | null
  scout: SpotScoutState
  fetch: SpotFetchState
  onFetch: (retry?: boolean) => void
  onRetryScout: () => void
  onSelect: (id: string) => void
  onBackToSky: () => void
}

// 0.4° → "24′", 12.3° → "12.3°"
const formatDistance = (deg: number) =>
  deg < 1 ? `${Math.round(deg * 60)}′` : `${deg.toFixed(deg < 10 ? 1 : 0)}°`

const signed = (n: number, places: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(places)}°`

const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`

// 75 → "about a minute", 130 → "about 2 minutes"
const formatDuration = (seconds: number) =>
  seconds < 90 ? 'about a minute' : `about ${Math.round(seconds / 60)} minutes`

// "Photographed 186 times · 2 visits you could blink between · about 2 minutes to fetch"
function summaryParts(scout: SpotScout) {
  const visits = scout.visits.length
  return [
    `Photographed ${plural(scout.images, 'time')}`,
    visits > 1
      ? `${visits} visits you could blink between`
      : 'one visit so far, so nothing to blink between yet',
    `${formatDuration(scout.estimateSeconds)} to fetch`,
  ]
}

// "24 Oct – 13 Nov 2025", or one date for a one-day visit
function visitDates(start: string, end: string) {
  if (start === end) return formatDate(start)
  const [a, b] = [formatDate(start), formatDate(end)]
  return a.slice(-4) === b.slice(-4) ? `${a.slice(0, -5)} – ${b}` : `${a} – ${b}`
}

// Detectors other than D1/D3/D6 with images here: ["D2", "D5"]
const otherDetectors = (scout: SpotScout) =>
  Object.entries(scout.imagesByDetector)
    .filter(([d, n]) => n > 0 && !['D1', 'D3', 'D6'].includes(d))
    .map(([d]) => d)

function FetchControls({
  fetch,
  onFetch,
}: {
  fetch: SpotFetchState
  onFetch: (retry?: boolean) => void
}) {
  if (fetch.status === 'processing') {
    const { job } = fetch
    const progress = Math.round((job.progress ?? 0) * 100)
    return (
      <div className="uncharted__progress" role="status" aria-live="polite">
        <p className="uncharted__stage">
          {job.stageLabel ?? 'Starting up'}
          {job.toDownload ? ` · ${job.downloaded ?? 0} of ${job.toDownload}` : '…'}
        </p>
        <div
          className="uncharted__bar"
          role="progressbar"
          aria-label="Fetching this spot"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${Math.max(progress, 2)}%` }} />
        </div>
        <p className="uncharted__hint">
          You can leave this page open; the plate appears here when it’s ready.
        </p>
      </div>
    )
  }
  if (fetch.status === 'failed') {
    return (
      <div className="uncharted__problem" role="alert">
        <p>{fetch.message}</p>
        {!fetch.permanent && (
          <button type="button" className="uncharted__go" onClick={() => onFetch(true)}>
            Try again
          </button>
        )}
      </div>
    )
  }
  if (fetch.status === 'offline') {
    return <BackendOffline />
  }
  return (
    <button type="button" className="uncharted__go" onClick={() => onFetch()}>
      Fetch this spot
    </button>
  )
}

function BackendOffline({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="uncharted__problem" role="alert">
      {import.meta.env.DEV ? (
        // On your own machine (npm run dev): say how to start it
        <p>
          The Celestial Navigator backend isn’t running, so new spots can’t be fetched. To start it,
          run <code>pipeline/.venv/bin/python pipeline/server.py</code> in the project folder.
        </p>
      ) : (
        <p>
          Fetching new spots needs Celestial Navigator’s backend, which isn’t connected to this
          site. Every charted target works without it: pick one from the sky chart.
        </p>
      )}
      {onRetry && (
        <button type="button" className="uncharted__go" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

function ScoutReport({
  scout,
  fetch,
  onFetch,
  onRetryScout,
}: {
  scout: SpotScout
  fetch: SpotFetchState
  onFetch: (retry?: boolean) => void
  onRetryScout: () => void
}) {
  if (scout.images === 0) {
    const others = otherDetectors(scout)
    const total = Object.values(scout.imagesByDetector).reduce((a, b) => a + b, 0)
    if (others.length) {
      return (
        <p className="uncharted__text">
          SPHEREx has photographed this spot {plural(total, 'time')}, but only with its{' '}
          {others.join(' and ')} detectors. Celestial Navigator blinks D1, D3 and D6, which haven’t
          covered it in a released image yet. This happens near the north ecliptic pole; try a spot
          a few degrees away.
        </p>
      )
    }
    // SPHEREx covers the whole sky, so an empty list is most likely a hiccup at IRSA.
    return (
      <div className="uncharted__problem" role="alert">
        <p>
          NASA’s archive didn’t list any SPHEREx photos for this spot. SPHEREx covers the whole sky,
          so this is probably a hiccup at the archive. Try again in a few minutes.
        </p>
        <button type="button" className="uncharted__go" onClick={onRetryScout}>
          Try again
        </button>
      </div>
    )
  }
  return (
    <>
      <p className="uncharted__summary">
        {summaryParts(scout).map((part, i) => (
          <span key={i}>{part}</span>
        ))}
      </p>
      <ul className="uncharted__visits">
        {scout.visits.map((v) => (
          <li key={v.start}>
            <span className="label">{v.label}</span>
            <span className="data">{visitDates(v.start, v.end)}</span>
            <span className="uncharted__count">{plural(v.images, 'photo')}</span>
          </li>
        ))}
      </ul>
      <FetchControls fetch={fetch} onFetch={onFetch} />
      <details className="uncharted__details">
        <summary>Technical details</summary>
        <dl>
          <dt>Images per detector</dt>
          <dd className="data">
            {Object.entries(scout.imagesByDetector)
              .map(([d, n]) => `${d} ${n}`)
              .join(' · ')}
          </dd>
          <dt>Fetch</dt>
          <dd className="data">
            {scout.downloadCount} cutouts (at most 8 per detector per pass), about{' '}
            {scout.downloadMB} MB
          </dd>
          <dt>Galactic latitude</dt>
          <dd className="data">{signed(scout.galacticLat, 1)}</dd>
          <dt>Spot id</dt>
          <dd className="data">{scout.id}</dd>
        </dl>
        {scout.notes.length > 0 && (
          <ul className="uncharted__notes">
            {scout.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </details>
    </>
  )
}

// Shown in place of the instrument when typed coordinates don't match a built-in target:
// what SPHEREx has there, and a button to fetch and process it on the backend.
export default function UnchartedSpot({
  spot,
  nearest,
  scout,
  fetch,
  onFetch,
  onRetryScout,
  onSelect,
  onBackToSky,
}: Props) {
  const readouts = [
    ['Right ascension', `${formatRA(spot.ra)} · ${spot.ra.toFixed(5)}°`],
    ['Declination', `${formatDec(spot.dec)} · ${signed(spot.dec, 5)}`],
    ['From the ecliptic', signed(eclipticLatitude(spot.ra, spot.dec), 1)],
  ]

  return (
    <section className="uncharted panel" aria-labelledby="uncharted-heading">
      <div className="uncharted__head">
        <h2 id="uncharted-heading" className="panel-heading">
          Uncharted spot
        </h2>
        <button type="button" className="uncharted__back" onClick={onBackToSky}>
          <svg viewBox="0 0 24 14" aria-hidden="true">
            <path d="M2 12 L12 2 L22 12" />
          </svg>
          Sky chart
        </button>
      </div>

      <dl className="uncharted__readouts">
        {readouts.map(([label, value]) => (
          <div key={label} className="uncharted__readout">
            <dt className="label">{label}</dt>
            <dd className="data">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="uncharted__text">
        This spot isn’t one of Celestial Navigator’s charted targets, but SPHEREx photographs the
        whole sky. Its photos can be fetched from NASA’s archive and lined up into plates you can
        blink, just like the charted ones.
      </p>

      {scout.status === 'loading' && (
        <p className="uncharted__text" role="status">
          Asking NASA’s SPHEREx archive what it has here… (this can take half a minute)
        </p>
      )}
      {scout.status === 'offline' && <BackendOffline onRetry={onRetryScout} />}
      {scout.status === 'error' && (
        <div className="uncharted__problem" role="alert">
          <p>{scout.message}</p>
          <button type="button" className="uncharted__go" onClick={onRetryScout}>
            Try again
          </button>
        </div>
      )}
      {/* A job already running (or failed) shows before the summary arrives */}
      {((scout.status !== 'ready' && fetch.status === 'processing') ||
        (scout.status === 'loading' && fetch.status === 'failed')) && (
        <FetchControls fetch={fetch} onFetch={onFetch} />
      )}
      {scout.status === 'ready' && (
        <ScoutReport
          scout={scout.scout}
          fetch={fetch}
          onFetch={onFetch}
          onRetryScout={onRetryScout}
        />
      )}

      {nearest && (
        <p className="uncharted__nearest">
          Nearest charted target: <strong>{nearest.target.name}</strong>,{' '}
          {formatDistance(nearest.distance)} away.{' '}
          <button
            type="button"
            className="uncharted__back uncharted__nearest-go"
            onClick={() => onSelect(nearest.target.id)}
          >
            Go to {nearest.target.name}
          </button>
        </p>
      )}
    </section>
  )
}
