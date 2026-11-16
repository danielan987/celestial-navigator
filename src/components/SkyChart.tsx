import { useState, type ReactNode } from 'react'
import type { Target } from '../api/types'
import {
  eclipticLatitude,
  eclipticToEquatorial,
  galacticPlaneToEquatorial,
  hammer,
} from '../utils/sky'
import { toRoman } from '../utils/coords'
import type { BodyId, BodyPosition } from '../utils/planets'
import PlanetIcon, { PlanetIconDefs } from './PlanetIcon'
import './SkyChart.css'

type Props = {
  targets: Target[]
  selectedTarget: Target | null
  bodies: BodyPosition[] // Sun, Moon and planets for the chosen date
  footer?: ReactNode // extra controls shown in the key row (the planet date)
  spot?: { ra: number; dec: number } | null // typed coordinates, marked with a crosshair
  onSelect: (id: string) => void
}

// The sky is a 200 × 100 ellipse (the Hammer projection is exactly 2:1), drawn inside an
// engraved frame. PAD is the room around it for the frame, in the same units.
const PAD_X = 16
const PAD_Y = 13
const VIEW_W = 200 + 2 * PAD_X
const VIEW_H = 100 + 2 * PAD_Y

const toBox = (ra: number, dec: number) => {
  const { x, y } = hammer(ra, dec)
  return [100 + 100 * x, 50 - 50 * y] as const
}
// Position as a percentage of the whole framed chart, for HTML overlays
const toPercent = (ra: number, dec: number) => {
  const [x, y] = toBox(ra, dec)
  return { left: ((x + PAD_X) / VIEW_W) * 100, top: ((y + PAD_Y) / VIEW_H) * 100 }
}

const steps = (from: number, to: number, n: number) =>
  Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n)

// SVG path through [ra, dec] points, lifting the pen where a line wraps off one edge onto the other.
function path(points: (readonly [number, number])[]) {
  let d = ''
  let prevX: number | null = null
  for (const [ra, dec] of points) {
    const [x, y] = toBox(ra, dec)
    d += `${prevX === null || Math.abs(x - prevX) > 50 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
    prevX = x
  }
  return d
}

const EDGE = 0.01 // keep lines just inside RA 0h/24h so they don't wrap
const PARALLELS = [-60, -30, 30, 60].map((dec) =>
  path(steps(EDGE, 360 - EDGE, 120).map((ra) => [ra, dec])),
)
const EQUATOR = path(steps(EDGE, 360 - EDGE, 120).map((ra) => [ra, 0]))
const MERIDIANS = steps(30, 330, 10).map((ra) => path(steps(-89.9, 89.9, 60).map((d) => [ra, d])))
const ECLIPTIC = path(steps(0, 360, 180).map((lon) => eclipticToEquatorial(lon, 0)))
const MILKY_WAY = path(steps(0, 360, 180).map((l) => galacticPlaneToEquatorial(l)))
// ±10° of the ecliptic is about 12.3 box units tall at the centre of the chart
const BAND_WIDTH = 12.3

// The rim of the oval is the 0h/24h meridian, so ticks along it mark declination, every 10°.
const RIM_TICKS = steps(-80, 80, 16).flatMap((dec) =>
  [EDGE, 360 - EDGE].map((ra) => {
    const [x, y] = toBox(ra, dec)
    // outward normal of the ellipse at (x, y)
    const nx = (x - 100) / 100 ** 2
    const ny = (y - 50) / 50 ** 2
    const len = Math.hypot(nx, ny)
    const major = dec % 30 === 0
    const t = major ? 4.5 : 2.5
    return { x1: x, y1: y, x2: x + (nx / len) * t, y2: y + (ny / len) * t, major }
  }),
)

// A fixed scatter of faint background stars (seeded, so it never changes between renders)
const BACKGROUND_STARS = (() => {
  let seed = 1930
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  return Array.from({ length: 260 }, () => {
    const ra = rand() * 360
    const dec = (Math.asin(rand() * 2 - 1) * 180) / Math.PI // uniform on the sphere
    const [x, y] = toBox(ra, dec)
    return { x, y, r: 0.12 + rand() ** 3 * 0.45, o: 0.25 + rand() * 0.5 }
  })
})()

// Hours along the equator, as Roman numerals, chosen to sit clear of the current targets
const HOUR_LABELS = [21, 15, 9, 3].map((h) => ({ text: toRoman(h), ...toPercent(h * 15, 0) }))
// A clear stretch of the Milky Way, away from the rim, the numerals and the targets
const MILKY_WAY_LABEL = toPercent(...galacticPlaneToEquatorial(60))

// Drawing order: big icons first, so a small planet in conjunction stays visible on top
const DRAW_ORDER: BodyId[] = [
  'sun',
  'jupiter',
  'saturn',
  'moon',
  'venus',
  'uranus',
  'neptune',
  'mars',
  'mercury',
]

const describeLatitude = (lat: number) =>
  Math.abs(lat) < 0.5
    ? 'on the ecliptic'
    : `${Math.abs(lat).toFixed(0)}° ${lat > 0 ? 'north' : 'south'} of the ecliptic`

// Small gilt flourish for the corners of the frame (drawn for the top-left; mirrored with CSS)
function Flourish({ className }: { className: string }) {
  return (
    <svg className={`sky-chart__flourish ${className}`} viewBox="-3 -3 44 44" aria-hidden="true">
      <path d="M2 38 V14 Q2 2 14 2 H38" />
      <path d="M7 38 V16 Q7 7 16 7 H38" />
      <path d="M12 20 Q12 12 20 12" />
      <path className="sky-chart__flourish-gem" d="M2 -2 L6 2 L2 6 L-2 2 Z" />
    </svg>
  )
}

export default function SkyChart({
  targets,
  selectedTarget,
  bodies,
  footer,
  spot,
  onSelect,
}: Props) {
  const spotAt = spot ? toPercent(spot.ra, spot.dec) : null
  // The planet under the pointer. Its name tag is drawn on a layer above the targets, so a
  // nearby target star can't cover it (the planet itself stays beneath the targets).
  const [hoveredBody, setHoveredBody] = useState<BodyId | null>(null)
  const placed = targets.map((t) => ({ target: t, ...toPercent(t.ra, t.dec) }))
  const placedBodies = bodies
    .map((b) => ({ body: b, ...toPercent(b.ra, b.dec) }))
    .sort((a, b) => DRAW_ORDER.indexOf(a.body.id) - DRAW_ORDER.indexOf(b.body.id))
  const crowdedTarget = (left: number, top: number) =>
    placed.some((o) => o.left > left && o.left - left < 8 && Math.abs(o.top - top) < 7)

  return (
    <figure className="sky-chart">
      <div className="sky-chart__map">
        <svg
          className="sky-chart__svg"
          viewBox={`${-PAD_X} ${-PAD_Y} ${VIEW_W} ${VIEW_H}`}
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="sky-chart-sky">
              <stop offset="0%" stopColor="var(--sky-inner)" />
              <stop offset="100%" stopColor="var(--sky-outer)" />
            </radialGradient>
            {/* warm light catching the inside of the rim, like lamplight in a dome */}
            <radialGradient id="sky-chart-rim-light">
              <stop offset="78%" stopColor="rgba(227, 200, 138, 0)" />
              <stop offset="100%" stopColor="rgba(227, 200, 138, 0.16)" />
            </radialGradient>
            <clipPath id="sky-chart-clip">
              <ellipse cx="100" cy="50" rx="100" ry="50" />
            </clipPath>
          </defs>

          {/* Engraved frame: two gilt rims with a band of declination ticks between them */}
          <ellipse className="sky-chart__frame-band" cx="100" cy="50" rx="106" ry="55.5" />
          <ellipse
            className="sky-chart__frame-line sky-chart__frame-line--outer"
            cx="100"
            cy="50"
            rx="108.5"
            ry="58"
            vectorEffect="non-scaling-stroke"
          />
          <ellipse
            className="sky-chart__frame-line"
            cx="100"
            cy="50"
            rx="106"
            ry="55.5"
            vectorEffect="non-scaling-stroke"
          />

          <ellipse cx="100" cy="50" rx="100" ry="50" fill="url(#sky-chart-sky)" />
          <g clipPath="url(#sky-chart-clip)" fill="none">
            {BACKGROUND_STARS.map((s, i) => (
              <circle
                key={i}
                className="sky-chart__bg-star"
                cx={s.x}
                cy={s.y}
                r={s.r}
                opacity={s.o}
              />
            ))}
            <path className="sky-chart__band" d={ECLIPTIC} strokeWidth={BAND_WIDTH} />
            {[...PARALLELS, ...MERIDIANS].map((d, i) => (
              <path key={i} className="sky-chart__grid" d={d} vectorEffect="non-scaling-stroke" />
            ))}
            <path className="sky-chart__equator" d={EQUATOR} vectorEffect="non-scaling-stroke" />
            <path
              className="sky-chart__milky-way"
              d={MILKY_WAY}
              vectorEffect="non-scaling-stroke"
            />
            <path className="sky-chart__ecliptic" d={ECLIPTIC} vectorEffect="non-scaling-stroke" />
            <ellipse cx="100" cy="50" rx="100" ry="50" fill="url(#sky-chart-rim-light)" />
          </g>
          {RIM_TICKS.map((t, i) => (
            <line
              key={i}
              className={`sky-chart__tick${t.major ? ' sky-chart__tick--major' : ''}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <ellipse
            className="sky-chart__outline"
            cx="100"
            cy="50"
            rx="100"
            ry="50"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <Flourish className="sky-chart__flourish--tl" />
        <Flourish className="sky-chart__flourish--tr" />
        <Flourish className="sky-chart__flourish--bl" />
        <Flourish className="sky-chart__flourish--br" />

        <div className="sky-chart__labels" aria-hidden="true">
          {HOUR_LABELS.map((l) => (
            <span
              key={l.text}
              className="sky-chart__hour"
              style={{ left: `${l.left}%`, top: `${l.top}%` }}
            >
              {l.text}
            </span>
          ))}
          <span
            className="sky-chart__curve-label"
            style={{ left: `${MILKY_WAY_LABEL.left}%`, top: `${MILKY_WAY_LABEL.top}%` }}
          >
            Milky Way
          </span>
        </div>

        <PlanetIconDefs />
        {/* Planets sit under the target stars, so a click on a target always wins */}
        <div className="sky-chart__bodies">
          {placedBodies.map(({ body, left, top }) => {
            // Names show on hover; near the right edge they open to the left.
            // Known issue (to fix later): when two planets overlap (a conjunction, e.g. Mars
            // in front of Jupiter), hovering the big one enlarges it over the small one, and
            // the small one is hard to point at.
            return (
              <span
                key={body.id}
                className="sky-chart__body"
                style={{ left: `${left}%`, top: `${top}%` }}
                role="img"
                aria-label={body.name}
                onMouseEnter={() => setHoveredBody(body.id)}
                onMouseLeave={() => setHoveredBody((h) => (h === body.id ? null : h))}
              >
                <PlanetIcon id={body.id} />
              </span>
            )
          })}
        </div>

        {spotAt && (
          <span
            className="sky-chart__spot"
            style={{ left: `${spotAt.left}%`, top: `${spotAt.top}%` }}
            role="img"
            aria-label="Your coordinates"
          >
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <circle cx="16" cy="16" r="7" />
              <path d="M16 2 V10 M16 22 V30 M2 16 H10 M22 16 H30" />
            </svg>
          </span>
        )}

        <div className="sky-chart__targets" role="group" aria-label="Targets on the sky chart">
          {placed.map(({ target, left, top }) => {
            // Put the name above if another target sits close by on the right (M101 and M51, M1 and M45).
            const crowded = crowdedTarget(left, top)
            const selected = target.id === selectedTarget?.id
            const lat = eclipticLatitude(target.ra, target.dec)
            return (
              <button
                key={target.id}
                type="button"
                className={`sky-chart__target${crowded ? ' sky-chart__target--label-above' : ''}`}
                style={{ left: `${left}%`, top: `${top}%` }}
                aria-pressed={selected}
                aria-label={`${target.messier} · ${target.name}, ${describeLatitude(lat)}`}
                onClick={() => onSelect(target.id)}
              >
                <span className="sky-chart__dot" aria-hidden="true" />
                <span className="sky-chart__name" aria-hidden="true">
                  {target.name}
                </span>
              </button>
            )
          })}
        </div>

        {/* Name tag for the hovered planet, above everything; near the right edge it opens left */}
        {placedBodies
          .filter(({ body }) => body.id === hoveredBody)
          .map(({ body, left, top }) => (
            <div key={body.id} className="sky-chart__tips" aria-hidden="true">
              <span
                className={`sky-chart__body-name${left > 80 ? ' sky-chart__body-name--left' : ''}`}
                style={{ left: `${left}%`, top: `${top}%` }}
              >
                {body.name}
              </span>
            </div>
          ))}
      </div>

      <figcaption className="sky-chart__caption">
        <span className="label">Key</span>
        <span className="sky-chart__key">
          <span className="sky-chart__swatch sky-chart__swatch--band" aria-hidden="true" />
          Ecliptic: where planets and asteroids travel
        </span>
        <span className="sky-chart__key">
          <span className="sky-chart__swatch sky-chart__swatch--milky-way" aria-hidden="true" />
          Milky Way: our galaxy's crowded disc
        </span>
        <span className="sky-chart__hint">Point at a star or planet to see its name</span>
        {footer}
      </figcaption>
    </figure>
  )
}
