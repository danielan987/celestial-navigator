# Celestial Navigator

A blink comparator for the NASA "Planet X and SPHEREx" hackathon challenge. Pick a target
on a sky chart, then step or play through every SPHEREx pass over that spot and look for
anything that moves. It's the modern version of the comparator Clyde Tombaugh used to
find Pluto in 1930.

**Live preview of the real data:** https://claude.ai/artifact/2TJEFE59zmsWqwEuHHUH75
(a one-page report built by `pipeline/build_report.py`, shared by link).

## Status at a glance

| Part               | State                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Front end (`src/`) | Working MVP: sky chart picker, sky plate, timeline with play, band switcher, observation log                                     |
| Real SPHEREx data  | M101, M104, M45, M1, M16, made by `pipeline/` and served as mock JSON                                                            |
| Simulated targets  | M31, M42, M51: placeholder images, marked "Simulated" in the app                                                                 |
| Django backend     | Not started in this repo. The contract is in `src/api/types.ts`; the how-to is in [docs/backend-notes.md](docs/backend-notes.md) |
| Mover detection    | Not built. Real targets show "No movers flagged here yet"                                                                        |

The saved working version is tagged **`v0.1-mvp`**. Try new ideas on a branch (see
[Working on it](#working-on-it)).

## What a user can do

- **Pick a target** from the dropdown or by clicking a star on the whole-sky chart. The
  chart shows the ecliptic (where planets and asteroids travel) and the Milky Way.
- **Blink the passes.** Each pass is SPHEREx's look at that spot, about six months apart.
  Step with ◀ ▶, the arrow keys, or press Play.
- **Switch bands.** Show the colour image or one infrared detector alone (D1 ~0.9 µm,
  D3 ~2.0 µm, D6 ~4.7 µm). Try D1 then D6 on M16: the Pillars of Creation appear.
- **Read the readouts:** RA/Dec, distance from the ecliptic, passes on file.
- **Enter coordinates** on the dome, in degrees (`269.446 +4.768`) or hours/degrees
  (`08h55m10.831s -7d14m42.53s`). Within 0.1° of a target opens it; anywhere else is
  marked on the chart as an uncharted spot until the backend can process it.
- **Share a view.** The address bar follows what's on screen: `?target=m45` or
  `?ra=133.79513&dec=-7.24515`. Opening such a link goes straight to the plate.
- **Watch the planets.** The Sun, Moon and planets sit on the chart for any date since
  launch; press Play to see them move along the ecliptic.

## Quick start

Needs Node 20.19 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. It runs entirely on the data in `src/api/mock/`, no backend
needed.

| Command          | What it does                                 |
| ---------------- | -------------------------------------------- |
| `npm run dev`    | dev server                                   |
| `npm test`       | unit tests (Vitest)                          |
| `npm run build`  | type-check and production build into `dist/` |
| `npm run lint`   | oxlint                                       |
| `npm run format` | Prettier                                     |
| `npm run mocks`  | regenerate the simulated placeholder SVGs    |

To process real SPHEREx data you also need Python 3.9+; see
[pipeline/README.md](pipeline/README.md).

### Every feature (three terminals)

The charted targets, Blink and Difference work with `npm run dev` alone. Two local Python
services add the rest:

| Service                      | Adds                                               | Start it with                                  |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| On-demand backend, port 8000 | fetching any RA/Dec ("Uncharted spot")             | `pipeline/.venv/bin/python pipeline/server.py` |
| Science service, port 8001   | the Spectral view (all light, carbon and ice maps) | `.venv-science/bin/python science/server.py`   |

One-time setup for each is in [docs/backend-notes.md](docs/backend-notes.md). Vite forwards
`/api`, `/media` and `/science` to them; without them the app says so and carries on.

## How it fits together

```
IRSA archive (NASA/IPAC)
   │  ADQL query + FITS cutouts, ~4 MB each, ~170 per target
   ▼
pipeline/  (Python)          group into passes → align north-up → combine → stretch → PNG
   │  writes public/mock/images/<id>/*.png and src/api/mock/passes/<id>.json
   ▼
src/api/client.ts            VITE_USE_MOCKS=true  → reads src/api/mock/
   │                         VITE_USE_MOCKS=false → GET /api/... from Django
   ▼
src/hooks/useExplorer.ts     all app state
   ▼
src/components/              what you see
```

The backend's job is to replace the middle step: do what `pipeline/` does ahead of time
and serve the same JSON shapes. Nothing in the front end changes except `.env`.

### The data contract

Defined in [`src/api/types.ts`](src/api/types.ts), with real examples in `src/api/mock/`.

```
GET /api/targets              -> Target[]          id, messier, name, kind, ra, dec
GET /api/targets/:id/passes   -> PassesResponse    passes[] (label, date, imageUrl,
                                                   bandImageUrls, short), candidates[]
GET /api/colour-key           -> ColourKeyEntry[]  band, colour, label, wavelength
```

If you change the contract, update `types.ts`, the mock JSON, `pipeline/to_app.py` and
`docs/backend-notes.md` together.

## Code tour

| File                                        | What it does                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/App.tsx`                               | page layout; works out the active band and preloads images                   |
| `src/hooks/useExplorer.ts`                  | the only state: targets, selection, passes, pass index, play loop, band      |
| `src/api/client.ts`                         | mock/real switch, fetch helpers, image URL resolving                         |
| `src/components/TargetBar.tsx`              | dropdown, readouts, and the `SkyChart`                                       |
| `src/components/SkyChart.tsx`               | whole-sky Hammer projection with ecliptic, Milky Way and clickable targets   |
| `src/components/SkyPlate.tsx`               | the image, overlays (grid, compass, scale bar, badges) and candidate markers |
| `src/components/TimelinePanel.tsx`          | pass list, ◀ Play ▶, arrow keys                                              |
| `src/components/ColourKeyPanel.tsx`         | band switcher and colour key                                                 |
| `src/components/PlateCaption.tsx`           | the caption and data line under the plate                                    |
| `src/components/ObservationLog.tsx`         | candidate table                                                              |
| `src/utils/sky.ts`, `coords.ts`, `bands.ts` | sky maths, coordinate formatting, band image lookup (all tested)             |
| `src/styles/tokens.css`                     | colours, fonts and spacing; change the look here first                       |
| `pipeline/`                                 | IRSA query → download → process → app files, plus the preview report         |

Conventions: strict TypeScript, plain CSS with tokens (no UI library), one CSS file per
component, Prettier and oxlint must pass, and pure logic goes in `src/utils/` with tests.

## Handoff notes

### For the backend

Start with [docs/backend-notes.md](docs/backend-notes.md). In short:

1. Wrap `pipeline/run.py` (or port its steps) in a Django management command that
   processes a target ahead of time and stores the PNGs under `MEDIA_ROOT`.
2. Serve the three endpoints above from stored results. **Never call IRSA during a page
   request**: the query takes up to a minute and some downloads fail every run.
3. Point the front end at it: `VITE_USE_MOCKS=false` in `.env`, Django on port 8000,
   restart `npm run dev`. The Vite proxy forwards `/api` and `/media`, so no CORS in dev.

### Decisions already made

- Detectors **D1, D3, D6**; colours blue / cream / amber (colour-blind friendly).
- Square 0.1° field, requested at **0.15°** so rotated corners stay filled.
- Passes split at gaps of more than 30 days; under 20 exposures or 3 days is a
  **short visit**.
- One stretch per target across all passes, so brightness doesn't flicker.

### Things that will trip you up

- **IRSA returns HTTP 503 on a few downloads most runs.** `run.py` retries; just rerun.
- **Raw data is big**: 0.6–0.8 GB per target. `pipeline/data/` is git-ignored.
- **Medians hide fast movers**, and plain difference images flag every bright star. See
  [docs/spherex-findings.md](docs/spherex-findings.md) before building mover detection.
- **Real images are 116 px across.** They look soft when enlarged; that's the true
  resolution, not a bug.

### What's next

- Design pass: landing page with the sky chart as an observatory dome, a short story
  section, less text (ideas in progress, to be tried on a branch).
- Flip through single exposures within a pass (where asteroids actually show up).
- Known-asteroid demo: cut out the sky where e.g. Vesta was, for a guaranteed mover.
- Process M31, M42 and M51 so every target is real.
- Finish the accessibility and responsive pass (`plan.md` task 10).

## Working on it

- `main` is always the working version. `v0.1-mvp` marks the first complete MVP.
- Try ideas on a branch: `git switch -c design-experiments`. Merge it if it works,
  delete it if it doesn't.
- Before committing: `npm test && npm run build && npm run lint`.

## More docs

- [docs/backend-notes.md](docs/backend-notes.md): building the backend, step by step
- [docs/spherex-findings.md](docs/spherex-findings.md): what the real data taught us
- [pipeline/README.md](pipeline/README.md): running the Python pipeline
- [plan.md](plan.md): the original front-end plan and task list
- `docs/reference/`: the IRSA notebook the query came from
