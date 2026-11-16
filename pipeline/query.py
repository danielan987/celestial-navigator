# Step 1: ask IRSA which SPHEREx images cover the target, per detector (same query as the IRSA notebook).
# If IRSA's query (TAP) service is down, falls back to its image-search (SIA) service, which
# lists the same Data Release 1 images; the quick releases (QR) are only in TAP.
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from astropy.io.votable import parse_single_table
from astroquery.ipac.irsa import Irsa

from config import BANDS, REQUEST_SIZE, SPOT_MAX_PER_BAND, is_spot, load_target
from passes import cap_per_band

T = load_target()
RA, DEC = T["ra"], T["dec"]
CUTOUT = f"?center={RA},{DEC}d&size={REQUEST_SIZE}"
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
OTHER_BANDS = []  # detectors other than ours that cover the spot (SIA only)


def from_tap():
    rows = []
    for band in BANDS:
        query = f"""
        SELECT
            'https://irsa.ipac.caltech.edu/' || a.uri || '{CUTOUT}' AS uri,
            p.time_bounds_lower
        FROM spherex.artifact a
        JOIN spherex.plane p ON a.planeid = p.planeid
        WHERE 1 = CONTAINS(POINT('ICRS', {RA}, {DEC}), p.poly)
                AND p.energy_bandpassname = '{band}'
        ORDER BY p.time_bounds_lower
        """
        t = time.time()
        res = Irsa.query_tap(query).to_table()
        print(f"{band}: {len(res)} images in {time.time() - t:.1f}s", flush=True)
        for r in res:
            rows.append({"band": band, "uri": str(r["uri"]), "mjd": float(r["time_bounds_lower"])})
    return rows


def from_sia():
    params = {
        "COLLECTION": "spherex_dr1",
        "POS": f"circle {RA} {DEC} 0.001",
        "RESPONSEFORMAT": "VOTable",
    }
    t = time.time()
    for attempt in range(5):  # IRSA drops out for minutes at a time; wait and try again
        try:
            with urllib.request.urlopen(f"{SIA_URL}?{urllib.parse.urlencode(params)}", timeout=300) as r:
                table = parse_single_table(io.BytesIO(r.read()))
            break
        except Exception as e:
            if attempt == 4:
                raise
            print(f"SIA attempt {attempt + 1} failed ({str(e)[:60]}); retrying in 60s", flush=True)
            time.sleep(60)
    col = {f.name: i for i, f in enumerate(table.fields)}  # columns by name, not position
    rows = []
    for rec in table.array:
        band = str(rec[col["energy_bandpassname"]])
        if band in BANDS:
            rows.append({
                "band": band,
                "uri": str(rec[col["access_url"]]) + CUTOUT,
                "mjd": float(rec[col["t_min"]]),
            })
    rows.sort(key=lambda r: (r["band"], r["mjd"]))
    others = sorted({str(rec[col["energy_bandpassname"]]) for rec in table.array} - set(BANDS))
    OTHER_BANDS[:] = others  # e.g. near the north ecliptic pole only D2 and D5 cover the spot
    for band in BANDS:
        print(f"{band}: {sum(r['band'] == band for r in rows)} images (SIA)", flush=True)
    print(f"SIA answered in {time.time() - t:.1f}s")
    return rows


print("@@stage query", flush=True)
try:
    listing = json.load(open("sia.json")) if is_spot(T) and os.path.exists("sia.json") else []
    if listing:  # server.py's scout already asked IRSA (it never saves an empty answer)
        rows = sorted(
            ({"band": im["band"], "uri": im["url"] + CUTOUT, "mjd": im["mjd"]}
             for im in listing if im["band"] in BANDS),
            key=lambda r: (r["band"], r["mjd"]),
        )
        OTHER_BANDS[:] = sorted({im["band"] for im in listing} - set(BANDS))
        print(f"using the image list saved by the scout: {len(rows)} images", flush=True)
    elif os.environ.get("SKIP_TAP"):  # set when TAP is known to be down, to skip its long timeout
        raise RuntimeError("SKIP_TAP is set")
    else:
        rows = from_tap()
except Exception as e:  # IRSA's TAP service has gone down for hours at a time (HTTP 502)
    print(f"TAP query failed ({type(e).__name__}: {str(e)[:80]}); using SIA instead", flush=True)
    try:
        rows = from_sia()
    except Exception as e:
        print(f"SIA failed too: {type(e).__name__}: {str(e)[:120]}", flush=True)
        print("!! NASA's SPHEREx archive (IRSA) isn't answering right now. "
              "Try again in a few minutes.", flush=True)
        sys.exit(1)

if not rows:
    if OTHER_BANDS:
        # IRSA answered with images, just none in our detectors: trying again won't help
        # (server.py hides the retry). An empty answer may be a wobble, so it isn't final.
        print("@@permanent", flush=True)
        names = " and ".join(b.replace("SPHEREx-", "") for b in OTHER_BANDS)
        print(f"!! SPHEREx has photographed this spot, but only with detectors {names}. "
              "Celestial Navigator blinks D1, D3 and D6, which haven't covered it in a released "
              "image yet (this happens near the north ecliptic pole).", flush=True)
    else:
        print("!! NASA's archive (IRSA) didn't list any SPHEREx images for this spot. SPHEREx "
              "covers the whole sky, so this is probably a hiccup at IRSA. Try again in a few "
              "minutes.", flush=True)
    sys.exit(1)

if is_spot(T):
    total = len(rows)
    rows = cap_per_band(rows, BANDS, SPOT_MAX_PER_BAND)
    print(f"keeping {len(rows)} of {total} exposures (at most {SPOT_MAX_PER_BAND} per detector "
          "per pass)", flush=True)

with open("query.json", "w") as f:
    json.dump(rows, f, indent=1)
print(f"saved {len(rows)} rows")
