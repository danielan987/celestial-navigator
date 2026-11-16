import type { ColourKeyEntry, PassesResponse, Target } from '../api/types'
import type { LoadStatus } from '../hooks/useExplorer'
import { imageForBand } from '../utils/bands'
import { formatDate } from '../utils/dates'
import './SkyPlate.css'

type Props = {
  target: Target | null
  passesData: PassesResponse | null
  passesStatus: LoadStatus
  passIndex: number
  band: ColourKeyEntry | null // null = colour composite
  // Set in the Difference and Spectral views: shown instead of the pass (and always real data,
  // so the "Simulated" tag is hidden)
  altImage?: PlateImage | null
  onRetry: () => void
}

// An image made for the plate (a difference plate, a spectral map), with its words
export type PlateImage = {
  status: 'loading' | 'ready' | 'error'
  url?: string
  badge: string // "Difference · Pass I → Pass III · D3"
  alt: string
  loadingText: string // "Subtracting…"
  errorText: string
}

function Corners() {
  return (
    <>
      <span className="sky-plate__corner sky-plate__corner--tl" aria-hidden="true" />
      <span className="sky-plate__corner sky-plate__corner--tr" aria-hidden="true" />
      <span className="sky-plate__corner sky-plate__corner--bl" aria-hidden="true" />
      <span className="sky-plate__corner sky-plate__corner--br" aria-hidden="true" />
    </>
  )
}

export default function SkyPlate({
  target,
  passesData,
  passesStatus,
  passIndex,
  band,
  altImage = null,
  onRetry,
}: Props) {
  const pass = passesData?.passes[passIndex]
  const total = passesData?.passes.length ?? 0

  let content
  if (passesStatus === 'error') {
    content = (
      <div className="sky-plate__message" role="alert">
        <p>The chart for this target couldn’t be loaded.</p>
        <button type="button" className="sky-plate__retry" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  } else if (passesStatus === 'loading' || !target || !passesData) {
    content = (
      <div className="sky-plate__message" role="status">
        <p>Charting course…</p>
      </div>
    )
  } else if (!pass) {
    content = (
      <div className="sky-plate__message">
        <p>No SPHEREx passes on file for {target.name} yet.</p>
      </div>
    )
  } else {
    // 1 arcminute as a share of the field width
    const scaleWidth = (1 / 60 / passesData.fieldSizeDeg) * 100
    const src = altImage
      ? altImage.status === 'ready'
        ? altImage.url
        : null
      : imageForBand(pass, band?.band ?? null)
    const bandText = band ? `, detector ${band.band} only (${band.wavelength})` : ''
    const alt = altImage
      ? altImage.alt
      : `${target.name}, ${pass.label} (${passIndex + 1} of ${total})${bandText}, observed ${formatDate(pass.date)}`

    content = (
      <>
        {src ? (
          <img className="sky-plate__image" src={src} alt={alt} />
        ) : (
          <div className="sky-plate__message" role="status">
            <p>
              {!altImage
                ? `No ${band?.band} images in this visit.`
                : altImage.status === 'error'
                  ? altImage.errorText
                  : altImage.loadingText}
            </p>
          </div>
        )}

        <div className="sky-plate__grid" aria-hidden="true" />
        <span className="sky-plate__compass sky-plate__compass--n" aria-hidden="true">
          N
        </span>
        <span className="sky-plate__compass sky-plate__compass--e" aria-hidden="true">
          E
        </span>
        <span className="sky-plate__badge" aria-hidden="true">
          {/* labels can be "Short visit", so show position separately */}
          {altImage ? (
            altImage.badge
          ) : (
            <>
              {pass.label} · {passIndex + 1} of {total}
              {band && ` · ${band.band}`}
            </>
          )}
        </span>
        {passesData.simulated && !altImage && (
          <span className="sky-plate__simulated" aria-hidden="true">
            Simulated
          </span>
        )}
        <span className="sky-plate__scale" style={{ width: `${scaleWidth}%` }} aria-hidden="true">
          <span className="sky-plate__scale-bar" />
          1′
        </span>

        {!altImage &&
          passesData.candidates.map((c) => {
            const pos = c.positions.find((p) => p.passId === pass.id)
            if (!pos) return null
            return (
              <div
                key={c.id}
                className="sky-plate__marker"
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                role="img"
                aria-label={`Candidate mover ${c.id}, ${c.status}`}
              >
                <span className="sky-plate__marker-ring" />
                <span className="sky-plate__marker-label">{c.id}</span>
              </div>
            )
          })}
      </>
    )
  }

  return (
    <figure className="sky-plate">
      <div className="sky-plate__frame">
        <Corners />
        <div className="sky-plate__sky">{content}</div>
      </div>
    </figure>
  )
}
