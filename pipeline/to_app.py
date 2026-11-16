# Step 4: copy a processed target's images (colour, plus each detector alone) into the app
# and write its passes JSON (the same shape the backend serves; see src/api/types.ts).
# Built-in targets go into the app's bundled mock data; spots go to pipeline/data/media/<id>/
# (served by server.py at /media/<id>/), with passes.json written last as the "done" marker.
import json
import os
import shutil

from config import BANDS, FIELD_DEG, MEDIA, REPO, is_spot, load_target

T = load_target()
tid = T["id"]
meta = json.load(open("out/meta.json"))
print("@@stage publish", flush=True)
if is_spot(T):
    images, url_base = os.path.join(MEDIA, tid), f"/media/{tid}"
    passes_json = os.path.join(images, "passes.json")
else:
    images, url_base = os.path.join(REPO, "public", "mock", "images", tid), f"/mock/images/{tid}"
    passes_json = os.path.join(REPO, "src", "api", "mock", "passes", f"{tid}.json")
os.makedirs(images, exist_ok=True)

passes = []
for i, p in enumerate(meta["passes"]):
    if not p["bands"]:
        continue  # no detector covered the field on this visit
    shutil.copy(f"out/colour/pass{i + 1}.png", os.path.join(images, f"pass-{i + 1}.png"))
    band_urls = {}
    for band in BANDS:  # greyscale single-detector images; a short visit may lack a band
        short_name = band[-2:]  # "D1"
        if band in p["bands"]:
            name = f"pass-{i + 1}-{short_name.lower()}.png"
            shutil.copy(f"out/aligned/pass{i + 1}_{short_name}.png", os.path.join(images, name))
            band_urls[short_name] = f"{url_base}/{name}"
    passes.append({
        "id": f"{tid}-pass-{i + 1}",
        "label": p["label"],
        "date": p["mid"] + "T00:00:00Z",
        "imageUrl": f"{url_base}/pass-{i + 1}.png",
        "bandImageUrls": band_urls,
        **({"short": True} if p["short"] else {}),
    })

data = {
    "_source": "REAL SPHEREx data: IRSA cutouts in D1/D3/D6, median-combined per visit, reprojected "
    f"north-up (requested at {meta['request_size_deg']}°). Dates are each visit's mean observation "
    "date. Made by pipeline/to_app.py. No candidate movers yet.",
    "targetId": tid,
    "fieldSizeDeg": FIELD_DEG,
    "passes": passes,
    "candidates": [],
}
with open(passes_json + ".part", "w") as f:
    f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
os.replace(passes_json + ".part", passes_json)
print(tid, [(p["label"], p["date"][:10]) for p in passes])
