# Step 3: group into passes, reproject onto one north-up grid, combine, and render PNGs.
import json
import math
import os
import warnings

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning
from PIL import Image
from scipy import ndimage
from reproject import reproject_interp

from config import BANDS, COLOURS, FIELD_DEG, REQUEST_SIZE, STRETCH, is_spot, load_target
from passes import group_passes, is_short


def roman(n):
    return "I II III IV V VI VII VIII IX X XI XII".split()[n - 1] if n <= 12 else str(n)

T = load_target()
RA, DEC = T["ra"], T["dec"]
SOFTEN, HI_PCT = STRETCH.get(T["id"], STRETCH["default"])

warnings.simplefilter("ignore")

SIZE = FIELD_DEG  # output grid; cutouts are requested larger and cropped by the reprojection
PIX_ARCSEC = 3.1  # 2x finer than SPHEREx's ~6.2" pixels, for a smoother display
N = int(round(SIZE * 3600 / PIX_ARCSEC))  # 116
OUT = "out"
# Spots skip the raw samples and frame-by-frame flipbook (report only, not used by the app).
EXTRAS = not is_spot(T)
for d in ["aligned", "colour", "diff"] + (["raw", "frames"] if EXTRAS else []):
    os.makedirs(f"{OUT}/{d}", exist_ok=True)

print("@@stage process", flush=True)
cutouts = [c for c in json.load(open("cutouts.json")) if "error" not in c]
if not cutouts:
    print("!! None of this spot's images could be downloaded from IRSA. Try again in a few "
          "minutes.", flush=True)
    raise SystemExit(1)

# Target grid: TAN projection centred on the target, north up, east left.
target = WCS(naxis=2)
target.wcs.ctype = ["RA---TAN", "DEC--TAN"]
target.wcs.crval = [RA, DEC]
target.wcs.crpix = [(N + 1) / 2, (N + 1) / 2]
target.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]

# Group into passes by date gap, rejoining visits split between detector pairs (passes.py).
passes = group_passes(cutouts, BANDS)


def load(c):
    with fits.open(c["file"]) as hdul:
        img = hdul["IMAGE"].data.astype(float)
        zodi = hdul["ZODI"].data.astype(float)
        flags = hdul["FLAGS"].data
        header = hdul["IMAGE"].header
    data = img - zodi  # remove the smooth zodiacal-light background
    data[flags & ~0 & 0b1 > 0] = np.nan  # bit 0: invalid pixel
    wcs = WCS(header)
    # rotation of the detector on the sky, from the CD/PC matrix
    pc = wcs.wcs.get_pc() * wcs.wcs.get_cdelt()[:, None] if wcs.wcs.has_pc() else wcs.wcs.cd
    angle = math.degrees(math.atan2(pc[0, 1], pc[1, 1]))
    return data, wcs, angle


def stretch(arr, lo, hi):
    """asinh stretch into 0..1 using fixed limits (same for every pass)."""
    a = np.clip((arr - lo) / (hi - lo), 0, None)
    return np.clip(np.arcsinh(a * SOFTEN) / np.arcsinh(SOFTEN), 0, 1)


def fill_holes(arr):
    """Saturated star cores are flagged in every exposure and leave enclosed NaN holes.
    Fill only those (not the empty edges), each with one flat value: the brightest pixel on
    its rim. Growing inward from the edges instead leaves dark X-shaped seams in big cores."""
    finite = np.isfinite(arr)
    labels, n = ndimage.label(ndimage.binary_fill_holes(finite) & ~finite)
    out = arr.copy()
    for i in range(1, n + 1):
        hole = labels == i
        rim = ndimage.binary_dilation(hole) & ~hole & finite
        if rim.any():
            out[hole] = arr[rim].max()
    return out


def save_grey(arr, path, flip=True):
    a = np.nan_to_num(arr, nan=0)
    img = Image.fromarray((a * 255).astype(np.uint8))
    (img.transpose(Image.FLIP_TOP_BOTTOM) if flip else img).save(path)


# Reproject every exposure; keep per-pass stacks.
stack = {}  # (pass_i, band) -> list of arrays
angles = []
for pi, group in enumerate(passes):
    for c in group:
        data, wcs, angle = load(c)
        c["angle_deg"] = angle
        angles.append(angle)
        arr, footprint = reproject_interp((data, wcs), target, shape_out=(N, N))
        arr[footprint == 0] = np.nan
        c["coverage"] = float(np.mean(footprint > 0))
        stack.setdefault((pi, c["band"]), []).append(arr)
        c["_aligned"] = arr

# One combined image per pass per band (median rejects cosmic rays / hot pixels).
combined = {k: fill_holes(np.nanmedian(np.array(v), axis=0)) for k, v in stack.items()}

# Stretch limits per band, shared by all passes so brightness doesn't flicker.
limits = {}
for b in BANDS:
    parts = [combined[(pi, b)].ravel() for pi in range(len(passes)) if (pi, b) in combined]
    allpix = np.concatenate(parts) if parts else np.array([])
    allpix = allpix[np.isfinite(allpix)]
    if allpix.size == 0:  # this band never covers the field: leave it out everywhere
        for pi in range(len(passes)):
            combined.pop((pi, b), None)
        continue
    limits[b] = (np.percentile(allpix, 5), np.percentile(allpix, HI_PCT))
if not limits:
    print("!! The downloaded images don't cover this spot. Try again in a few minutes.", flush=True)
    raise SystemExit(1)

# Short visits (a day or so, few images) get their own label instead of a pass number.
labels, n = [], 0
for group in passes:
    if is_short(group):
        labels.append("Short visit")
    else:
        n += 1
        labels.append(f"Pass {roman(n)}")

meta = {"target": T, "request_size_deg": REQUEST_SIZE,
        "grid": {"pixels": N, "arcsec_per_pixel": PIX_ARCSEC, "field_deg": SIZE}, "passes": []}
for pi, group in enumerate(passes):
    rgb = np.zeros((N, N, 3))
    for b in BANDS:
        if (pi, b) not in combined:
            continue  # e.g. a short visit with no D1 images
        s = stretch(combined[(pi, b)], *limits[b])
        save_grey(s, f"{OUT}/aligned/pass{pi + 1}_{b[-2:]}.png")
        rgb += np.nan_to_num(s)[..., None] * np.array(COLOURS[b]) / 255
    rgb = np.clip(rgb / 1.6, 0, 1)
    Image.fromarray((rgb * 255).astype(np.uint8)).transpose(Image.FLIP_TOP_BOTTOM).save(
        f"{OUT}/colour/pass{pi + 1}.png"
    )
    mjds = [c["mjd"] for c in group]
    meta["passes"].append({
        "label": labels[pi],
        "short": is_short(group),
        "bands": [b for b in BANDS if (pi, b) in combined],
        "start": Time(min(mjds), format="mjd").iso[:10],
        "end": Time(max(mjds), format="mjd").iso[:10],
        "mid": Time(np.mean(mjds), format="mjd").isot[:10],
        "count": len(group),
        "per_band": {b: sum(c["band"] == b for c in group) for b in BANDS},
        "wavelength_um": {
            b: round(float(np.median([c["wavelength_um"] for c in group if c["band"] == b])), 3)
            for b in BANDS if (pi, b) in combined
        },
    })

# Differences between consecutive passes (D3, or another band both have): anything that
# moved shows as +/- pairs. Passes with no band in common get no difference image.
DIFF_ORDER = ["SPHEREx-D3", "SPHEREx-D6", "SPHEREx-D1"]
for pi in range(1, len(passes)):
    b = next((b for b in DIFF_ORDER if (pi, b) in combined and (pi - 1, b) in combined), None)
    if b is None:
        continue
    d = stretch(combined[(pi, b)], *limits[b]) - stretch(combined[(pi - 1, b)], *limits[b])
    d = np.nan_to_num(d)
    rgb = np.zeros((N, N, 3))
    rgb[..., 0] = np.clip(-d * 2.5, 0, 1)  # brighter before: amber-ish
    rgb[..., 1] = np.clip(-d * 1.7, 0, 1) * 0.69 + np.clip(d * 2.5, 0, 1) * 0.63
    rgb[..., 2] = np.clip(d * 2.5, 0, 1)  # brighter after: blue
    rgb[..., 0] += np.clip(d * 2.5, 0, 1) * 0.35
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).transpose(
        Image.FLIP_TOP_BOTTOM).save(f"{OUT}/diff/pass{pi}-to-{pi + 1}.png")

# Raw samples: what single cutouts look like straight from IRSA (native orientation).
# Plus every aligned D3 exposure in time order, for a frame-by-frame flipbook.
raw_meta, frame_meta = [], []
for pi, group in enumerate(passes if EXTRAS else []):
    d3 = [c for c in group if c["band"] == "SPHEREx-D3"]
    picks = sorted({0, len(d3) // 2, len(d3) - 1}) if d3 else []
    for k, c in enumerate(d3[i] for i in picks):
        data, _, _ = load(c)
        finite = data[np.isfinite(data)]
        lo, hi = np.percentile(finite, 5), np.percentile(finite, 99.7)
        name = f"pass{pi + 1}_{k}.png"
        save_grey(stretch(data, lo, hi), f"{OUT}/raw/{name}")
        raw_meta.append({"file": f"raw/{name}", "pass": pi + 1, "label": labels[pi], "date": Time(c["mjd"], format="mjd").iso[:16],
                         "angle_deg": round(c["angle_deg"], 1), "shape": c["shape"],
                         "wavelength_um": round(c["wavelength_um"], 3)})
    for k, c in enumerate(d3):
        name = f"pass{pi + 1}_{k:02d}.png"
        save_grey(stretch(c["_aligned"], *limits["SPHEREx-D3"]), f"{OUT}/frames/{name}")
        frame_meta.append({"file": f"frames/{name}", "pass": pi + 1, "label": labels[pi],
                           "date": Time(c["mjd"], format="mjd").iso[:16],
                           "wavelength_um": round(c["wavelength_um"], 3),
                           "coverage": round(c["coverage"], 2)})

meta["raw"] = raw_meta
meta["frames"] = frame_meta
meta["angles_deg"] = sorted(round(a, 1) for a in angles)
meta["exposures"] = [
    {"band": c["band"], "date": Time(c["mjd"], format="mjd").isot[:16],
     "wavelength_um": round(c["wavelength_um"], 3), "pass": pi + 1}
    for pi, g in enumerate(passes) for c in g
]
json.dump(meta, open(f"{OUT}/meta.json", "w"), indent=1)
print(json.dumps(meta["passes"], indent=1))
print("rotation angles range:", min(angles), max(angles))
print("files:", sum(len(f) for _, _, f in os.walk(OUT)))
