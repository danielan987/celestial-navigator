import type { ColourKeyEntry } from '../api/types'
import './ColourKeyPanel.css'

type Props = {
  entries: ColourKeyEntry[]
  band: string | null // null = colour composite
  bandsAvailable: boolean // false for simulated targets, which only have colour images
  onBandChange: (band: string | null) => void
}

export default function ColourKeyPanel({ entries, band, bandsAvailable, onBandChange }: Props) {
  // The panel follows the mode: a colour legend for the composite, a greyscale guide for one band.
  const active = band === null ? null : (entries.find((e) => e.band === band) ?? null)
  const shortest = entries[0]?.band
  const longest = entries[entries.length - 1]?.band

  const options = [
    { id: null, label: 'Colour' },
    ...entries.map((e) => ({ id: e.band, label: e.band })),
  ]

  return (
    <section id="colours" className="colour-key panel" aria-labelledby="colour-key-heading">
      <h2 id="colour-key-heading" className="panel-heading">
        Wavelengths
      </h2>
      <p className="panel-intro">
        {active
          ? `Showing ${active.band} alone, in greyscale: brighter means more light at ${active.wavelength}.`
          : 'Each visible colour stands in for an infrared wavelength SPHEREx measured.'}
      </p>
      {active && (
        <div className="colour-key__ramp" aria-hidden="true">
          <span className="colour-key__ramp-bar" />
          <span className="colour-key__ramp-labels">
            <span>Faint</span>
            <span>Bright</span>
          </span>
        </div>
      )}

      {entries.length > 0 && (
        <div className="colour-key__switcher">
          <p className="label" id="band-switcher-label">
            Show
          </p>
          <div className="colour-key__options" role="group" aria-labelledby="band-switcher-label">
            {options.map((o) => (
              <button
                key={o.label}
                type="button"
                className="colour-key__option"
                aria-pressed={band === o.id}
                disabled={!bandsAvailable && o.id !== null}
                onClick={() => onBandChange(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="colour-key__hint">
            {bandsAvailable
              ? 'See what each detector recorded on its own.'
              : 'Single detectors are only available for real SPHEREx targets.'}
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <ul className={`colour-key__list${active ? ' colour-key__list--single' : ''}`}>
          {entries.map((entry) => {
            const isActive = active?.band === entry.band
            const content = (
              <>
                <span
                  className="colour-key__dot"
                  // In single-band mode the image is grey, so the dots drop their colour too.
                  style={active ? undefined : { background: entry.colour }}
                  aria-hidden="true"
                />
                <span className="colour-key__label">{entry.label}</span>
                <span className="colour-key__wavelength data">{entry.wavelength}</span>
              </>
            )
            return (
              <li
                key={entry.band}
                className={`colour-key__row${isActive ? ' colour-key__row--active' : ''}`}
              >
                {/* The other bands become shortcuts while one band is showing */}
                {active && !isActive ? (
                  <button
                    type="button"
                    className="colour-key__row-button"
                    aria-label={`Show ${entry.band} alone`}
                    onClick={() => onBandChange(entry.band)}
                  >
                    {content}
                  </button>
                ) : (
                  content
                )}
              </li>
            )
          })}
        </ul>
      )}

      {active ? (
        <div className="colour-key__note">
          <h3 className="label">Why look at one band?</h3>
          <p>
            Different things shine at different wavelengths. Stars are brightest in the short bands;
            cool brown dwarfs and warm dust glow in the long ones. Switch between {shortest} and{' '}
            {longest} to see what changes.
          </p>
        </div>
      ) : (
        <div className="colour-key__note">
          <h3 className="label">Why false colour?</h3>
          <p>
            SPHEREx sees infrared light, which human eyes can’t, so each band is shown as a colour
            we can see. A spot that looks amber is brightest at the longest wavelengths, often warm
            dust.
          </p>
        </div>
      )}
    </section>
  )
}
