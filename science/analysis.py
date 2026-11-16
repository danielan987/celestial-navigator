"""Quick-look feature estimators on calibrated HiPS surface brightness."""
import numpy as np
from astropy.stats import sigma_clip

# Rest-frame windows in microns; exploratory continuum choices, not profile fits.
FEATURES = [
    dict(id='pah', name='PAH · small carbon-based particles', wave=3.3, kind='emission', left=(3.10, 3.22), right=(3.38, 3.58)),
    dict(id='water', name='Water ice', wave=3.05, kind='absorption', left=(2.64, 2.81), right=(3.55, 3.78)),
    dict(id='co2', name='CO₂ ice', wave=4.27, kind='absorption', left=(4.14, 4.22), right=(4.33, 4.41)),
    dict(id='co', name='CO ice', wave=4.67, kind='absorption', left=(4.53, 4.61), right=(4.73, 4.81)),
]

def feature_map(cube, waves, feature, z=0):
    observed = feature['wave'] * (1 + z)
    idx = int(np.argmin(np.abs(waves - observed)))
    sides = []
    selected = []
    for side in ('left', 'right'):
        lo, hi = np.array(feature[side]) * (1 + z)
        ids = np.where((waves >= lo) & (waves <= hi))[0]
        if not len(ids):
            raise ValueError('Continuum window lies outside the cube wavelength coverage.')
        selected.extend(ids.tolist())
        # Require all selected continuum channels at each pixel.
        sides.append((float(np.mean(waves[ids])), np.mean(cube[ids], axis=0)))
    (wl, left), (wr, right) = sides
    continuum = left + (right - left) * ((waves[idx] - wl) / (wr - wl))
    signal = cube[idx]
    valid = np.isfinite(signal) & np.isfinite(continuum)
    result = np.full(signal.shape, np.nan)
    if feature['kind'] == 'emission':
        result[valid] = signal[valid] - continuum[valid]
    else:
        valid &= (signal > 0) & (continuum > 0)
        result[valid] = -np.log(signal[valid] / continuum[valid])
    return result, idx, selected


def spectrum(cube, aperture, annulus, solid_angle):
    output = []
    for plane in cube:
        valid = aperture & np.isfinite(plane)
        sky = plane[annulus & np.isfinite(plane)]
        if valid.sum() < 0.8 * aperture.sum() or len(sky) < 0.8 * annulus.sum():
            output.append(None)
            continue
        background = float(np.ma.mean(sigma_clip(sky, sigma=3, maxiters=10)))
        output.append(float(np.sum((plane[valid] - background) * solid_angle[valid]) * 1e9))
    return output
