# What the real SPHEREx data taught us

Source notebook: [docs/reference/irsa-spherex-cutouts-notebook.pdf](reference/irsa-spherex-cutouts-notebook.pdf).

Notes from processing five targets with `pipeline/` (November 2026): M101, M104, M45,
M1 and M16. Preview report: https://claude.ai/artifact/2TJEFE59zmsWqwEuHHUH75
(rebuild it with `python pipeline/build_report.py`).

## The data

| Target        | Ecliptic lat. | Cutouts (3 detectors) | Visits                               |
| ------------- | ------------- | --------------------- | ------------------------------------ |
| M101 Pinwheel | +60°          | 156                   | 3 passes                             |
| M104 Sombrero | −7°           | 187                   | 3 passes + 1 short visit             |
| M45 Pleiades  | +4°           | 166                   | 3 passes                             |
| M1 Crab       | −1°           | 161                   | 3 passes                             |
| M16 Pillars   | +10°          | 201                   | 3 passes (two spread over 6–7 weeks) |

- **Any RA/Dec has data.** SPHEREx maps the whole sky; there is no fixed target list.
- **Passes are about six months apart** and each is a cluster of 15–20 exposures per
  detector over one to three weeks. Grouping by a gap of more than 30 days works.
- **Short visits exist.** M104 has a one-day visit in February 2026 with only 10
  exposures and no D1 at all, so its colour image has no blue and looks amber. We label
  any group under 20 exposures or 3 days long "Short visit" (`Pass.short` in the contract).
- **Each detector is a gradient filter.** The wavelength at the target depends on where it
  fell on the detector: D1 ran 0.74–1.11 µm across M45's images. We show the median
  (~0.9 / ~2.0 / ~4.7 µm for D1 / D3 / D6).
- **Each cutout is ~4 MB** (seven FITS layers), so one target is 0.6–0.8 GB to download,
  but its app images are three or four PNGs of ~20 KB. Download once, process, serve PNGs.
- **IRSA is slow and flaky.** The query takes 10–90 s per detector, and 5–15 of ~170
  downloads fail with HTTP 503 on each run. Retrying a minute later fetches them.

## Barnard's Star: a real mover

- Processed from IRSA's image search (SIA) while the TAP query service was down, so it
  has only the Data Release 1 passes: August 2025 and March 2026.
- **It visibly moves.** Its centroid shifts about **6″ north** between the passes (≈2 pixels
  in our 3.1″ grid), measured in the colour and D6 images; Gaia predicts 5.9″. In D1 and D3
  the star saturates into a flat disc, so its centre can't be measured there.
- Fast movers must be cut out at today's position: its J2000 catalogue position is 4.5′ off.

## The challenge's test targets (15 Nov 2026)

All five are processed from Data Release 1 (IRSA's TAP service was down, so via SIA), each
centred on its 2026 position. Measured from unstretched per-pass medians:

| Target         | Result                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Barnard's Star | moved 6″ north in 0.57 yr (Gaia: 5.9″); saturated in D1/D3                                                                                      |
| Epsilon Indi B | moved 3.4″ east, 2.1″ south in 0.97 yr (expected 3.9″, 2.4″); amber in colour because it's cool; glare from ε Ind A (7′ away) crosses the field |
| WISE 0855      | detected only in D6 (S/N ≈ 35), too faint to see by eye in our stretch; moved 6.9″ west, 0.9″ north in 0.98 yr (expected 8.0″, 0.7″)            |
| RW Aurigae     | about a third brighter in D3 and a quarter fainter in D6 between Sep 2025 and Feb 2026                                                          |
| R Draconis     | core saturated; the glow around it doubled in D6 in the second pass, then fell back: a rough sign of its pulsation                              |

Lessons: faint, cold objects need D6 and a stretch tuned for them; saturated variables need
brightness measured from the wings, not the core; and the colour image can hide what one
band shows clearly.

## What scouting showed (`pipeline/scout.py`, 15 Nov 2026)

- **Detectors work in pairs.** D1 and D4, D2 and D5, D3 and D6 always have matching image
  counts: each pair sees the same patch of sky at the same moment, through a beam splitter.
  So D3 and D6 are taken together, but D1 is taken at a different time.
- **Away from the poles that doesn't matter**: all three pairs cross a target within the
  same few weeks. **Near the ecliptic pole it does**: R Draconis (+81°) gets a "pass" with
  only D1 and others with only D3 + D6, so their colour images are missing bands.
- **The north ecliptic pole has ~220 images, all in D2/D5 and none in D1, D3 or D6.** A
  fixed D1/D3/D6 choice shows nothing there. The tool should pick, per spot, one detector
  from the short-wave pairs and one from the long-wave pairs that actually have data.
- High ecliptic latitudes get more visits (Lockman Hole 186 images, R Draconis 208, versus
  about 115 near the ecliptic), and about 5–10% of cutouts reach past an image edge.

## Processing lessons

- **Detectors work in pairs** (D1+D4, D2+D5, D3+D6): each pair sees the same sky at the
  same moment, so D3 and D6 are taken together but D1 at a different time. Near the ecliptic
  poles one pair can cross a target weeks before another, splitting a pass (R Draconis);
  `passes.py` rejoins neighbouring visits that are complete only together.
- **Request 0.15°, show 0.1°.** The camera's orientation changes by up to half a turn
  between passes. A 0.1° cutout rotated north-up leaves empty corners; a 0.15° one
  cropped after reprojecting fills the frame.
- **Subtract the ZODI layer** (smooth zodiacal-light glow) and mask FLAGS bit 0.
- **Median-combine each band within a pass.** It removes cosmic rays and hot pixels,
  which are common in single frames (bright specks in M104's raw cutouts).
- **Use the same stretch limits for every pass of a target**, or brightness flickers
  during playback.
- **Bright, frame-filling targets need a gentler stretch.** The Crab washed out to white
  with the default; `config.STRETCH` holds per-target overrides.
- **Saturated stars leave holes.** Their cores are flagged in every exposure, so the
  median is empty. We fill each enclosed hole with one flat value (the brightest pixel on
  its rim); growing inward from the edges left dark X-shaped seams in big cores.
- **Flip vertically** when writing PNGs (FITS rows run bottom to top).
- **Images are small:** 116 px across after reprojecting at 3.1″ per pixel (SPHEREx's
  own pixels are ~6.2″). They look soft when scaled up; that is the real resolution.

## What this means for finding movers

- **Medians hide fast movers.** Anything that moves noticeably within a one-to-three-week
  pass is removed by the median. To catch asteroids, compare individual exposures within
  a pass, not just the combined pass images.
- **Plain difference images raise false alarms.** Every bright star leaves a blue-and-amber
  ring (the star image changes shape as the camera rotates), crowded fields like M16
  are full of them, and filled saturated stars flip colour. A difference mode needs to
  ignore these, e.g. flag only spots that appear in one pass and are absent from the others.
- **Stay near the ecliptic for asteroids.** M1, M45 and M104 are the best bets; M101 at
  +60° is a good "nothing should move" control.
- **A distant Planet X would shift far more than our field.** Parallax over six months
  would be about 7–14′ for a planet 500–1000 AU away, larger than our 6′ field, so it would
  leave the frame rather than blink inside it. The blink comparator suits nearer, slower movers
  seen within a pass, or needs a wider field.

## Ideas we haven't built yet

- **Two timescales:** blink between passes (months) and flip through exposures within a
  pass (hours to days).
- **Spectrum scrubber:** slide through wavelength using each exposure's measured value.
- **Difference toggle** with the false-alarm filtering above.
- **Known-asteroid demo:** look up where an asteroid such as Vesta was during a pass
  (JPL Horizons) and cut out that patch, for a guaranteed mover.
- **More targets:** M20 Trifid (on the ecliptic), the Galactic Centre, the Horsehead,
  M82, and NGC 6543 at the north ecliptic pole, which SPHEREx images every orbit (many
  visits, but a large download).
