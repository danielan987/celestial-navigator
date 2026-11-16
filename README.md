# Celestial Navigator

A blink comparator for the NASA Space Apps "Planet X and SPHEREx" challenge. Pick a star
on a sky chart or type any coordinates, then step through every pass SPHEREx made over
that patch of sky and look for anything that moves or changes brightness. It's the
modern version of the comparator Clyde Tombaugh used to find Pluto in 1930.

**Preview report of the real data:** https://claude.ai/artifact/2TJEFE59zmsWqwEuHHUH75
(a one-page report built by `pipeline/build_report.py`).

## What you can do

- **Pick a target** from the dropdown or by clicking a star on the whole-sky chart. The
  chart shows the ecliptic (where planets and asteroids travel), the Milky Way, and the
  Sun, Moon and planets for any date since launch (press Play to watch them move).
- **Enter coordinates** in degrees (`269.446 +4.768`) or hours/degrees
  (`08h55m10.831s -7d14m42.53s`). Within 0.1° of a built-in target opens that target;
  anywhere else opens an **uncharted spot**, which the on-demand backend can fetch from
  NASA's archive in about two minutes.
- **Blink** the passes. Each pass is SPHEREx's look at that spot, about six months apart.
  Step with ◀ ▶ or the arrow keys, or press Play. Show the colour image or one detector
  alone (D1 ~0.9 µm, D3 ~2.0 µm, D6 ~4.7 µm). Try D1 then D6 on M16: the Pillars of
  Creation appear.
- **Difference**: pick two passes and a detector to subtract them. Things that stayed put
  cancel to black; a mover shows as amber (before) next to blue (after).
- **Spectral**: maps from SPHEREx's 102-colour all-sky cube: all light, plus carbon
  particles (PAH), water ice, CO₂ ice and CO ice.
- **Share a view.** The address bar follows what's on screen (`?target=m45` or
  `?ra=133.79513&dec=-7.24515`), so a link opens straight to that plate.

## Targets

All 19 built-in targets are bundled with the app, so they work with no backend.

All use real SPHEREx data.

- **Challenge test targets:** Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae,
  R Draconis
- **Showcase:** Kapteyn's Star, Luhman 16, M101, M104, M45 Pleiades, M1 Crab Nebula,
  M16 Pillars of Creation, Horsehead Nebula, Rho Ophiuchi Cloud, Tarantula Nebula,
  M57 Ring Nebula, Galactic Centre, Omega Centauri, M51 Whirlpool Galaxy

## Quick start (front end only)

Needs Node 20.19 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. Every built-in target, Blink and Difference work with just
this; the data is in `src/api/mock/` and `public/mock/images/`.

## Running everything (three terminals)

Two local Python services add the rest. Without them the app says what's missing and
carries on.

| Service                      | Adds                                  | Needs                         |
| ---------------------------- | ------------------------------------- | ----------------------------- |
| On-demand backend, port 8000 | fetching any RA/Dec (uncharted spots) | Python 3.9+, `pipeline/.venv` |
| Science service, port 8001   | the Spectral view                     | Python 3.9+, `.venv-science`  |

**Setup (once), from the project root:**

```bash
python3 -m venv pipeline/.venv
```

```bash
pipeline/.venv/bin/pip install -r pipeline/requirements.txt
```

```bash
python3 -m venv .venv-science
```

```bash
.venv-science/bin/pip install -r science/requirements-py39.txt
```

Use `science/requirements-py39.txt` on Python 3.9 (the macOS system Python), or
`science/requirements.txt` on Python 3.11 or newer.

**Run, each in its own terminal:**

```bash
npm run dev
```

```bash
pipeline/.venv/bin/python pipeline/server.py
```

```bash
.venv-science/bin/python science/server.py
```

The Vite dev server forwards `/api` and `/media` to port 8000 and `/science` to port 8001,
so there's no CORS setup. The first Spectral request for a place takes 30–60 s; after that
it's cached.

## Commands

| Command          | What it does                                 |
| ---------------- | -------------------------------------------- |
| `npm run dev`    | dev server on port 5173                      |
| `npm test`       | unit tests (Vitest)                          |
| `npm run build`  | type-check and production build into `dist/` |
| `npm run lint`   | oxlint                                       |
| `npm run format` | Prettier                                     |

Processing a new built-in target, scouting a spot's coverage and rebuilding the preview
report are covered in [pipeline/README.md](pipeline/README.md).

## How it fits together

```
IRSA archive (NASA/IPAC)
   │  FITS cutouts per exposure, detectors D1, D3, D6
   ▼
pipeline/  (Python)       group into passes → align north-up → combine → stretch → PNG
   │                      built-in targets: run ahead of time into src/api/mock/ and public/mock/
   │                      uncharted spots: pipeline/server.py runs it on request (port 8000)
   ▼
src/api/client.ts         loads targets and passes (bundled mock data, or /api)
src/api/science.ts        loads spectral maps from science/server.py (port 8001,
   │                      SPHEREx all-sky cube, 102 channels)
   ▼
src/hooks/useExplorer.ts  app state: targets, selection, passes, pass index, play, band
   ▼
src/components/           what you see
```

The data shapes are defined in [`src/api/types.ts`](src/api/types.ts), with real examples
in `src/api/mock/`:

```
GET /api/targets              -> Target[]          id, messier, name, kind, ra, dec
GET /api/targets/:id/passes   -> PassesResponse    passes[] (label, date, imageUrl,
                                                   bandImageUrls, short), candidates[]
GET /api/colour-key           -> ColourKeyEntry[]  band, colour, label, wavelength
```

The built-in targets read these from the bundled files (`VITE_USE_MOCKS=true` in `.env`);
set it to `false` to fetch them from a backend instead. The on-demand backend's endpoints
(`/api/status`, `/api/scout`, `/api/passes?ra=&dec=`) and the science service's
(`/science/extract`) are documented in [docs/backend-notes.md](docs/backend-notes.md).

If you change a shape, update `types.ts`, the mock JSON, `pipeline/to_app.py` and
`docs/backend-notes.md` together.

## Code tour

| Path                                 | What it does                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `src/App.tsx`                        | page layout; picks the active view and band, preloads images                          |
| `src/hooks/useExplorer.ts`           | the main state: targets, selection, passes, pass index, play loop, band               |
| `src/hooks/useUrlState.ts`           | keeps `?target=` / `?ra=&dec=` in sync with the screen                                |
| `src/api/client.ts`                  | mock/real switch, fetch helpers, image URL resolving                                  |
| `src/components/DomeHero.tsx`        | landing dome: sky chart, coordinate entry, planets date slider                        |
| `src/components/SkyChart.tsx`        | whole-sky Hammer projection with ecliptic, Milky Way, planets and targets             |
| `src/components/UnchartedSpot.tsx`   | scout and fetch flow for coordinates that aren't a built-in target                    |
| `src/components/SkyPlate.tsx`        | the image, overlays (grid, compass, scale bar, badges) and candidate marks            |
| `src/components/ViewSwitch.tsx`      | Blink · Difference · Spectral                                                         |
| `src/components/TimelinePanel.tsx`   | pass list, ◀ Play ▶, arrow keys                                                       |
| `src/components/DifferencePanel.tsx` | choose two passes and a detector to subtract                                          |
| `src/components/SpectralPanel.tsx`   | choose a spectral map; explanation and legend                                         |
| `src/components/StorySection.tsx`    | the short story cards below the instrument                                            |
| `src/utils/`                         | pure logic with tests: sky maths, coordinates, planets, differences, spectral drawing |
| `src/styles/tokens.css`              | colours, fonts and spacing; change the look here first                                |
| `pipeline/`                          | IRSA query → download → process → app files; scout; on-demand server; report          |
| `science/`                           | science service: spectral and molecule maps from the all-sky cube                     |

Conventions: strict TypeScript, plain CSS with tokens (no UI library), one CSS file per
component, Prettier and oxlint must pass, pure logic goes in `src/utils/` with tests.
Before committing: `npm test && npm run build && npm run lint`.

## Decisions and gotchas

- Detectors **D1, D3, D6**, coloured blue / cream / amber (colour-blind friendly).
- Square 0.1° field, requested at **0.15°** so rotated corners stay filled.
- Passes split at gaps of more than 30 days; under 20 exposures or 3 days is a
  **short visit**. One brightness stretch per target, so passes don't flicker.
- **Real images are 116 px across.** They look soft enlarged; that's SPHEREx's true
  resolution, not a bug.
- **IRSA refuses a few downloads (HTTP 503) most runs.** The pipeline retries; rerun if
  needed. Raw data is 0.6–0.8 GB per target and lives in git-ignored `pipeline/data/`.
- **Never call IRSA's slow query during a page request** for built-in targets; process
  them ahead of time. Uncharted spots run as background jobs the app polls.
- **Spectral maps can't change between passes**: the all-sky cube stacks every visit.

## Known limits and what's next

- **No automatic mover detection yet.** Medians hide fast movers, and plain differences
  flag every bright star; see [docs/spherex-findings.md](docs/spherex-findings.md).
- Spots near the north ecliptic pole fail: only detectors D2 and D5 are released there.
- Both Python services are local-only demos (no authentication, no disk limit).
- Ideas: flip through single exposures within a pass (where asteroids show up), a
  known-asteroid demo, overlay Gaia DR3.

## More docs

- [docs/backend-notes.md](docs/backend-notes.md): the data contract, on-demand backend
  and science service in detail
- [docs/spherex-findings.md](docs/spherex-findings.md): what the real data taught us
- [pipeline/README.md](pipeline/README.md): running the Python pipeline and scout
- [plan.md](plan.md): the original front-end plan
- `docs/reference/`: the challenge brief and the IRSA notebook the query came from
