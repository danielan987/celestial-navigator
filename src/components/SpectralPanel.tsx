import type { SpectralMap } from '../hooks/useSpectralMap'
import { spectralColour } from '../utils/spectral'
import { SPECTRAL_LAYERS, layerById } from '../utils/spectralLayers'
import type { SpectralLayerId } from '../utils/spectralLayers'
import './SpectralPanel.css'

type Props = {
  map: SpectralMap
  layer: SpectralLayerId
  onLayerChange: (layer: SpectralLayerId) => void
  onRetry: () => void
}

// The legend's gradient, in the map's own colours (dark = faint, light = bright)
const GRADIENT = `linear-gradient(to right, ${Array.from({ length: 9 }, (_, i) =>
  spectralColour(i / 8),
).join(', ')})`

function Status({ map, onRetry }: Pick<Props, 'map' | 'onRetry'>) {
  if (map.status === 'loading') {
    return (
      <p className="spectral__status" role="status">
        Building the spectral map from SPHEREx’s all-sky cube… The first time for a new place takes
        up to a minute; after that it’s instant.
      </p>
    )
  }
  if (map.status === 'offline') {
    return (
      <div className="spectral__problem" role="alert">
        {import.meta.env.DEV ? (
          <p>
            The science service isn’t running, so spectral maps can’t be made. To start it, run{' '}
            <code>.venv-science/bin/python science/server.py</code> in the project folder.
          </p>
        ) : (
          <p>
            Spectral maps need Celestial Navigator’s science service, which isn’t connected to this
            site. Blink and Difference work without it.
          </p>
        )}
        <button type="button" className="spectral__retry" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  }
  if (map.status === 'error') {
    return (
      <div className="spectral__problem" role="alert">
        <p>{map.message}</p>
        <button type="button" className="spectral__retry" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  }
  return null
}

// The side panel in the Spectral view: All light, or one of the molecule maps (carbon particles,
// water, CO₂ and CO ice). They all arrive together, so switching is instant.
export default function SpectralPanel({ map, layer, onLayerChange, onRetry }: Props) {
  const current = layerById(layer)
  const has = (id: SpectralLayerId) => map.status !== 'ready' || Boolean(map.images[id])
  return (
    <section className="spectral panel" aria-labelledby="spectral-heading">
      <h2 id="spectral-heading" className="panel-heading">
        Spectral Map
      </h2>
      <p className="panel-intro">
        Maps from SPHEREx’s 102 colours of infrared light, with every visit stacked together.
      </p>

      <div className="spectral__group">
        <p className="label" id="spectral-map-label">
          Show
        </p>
        <div className="spectral__options" role="group" aria-labelledby="spectral-map-label">
          {SPECTRAL_LAYERS.map((l) => (
            <button
              key={l.id}
              type="button"
              className="spectral__option"
              aria-pressed={layer === l.id}
              disabled={!has(l.id)}
              title={has(l.id) ? undefined : 'No usable pixels for this map here'}
              onClick={() => onLayerChange(l.id)}
            >
              {l.button}
            </button>
          ))}
        </div>
        <p className="spectral__hint">
          {current.wavelength && <strong>{current.wavelength}. </strong>}
          {current.explain}
        </p>
      </div>

      <Status map={map} onRetry={onRetry} />

      <div className="spectral__legend">
        <p className="label">{current.id === 'all' ? 'Brightness' : current.title}</p>
        <span className="spectral__gradient" style={{ background: GRADIENT }} aria-hidden="true" />
        <p className="spectral__scale">
          <span>{current.low}</span>
          <span>{current.high}</span>
        </p>
        <p className="spectral__hint">
          Colours are scaled to each map, so compare places within one map, not between targets.
          Grey means no data.
        </p>
      </div>

      <div className="spectral__note">
        <h3 className="label">Good to know</h3>
        {current.id === 'all' ? (
          <p>
            Every visit is stacked, so nothing moves here. Hunt for movers with Blink and
            Difference.
          </p>
        ) : (
          <p>
            Water, carbon and ice are ingredients of planets and life. These maps are hints, not
            detections: dust and stripes in the data can look alike.
          </p>
        )}
      </div>
    </section>
  )
}
