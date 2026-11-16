# Backend notes

How the Django backend should produce the data the front end expects
(`src/api/types.ts`). `pipeline/` already does every step below as scripts, so the
backend can wrap or port it. What we learned from real data is in
[spherex-findings.md](spherex-findings.md).

## Endpoints the front end calls

```
GET /api/targets                 -> Target[]
GET /api/targets/:id/passes      -> PassesResponse
GET /api/colour-key              -> ColourKeyEntry[]
```

`src/api/mock/` holds working examples of every response. The passes files for M101,
M104, M45, M1 and M16 are real data written by `pipeline/to_app.py`.

**Do all IRSA work ahead of time** (a management command, or a job per target) and serve
cached PNGs. The API must never call IRSA while someone is waiting for a page: the query
takes up to a minute per detector and some downloads fail every run.

## Steps (what `pipeline/` does)

1. **Query** IRSA TAP once per detector, D1, D3 and D6 (`pipeline/query.py`):

   ```sql
   SELECT
       'https://irsa.ipac.caltech.edu/' || a.uri || '?center={ra},{dec}d&size=0.15' AS uri,
       p.time_bounds_lower
   FROM spherex.artifact a
   JOIN spherex.plane p ON a.planeid = p.planeid
   WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
         AND p.energy_bandpassname = 'SPHEREx-D1'
   ORDER BY p.time_bounds_lower
   ```

   One row is one exposure: a cutout URL centred on the target and its start time (MJD).
   Request **0.15°** even though the app shows 0.1°, so the corners stay filled after
   rotating north-up.

2. **Download** each cutout, 8 at a time, retrying HTTP 503s (`pipeline/download.py`).
   Record the wavelength at the target pixel from the `WCS-WAVE` layer.

3. **Process** (`pipeline/process.py`):
   - group exposures into visits by a gap of more than 30 days; a group under 20
     exposures or 3 days long is a short visit
   - subtract the `ZODI` layer, mask `FLAGS` bit 0
   - reproject onto one north-up TAN grid per target (0.1°, 116 px) with
     `reproject.reproject_interp`
   - median-combine each band within a visit, fill saturated-star holes
   - asinh-stretch with the same limits for every visit of a target
   - colour-combine D1 → #5AA0FF, D3 → #F4EFE2, D6 → #FFB000, flip vertically, save PNG

4. **Serve** (`pipeline/to_app.py` writes the mock JSON in this shape):

| Contract field                | Value                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Pass.label`                  | "Pass I", "Pass II", … or "Short visit"                                                                                                         |
| `Pass.date`                   | mean observation time of the visit, ISO 8601 (`Time(mjd, format="mjd").isot + "Z"`)                                                             |
| `Pass.imageUrl`               | the visit's colour PNG, e.g. `/media/m101/pass-1.png`                                                                                           |
| `Pass.short`                  | `true` for short visits, otherwise omit                                                                                                         |
| `Pass.bandImageUrls`          | `{ "D1": url, "D3": url, "D6": url }`: each detector alone, greyscale, same stretch as the colour image; leave a band out if the visit has none |
| `PassesResponse.fieldSizeDeg` | `0.1` (the reprojected grid, not the 0.15° request)                                                                                             |
| `PassesResponse.candidates`   | `[]` until we detect movers; positions are 0–100 % of the image                                                                                 |
| `PassesResponse.simulated`    | never set by the backend (mock placeholders only)                                                                                               |
| `ColourKeyEntry.wavelength`   | median measured wavelength per detector, e.g. "~0.9 µm"                                                                                         |
| `ColourKeyEntry.band`         | detector id, `"D1"`, matching the `bandImageUrls` keys                                                                                          |

## On-demand backend: any coordinates (built)

The challenge's core ask: type any RA/Dec and see that patch of sky as a blinkable series.
`pipeline/server.py` does it with the Python standard library and the pipeline's own
environment, no new dependencies. Built-in targets stay bundled in the front end (instant,
and they work with no backend at all); only uncharted spots use the backend.

**Run it** (two terminals, from the project root):

```bash
pipeline/.venv/bin/python pipeline/server.py
```

```bash
npm run dev
```

The Vite dev server already forwards `/api` and `/media` to port 8000. Keep
`VITE_USE_MOCKS=true`: that switch only affects the built-in targets.

**What happens when someone types new coordinates**

1. The app opens the "Uncharted spot" panel and asks `GET /api/status` (instant) whether the
   spot is processed already; if it is, the plate opens straight away.
2. It also asks `GET /api/scout` what SPHEREx has there (an IRSA image search, 1–90 s
   depending on IRSA's mood). The panel shows "Photographed 101 times · 3 visits you could
   blink between · about 2 minutes to fetch", the visits, and technical notes folded away.
   The image list is saved, so fetching doesn't have to ask IRSA again.
3. "Fetch this spot" calls `GET /api/passes`, which starts `run.py` for the spot in its own
   process and answers 202 with the stage and progress until it's done, then 200 with a
   normal `PassesResponse` whose images are under `/media/<spot id>/`.

| Endpoint                     | Answers                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`            | `{"ok": true}`                                                                                                                                              |
| `GET /api/status?ra=&dec=`   | `{"status": "none" / "processing" / "ready" / "failed", ...}`, never starts a job                                                                           |
| `GET /api/scout?ra=&dec=`    | the scout summary (`SpotScout` in `src/api/types.ts`); 503 if IRSA is down                                                                                  |
| `GET /api/passes?ra=&dec=`   | 200 `PassesResponse`, 202 `{status: "processing", stage, stageLabel, progress}`, 500 `{status: "failed", message, permanent}`; `&retry=1` retries a failure |
| `GET /media/<spot id>/*.png` | the plates                                                                                                                                                  |

**Rules:** a spot's id is its position rounded to 0.0001° (`spot_150.1000_2.2000`). At most
two spots process at once (others wait as "queued"), never the same spot twice at once.
Results are cached forever in `pipeline/data/media/<id>/` (git-ignored); delete a folder to
redo a spot. A failed spot is retried automatically after 10 minutes, or straight away with
"Try again", except permanent failures (no images in D1/D3/D6). Restarting the server
forgets running jobs; asking again restarts them.

**Speed:** a spot keeps at most 8 exposures per detector per pass (evenly spaced in time;
`SPOT_MAX_PER_BAND`), about 48 cutouts and 190 MB, so a new spot takes 1.5–2 minutes
instead of 5–10. The median of 8 is still clean. The raw samples and frame-by-frame
flipbook that `build_report.py` uses are skipped for spots.

**IRSA:** spots use IRSA's image search (SIA), retried 5 times a minute apart. Its query
service (TAP) lists newer quick-release images but takes about a minute per detector and
has been down for hours; set `SPOT_TRY_TAP=1` to try it (a failure is then remembered for
10 minutes and skipped). TAP is only used when no scout listing is saved.

**Logs:** every run appends to `pipeline/data/spots/<id>/log.txt`, the failure log to
review afterwards. A failed spot also has `failed.json` with the message the app showed.
Pipeline lines starting `!! ` are the plain-words reasons the app shows; `@@stage` and
`@@progress` lines are how the server follows progress.

**Known limits:** near the north ecliptic pole only detectors D2 and D5 have released
images, so those spots fail with a clear message (choosing detectors per spot would fix
it). Data Release 1 only (via SIA). Single machine, local only: the server listens on
127.0.0.1 and has no authentication or disk limit, fine for the demo, not for the open
internet.

## Spectral maps: the science service (built)

The Spectral view (Blink | Difference | **Spectral**) comes from Daniel's science service,
`science/server.py`, a separate local service on **port 8001**. It reads SPHEREx's Data
Release 1 all-sky cube (HiPS, 102 channels, every visit stacked) from IRSA with range reads,
and returns, for a 0.1° field on the same north-up grid as the plates:

- **All light**: the median across all channels (drawn on a logarithmic scale)
- **Molecule maps** (`science/analysis.py`): carbon particles (PAH, 3.3 µm), water ice
  (3.05 µm), CO₂ ice (4.27 µm), CO ice (4.67 µm), each against its nearby continuum; plus
  GALEX FUV (not shown in the app yet)

**Setup (once).** Its own environment, separate from the pipeline's:

```bash
python3 -m venv .venv-science
.venv-science/bin/pip install -r science/requirements-py39.txt
```

Use `science/requirements-py39.txt` on Python 3.9 (the macOS system Python);
`science/requirements.txt` (astropy 7) needs Python 3.11 or newer.

**Run.**

```bash
.venv-science/bin/python science/server.py
```

`GET /science/extract?target=<id>` (a built-in target) or `?ra=&dec=` (any spot, named
`spot_<ra>_<dec>` like the on-demand backend's), plus `&radius=30&z=0`. It answers with a
status to poll and, when ready, a manifest of lossless float64 pixel arrays
(`src/api/science.ts` loads them). The first request for a place takes 30–60 s; results are
cached outside the repository in `../work/science-cache` (override with `SCIENCE_CACHE`).

**In the app.** `src/hooks/useSpectralMap.ts` asks for the maps; `src/utils/spectral.ts` draws
them on the plate with Daniel's limits (`plotLimits.ts`) and the inferno colour scale;
`src/utils/spectralLayers.ts` holds each map's name, explanation and legend. If the service
isn't running, the Spectral panel says how to start it (in development) or that it isn't
connected (on a published site).

**Limits.** The cube combines every visit, so these maps can't change between passes (per-pass
maps would need the individual D4/D5 exposures; parked). Very bright stars are masked by
SPHEREx's quality flags and show as grey holes (R Draconis, the Orion Nebula's core). The
molecule maps are exploratory continuum ratios, not fitted detections.

## Decided

- **Detectors:** D1, D3, D6 for a wide spread across 0.75–5 µm.
- **Alignment:** reproject everything onto a shared north-up grid; candidate positions
  come from RA/Dec through that grid's WCS.
- **Images:** square PNGs, 116 px (the real resolution, scaled up by the browser).
- **Data releases:** some exposures appear twice (`l2b` and `l2b_retry`); keep one.
- **Input safety:** the ADQL is built with an f-string. Only ever fill it from our own
  target list or a spot id (`spot_<ra>_<dec>`, checked by a strict regex in
  `config.parse_spot_id`, so it can only hold numbers), never from raw user input.

## Open

- **Mover detection.** Medians remove anything that moves within a pass, and plain
  differences flag every bright star. See spherex-findings.md for what a detector needs.
- **Fast movers need today's position.** Barnard's Star, Epsilon Indi B and WISE 0855
  move arcseconds per year, so catalogue (J2000) positions are several arcminutes off.
  Propagate with proper motion (astropy `apply_space_motion`) before cutting out.

## Connecting in development

1. Run Django on `http://localhost:8000` (or set `API_PROXY_TARGET` in `.env`).
2. Set `VITE_USE_MOCKS=false` in `.env` and restart `npm run dev`.

The Vite dev server forwards `/api/*` and `/media/*` to Django, so the browser sees one
origin. **No CORS setup is needed**, and `imageUrl` can be a relative path such as
`/media/m101/pass-1.png`. Serve the PNGs under `/media/` (Django's `MEDIA_URL`), or add
another prefix to `server.proxy` in `vite.config.ts`. Trailing slashes are fine: a Django
redirect from `/api/targets` to `/api/targets/` is followed.

## Connecting a deployed build

Set `VITE_API_BASE=https://your-backend` before `npm run build`. Relative `imageUrl`
values are then resolved against that address, and Django will need CORS allowing the
front end's origin (e.g. `django-cors-headers`).
