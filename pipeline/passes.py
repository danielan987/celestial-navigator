# How exposures are grouped into passes. Shared by process.py and scout.py.
from config import PASS_GAP_DAYS

SHORT_VISIT_IMAGES = 20  # fewer exposures than this...
SHORT_VISIT_DAYS = 3  # ...or a span shorter than this makes a "short visit"


def group_by_gap(items, key=lambda x: x["mjd"]):
    """Sort by time and split wherever consecutive exposures are PASS_GAP_DAYS or more apart."""
    items = sorted(items, key=key)
    groups = []
    for item in items:
        if groups and key(item) - key(groups[-1][-1]) < PASS_GAP_DAYS:
            groups[-1].append(item)
        else:
            groups.append([item])
    return groups


def is_short(group, key=lambda x: x["mjd"]):
    # A spot's exposures are thinned out (query.py); each kept one "represents" several.
    count = sum(x.get("represents", 1) for x in group)
    return count < SHORT_VISIT_IMAGES or key(group[-1]) - key(group[0]) < SHORT_VISIT_DAYS


def merge_complementary(groups, bands, max_gap_days=90, key=lambda x: x["mjd"]):
    """Join neighbouring groups that are each missing bands but complete together.

    Detectors work in pairs (D1+D4, D2+D5, D3+D6) that see different strips of sky, so near
    the ecliptic poles a target can be crossed by one pair weeks before another: R Draconis
    gets a D1-only visit followed by a D3 + D6 visit. Together they make one full pass. A short
    visit next to a pass that is already complete (M104's D3 + D6 day) stays on its own.
    """
    want = set(bands)
    have = lambda group: {x["band"] for x in group}
    merged = []
    for group in groups:
        if merged:
            prev = merged[-1]
            if (
                have(prev) != want
                and have(group) != want
                and have(prev) | have(group) == want
                and key(group[0]) - key(prev[-1]) < max_gap_days
            ):
                prev.extend(group)
                continue
        merged.append(list(group))
    return merged


def group_passes(items, bands, key=lambda x: x["mjd"]):
    """Group exposures into passes: split on time gaps, then rejoin complementary halves."""
    return merge_complementary(group_by_gap(items, key), bands, key=key)


def cap_per_band(rows, bands, most):
    """Keep at most `most` exposures per detector per pass, evenly spaced in time (first and
    last always kept). Each kept row records how many it stands for, so a pass is still told
    apart from a short visit by its real size (passes.is_short)."""
    kept = []
    for group in group_passes(rows, bands):
        for band in bands:
            these = [r for r in group if r["band"] == band]
            if len(these) <= most:
                kept += these
                continue
            picks = sorted({round(i * (len(these) - 1) / (most - 1)) for i in range(most)})
            kept += [{**these[i], "represents": len(these) / len(picks)} for i in picks]
    kept.sort(key=lambda r: (r["band"], r["mjd"]))
    return kept
