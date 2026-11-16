# Shared settings for the SPHEREx pipeline. Every step takes a target id from the
# app's targets.json, e.g. `python pipeline/query.py m45`, and works inside
# pipeline/data/<id>/ (git-ignored: raw cutouts are ~4 MB each).
#
# Any other spot works too, by an id made from its position (see spot_id):
# `python pipeline/run.py --ra 161.25 --dec 58` runs as `spot_161.2500_58.0000`, works in
# pipeline/data/spots/<id>/ and publishes to pipeline/data/media/<id>/ for server.py.
import json
import os
import re
import sys

PIPELINE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(PIPELINE)
TARGETS_JSON = os.path.join(REPO, "src", "api", "mock", "targets.json")
DATA = os.path.join(PIPELINE, "data")
SPOTS = os.path.join(DATA, "spots")  # work folders for spots entered by coordinates
MEDIA = os.path.join(DATA, "media")  # what server.py serves at /media/<id>/

# Spots keep at most this many exposures per detector per pass, evenly spaced in time, so a
# new spot downloads ~100 MB in a minute or two instead of 500 MB. Built-in targets keep all.
SPOT_MAX_PER_BAND = int(os.environ.get("SPOT_MAX_PER_BAND", "8"))

BANDS = ["SPHEREx-D1", "SPHEREx-D3", "SPHEREx-D6"]  # shortest, middle and longest detector
COLOURS = {  # matches the app's colour key (src/api/mock/colourKey.json)
    "SPHEREx-D1": (0x5A, 0xA0, 0xFF),
    "SPHEREx-D3": (0xF4, 0xEF, 0xE2),
    "SPHEREx-D6": (0xFF, 0xB0, 0x00),
}

FIELD_DEG = 0.1  # the square field shown in the app
# Cutouts are requested larger than the field so that, once rotated north-up,
# the corners are still covered. 0.1 leaves empty corners.
REQUEST_SIZE = float(os.environ.get("REQUEST_SIZE", "0.15"))

PASS_GAP_DAYS = 30  # exposures closer together than this belong to the same pass
# ...but no pass runs longer than this. Near the ecliptic poles SPHEREx looks every few days,
# so there's never a 30-day gap (the Tarantula's 250 days would be one pass). Normal passes
# last 1 to 8 weeks.
MAX_PASS_DAYS = 100

# Per-target stretch overrides: (asinh strength, percentile mapped to white).
# Bright, frame-filling objects wash out with the default.
STRETCH = {"default": (10, 99.7), "m1": (2, 99.95)}


def spot_id(ra, dec):
    """An id for any spot, from its position rounded to 0.0001° (0.36"): spot_133.7951_-7.2452."""
    ra = round(float(ra) % 360, 4) % 360
    return f"spot_{ra:.4f}_{round(float(dec), 4) + 0.0:.4f}"  # + 0.0 turns -0.0 into 0.0


def parse_spot_id(tid):
    """(ra, dec) from a spot id, or None if it isn't one."""
    m = re.fullmatch(r"spot_(\d{1,3}\.\d{4})_(-?\d{1,2}\.\d{4})", tid)
    if not m:
        return None
    ra, dec = float(m.group(1)), float(m.group(2))
    return (ra, dec) if 0 <= ra < 360 and -90 <= dec <= 90 else None


def is_spot(target):
    return target["id"].startswith("spot_")


def load_target():
    """Read the target id from argv, return its targets.json entry, and cd into its data folder.
    A spot id (spot_<ra>_<dec>) needs no entry: its position is in the id."""
    if len(sys.argv) < 2:
        sys.exit(f"usage: python {sys.argv[0]} <target id>   (an id from {TARGETS_JSON})")
    tid = sys.argv[1]
    spot = parse_spot_id(tid)
    if spot:
        work = os.path.join(SPOTS, tid)
        os.makedirs(work, exist_ok=True)
        os.chdir(work)
        return {"id": tid, "name": f"Spot at RA {spot[0]}, Dec {spot[1]}", "ra": spot[0], "dec": spot[1]}
    targets = {t["id"]: t for t in json.load(open(TARGETS_JSON))}
    if tid not in targets:
        sys.exit(f"unknown target {tid!r}; known: {', '.join(targets)}")
    work = os.path.join(DATA, tid)
    os.makedirs(work, exist_ok=True)
    os.chdir(work)
    return targets[tid]
