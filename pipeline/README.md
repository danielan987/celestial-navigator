# SPHEREx pipeline

Turns real SPHEREx images from NASA/IPAC's IRSA archive into the files the app shows.
For one target it finds every exposure in detectors D1, D3 and D6, downloads cutouts,
groups them into passes, lines them up north-up and writes one colour PNG per pass.

## Setup (once)

Python 3.9 or newer.

```bash
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r pipeline/requirements.txt
```

## Run a target

The target must be in `src/api/mock/targets.json`. From the project root:

```bash
pipeline/.venv/bin/python pipeline/run.py m45
```

It takes about 5–10 minutes and downloads 0.6–0.8 GB. Steps, which can also run one at
a time with the same argument:

| Script        | Does                                           | Writes (in `pipeline/data/<id>/`)                           |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `query.py`    | asks IRSA which exposures cover the target     | `query.json`                                                |
| `download.py` | downloads cutouts, 8 at a time, with retries   | `cutouts/*.fits`, `cutouts.json`                            |
| `process.py`  | groups passes, reprojects, combines, stretches | `out/` PNGs and `meta.json`                                 |
| `to_app.py`   | copies colour PNGs into the app                | `public/mock/images/<id>/`, `src/api/mock/passes/<id>.json` |

If IRSA's query (TAP) service is down, `query.py` falls back to its image-search (SIA)
service automatically. SIA only lists Data Release 1 images, so a target may get fewer
passes than with TAP; rerun later to pick up the newer quick-release passes.

`run.py` reruns `download.py` until every file is fetched, since IRSA refuses a few
requests (HTTP 503) on most runs. Files already downloaded are skipped.

To rebuild the preview report with every processed target:

```bash
pipeline/.venv/bin/python pipeline/build_report.py
```

It writes `pipeline/data/report.html`, a single file with all images embedded.

## Scout first

Before processing a new spot, see what SPHEREx has there. It takes about a second per spot
and downloads nothing:

```bash
pipeline/.venv/bin/python pipeline/scout.py rdra barnard
pipeline/.venv/bin/python pipeline/scout.py --at 270 66.56 "North ecliptic pole"
```

For each spot it prints the image counts per detector, how the images group into passes
(dates, counts, which bands), the download size, and warnings: missing bands, very long
or very many visits, cutouts that run off an image edge, a bright planet or the Moon nearby,
the asteroid band, the Milky Way, the celestial poles and the 0h/24h line. Each warning is
an assumption the pipeline or app makes that this spot might break.

## Any spot, and the on-demand backend

Any position works, not just targets in `targets.json`:

```bash
pipeline/.venv/bin/python pipeline/run.py --ra 161.25 --dec 58
```

It runs as `spot_161.2500_58.0000`, keeps at most 8 exposures per detector per pass (about
190 MB, 1.5–2 minutes), works in `pipeline/data/spots/<id>/` and writes the plates and
`passes.json` to `pipeline/data/media/<id>/`, never into the app's bundled mock data.

The backend runs this for the app whenever someone types coordinates that aren't a built-in
target:

```bash
pipeline/.venv/bin/python pipeline/server.py
```

Then `npm run dev` in another terminal. It listens on port 8000, which the Vite dev server
already forwards `/api` and `/media` to. Each spot's log is
`pipeline/data/spots/<id>/log.txt`. Endpoints, rules and limits are in
[../docs/backend-notes.md](../docs/backend-notes.md#on-demand-backend-any-coordinates-built).

## Settings

All in `config.py`: detectors and colours, the 0.1° field, the 0.15° request size, the
30-day gap between passes, and per-target stretch overrides (the Crab needs a gentler
one). See [../docs/spherex-findings.md](../docs/spherex-findings.md) for why.

## Disk space

`pipeline/data/` is git-ignored. Raw cutouts are only needed to reprocess; once a target
is in the app, its `cutouts/` folder can be deleted and re-downloaded later if needed.
